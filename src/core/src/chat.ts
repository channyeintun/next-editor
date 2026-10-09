import type { ContentDelta } from "./utils/deltaTypes";

export type ChatRole = "user" | "assistant";

export interface ChatImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  name?: string;
}

export type ChatStatus =
  | "idle"
  | "streaming"
  | "running-tool"
  | "waiting-confirmation"
  | "done"
  | "error";

/**
 * A single transcript entry, modeled directly on the OpenRouter Responses "items"
 * the agent SDK streams (see `getItemsStream()`): a flat, ordered list of assistant/
 * user messages, tool calls, and tool results — not the nested Anthropic content-block
 * shape this used to carry. `toResponsesInput` (src/agent/responsesInput.ts) maps a
 * `ChatItem[]` straight back to the SDK's `Item[]` so a recorded transcript can be
 * replayed to the model as history.
 */
export type ChatItem =
  | { kind: "message"; id: string; role: ChatRole; text: string; images?: ChatImage[] }
  | { kind: "tool_call"; id: string; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; id: string; callId: string; output: string; isError?: boolean };

/**
 * Transcript text records only what changed: it streams into the active (most recently
 * started) message item as a dmp `content` delta; tool calls and results are appended
 * whole. Prompt drafts are small replacement values so arbitrary typing/deletion is
 * replayable without becoming transcript content. No full-transcript records here —
 * see `ChatCheckpoint` for the sparse seek anchor. Replay is a reducer that folds these
 * in order (src/core/src/machine/replayState/chat.ts).
 */
export type ChatDelta =
  // Clear the live/replayed conversation and composer. This is recorded when
  // the user starts a new chat so playback observes the same boundary.
  | { k: "reset" }
  // Replace the text currently visible in the prompt composer. Recording this
  // separately from user messages preserves typing before a prompt is sent.
  | { k: "draft"; text: string }
  // Append a message shell (plus any user images) and make it active for text deltas.
  | { k: "message_start"; id: string; role: ChatRole; images?: ChatImage[] }
  // dmp text delta applied to the active message item's text.
  | { k: "content"; delta: ContentDelta }
  // Append a completed tool call (arguments already fully streamed).
  | { k: "tool_call"; id: string; callId: string; name: string; arguments: string }
  // Append the result of a prior tool call, matched by `callId`.
  | { k: "tool_result"; callId: string; output: string; isError?: boolean }
  // Drop the item `fromId` and everything recorded after it — an aborted or
  // retried turn rewinds the transcript instead of appending.
  | { k: "remove"; fromId: string }
  | { k: "status"; status: ChatStatus };

/**
 * A sparse seek keyframe (frames-style), plus the baseline when recording starts
 * after a conversation already exists. After that initial seed, `ChatDelta`s are
 * the authoritative recording unit and checkpoints only bound replay work.
 */
export interface ChatCheckpoint {
  items: ChatItem[];
  status: ChatStatus;
  /** Prompt composer text at this point in the recording. Absent in older recordings. */
  draft?: string;
}

export interface ChatRecordingEvent {
  timestamp: number;
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint };
}

/**
 * The agent recorder (src/agent/chatRecording.ts) checkpoints on every run completion
 * and otherwise after this many of its deltas, which bounds how far a replay seek folds.
 */
export const CHAT_CHECKPOINT_DELTA_INTERVAL = 200;
