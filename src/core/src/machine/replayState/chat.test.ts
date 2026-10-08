import { describe, expect, it } from "vite-plus/test";
import type { ChatCheckpoint, ChatDelta, ChatRecordingEvent } from "../../../../types/chat";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
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

  // A forward seek from an early retained fold used to replay every delta up to a
  // checkpoint in the range and then discard the result. The delta here was recorded
  // against other text, so applying it throws: the seek must never touch it.
  it("a forward seek from a retained fold restarts at the checkpoint it passes", () => {
    const events: ChatRecordingEvent[] = [
      { timestamp: 0, event: { k: "message_start", id: "msg-1", role: "user" } },
      { timestamp: 10, event: { k: "content", delta: insertDelta("other text", "other text!") } },
      {
        timestamp: 20,
        event: {
          k: "checkpoint",
          state: {
            items: [{ kind: "message", id: "msg-1", role: "user", text: "fix the bug" }],
            status: "streaming",
          },
        },
      },
      { timestamp: 30, event: { k: "status", status: "done" } },
    ];

    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 0, lastAppliedIndex: -1 }).nextIndex,
    ).toBe(0);

    const seeked = getChatReplayResult({
      chatEvents: events,
      currentTime: 30,
      lastAppliedIndex: 0,
      isResync: true,
    });
    const cold = getChatReplayResult({
      chatEvents: [...events],
      currentTime: 30,
      lastAppliedIndex: -1,
    });

    expect(seeked.snapshotToApply).toEqual(cold.snapshotToApply);
    expect(seeked.snapshotToApply).toEqual({
      items: [{ kind: "message", id: "msg-1", role: "user", text: "fix the bug" }],
      status: "done",
      draft: "",
    });
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

describe("getChatReplayResult before the first chat event", () => {
  // The agent panel was first used 500ms in, so the transcript was empty before that.
  const chatEvents: ChatRecordingEvent[] = [
    {
      timestamp: 500,
      event: {
        k: "checkpoint",
        state: {
          items: [{ kind: "message", id: "msg-1", role: "user", text: "fix the bug" }],
          status: "done",
        },
      },
    },
  ];
  const emptyTranscript = { items: [], status: "idle" };

  it("applies the empty transcript on a resync", () => {
    expect(
      getChatReplayResult({ chatEvents, currentTime: 100, lastAppliedIndex: -1, isResync: true }),
    ).toEqual({ nextIndex: -1, snapshotToApply: emptyTranscript });
  });

  it("applies nothing on a tick that has not reached the first event", () => {
    expect(getChatReplayResult({ chatEvents, currentTime: 100, lastAppliedIndex: -1 })).toEqual({
      nextIndex: -1,
    });
  });

  it("applies the empty transcript once when a tick rewinds to before the first event", () => {
    expect(getChatReplayResult({ chatEvents, currentTime: 100, lastAppliedIndex: 0 })).toEqual({
      nextIndex: -1,
      snapshotToApply: emptyTranscript,
    });
  });
});

describe("getChatReplayResult fold budget", () => {
  function messageStarts(count: number): ChatRecordingEvent[] {
    return Array.from({ length: count }, (_, index) => ({
      timestamp: index,
      event: { k: "message_start", id: `msg-${index}`, role: "user" },
    }));
  }

  // Each item-list delta copies the item list, so a crafted track with no checkpoints
  // made one seek O(deltas × items) on the main thread. The recorder checkpoints every
  // 200 deltas, so a run ten times that long is refused instead of folded.
  it("refuses a fold through more item-list deltas than a recorder ever writes", () => {
    const allowed = messageStarts(2_000);
    expect(
      getChatReplayResult({ chatEvents: allowed, currentTime: 1_999, lastAppliedIndex: -1 })
        .snapshotToApply?.items,
    ).toHaveLength(2_000);

    const tooMany = messageStarts(2_001);
    expect(() =>
      getChatReplayResult({ chatEvents: tooMany, currentTime: 2_000, lastAppliedIndex: -1 }),
    ).toThrow("too many changes between checkpoints");
  });

  // The agent panel records prompt drafts per keystroke outside the recorder's
  // checkpoint count, so a long typed prompt is a legit run with no checkpoint.
  it("does not count prompt drafts, which a long typed prompt records per keystroke", () => {
    const events: ChatRecordingEvent[] = Array.from({ length: 5_000 }, (_, index) => ({
      timestamp: index,
      event: { k: "draft", text: `keystroke ${index}` },
    }));

    expect(
      getChatReplayResult({ chatEvents: events, currentTime: 4_999, lastAppliedIndex: -1 })
        .snapshotToApply?.draft,
    ).toBe("keystroke 4999");
  });

  it("folds a long recorder-shaped track to the end and back", () => {
    // Recorded the way the agent recorder does: a checkpoint after every 200 deltas.
    const events: ChatRecordingEvent[] = [];
    const expected: ChatFoldState[] = [];
    let state = INITIAL_CHAT_FOLD_STATE;
    let deltasSinceCheckpoint = 0;
    for (let serial = 0; events.length < 10_000; serial += 1) {
      if (deltasSinceCheckpoint === 200) {
        events.push({ timestamp: events.length, event: { k: "checkpoint", state } });
        expected.push(state);
        deltasSinceCheckpoint = 0;
        continue;
      }
      const active = state.items.at(-1);
      const event: ChatDelta =
        serial % 40 === 0 || active?.kind !== "message"
          ? { k: "message_start", id: `msg-${serial}`, role: "assistant" }
          : { k: "content", delta: insertDelta(active.text, `${active.text}${serial % 10}`) };
      events.push({ timestamp: events.length, event });
      state = applyChatDelta(state, event);
      expected.push(state);
      deltasSinceCheckpoint += 1;
    }

    const end = getChatReplayResult({
      chatEvents: events,
      currentTime: 9_999,
      lastAppliedIndex: -1,
    });
    expect(end.snapshotToApply).toEqual(expected[9_999]);

    const back = getChatReplayResult({
      chatEvents: events,
      currentTime: 4_321,
      lastAppliedIndex: end.nextIndex,
    });
    expect(back.snapshotToApply).toEqual(expected[4_321]);
  });
});
