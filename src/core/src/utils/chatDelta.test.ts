import { describe, expect, it } from "vitest";
import type { ChatDelta } from "../../../types/chat";
import { createContentDelta } from "./frameDelta";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "./chatDelta";

function fold(
  deltas: ChatDelta[],
  initial: ChatFoldState = INITIAL_CHAT_FOLD_STATE,
): ChatFoldState {
  return deltas.reduce(applyChatDelta, initial);
}

function insertDelta(prev: string, next: string) {
  const delta = createContentDelta(prev, next);
  if (!delta) throw new Error("expected a non-null content delta");
  return delta;
}

describe("applyChatDelta", () => {
  it("tracks prompt composer edits and clearing independently from transcript items", () => {
    const typed = fold([
      { k: "draft", text: "fix" },
      { k: "draft", text: "fix the bug" },
    ]);

    expect(typed.draft).toBe("fix the bug");
    expect(typed.items).toEqual([]);
    expect(fold([{ k: "draft", text: "" }], typed).draft).toBe("");
  });

  it("streams text into the active message via message_start + content", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "content", delta: insertDelta("", "Hello") },
      { k: "content", delta: insertDelta("Hello", "Hello world") },
    ]);

    expect(state.items).toEqual([
      { kind: "message", id: "msg-1", role: "assistant", text: "Hello world" },
    ]);
  });

  it("appends a tool_call item after the active message (does not intercept its text)", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "content", delta: insertDelta("", "Reading a file...") },
      {
        k: "tool_call",
        id: "tool-1",
        callId: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
      { k: "content", delta: insertDelta("Reading a file...", "Reading a file... done") },
    ]);

    expect(state.items).toEqual([
      { kind: "message", id: "msg-1", role: "assistant", text: "Reading a file... done" },
      {
        kind: "tool_call",
        id: "tool-1",
        callId: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
    ]);
  });

  it("tool_result appends its own item keyed by callId", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "tool_call", id: "tool-1", callId: "call-1", name: "read", arguments: "{}" },
      { k: "tool_result", callId: "call-1", output: "file contents", isError: false },
    ]);

    expect(state.items).toHaveLength(3);
    expect(state.items[2]).toEqual({
      kind: "tool_result",
      id: "out:call-1",
      callId: "call-1",
      output: "file contents",
      isError: false,
    });
  });

  it("status updates status; message_start with empty text yields an empty message item", () => {
    const state = fold([
      { k: "status", status: "streaming" },
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "status", status: "done" },
    ]);

    expect(state.status).toBe("done");
    expect(state.items).toEqual([{ kind: "message", id: "msg-1", role: "assistant", text: "" }]);
  });

  it("remove truncates the transcript from the target item onward (aborted/retried turn)", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "user" },
      { k: "content", delta: insertDelta("", "hi") },
      { k: "message_start", id: "msg-2", role: "assistant" },
      { k: "content", delta: insertDelta("", "partial reply that gets retried") },
      { k: "remove", fromId: "msg-2" },
      { k: "message_start", id: "msg-3", role: "assistant" },
      { k: "content", delta: insertDelta("", "final reply") },
    ]);

    expect(state.items).toEqual([
      { kind: "message", id: "msg-1", role: "user", text: "hi" },
      { kind: "message", id: "msg-3", role: "assistant", text: "final reply" },
    ]);
  });

  it("a full fold equals folding onto an intermediate checkpoint state incrementally", () => {
    const deltas: ChatDelta[] = [
      { k: "message_start", id: "msg-1", role: "user" },
      { k: "content", delta: insertDelta("", "hello") },
      { k: "message_start", id: "msg-2", role: "assistant" },
      { k: "content", delta: insertDelta("", "hi there") },
    ];

    const fullFold = fold(deltas);
    const midpoint = fold(deltas.slice(0, 2));
    const resumedFold = fold(deltas.slice(2), midpoint);

    expect(resumedFold).toEqual(fullFold);
  });
});
