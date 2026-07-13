import type { ChatCheckpoint, ChatRecordingEvent } from "../../../../types/chat";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
import { advanceReplayCursor } from "./cursor";

// ============================================================================
// Chat track replay.
//
// Unlike the other tracks (which carry a full snapshot per event and just grab
// "the latest one"), the chat track is a delta log with sparse checkpoints
// (plan §9.2). Replay therefore *folds*: restore the nearest checkpoint at or
// before the target event, then apply every delta from there forward. Seeking
// backward re-folds from the preceding checkpoint instead of incrementally
// undoing deltas.
// ============================================================================

export interface ChatReplayResult {
  nextIndex: number;
  snapshotToApply?: ChatCheckpoint;
}

function isCheckpointEvent(
  event: ChatRecordingEvent["event"],
): event is { k: "checkpoint"; state: ChatCheckpoint } {
  return event.k === "checkpoint";
}

function foldChatEventsUpTo(chatEvents: ChatRecordingEvent[], targetIndex: number): ChatFoldState {
  let checkpointIndex = -1;

  for (let index = targetIndex; index >= 0; index -= 1) {
    if (isCheckpointEvent(chatEvents[index].event)) {
      checkpointIndex = index;
      break;
    }
  }

  let state = INITIAL_CHAT_FOLD_STATE;
  let foldStart = 0;

  if (checkpointIndex >= 0) {
    const checkpointEvent = chatEvents[checkpointIndex].event;
    if (isCheckpointEvent(checkpointEvent)) {
      state = { items: checkpointEvent.state.items, status: checkpointEvent.state.status };
      foldStart = checkpointIndex + 1;
    }
  }

  for (let index = foldStart; index <= targetIndex; index += 1) {
    const event = chatEvents[index].event;
    if (!isCheckpointEvent(event)) {
      state = applyChatDelta(state, event);
    }
  }

  return state;
}

export function getChatReplayResult({
  chatEvents,
  currentTime,
  lastAppliedIndex,
}: {
  chatEvents: ChatRecordingEvent[];
  currentTime: number;
  lastAppliedIndex: number;
}): ChatReplayResult {
  const replayCursor = advanceReplayCursor({
    events: chatEvents,
    currentTime,
    lastAppliedIndex,
  });

  if (!replayCursor.latestEvent || replayCursor.nextIndex === lastAppliedIndex) {
    return { nextIndex: replayCursor.nextIndex };
  }

  const folded = foldChatEventsUpTo(chatEvents, replayCursor.nextIndex);

  return {
    nextIndex: replayCursor.nextIndex,
    snapshotToApply: { items: folded.items, status: folded.status },
  };
}
