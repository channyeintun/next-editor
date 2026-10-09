// Adapters between the chat recording model and the @openrouter/agent SDK's
// Responses items. Only the agent loop speaks the SDK, so they live here rather
// than beside the model the recording stores (src/core/src/chat.ts).
import type {
  EasyInputMessage,
  EasyInputMessageContentInputImage,
  FunctionCallOutputItem,
  InputText,
  Item,
  OutputFunctionCallItem,
  ResponseOutputText,
} from "@openrouter/agent";
import type { ChatItem } from "../types/chat";

export function toEasyInputMessage({
  role,
  text,
  images,
}: Pick<Extract<ChatItem, { kind: "message" }>, "role" | "text" | "images">): EasyInputMessage {
  const content = images?.length
    ? [
        ...(text ? ([{ type: "input_text", text }] satisfies InputText[]) : []),
        ...images.map((image): EasyInputMessageContentInputImage => ({
          type: "input_image",
          imageUrl: image.dataUrl,
          detail: "auto",
        })),
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
export function outputMessageText(content: ReadonlyArray<unknown>): string {
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "output_text") {
      text += (part as ResponseOutputText).text;
    }
  }
  return text;
}
