import { describe, expect, it } from "vitest";
import type { ChatCheckpoint, ChatRecordingEvent } from "../../../../types/chat";
import { createContentDelta } from "../../utils/frameDelta";
import { getChatReplayResult } from "./chat";

function insertDelta(prev: string, next: string) {
  const delta = createContentDelta(prev, next);
  if (!delta) throw new Error("expected a non-null content delta");
  return delta;
}

// A conversation with a checkpoint roughly halfway through.
const CHAT_EVENTS: ChatRecordingEvent[] = [
  { timestamp: 0, event: { k: "message_start", id: "msg-1", role: "user" } },
  { timestamp: 10, event: { k: "content", delta: insertDelta("", "fix the bug") } },
  {
    timestamp: 30,
    event: {
      k: "checkpoint",
      state: {
        items: [{ kind: "message", id: "msg-1", role: "user", text: "fix the bug" }],
        status: "streaming",
      },
    },
  },
  { timestamp: 40, event: { k: "message_start", id: "msg-2", role: "assistant" } },
  { timestamp: 50, event: { k: "content", delta: insertDelta("", "Looking into it") } },
  { timestamp: 70, event: { k: "status", status: "done" } },
];

describe("getChatReplayResult", () => {
  it("restores a conversation captured when recording starts, then honors new chat", () => {
    const initialState = {
      items: [{ kind: "message", id: "existing", role: "assistant", text: "Already here" }],
      status: "done",
      draft: "follow up",
    } satisfies ChatCheckpoint;
    const events: ChatRecordingEvent[] = [
      { timestamp: 0, event: { k: "checkpoint", state: initialState } },
      { timestamp: 10, event: { k: "reset" } },
    ];

    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 0, lastAppliedIndex: -1 })
        .snapshotToApply,
    ).toEqual(initialState);
    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 10, lastAppliedIndex: 0 })
        .snapshotToApply,
    ).toEqual({ items: [], status: "idle", draft: "" });
  });

  it("replays prompt composer typing and clearing at their recorded times", () => {
    const events: ChatRecordingEvent[] = [
      { timestamp: 5, event: { k: "draft", text: "fix" } },
      { timestamp: 10, event: { k: "draft", text: "fix the bug" } },
      { timestamp: 15, event: { k: "draft", text: "" } },
    ];

    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 10, lastAppliedIndex: -1 })
        .snapshotToApply?.draft,
    ).toBe("fix the bug");
    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 15, lastAppliedIndex: 1 })
        .snapshotToApply?.draft,
    ).toBe("");
  });

  it("folds from empty when there is no checkpoint yet", () => {
    const result = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 15,
      lastAppliedIndex: -1,
    });

    expect(result.snapshotToApply?.items).toEqual([
      { kind: "message", id: "msg-1", role: "user", text: "fix the bug" },
    ]);
  });

  it("folding from the nearest checkpoint matches folding from empty at the same time", () => {
    const fromScratch = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 55,
      lastAppliedIndex: -1,
    });

    // Seek that lands after the checkpoint (index 2) — exercises the
    // checkpoint-seed path instead of folding from empty.
    const fromCheckpoint = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 55,
      lastAppliedIndex: 2,
    });

    expect(fromCheckpoint.snapshotToApply).toEqual(fromScratch.snapshotToApply);
    expect(fromScratch.snapshotToApply?.status).toBe("streaming");
    expect(fromScratch.snapshotToApply?.items).toHaveLength(2);
  });

  it("seeking backward past a checkpoint re-folds from the preceding checkpoint", () => {
    const seekedBack = getChatReplayResult({
      chatEvents: CHAT_EVENTS,
      currentTime: 10,
      lastAppliedIndex: 5,
    });

    expect(seekedBack.snapshotToApply?.items).toEqual([
      { kind: "message", id: "msg-1", role: "user", text: "fix the bug" },
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

  // Forward playback advances one event per tick and continues from the retained
  // fold rather than re-folding from the checkpoint; the result must be identical
  // to a cold fold to the same point, including across a checkpoint.
  it("walking forward event by event matches a cold fold at every step", () => {
    const times = CHAT_EVENTS.map((event) => event.timestamp);
    let lastAppliedIndex = -1;

    for (const [index, currentTime] of times.entries()) {
      const walked = getChatReplayResult({
        chatEvents: CHAT_EVENTS,
        currentTime,
        lastAppliedIndex,
      });
      // A cold fold to the same instant, on a separate array so it cannot share
      // the walk's retained state.
      const cold = getChatReplayResult({
        chatEvents: [...CHAT_EVENTS],
        currentTime,
        lastAppliedIndex: -1,
      });

      expect(walked.nextIndex).toBe(index);
      expect(walked.snapshotToApply).toEqual(cold.snapshotToApply);
      lastAppliedIndex = walked.nextIndex;
    }
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
