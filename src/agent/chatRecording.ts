import type { ChatCheckpoint, ChatDelta } from "../types/chat";
import type { AgentStoreInstance } from "./agentStore";

// Checkpoint on every run completion (status → done/error) and otherwise every
// ~200 deltas — sparse enough that checkpoint cost stays sub-dominant to the
// delta log, bounded enough that a seek never re-folds from empty on a long
// conversation.
const CHECKPOINT_DELTA_INTERVAL = 200;

export type ChatEventHandler = (
  event: ChatDelta | { k: "checkpoint"; state: ChatCheckpoint },
) => void;

export function createChatCheckpoint(agentStore: AgentStoreInstance): ChatCheckpoint {
  const context = agentStore.getSnapshot().context;
  return { items: context.items, status: context.status, draft: context.draft };
}

/**
 * Turns an agent loop's delta stream into recorded chat events. `handleChatEvent`
 * is `NextEditorActions.handleChatEvent`, which no-ops while no recording session
 * is active — so this recorder can run unconditionally; it captures only while
 * recording.
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
    handleChatEvent({
      k: "checkpoint",
      state: createChatCheckpoint(agentStore),
    });
    deltasSinceCheckpoint = 0;
  };

  return function recordChatDelta(delta: ChatDelta): void {
    handleChatEvent(delta);
    deltasSinceCheckpoint += 1;

    const runSettled =
      delta.k === "status" && (delta.status === "done" || delta.status === "error");
    if (runSettled || deltasSinceCheckpoint >= CHECKPOINT_DELTA_INTERVAL) {
      emitCheckpoint();
    }
  };
}
