import type {
  EasyInputMessage,
  FunctionCallOutputItem,
  Item,
  OutputFunctionCallItem,
  ResponseOutputText,
} from "@openrouter/agent";

export type ChatRole = "user" | "assistant";

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
 * shape this used to carry. `toResponsesInput` maps a `ChatItem[]` straight back to the
 * SDK's `Item[]` so a recorded transcript can be replayed to the model as history.
 */
export type ChatItem =
  | { kind: "message"; id: string; role: ChatRole; text: string }
  | { kind: "tool_call"; id: string; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; id: string; callId: string; output: string; isError?: boolean };

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
 * Every delta records ONLY what changed. Text streams into the active (most recently
 * started) message item as a dmp `content` delta; tool calls and results are appended
 * whole. No full-transcript records here — see `ChatCheckpoint` for the sparse seek
 * anchor. Replay is a reducer that folds these in order (src/core/src/machine/
 * replayState/chat.ts).
 */
export type ChatDelta =
  // Append an empty message item and make it the active one for `content` deltas.
  | { k: "message_start"; id: string; role: ChatRole }
  // dmp text delta applied to the active message item's text.
  | { k: "content"; delta: ChatContentDelta }
  // Append a completed tool call (arguments already fully streamed).
  | { k: "tool_call"; id: string; callId: string; name: string; arguments: string }
  // Append the result of a prior tool call, matched by `callId`.
  | { k: "tool_result"; callId: string; output: string; isError?: boolean }
  // Drop the item `fromId` and everything recorded after it — an aborted or
  // retried turn rewinds the transcript instead of appending.
  | { k: "remove"; fromId: string }
  | { k: "status"; status: ChatStatus };

/**
 * Seek keyframe only (frames-style), emitted sparsely — never the recording unit.
 * The `ChatDelta` log alone is authoritative and fully reconstructs the transcript;
 * a checkpoint just lets seeking skip replaying from zero.
 */
export interface ChatCheckpoint {
  items: ChatItem[];
  status: ChatStatus;
}

export interface ChatRecordingEvent {
  timestamp: number;
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint };
}

/**
 * Map a folded `ChatItem[]` transcript back to the SDK `Item[]` input format so a
 * continued conversation replays prior turns as history: assistant/user text become
 * `EasyInputMessage`s, tool calls become `function_call` items, and tool results
 * become `function_call_output` items (paired by `callId`). The agent SDK's own `Item`
 * union is documented as non-exhaustive, so the final assertion bridges the hand-built
 * (but wire-valid) items to it.
 */
export function toResponsesInput(items: ChatItem[]): Item[] {
  return items.map((item): Item => {
    if (item.kind === "message") {
      const message: EasyInputMessage = { role: item.role, content: item.text };
      return message as Item;
    }

    if (item.kind === "tool_call") {
      const call: OutputFunctionCallItem = {
        type: "function_call",
        callId: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
      return call as Item;
    }

    const result: FunctionCallOutputItem = {
      type: "function_call_output",
      callId: item.callId,
      output: item.output,
    };
    return result as Item;
  });
}

/** Pull plain text out of a streamed assistant `message` item's content parts. */
export function outputMessageText(content: ReadonlyArray<ResponseOutputText | unknown>): string {
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "output_text") {
      text += (part as ResponseOutputText).text;
    }
  }
  return text;
}
