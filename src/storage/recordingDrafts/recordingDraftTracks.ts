import {
  createEmptyRecordingTracks,
  RECORDING_TRACK_NAMES,
  type RecordingTracks,
} from "../../core/src/machine/recordingAssembly";
import type { Slide } from "../../core/src/slides";
import type {
  WorkspaceFile,
  WorkspaceProject,
  WorkspaceRecordingEvent,
  WorkspaceRecordingSnapshot,
} from "../../types/workspace";
import type { RecordingDraftRecord } from "./recordingDraftStore";

// ============================================================================
// Journaling a take's tracks, and reading them back.
//
// The session's tracks are append-only arrays, so the writer keeps a read
// cursor per track and journals only what each gained since the last flush. A
// track the take replaced (a retake cuts it back) is written over whole.
//
// Workspace events are snapshots of the whole project. In memory they share
// every unchanged file with the event before them, but a journal write clones
// what it is given, so each is written with only the files that changed since
// the one before it; reading folds them back into full snapshots.
// ============================================================================

interface JournaledWorkspaceEvent {
  timestamp: number;
  snapshot: Omit<WorkspaceRecordingSnapshot, "project"> & {
    project: Omit<WorkspaceProject, "files">;
  };
  changedFiles: Record<string, WorkspaceFile>;
  removedPaths: string[];
}

export class RecordingDraftTrackWriter {
  private readonly cursors = new Map<string, { entries: readonly unknown[]; length: number }>();
  /** Files of the last journaled workspace event, compared by identity. */
  private workspaceFiles: Record<string, WorkspaceFile> = {};
  private slides: Slide[] | undefined;

  /** Records for everything `tracks` gained since the last call, and a changed deck. */
  collect(tracks: RecordingTracks, slides?: Slide[]): RecordingDraftRecord[] {
    const records: RecordingDraftRecord[] = [];

    for (const track of RECORDING_TRACK_NAMES) {
      const entries: readonly unknown[] = tracks[track];
      const cursor = this.cursors.get(track);

      if (cursor && cursor.entries === entries && entries.length >= cursor.length) {
        if (entries.length > cursor.length) {
          records.push({
            kind: "append",
            track,
            entries: this.encode(track, entries.slice(cursor.length)),
          });
          cursor.length = entries.length;
        }
        continue;
      }

      // First read of this track, or the take replaced it: write it over.
      if (track === "workspaceEvents") this.workspaceFiles = {};
      if (cursor || entries.length > 0) {
        records.push({
          kind: cursor ? "reset" : "append",
          track,
          entries: this.encode(track, entries.slice()),
        });
      }
      this.cursors.set(track, { entries, length: entries.length });
    }

    if (slides && slides !== this.slides) {
      records.push({ kind: "slides", slides });
      this.slides = slides;
    }

    return records;
  }

  private encode(track: string, entries: unknown[]): unknown[] {
    if (track !== "workspaceEvents") return entries;
    return (entries as WorkspaceRecordingEvent[]).map((event) => this.encodeWorkspaceEvent(event));
  }

  private encodeWorkspaceEvent(event: WorkspaceRecordingEvent): JournaledWorkspaceEvent {
    const { project, ...snapshot } = event.snapshot;
    const { files, ...projectFields } = project;
    const changedFiles: Record<string, WorkspaceFile> = {};
    for (const [path, file] of Object.entries(files)) {
      if (this.workspaceFiles[path] !== file) changedFiles[path] = file;
    }
    const removedPaths = Object.keys(this.workspaceFiles).filter((path) => !(path in files));
    this.workspaceFiles = files;
    return {
      timestamp: event.timestamp,
      snapshot: { ...snapshot, project: projectFields },
      changedFiles,
      removedPaths,
    };
  }
}

export interface RebuiltDraftTracks {
  tracks: RecordingTracks;
  slides?: Slide[];
}

/** Replays a draft's records into the tracks the take had at its last write. */
export function rebuildRecordingDraftTracks(
  records: readonly RecordingDraftRecord[],
): RebuiltDraftTracks {
  const tracks = createEmptyRecordingTracks();
  let slides: Slide[] | undefined;
  let workspaceFiles: Record<string, WorkspaceFile> = {};

  const decodeWorkspaceEvent = (entry: JournaledWorkspaceEvent): WorkspaceRecordingEvent => {
    // Unchanged files keep their objects, so rebuilt events share them as captured ones did.
    const files = { ...workspaceFiles, ...entry.changedFiles };
    for (const path of entry.removedPaths) delete files[path];
    workspaceFiles = files;
    return {
      timestamp: entry.timestamp,
      snapshot: { ...entry.snapshot, project: { ...entry.snapshot.project, files } },
    };
  };

  for (const record of records) {
    if (record.kind === "slides") {
      slides = record.slides;
      continue;
    }

    let entries = record.entries;
    if (record.track === "workspaceEvents") {
      if (record.kind === "reset") workspaceFiles = {};
      entries = (entries as JournaledWorkspaceEvent[]).map(decodeWorkspaceEvent);
    }

    const target: unknown[] = record.kind === "reset" ? [] : tracks[record.track];
    // A loop, not push(...entries): a track can hold far more entries than a spread's
    // argument limit.
    for (const entry of entries) target.push(entry);
    (tracks as unknown as Record<string, unknown[]>)[record.track] = target;
  }

  return { tracks, slides };
}
