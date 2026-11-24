// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Recording } from "../../src/core/src";
import { applyRecordingEdit } from "../../src/core/src/recordingEdit";
import type { CheckResult } from "./check.ts";
import { checkCutLaw, pickCuts, type RecordingEditor } from "./cutLaw.ts";
import { checkSeekVsPlay } from "./seekVsPlay.ts";
import { recordTake } from "./testRecording.ts";

const SEEK = { seed: 3, tickMs: 1000 / 60, everyMs: 100 };
const CUTS = { cuts: 6, seed: 3, everyMs: 100 };

const diffsByTrack = (result: CheckResult) =>
  Object.fromEntries(result.tracks.map(({ track, tally }) => [track, tally.diffs]));

const checksOf = (result: CheckResult, track: string) =>
  result.tracks.find((each) => each.track === track)!.tally.checks;

describe("seek vs play", () => {
  it("finds nothing on a take replay walks the same either way", () => {
    const result = checkSeekVsPlay(recordTake(), SEEK);
    expect(result.stopped).toBeNull();
    expect(result.odd.count).toBe(0);
    expect(diffsByTrack(result)).toEqual({
      editor: 0,
      workspace: 0,
      runtime: 0,
      chat: 0,
      whiteboard: 0,
      slides: 0,
      preview: 0,
    });
    expect(checksOf(result, "editor")).toBeGreaterThan(100);
  });

  it("leaves out a preview interaction, which playing applies and the panel does not show", () => {
    const take = recordTake();
    const recording: Recording = {
      ...take,
      previewEvents: [
        { timestamp: 0, type: "preview_open", size: "medium" },
        {
          timestamp: 1_000,
          type: "preview_interaction",
          interaction: { type: "click", timestamp: 1_000, target: { tagName: "button" } },
        },
      ],
    };
    const result = checkSeekVsPlay(recording, SEEK);
    expect(diffsByTrack(result).preview).toBe(0);
    expect(checksOf(result, "preview")).toBeGreaterThan(100);
  });

  it("counts a frame the machine cannot rebuild under 'odd file', not as a difference", () => {
    const recording = recordTake();
    // A delta frame whose text edit this reader cannot apply, as a damaged file has.
    const frames = recording.frames.map((frame, index) =>
      index === 2
        ? { ...frame, contentDelta: undefined, contentEditDelta: { version: 999 } }
        : frame,
    );
    const result = checkSeekVsPlay({ ...recording, frames } as Recording, SEEK);
    expect(result.stopped).toBeNull();
    expect(result.odd.count).toBeGreaterThan(0);
    expect(result.odd.first).toEqual(expect.any(String));
  });
});

describe("the cut law", () => {
  it("finds nothing in the law when the cut is the real one", () => {
    const result = checkCutLaw(recordTake(), CUTS);
    expect(result.stopped).toBeNull();
    expect(diffsByTrack(result)).toMatchObject({
      editor: 0,
      workspace: 0,
      runtime: 0,
      chat: 0,
      whiteboard: 0,
      slides: 0,
      preview: 0,
    });
    expect(checksOf(result, "runtime")).toBeGreaterThan(100);
    // Captions said across a cut lose the cut words: outside the law, but compared.
    expect(checksOf(result, "captions")).toBeGreaterThan(0);
    expect(result.tracks.find((each) => each.track === "pointer")!.scope).toBe("outside");
  });

  it("reports a cut that loses a record outside it, with the time, both values and the cut", () => {
    // A broken cut: the runtime's last record, which is after every cut, is lost.
    const losesTheLastRun: RecordingEditor = (recording, edit) => {
      const edited = applyRecordingEdit(recording, edit);
      return { ...edited, runtimeEvents: edited.runtimeEvents!.slice(0, -1) };
    };
    const recording = recordTake();
    const result = checkCutLaw(recording, { ...CUTS, edit: losesTheLastRun });
    const runtime = result.tracks.find((each) => each.track === "runtime")!.tally;
    expect(runtime.diffs).toBeGreaterThan(0);
    expect(runtime.first).toMatchObject({
      a: expect.stringContaining("built"),
      note: expect.stringMatching(/^cut \d/),
    });
    expect(runtime.first!.time).toBeGreaterThanOrEqual(recording.runtimeEvents!.at(-1)!.timestamp);
  });

  it("moves the preview's last refresh time with the cut, as it moves the refresh", () => {
    const take = recordTake();
    const recording: Recording = {
      ...take,
      previewEvents: [
        { timestamp: 0, type: "preview_open" },
        { timestamp: take.duration - 500, type: "preview_refresh" },
      ],
    };
    const result = checkCutLaw(recording, CUTS);
    expect(diffsByTrack(result).preview).toBe(0);
    expect(checksOf(result, "preview")).toBeGreaterThan(100);
  });

  it("picks the same cuts for the same seed, and others for another", () => {
    const recording = recordTake();
    expect(pickCuts(recording, 5, 9)).toEqual(pickCuts(recording, 5, 9));
    expect(pickCuts(recording, 5, 9)).not.toEqual(pickCuts(recording, 5, 10));
    for (const [cut] of pickCuts(recording, 20, 9)) {
      expect(cut.start).toBeGreaterThanOrEqual(0);
      expect(cut.end).toBeLessThanOrEqual(recording.duration);
      expect(cut.end).toBeGreaterThan(cut.start);
    }
  });

  it("makes every third cut span a file switch, where a cut can give a frame to the wrong file", () => {
    const recording = recordTake();
    const switches = recording.workspaceEvents!.map((event) => event.timestamp);
    for (const seed of [1, 2, 3, 4]) {
      const across = pickCuts(recording, 9, seed).filter((_, index) => index % 3 === 2);
      for (const [cut] of across) {
        const spanned = switches.filter((time) => time > cut.start && time <= cut.end + 1);
        expect({ cut, spansASwitch: spanned.length > 0 }).toEqual({ cut, spansASwitch: true });
      }
    }
  });
});
