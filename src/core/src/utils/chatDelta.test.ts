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
  it("streams text into the active message via message_start + content", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "content", delta: insertDelta("", "Hello") },
      { k: "content", delta: insertDelta("Hello", "Hello world") },
    ]);

    expect(state.messages).toEqual([
      { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]);
  });

  it("appends a tool_use block onto the active (last) message", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "content", delta: insertDelta("", "Reading a file...") },
      { k: "tool_use", toolUseId: "tool-1", name: "read", input: { path: "src/App.tsx" } },
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toEqual([
      { type: "text", text: "Reading a file..." },
      { type: "tool_use", id: "tool-1", name: "read", input: { path: "src/App.tsx" } },
    ]);
  });

  it("tool_result pushes its own user-role message (matching the Anthropic wire shape)", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "tool_use", toolUseId: "tool-1", name: "read", input: { path: "a.ts" } },
      { k: "message_end", id: "msg-1" },
      { k: "tool_result", toolUseId: "tool-1", content: "file contents", isError: false },
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toEqual({
      id: "tool_result:tool-1",
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "file contents", is_error: false },
      ],
    });
  });

  it("message_end and status are no-ops on the message list, status updates status", () => {
    const state = fold([
      { k: "status", status: "streaming" },
      { k: "message_start", id: "msg-1", role: "assistant" },
      { k: "message_end", id: "msg-1" },
      { k: "status", status: "done" },
    ]);

    expect(state.status).toBe("done");
    expect(state.messages).toEqual([{ id: "msg-1", role: "assistant", content: [] }]);
  });

  it("remove truncates the transcript from the target message onward (aborted/retried turn)", () => {
    const state = fold([
      { k: "message_start", id: "msg-1", role: "user" },
      { k: "content", delta: insertDelta("", "hi") },
      { k: "message_end", id: "msg-1" },
      { k: "message_start", id: "msg-2", role: "assistant" },
      { k: "content", delta: insertDelta("", "partial reply that gets retried") },
      { k: "remove", fromId: "msg-2" },
      { k: "message_start", id: "msg-3", role: "assistant" },
      { k: "content", delta: insertDelta("", "final reply") },
    ]);

    expect(state.messages).toEqual([
      { id: "msg-1", role: "user", content: [{ type: "text", text: "hi" }] },
      { id: "msg-3", role: "assistant", content: [{ type: "text", text: "final reply" }] },
    ]);
  });

  it("a full fold from empty equals folding the same deltas onto an intermediate state incrementally", () => {
    const deltas: ChatDelta[] = [
      { k: "message_start", id: "msg-1", role: "user" },
      { k: "content", delta: insertDelta("", "hello") },
      { k: "message_end", id: "msg-1" },
      { k: "message_start", id: "msg-2", role: "assistant" },
      { k: "content", delta: insertDelta("", "hi there") },
      { k: "message_end", id: "msg-2" },
    ];

    const fullFold = fold(deltas);
    const midpoint = fold(deltas.slice(0, 3));
    const resumedFold = fold(deltas.slice(3), midpoint);

    expect(resumedFold).toEqual(fullFold);
  });
});
