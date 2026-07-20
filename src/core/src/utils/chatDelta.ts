import type { ChatDelta, ChatItem, ChatStatus } from "../../../types/chat";
import { applyContentDelta } from "./frameDelta";

export interface ChatFoldState {
  items: ChatItem[];
  status: ChatStatus;
  draft: string;
}

export const INITIAL_CHAT_FOLD_STATE: ChatFoldState = { items: [], status: "idle", draft: "" };

/** Index of the active message item: the last `message` in the list, or -1. */
function lastMessageIndex(items: ChatItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === "message") {
      return index;
    }
  }
  return -1;
}

/**
 * Folds one `ChatDelta` into transcript state. Shared by the live agent store
 * (src/agent/agentStore.ts) and the recording replay reducer
 * (replayState/chat.ts) so "what does each delta kind do" has one definition.
 *
 * `content` always targets the active message — the last `message` item in the
 * list. Tool-call/tool-result items appended after it never intercept text,
 * because they are not messages; the next `message_start` is what moves the
 * active message forward.
 */
export function applyChatDelta(state: ChatFoldState, delta: ChatDelta): ChatFoldState {
  switch (delta.k) {
    case "reset":
      return INITIAL_CHAT_FOLD_STATE;

    case "draft":
      return delta.text === state.draft ? state : { ...state, draft: delta.text };

    case "message_start":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "message",
            id: delta.id,
            role: delta.role,
            text: "",
            ...(delta.images?.length ? { images: delta.images } : {}),
          },
        ],
      };

    case "content": {
      const index = lastMessageIndex(state.items);
      if (index === -1) {
        return state;
      }
      const message = state.items[index];
      if (message.kind !== "message") {
        return state;
      }
      const nextText = applyContentDelta(message.text, delta.delta);
      const items = state.items.slice();
      items[index] = { ...message, text: nextText };
      return { ...state, items };
    }

    case "tool_call":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool_call",
            id: delta.id,
            callId: delta.callId,
            name: delta.name,
            arguments: delta.arguments,
          },
        ],
      };

    case "tool_result":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool_result",
            id: `out:${delta.callId}`,
            callId: delta.callId,
            output: delta.output,
            isError: delta.isError,
          },
        ],
      };

    case "remove": {
      const cutIndex = state.items.findIndex((item) => item.id === delta.fromId);
      return cutIndex === -1 ? state : { ...state, items: state.items.slice(0, cutIndex) };
    }

    case "status":
      return { ...state, status: delta.status };

    default:
      return state;
  }
}
