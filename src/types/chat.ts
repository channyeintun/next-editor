import type Anthropic from "@anthropic-ai/sdk";

export type ChatRole = "user" | "assistant";

export type ChatStatus =
  | "idle"
  | "streaming"
  | "running-tool"
  | "waiting-confirmation"
  | "done"
  | "error";

/**
 * A single message in the agent transcript, keyed by a stable id so tool_use/
 * tool_result deltas and `remove` (retry/abort truncation) can target it. `content`
 * mirrors `Anthropic.MessageParam["content"]` in its always-array form so a
 * `ChatMessage[]` converts to `Anthropic.MessageParam[]` (see `toMessageParams`)
 * without reshaping — the loop and the recorder share this one type.
 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: Anthropic.ContentBlockParam[];
}

/**
 * Same dmp (Myers diff) patch primitive as `ContentDelta` in
 * core/src/utils/deltaTypes.ts — duplicated here (not imported) because that file
 * pulls in `ChatRecordingEvent` for `DeltaRecording.chatEvents`, and importing back
 * from here would cycle. Both wrap the same `getDmpCodec()`-produced bytes.
 */
export interface ChatContentDelta {
  delta: Uint8Array;
}

/**
 * Every delta records ONLY what changed: a node inserted/removed, or text
 * inserted/removed inside the active (most recently started, unclosed) message.
 * No full-transcript records here — see `ChatCheckpoint` for the sparse seek
 * anchor. Replay is a reducer that folds these in order (src/core/src/machine/
 * replayState/chat.ts).
 */
export type ChatDelta =
  // Insert an empty message node and make it the "active" message for
  // subsequent `content`/`tool_use` deltas until its `message_end`.
  | { k: "message_start"; id: string; role: ChatRole }
  // Insert or remove text from the active message's trailing text block
  // (a new text block is appended first if the active message has none yet).
  | { k: "content"; delta: ChatContentDelta }
  // Insert a tool_use content block into the active (assistant) message.
  | { k: "tool_use"; toolUseId: string; name: string; input: unknown; path?: string }
  // Insert a tool_result message (its own user-role message, matching the
  // Anthropic wire format) for a prior tool_use.
  | { k: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  // Drop the message `fromId` and every message recorded after it — an
  // aborted or retried turn rewinds the transcript instead of appending.
  | { k: "remove"; fromId: string }
  | { k: "message_end"; id: string; usage?: { input: number; output: number } }
  | { k: "status"; status: ChatStatus };

/**
 * Seek keyframe only (frames-style), emitted sparsely — never the recording
 * unit. The `ChatDelta` log alone is authoritative and fully reconstructs the
 * transcript; a checkpoint just lets seeking skip replaying from zero, and
 * re-seats replay if a delta is ever dropped or mis-ordered.
 */
export interface ChatCheckpoint {
  messages: ChatMessage[];
  status: ChatStatus;
}

export interface ChatRecordingEvent {
  timestamp: number;
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint };
}

/** Strip the recorder-only `id` so a `ChatMessage[]` transcript can be sent as-is. */
export function toMessageParams(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
