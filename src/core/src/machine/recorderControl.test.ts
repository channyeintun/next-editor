import { describe, expect, it } from "vite-plus/test";
import { recorderErrorMessage, syncRecorderPause } from "./recorderControl";

/** Just the part of a MediaRecorder that pausing touches. */
function fakeRecorder(state: RecordingState) {
  const recorder = {
    state,
    calls: [] as string[],
    pause() {
      recorder.calls.push("pause");
      recorder.state = "paused";
    },
    resume() {
      recorder.calls.push("resume");
      recorder.state = "recording";
    },
  };
  return recorder;
}

describe("syncRecorderPause", () => {
  it("does nothing before the recorder exists", () => {
    expect(syncRecorderPause(null, true)).toBeNull();
  });

  it.each([
    ["recording", true, ["pause"], "paused"],
    ["paused", false, ["resume"], "resumed"],
    ["recording", false, [], null],
    ["paused", true, [], null],
    ["inactive", true, [], null],
    ["inactive", false, [], null],
  ] as const)("brings a %s recorder to paused=%s", (state, paused, calls, change) => {
    const recorder = fakeRecorder(state);
    expect(syncRecorderPause(recorder as unknown as MediaRecorder, paused)).toBe(change);
    expect(recorder.calls).toEqual(calls);
  });
});

describe("recorderErrorMessage", () => {
  it("reads the error an error event carries", () => {
    const event = Object.assign(new Event("error"), { error: new Error("device lost") });
    expect(recorderErrorMessage(event, "Recording error")).toBe("device lost");
  });

  it("falls back when the event carries no Error", () => {
    expect(recorderErrorMessage(new Event("error"), "Recording error")).toBe("Recording error");
    const event = Object.assign(new Event("error"), { error: "not an Error" });
    expect(recorderErrorMessage(event, "Recording error")).toBe("Recording error");
  });
});
