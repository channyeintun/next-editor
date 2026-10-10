import { describe, expect, it } from "vite-plus/test";
import {
  assembleRecording,
  createEmptyRecordingTracks,
  lastRecordedTrackTime,
  RECORDING_TRACK_NAMES,
  RECORDING_TRACK_TIME,
  sortRecordingTracksByTime,
  type RecordingTrackName,
  type RecordingTracks,
} from "./recordingAssembly";

/** Tracks holding stand-in entries that carry only their time field and a tag. */
function tracksWith(entries: Partial<Record<RecordingTrackName, object[]>>): RecordingTracks {
  return { ...createEmptyRecordingTracks(), ...entries } as unknown as RecordingTracks;
}

const tagsOf = (entries: readonly unknown[]) =>
  entries.map((entry) => (entry as { tag: string }).tag);

describe("RECORDING_TRACK_TIME", () => {
  it("names every track, in the track order", () => {
    expect(Object.keys(RECORDING_TRACK_TIME)).toEqual([...RECORDING_TRACK_NAMES]);
  });
});

describe("sortRecordingTracksByTime", () => {
  it("orders the preview documents and patch batches by time and the rest by timestamp", () => {
    const tracks = tracksWith({
      frames: [
        { timestamp: 30, time: 0, tag: "c" },
        { timestamp: 10, time: 99, tag: "a" },
        { timestamp: 20, time: 50, tag: "b" },
      ],
      chatEvents: [
        { timestamp: 2, tag: "y" },
        { timestamp: 1, tag: "x" },
      ],
      previewInitialDocuments: [
        { time: 40, timestamp: 0, tag: "b" },
        { time: 5, timestamp: 99, tag: "a" },
      ],
      previewPatchBatches: [
        { time: 9, tag: "b" },
        { time: 3, tag: "a" },
      ],
    });

    sortRecordingTracksByTime(tracks);

    expect(tagsOf(tracks.frames)).toEqual(["a", "b", "c"]);
    expect(tagsOf(tracks.chatEvents)).toEqual(["x", "y"]);
    expect(tagsOf(tracks.previewInitialDocuments)).toEqual(["a", "b"]);
    expect(tagsOf(tracks.previewPatchBatches)).toEqual(["a", "b"]);
  });

  it("keeps entries with equal times in their recorded order", () => {
    const tracks = tracksWith({
      workspaceEvents: [
        { timestamp: 5, tag: "first" },
        { timestamp: 1, tag: "early" },
        { timestamp: 5, tag: "second" },
        { timestamp: 5, tag: "third" },
      ],
    });

    sortRecordingTracksByTime(tracks);

    expect(tagsOf(tracks.workspaceEvents)).toEqual(["early", "first", "second", "third"]);
  });

  it("sorts each track's own array in place", () => {
    const tracks = tracksWith({ cursorEvents: [{ timestamp: 2 }, { timestamp: 1 }] });
    const cursorEvents = tracks.cursorEvents;

    sortRecordingTracksByTime(tracks);

    expect(tracks.cursorEvents).toBe(cursorEvents);
  });
});

describe("lastRecordedTrackTime", () => {
  it("is 0 when every track is empty", () => {
    expect(lastRecordedTrackTime(createEmptyRecordingTracks())).toBe(0);
  });

  it("takes the latest last entry across tracks, reading each track's own time field", () => {
    const tracks = tracksWith({
      frames: [{ timestamp: 100 }, { timestamp: 400 }],
      // A larger `timestamp` on a time-keyed track is not its recording time.
      previewPatchBatches: [{ time: 900, timestamp: 1 }],
      previewInitialDocuments: [{ time: 10, timestamp: 5000 }],
      whiteboardEvents: [{ timestamp: 700 }],
    });

    expect(lastRecordedTrackTime(tracks)).toBe(900);
  });

  it("reads each track's last entry, the way an append-only track ends", () => {
    const tracks = tracksWith({ runtimeEvents: [{ timestamp: 800 }, { timestamp: 300 }] });

    expect(lastRecordedTrackTime(tracks)).toBe(300);
  });
});

describe("assembleRecording", () => {
  it("carries every track's array into the recording", () => {
    const tracks = tracksWith(
      Object.fromEntries(
        RECORDING_TRACK_NAMES.map((name) => [name, [{ timestamp: 0, tag: name }]]),
      ),
    );

    const recording = assembleRecording({
      tracks,
      duration: 1000,
      audio: { startOffsetMs: 0 },
      camera: { startOffsetMs: 0 },
    });

    const dropped = RECORDING_TRACK_NAMES.filter((name) => recording[name] !== tracks[name]);
    expect(dropped).toEqual([]);
  });
});
