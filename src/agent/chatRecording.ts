import type { ChatCheckpoint, ChatDelta } from "../types/chat";
import type { AgentStoreInstance } from "./agentStore";

// Every message_end, and otherwise every ~200 deltas (plan §13) — sparse enough
// that checkpoint cost stays sub-dominant to the delta log, bounded enough that
// a seek never re-folds from empty on a long-running conversation.
const CHECKPOINT_DELTA_INTERVAL = 200;

export type ChatEventHandler = (
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint },
) => void;

/**
 * Turns an agent loop's delta stream into recorded chat events. `handleChatEvent`
 * is `NextEditorActions.handleChatEvent`, which no-ops while no recording session
 * is active (`captureChatEvent` → `appendToSession` in captureActions.ts) — so
 * this recorder can run unconditionally; it captures only while recording, per
 * plan §9.2.
 *
 * Callers must apply each delta to `agentStore` (`trigger.applyDelta`) *before*
 * calling the returned function, since a checkpoint is folded from the store's
 * current snapshot.
 */
export function createChatRecorder(
  agentStore: AgentStoreInstance,
  handleChatEvent: ChatEventHandler,
): (delta: ChatDelta) => void {
  let deltasSinceCheckpoint = 0;

  const emitCheckpoint = () => {
    const context = agentStore.getSnapshot().context;
    handleChatEvent({
      k: "checkpoint",
      state: { messages: context.messages, status: context.status },
    });
    deltasSinceCheckpoint = 0;
  };

  return function recordChatDelta(delta: ChatDelta): void {
    handleChatEvent(delta);
    deltasSinceCheckpoint += 1;

    if (delta.k === "message_end" || deltasSinceCheckpoint >= CHECKPOINT_DELTA_INTERVAL) {
      emitCheckpoint();
    }
  };
}
