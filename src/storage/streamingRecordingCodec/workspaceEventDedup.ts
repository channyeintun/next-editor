import type { WorkspaceFile, WorkspaceRecordingEvent } from "../../types/workspace";

// ============================================================================
// Workspace-event content dedup (stream-only representation)
//
// Every workspace recording event embeds the FULL project — every file's whole
// text content. Binary files are descriptors and their bytes live in dedicated
// asset storage, so this pass only needs to carry repeated strings.
//
// On encode, a file whose content is byte-identical to the last content written
// for the same path is stored with `content: ""` and a `contentUnchanged: true`
// marker; on decode the marker is resolved by carrying contents forward (sharing
// the same string reference, so rehydration is memory-cheap). The first
// occurrence of every path always carries its full content, so any decoded
// prefix that contains an event can resolve it. The marker exists ONLY inside
// the stream: in-memory `Recording` objects never carry it, and a
// decode(encode(x)) round-trip reproduces `x` exactly.
//
// Symmetry contract: strippers and hydrators must observe events in the same
// order. Both encoders (the live writer and the one-shot exporter) funnel
// workspace records through `StreamingRecordingWriter.appendEventSegment` in
// stream order, and both decoders (one-shot and incremental) accumulate segments
// in stream order, so a per-writer/per-reader carry map stays in lockstep.
// ============================================================================

/** Stream-only shape: a `WorkspaceFile` whose content was deduped away. */
type DedupedWorkspaceFile = WorkspaceFile & { contentUnchanged?: boolean };

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
 * returns copies with repeated file contents replaced by the
 * `contentUnchanged` marker. Never mutates its input (events are live app state).
 */
export function createWorkspaceEventContentStripper(): (
  events: ReadonlyArray<unknown>,
) => unknown[] {
  const lastContentByPath = new Map<string, string>();

  return (events) =>
    events.map((record) =>
      mapEventFiles(record as WorkspaceEventRecord, (path, file) => {
        if (typeof file.content !== "string" || file.content === "") {
          return file;
        }

        if (lastContentByPath.get(path) === file.content) {
          return { ...file, content: "", contentUnchanged: true };
        }

        lastContentByPath.set(path, file.content);
        return file;
      }),
    );
}

/**
 * Stateful hydrator for one decode pass. Feed decoded workspace events in stream
 * order; resolves `contentUnchanged` markers by carrying contents forward and
 * strips the marker so the in-memory event matches what was originally encoded.
 */
export function createWorkspaceEventContentHydrator(): (
  events: WorkspaceRecordingEvent[],
) => WorkspaceRecordingEvent[] {
  const lastContentByPath = new Map<string, string>();

  return (events) =>
    events.map((event) =>
      mapEventFiles(event, (path, file) => {
        if (file.contentUnchanged) {
          const { contentUnchanged: _contentUnchanged, ...rest } = file;
          return { ...rest, content: lastContentByPath.get(path) ?? "" };
        }

        if (typeof file.content === "string" && file.content !== "") {
          lastContentByPath.set(path, file.content);
        }
        return file;
      }),
    ) as WorkspaceRecordingEvent[];
}
