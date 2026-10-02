import { describe, expect, it } from "vite-plus/test";
import {
  createEmptyRecordingTracks,
  type RecordingTrackName,
} from "../../core/src/machine/recordingAssembly";
import type { WorkspaceFile, WorkspaceRecordingEvent } from "../../types/workspace";
import type { Slide } from "../../core/src/slides";
import { RecordingDraftTrackWriter, rebuildRecordingDraftTracks } from "./recordingDraftTracks";
import type { RecordingDraftRecord } from "./recordingDraftStore";

const file = (path: string, content: string): WorkspaceFile => ({
  path,
  name: path,
  language: "typescript",
  content,
});

const workspaceEvent = (
  timestamp: number,
  files: Record<string, WorkspaceFile>,
): WorkspaceRecordingEvent => ({
  timestamp,
  snapshot: {
    activeFilePath: "a.ts",
    project: {
      id: "p",
      name: "P",
      lessonType: "html-css",
      entryFilePath: "a.ts",
      folders: [],
      files,
    },
  },
});

describe("journaling a take's tracks", () => {
  it("writes only what each track gained since the last flush", () => {
    const tracks = createEmptyRecordingTracks();
    const writer = new RecordingDraftTrackWriter();

    tracks.cursorEvents.push({ timestamp: 0, x: 0, y: 0, visible: false });
    const first = writer.collect(tracks);
    expect(first).toEqual([
      {
        kind: "append",
        track: "cursorEvents",
        entries: [{ timestamp: 0, x: 0, y: 0, visible: false }],
      },
    ]);

    expect(writer.collect(tracks)).toEqual([]);

    tracks.cursorEvents.push({ timestamp: 10, x: 5, y: 5, visible: true });
    expect(writer.collect(tracks)).toEqual([
      {
        kind: "append",
        track: "cursorEvents",
        entries: [{ timestamp: 10, x: 5, y: 5, visible: true }],
      },
    ]);
  });

  it("writes a replaced track over whole", () => {
    const tracks = createEmptyRecordingTracks();
    const writer = new RecordingDraftTrackWriter();
    tracks.cursorEvents.push({ timestamp: 0, x: 0, y: 0, visible: false });
    tracks.cursorEvents.push({ timestamp: 10, x: 5, y: 5, visible: true });
    writer.collect(tracks);

    tracks.cursorEvents = tracks.cursorEvents.slice(0, 1);
    const records = writer.collect(tracks);
    expect(records).toEqual([
      {
        kind: "reset",
        track: "cursorEvents",
        entries: [{ timestamp: 0, x: 0, y: 0, visible: false }],
      },
    ]);
    expect(rebuildRecordingDraftTracks(records).tracks.cursorEvents).toHaveLength(1);
  });

  it("journals only the workspace files that changed, and reads full snapshots back", () => {
    const tracks = createEmptyRecordingTracks();
    const writer = new RecordingDraftTrackWriter();
    const a1 = file("a.ts", "one");
    const b = file("b.ts", "shared");
    tracks.workspaceEvents.push(workspaceEvent(0, { "a.ts": a1, "b.ts": b }));
    const records: RecordingDraftRecord[] = writer.collect(tracks);

    const a2 = file("a.ts", "two");
    tracks.workspaceEvents.push(workspaceEvent(100, { "a.ts": a2, "b.ts": b }));
    tracks.workspaceEvents.push(workspaceEvent(200, { "a.ts": a2 }));
    const later = writer.collect(tracks);
    records.push(...later);

    const [append] = later;
    expect(append.kind).toBe("append");
    const journaled = append.kind === "append" ? append.entries : [];
    expect(journaled).toMatchObject([
      { changedFiles: { "a.ts": a2 }, removedPaths: [] },
      { changedFiles: {}, removedPaths: ["b.ts"] },
    ]);

    const rebuilt = rebuildRecordingDraftTracks(records).tracks.workspaceEvents;
    expect(rebuilt).toEqual(tracks.workspaceEvents);
    // Unchanged files are the same objects from one rebuilt event to the next.
    expect(rebuilt[1].snapshot.project.files["b.ts"]).toBe(
      rebuilt[0].snapshot.project.files["b.ts"],
    );
  });

  // Read off the empty tracks rather than RECORDING_TRACK_NAMES, so a track that
  // list ever missed would still get a case here, and that case would fail.
  const everyTrack = Object.keys(createEmptyRecordingTracks()) as RecordingTrackName[];

  /**
   * An entry of `track` at `time`. The writer reads only workspace events; it
   * passes the rest on as they are.
   */
  const entryAt = (track: RecordingTrackName, time: number): unknown =>
    track === "workspaceEvents"
      ? workspaceEvent(time, { "a.ts": file("a.ts", `at ${time}`) })
      : { timestamp: time, time, track };

  it.each(everyTrack)("reads %s back after appends and a retake", (track) => {
    const tracks = createEmptyRecordingTracks();
    const writer = new RecordingDraftTrackWriter();
    const records: RecordingDraftRecord[] = [];
    const entries = (): unknown[] => tracks[track];
    const flush = () => {
      records.push(...writer.collect(tracks));
      expect(rebuildRecordingDraftTracks(records).tracks).toEqual(tracks);
    };

    entries().push(entryAt(track, 0), entryAt(track, 100));
    flush();
    entries().push(entryAt(track, 200));
    flush();
    // A retake replaces the track with a copy cut back to the safe point, and the
    // take goes on. By the next flush the new array is as long as the old one, so
    // only its identity tells the writer to read it again from the start.
    (tracks as Record<RecordingTrackName, unknown[]>)[track] = entries().slice(0, 1);
    entries().push(entryAt(track, 300), entryAt(track, 400));
    flush();

    expect(records.map((record) => record.kind)).toEqual(["append", "append", "reset"]);
    expect(rebuildRecordingDraftTracks(records).tracks[track]).toHaveLength(3);
  });

  it("journals the deck only when it changes", () => {
    const tracks = createEmptyRecordingTracks();
    const writer = new RecordingDraftTrackWriter();
    const deck = [{ id: "s1" }] as unknown as Slide[];
    expect(writer.collect(tracks, deck)).toEqual([{ kind: "slides", slides: deck }]);
    expect(writer.collect(tracks, deck)).toEqual([]);
    const next = [...deck, { id: "s2" }] as unknown as Slide[];
    const records = writer.collect(tracks, next);
    expect(rebuildRecordingDraftTracks(records).slides).toBe(next);
  });
});
