import { describe, expect, it } from "vitest";
import type { ChatRecordingEvent } from "../../../../types/chat";
import { createContentDelta } from "../../utils/frameDelta";
import { getChatReplayResult } from "./chat";

function insertDelta(prev: string, next: string) {
  const delta = createContentDelta(prev, next);
  if (!delta) throw new Error("expected a non-null content delta");
  return delta;
}

// A conversation with a checkpoint roughly halfway through, matching the
// "checkpoint every message_end" cadence (plan §13).
const CHAT_EVENTS: ChatRecordingEvent[] = [
  { timestamp: 0, event: { k: "message_start", id: "msg-1", role: "user" } },
  { timestamp: 10, event: { k: "content", delta: insertDelta("", "fix the bug") } },
  { timestamp: 20, event: { k: "message_end", id: "msg-1" } },
  {
    timestamp: 30,
    event: {
      k: "checkpoint",
      state: {
        messages: [{ id: "msg-1", role: "user", content: [{ type: "text", text: "fix the bug" }] }],
        status: "streaming",
      },
    },
  },
  { timestamp: 40, event: { k: "message_start", id: "msg-2", role: "assistant" } },
  { timestamp: 50, event: { k: "content", delta: insertDelta("", "Looking into it") } },
  { timestamp: 60, event: { k: "message_end", id: "msg-2", usage: { input: 5, output: 3 } } },
  { timestamp: 70, event: { k: "status", status: "done" } },
];

describe("getChatReplayResult", () => {
  it("folds from empty when there is no checkpoint yet", () => {
    const result = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 15,
      lastAppliedIndex: -1,
    });

    expect(result.snapshotToApply?.messages).toEqual([
      { id: "msg-1", role: "user", content: [{ type: "text", text: "fix the bug" }] },
    ]);
  });

  it("folding from the nearest checkpoint matches folding from empty at the same time", () => {
    const fromScratch = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 65,
      lastAppliedIndex: -1,
    });

    // Seek that lands after the checkpoint (index 3) — exercises the
    // checkpoint-seed path instead of folding from empty.
    const fromCheckpoint = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 65,
      lastAppliedIndex: 3,
    });

    expect(fromCheckpoint.snapshotToApply).toEqual(fromScratch.snapshotToApply);
    expect(fromScratch.snapshotToApply?.status).toBe("streaming");
    expect(fromScratch.snapshotToApply?.messages).toHaveLength(2);
  });

  it("seeking backward past a checkpoint re-folds from the preceding checkpoint, not incrementally", () => {
    // lastAppliedIndex parked at the end; seek back to before the checkpoint.
    const seekedBack = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 10,
      lastAppliedIndex: 7,
    });

    expect(seekedBack.snapshotToApply?.messages).toEqual([
      { id: "msg-1", role: "user", content: [{ type: "text", text: "fix the bug" }] },
    ]);
  });

  it("reflects a later status delta after the checkpoint", () => {
    const result = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 70,
      lastAppliedIndex: -1,
    });

    expect(result.snapshotToApply?.status).toBe("done");
  });

  it("returns no snapshot when the cursor index hasn't changed", () => {
    const first = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 70,
      lastAppliedIndex: -1,
    });
    const second = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 70,
      lastAppliedIndex: first.nextIndex,
    });

    expect(second.snapshotToApply).toBeUndefined();
  });
});
