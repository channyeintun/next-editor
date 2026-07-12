import type Anthropic from "@anthropic-ai/sdk";
import type { ChatDelta, ChatMessage, ChatStatus } from "../../../types/chat";
import { applyContentDelta } from "./frameDelta";

export interface ChatFoldState {
  messages: ChatMessage[];
  status: ChatStatus;
}

export const INITIAL_CHAT_FOLD_STATE: ChatFoldState = { messages: [], status: "idle" };

function getTrailingText(message: ChatMessage): string {
  const lastBlock = message.content[message.content.length - 1];
  return lastBlock?.type === "text" ? lastBlock.text : "";
}

function withTrailingText(message: ChatMessage, text: string): ChatMessage {
  const content = message.content.slice();
  const lastBlock = content[content.length - 1];

  if (lastBlock?.type === "text") {
    content[content.length - 1] = { type: "text", text };
  } else {
    content.push({ type: "text", text });
  }

  return { ...message, content };
}

function withAppendedBlock(message: ChatMessage, block: Anthropic.ContentBlockParam): ChatMessage {
  return { ...message, content: [...message.content, block] };
}

/**
 * Folds one `ChatDelta` into transcript state. Shared by the live agent store
 * (src/agent/agentStore.ts) and the recording replay reducer
 * (replayState/chat.ts) so "what does each delta kind do" has one definition.
 *
 * `content`/`tool_use` always target the last message in the array: the loop
 * only ever streams text into, or appends a tool_use block onto, the most
 * recently started message, and `message_start`/`tool_result` are what push a
 * new one — so no separate "active message id" bookkeeping is needed.
 */
export function applyChatDelta(state: ChatFoldState, delta: ChatDelta): ChatFoldState {
  switch (delta.k) {
    case "message_start":
      return {
        ...state,
        messages: [...state.messages, { id: delta.id, role: delta.role, content: [] }],
      };

    case "content": {
      const lastMessage = state.messages[state.messages.length - 1];
      if (!lastMessage) {
        return state;
      }
      const nextText = applyContentDelta(getTrailingText(lastMessage), delta.delta);
      return {
        ...state,
        messages: [...state.messages.slice(0, -1), withTrailingText(lastMessage, nextText)],
      };
    }

    case "tool_use": {
      const lastMessage = state.messages[state.messages.length - 1];
      if (!lastMessage) {
        return state;
      }
      const nextMessage = withAppendedBlock(lastMessage, {
        type: "tool_use",
        id: delta.toolUseId,
        name: delta.name,
        input: delta.input,
      });
      return { ...state, messages: [...state.messages.slice(0, -1), nextMessage] };
    }

    case "tool_result": {
      const resultMessage: ChatMessage = {
        id: `tool_result:${delta.toolUseId}`,
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: delta.toolUseId,
            content: delta.content,
            is_error: delta.isError,
          },
        ],
      };
      return { ...state, messages: [...state.messages, resultMessage] };
    }

    case "remove": {
      const cutIndex = state.messages.findIndex((message) => message.id === delta.fromId);
      return cutIndex === -1 ? state : { ...state, messages: state.messages.slice(0, cutIndex) };
    }

    case "message_end":
      return state;

    case "status":
      return { ...state, status: delta.status };

    default:
      return state;
  }
}
