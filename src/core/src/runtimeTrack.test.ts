import { describe, expect, it } from "vitest";
import type { RuntimeRecordingEvent, RuntimeRecordingSnapshot } from "../../types/runtime";
import {
  decodeRecordingStream,
  encodeRecordingToStream,
} from "../../storage/streamingRecordingCodec";
import {
  applyTerminalOutputDelta,
  createRuntimeRecordingEvent,
  diffTerminalOutput,
  resolveLatestRuntimeSnapshot,
  resolveRuntimeSnapshotAt,
  RUNTIME_CHECKPOINT_MAX_EVENTS,
  RUNTIME_CHECKPOINT_RESET,
  type RuntimeCheckpointProgress,
} from "./runtimeTrack";
import type { Recording } from "./types";

// Mirrors the rolling window in useWebContainerRuntimeSession.
const WINDOW = 50_000;

function snapshot(output: string, extra: Partial<RuntimeRecordingSnapshot> = {}) {
  return {
    mode: "webcontainer",
    status: "running",
    terminalSessions: [{ id: "t1", title: "npm", output }],
    ...extra,
  } satisfies RuntimeRecordingSnapshot;
}

/** Records `outputs` the way the capture path does, returning the event track. */
function record(snapshots: RuntimeRecordingSnapshot[]): RuntimeRecordingEvent[] {
  const events: RuntimeRecordingEvent[] = [];
  let previous: RuntimeRecordingSnapshot | null = null;
  let progress: RuntimeCheckpointProgress = RUNTIME_CHECKPOINT_RESET;
  snapshots.forEach((next, index) => {
    const created = createRuntimeRecordingEvent(index * 10, previous, next, progress);
    events.push(created.event);
    progress = created.progress;
    previous = next;
  });
  return events;
}

/** A streaming command: repetitive chunks appended to a rolling window. */
function streamedOutputs(chunks: number): string[] {
  const outputs: string[] = [];
  let output = "";
  for (let index = 0; index < chunks; index++) {
    // Spinner-like, highly repetitive text is where a naive overlap search goes wrong.
    const chunk = `\r⠋ reify:fsevents: timing reifyNode ${index % 3} Completed in 12ms\n`;
    output = `${output}${chunk}`.slice(-WINDOW);
    outputs.push(output);
  }
  return outputs;
}

describe("diffTerminalOutput", () => {
  it.each([
    ["pure append", "abc", "abcdef", { drop: 0, append: "def" }],
    ["window scrolled", "abcdef", "defghi", { drop: 3, append: "ghi" }],
    ["cleared", "abcdef", "xyz", { drop: 6, append: "xyz" }],
    ["from empty", "", "hello", { drop: 0, append: "hello" }],
    ["to empty", "hello", "", { drop: 5, append: "" }],
  ])("%s", (_label, previous, next, expected) => {
    expect(diffTerminalOutput(previous, next)).toEqual(expected);
    expect(applyTerminalOutputDelta(previous, expected)).toBe(next);
  });

  it("stays exact and minimal on a repetitive rolling window", () => {
    const outputs = streamedOutputs(2_000);
    for (let index = 1; index < outputs.length; index++) {
      const delta = diffTerminalOutput(outputs[index - 1], outputs[index]);
      expect(applyTerminalOutputDelta(outputs[index - 1], delta)).toBe(outputs[index]);
      // Never carries more than the chunk that actually arrived.
      expect(delta.append.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("runtime track checkpoints and resolution", () => {
  it("starts with a checkpoint and resolves every index to the recorded snapshot", () => {
    const snapshots = streamedOutputs(1_500).map((output) => snapshot(output));
    const events = record(snapshots);

    expect(events[0].snapshot).toBe(snapshots[0]);
    // Forward (the playback path), then backward seeks (the checkpoint path).
    for (const index of [0, 1, 2, 700, 701, 1_499, 3, 1_000, 999]) {
      expect(resolveRuntimeSnapshotAt(events, index)).toEqual(snapshots[index]);
    }
    expect(resolveLatestRuntimeSnapshot(events)).toEqual(snapshots.at(-1));
  });

  it("stores O(total output), not O(events × window)", () => {
    const snapshots = streamedOutputs(3_000).map((output) => snapshot(output));
    const events = record(snapshots);
    const stored = events.reduce(
      (total, event) =>
        total +
        (event.snapshot
          ? (event.snapshot.terminalSessions?.[0]?.output.length ?? 0)
          : (event.delta.terminalSessions?.[0]?.output.append.length ?? 0)),
      0,
    );
    const produced = snapshots.at(-1)!.terminalSessions[0].output.length + 3_000 * 60;
    const fullSnapshots = snapshots.reduce(
      (total, next) => total + next.terminalSessions[0].output.length,
      0,
    );

    expect(stored).toBeLessThan(produced * 3);
    expect(stored).toBeLessThan(fullSnapshots / 20);
  });

  it("bounds the deltas between checkpoints when each one is tiny", () => {
    const snapshots = Array.from({ length: RUNTIME_CHECKPOINT_MAX_EVENTS * 2 }, (_, index) =>
      snapshot(`${"x".repeat(10_000)}${index}`.slice(-10_000)),
    );
    const events = record(snapshots);
    let run = 0;
    for (const event of events) {
      run = event.snapshot ? 0 : run + 1;
      expect(run).toBeLessThan(RUNTIME_CHECKPOINT_MAX_EVENTS);
    }
  });

  it("carries non-output fields whole and handles sessions opening and closing", () => {
    const snapshots: RuntimeRecordingSnapshot[] = [
      snapshot("boot\n"),
      snapshot("boot\nready\n", { status: "ready", activeTab: "terminal" }),
      {
        ...snapshot("boot\nready\n"),
        terminalSessions: [
          { id: "t1", title: "npm", output: "boot\nready\n" },
          { id: "t2", title: "bash", output: "$ " },
        ],
        activeTerminalSessionId: "t2",
      },
      { ...snapshot(""), terminalSessions: [{ id: "t2", title: "bash", output: "$ ls\n" }] },
    ];
    const events = record(snapshots);
    snapshots.forEach((expected, index) => {
      expect(resolveRuntimeSnapshotAt(events, index)).toEqual(expected);
    });
  });

  it("resolves a track of legacy full-snapshot events unchanged", () => {
    const events: RuntimeRecordingEvent[] = [
      { timestamp: 0, snapshot: snapshot("a") },
      { timestamp: 5, snapshot: snapshot("ab") },
    ];
    expect(resolveRuntimeSnapshotAt(events, 1)).toBe(events[1].snapshot);
    expect(resolveRuntimeSnapshotAt(events, 0)).toBe(events[0].snapshot);
  });

  it("round-trips the delta track through the SCR3 stream", async () => {
    const snapshots = streamedOutputs(400).map((output) => snapshot(output));
    const runtimeEvents = record(snapshots);
    const recording: Recording = {
      version: 4,
      id: "runtime-deltas",
      name: "Runtime deltas",
      createdAt: 1_700_000_000_000,
      duration: 5_000,
      keyframeInterval: 120,
      frames: [],
      runtimeEvents,
      streamFinalized: true,
    };

    const decoded = decodeRecordingStream(await encodeRecordingToStream(recording));

    expect(decoded.runtimeEvents).toEqual(runtimeEvents);
    expect(resolveLatestRuntimeSnapshot(decoded.runtimeEvents)).toEqual(snapshots.at(-1));
  });
});
