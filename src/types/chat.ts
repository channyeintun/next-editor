import type {
  EasyInputMessage,
  EasyInputMessageContentInputImage,
  FunctionCallOutputItem,
  InputText,
  Item,
  OutputFunctionCallItem,
  ResponseOutputText,
} from "@openrouter/agent";

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
 * shape this used to carry. `toResponsesInput` maps a `ChatItem[]` straight back to the
 * SDK's `Item[]` so a recorded transcript can be replayed to the model as history.
 */
export type ChatItem =
  | { kind: "message"; id: string; role: ChatRole; text: string; images?: ChatImage[] }
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

export function toEasyInputMessage({
  role,
  text,
  images,
}: Pick<Extract<ChatItem, { kind: "message" }>, "role" | "text" | "images">): EasyInputMessage {
  const content = images?.length
    ? [
        ...(text ? ([{ type: "input_text", text }] satisfies InputText[]) : []),
        ...images.map(
          (image): EasyInputMessageContentInputImage => ({
            type: "input_image",
            imageUrl: image.dataUrl,
            detail: "auto",
          }),
        ),
      ]
    : text;

  return { role, content };
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
      return toEasyInputMessage(item) as Item;
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
