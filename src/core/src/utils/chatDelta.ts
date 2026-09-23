import type { ChatDelta, ChatItem, ChatStatus } from "../../../types/chat";
import { applyContentDelta } from "./frameDelta";

export interface ChatFoldState {
  items: ChatItem[];
  status: ChatStatus;
  draft: string;
}

export const INITIAL_CHAT_FOLD_STATE: ChatFoldState = { items: [], status: "idle", draft: "" };

type ChatMessageItem = Extract<ChatItem, { kind: "message" }>;

/** The active message item (the last `message` in the list) and its index, or null. */
function findActiveMessage(items: ChatItem[]): { index: number; message: ChatMessageItem } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message") {
      return { index, message: item };
    }
  }
  return null;
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
      const active = findActiveMessage(state.items);
      if (!active) {
        return state;
      }
      const items = state.items.slice();
      items[active.index] = {
        ...active.message,
        text: applyContentDelta(active.message.text, delta.delta),
      };
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
