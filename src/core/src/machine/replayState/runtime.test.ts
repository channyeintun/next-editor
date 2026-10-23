import { describe, expect, it } from "vite-plus/test";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../runtime";
import { getRuntimeDockViewChangeIndex, withRuntimeDockView } from "./runtime";

/** Runtime fields without terminal sessions: a valid checkpoint and a valid delta alike. */
type DockRecord = Omit<RuntimeRecordingSnapshot, "terminalSessions">;

const snapshot = (fields: Partial<DockRecord> = {}): DockRecord => ({
  mode: "single-file",
  status: "ready",
  ...fields,
});

describe("getRuntimeDockViewChangeIndex", () => {
  it("marks where the dock was collapsed or expanded, not where output arrived", () => {
    const events: RuntimeRecordingEvent[] = [
      { timestamp: 0, snapshot: snapshot({ isCollapsed: false }) },
      { timestamp: 10, delta: snapshot({ isCollapsed: false, lastOutput: "one" }) },
      { timestamp: 20, delta: snapshot({ isCollapsed: true, lastOutput: "one" }) },
      { timestamp: 30, snapshot: snapshot({ isCollapsed: true, lastOutput: "two" }) },
      { timestamp: 40, delta: snapshot({ isCollapsed: false }) },
    ];

    expect(events.map((_, index) => getRuntimeDockViewChangeIndex(events, index))).toEqual([
      -1, -1, 2, 2, 4,
    ]);
  });

  it("reads a record without the dock's state as expanded and skips a damaged entry", () => {
    const events = [
      { timestamp: 0, snapshot: snapshot({ isCollapsed: true }) },
      { timestamp: 10 },
      { timestamp: 20, delta: snapshot() },
    ] as RuntimeRecordingEvent[];

    expect(events.map((_, index) => getRuntimeDockViewChangeIndex(events, index))).toEqual([
      0, 0, 2,
    ]);
  });
});

describe("withRuntimeDockView", () => {
  it("collapses a copy of the recorded state, or returns it when it already matches", () => {
    const recorded = snapshot({ lastOutput: "hi" });

    expect(withRuntimeDockView(recorded, false)).toBe(recorded);
    expect(withRuntimeDockView(recorded, true)).toEqual({ ...recorded, isCollapsed: true });
    expect(recorded.isCollapsed).toBeUndefined();
  });
});
