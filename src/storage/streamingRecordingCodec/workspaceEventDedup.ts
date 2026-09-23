import type {
  WorkspaceFile,
  WorkspaceRecordingEvent,
  WorkspaceRecordingSnapshot,
} from "../../types/workspace";

// ============================================================================
// Workspace-event content dedup (stream-only representation)
//
// Every workspace recording event embeds the FULL project — every file's whole
// text content. Binary files are descriptors and their bytes live in dedicated
// asset storage, so this pass only needs to carry text.
//
// On encode, each text file is written as the smallest of:
//   * `content: ""` + `contentUnchanged: true` — byte-identical to the last
//     content known for the same path;
//   * `content: ""` + `contentSplice: [start, deleteCount, insert]` — the last
//     known content with one range replaced (common prefix and suffix kept),
//     when that is smaller than the file;
//   * the full content.
// On decode the markers are resolved by carrying contents forward (an unchanged
// file shares the same string reference, so rehydration is memory-cheap). The
// markers exist ONLY inside the stream: in-memory `Recording` objects never
// carry them, and a decode(encode(x)) round-trip reproduces `x` exactly.
//
// Format version 5 also seeds the "last known content" from the header's
// `workspaceSnapshot`, which the header always carries before any segment. The
// project a lesson starts from is usually the one it ends with, so without the
// seed the first workspace event stored every file a second time. Version 4
// and older streams were written without a seed and are hydrated without one.
//
// Symmetry contract: strippers and hydrators must observe events in the same
// order. The writer funnels workspace records through
// `StreamingRecordingWriter.appendEventSegment` in stream order, and both
// decoders (one-shot and incremental) accumulate segments in stream order, so a
// per-writer/per-reader carry map stays in lockstep.
// ============================================================================

/** `[start, deleteCount, insert]` applied to the last known content for the path. */
type ContentSplice = [start: number, deleteCount: number, insert: string];

/** Stream-only shape: a `WorkspaceFile` whose content was deduped away. */
type DedupedWorkspaceFile = WorkspaceFile & {
  contentUnchanged?: boolean;
  contentSplice?: ContentSplice;
};

/** A splice header costs a few msgpack bytes; below this saving, keep the full text. */
const MIN_SPLICE_SAVING_CHARS = 16;

function createContentSplice(previous: string, next: string): ContentSplice | null {
  const maxAffix = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < maxAffix && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < maxAffix - prefix &&
    previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }
  const insert = next.slice(prefix, next.length - suffix);
  if (insert.length + MIN_SPLICE_SAVING_CHARS >= next.length) return null;
  return [prefix, previous.length - prefix - suffix, insert];
}

function applyContentSplice(previous: string, [start, deleteCount, insert]: ContentSplice): string {
  return previous.slice(0, start) + insert + previous.slice(start + deleteCount);
}

/** Last known content per text-file path, optionally starting from a snapshot. */
function createContentCarry(seed: WorkspaceRecordingSnapshot | undefined): Map<string, string> {
  const lastContentByPath = new Map<string, string>();
  for (const [path, file] of Object.entries(seed?.project?.files ?? {})) {
    if (file.encoding !== "asset" && typeof file.content === "string" && file.content !== "") {
      lastContentByPath.set(path, file.content);
    }
  }
  return lastContentByPath;
}

type WorkspaceEventRecord = WorkspaceRecordingEvent & {
  snapshot?: WorkspaceRecordingEvent["snapshot"];
};

function mapEventFiles(
  event: WorkspaceEventRecord,
  mapFile: (path: string, file: DedupedWorkspaceFile) => DedupedWorkspaceFile,
): WorkspaceEventRecord {
  const snapshot = event.snapshot;
  const project = snapshot?.project;
  if (!snapshot || !project?.files) {
    return event;
  }

  let changed = false;
  const nextFiles: Record<string, DedupedWorkspaceFile> = {};

  for (const [path, file] of Object.entries(project.files)) {
    const nextFile = mapFile(path, file);
    nextFiles[path] = nextFile;
    if (nextFile !== file) {
      changed = true;
    }
  }

  if (!changed) {
    return event;
  }

  return {
    ...event,
    snapshot: {
      ...snapshot,
      project: { ...project, files: nextFiles },
    },
  };
}

/**
 * Stateful stripper for one encode pass. Feed workspace events in stream order;
 * returns copies with repeated file contents replaced by the stream-only markers.
 * Never mutates its input (events are live app state). `seed` is the header's
 * `workspaceSnapshot` — the reader must seed its hydrator with the same one.
 */
export function createWorkspaceEventContentStripper(
  seed?: WorkspaceRecordingSnapshot,
): (events: ReadonlyArray<unknown>) => unknown[] {
  const lastContentByPath = createContentCarry(seed);

  return (events) =>
    events.map((record) =>
      mapEventFiles(record as WorkspaceEventRecord, (path, file) => {
        if (file.encoding === "asset" || file.content === "") {
          return file;
        }

        const previous = lastContentByPath.get(path);
        if (previous === file.content) {
          return { ...file, content: "", contentUnchanged: true };
        }

        lastContentByPath.set(path, file.content);
        const splice = previous === undefined ? null : createContentSplice(previous, file.content);
        return splice ? { ...file, content: "", contentSplice: splice } : file;
      }),
    );
}

/**
 * Stateful hydrator for one decode pass. Feed decoded workspace events in stream
 * order; resolves the markers by carrying contents forward and strips them so the
 * in-memory event matches what was originally encoded.
 */
export function createWorkspaceEventContentHydrator(
  seed?: WorkspaceRecordingSnapshot,
): (events: WorkspaceRecordingEvent[]) => WorkspaceRecordingEvent[] {
  const lastContentByPath = createContentCarry(seed);

  return (events) =>
    events.map((event) =>
      mapEventFiles(event, (path, file) => {
        if (file.contentUnchanged) {
          if (file.encoding === "asset") {
            const { contentUnchanged: _contentUnchanged, ...rest } = file;
            return rest;
          }
          const { contentUnchanged: _contentUnchanged, ...rest } = file;
          return { ...rest, content: lastContentByPath.get(path) ?? "" };
        }

        if (file.contentSplice && file.encoding !== "asset") {
          const previous = lastContentByPath.get(path);
          if (previous === undefined) {
            throw new Error(
              `Invalid SCR3 stream: workspace content splice for ${path} has no base`,
            );
          }
          const { contentSplice, ...rest } = file;
          const content = applyContentSplice(previous, contentSplice);
          lastContentByPath.set(path, content);
          return { ...rest, content };
        }

        if (typeof file.content === "string" && file.content !== "") {
          lastContentByPath.set(path, file.content);
        }
        return file;
      }),
    ) as WorkspaceRecordingEvent[];
}
