import { describe, expect, it } from "vite-plus/test";
import type { Recording, RecordingStreamDelta } from "../types";
import { RECORDING_TRACK_NAMES } from "./recordingAssembly";
import { appendRecordingDelta } from "./replayActions";
import { createInitialContext } from "./types";

describe("appendRecordingDelta", () => {
  it("appends every track's streamed records, keeping the arrays it already holds", () => {
    const frames = [{ tag: "first frame" }];
    const recording = {
      id: "lesson",
      frames,
      duration: 1000,
    } as unknown as Recording;
    // Each track's records under the delta's `new<Track>` field, one stand-in apiece.
    const delta = {
      cursor: 1,
      recordingId: "lesson",
      duration: 2000,
      streamFinalized: false,
      ...Object.fromEntries(
        RECORDING_TRACK_NAMES.map((name) => [
          `new${name[0]!.toUpperCase()}${name.slice(1)}`,
          [{ tag: name }],
        ]),
      ),
    } as unknown as RecordingStreamDelta;

    const update = appendRecordingDelta({
      context: { ...createInitialContext({ editorRef: { current: null } }), recording },
      event: { type: "APPEND_RECORDING_DELTA", delta },
    });

    const dropped = RECORDING_TRACK_NAMES.filter(
      (name) =>
        !(update.recording?.[name] as unknown[] | undefined)?.some(
          (record) => (record as { tag: string }).tag === name,
        ),
    );
    expect(dropped).toEqual([]);
    expect(update.recording?.frames).toBe(frames);
    expect(frames).toEqual([{ tag: "first frame" }, { tag: "frames" }]);
    expect(update.recordingStreamCursor).toBe(1);
  });
});
