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
//
// Forward playback is the common case and does not pay for that: the last fold
// is retained per `chatEvents` array, so advancing one event applies one delta.
// Without it every advancing tick re-folded from the preceding checkpoint — up
// to 200 deltas (the recorder's checkpoint interval), each `content` delta being
// a wasm dmp apply against the growing message text.
// ============================================================================

export interface ChatReplayResult {
  nextIndex: number;
  snapshotToApply?: ChatCheckpoint;
}

interface ChatFoldCache {
  /** The index `state` is folded through. */
  index: number;
  state: ChatFoldState;
}

/**
 * Keyed on the events array, which streaming playback appends to in place — safe
 * because the cached index always refers to an already-decoded prefix, and records
 * behind it never change.
 */
const chatFoldCache = new WeakMap<ChatRecordingEvent[], ChatFoldCache>();

/** The transcript before the first chat event: the baseline `setRecording` applies at load. */
const EMPTY_CHAT_CHECKPOINT: ChatCheckpoint = { items: [], status: "idle" };

function isCheckpointEvent(
  event: ChatRecordingEvent["event"],
): event is { k: "checkpoint"; state: ChatCheckpoint } {
  return event.k === "checkpoint";
}

function checkpointFoldState(checkpoint: ChatCheckpoint): ChatFoldState {
  return {
    items: checkpoint.items,
    status: checkpoint.status,
    draft: checkpoint.draft ?? "",
  };
}

function foldChatEventsUpTo(chatEvents: ChatRecordingEvent[], targetIndex: number): ChatFoldState {
  const cached = chatFoldCache.get(chatEvents);
  let state: ChatFoldState;
  let foldStart: number;

  if (cached && cached.index <= targetIndex) {
    // Advancing: continue from where the last fold stopped.
    state = cached.state;
    foldStart = cached.index + 1;
  } else {
    // First fold, or a backward seek — deltas are not invertible, so restart from
    // the nearest checkpoint at or before the target.
    let checkpointIndex = -1;
    for (let index = targetIndex; index >= 0; index -= 1) {
      if (isCheckpointEvent(chatEvents[index].event)) {
        checkpointIndex = index;
        break;
      }
    }

    state = INITIAL_CHAT_FOLD_STATE;
    foldStart = 0;

    if (checkpointIndex >= 0) {
      const checkpointEvent = chatEvents[checkpointIndex].event;
      if (isCheckpointEvent(checkpointEvent)) {
        state = checkpointFoldState(checkpointEvent.state);
        foldStart = checkpointIndex + 1;
      }
    }
  }

  for (let index = foldStart; index <= targetIndex; index += 1) {
    const event = chatEvents[index].event;
    // A checkpoint *is* the folded state at that point, so adopting it is exactly
    // equivalent to having replayed everything before it. The restart branch above
    // can never see one in its range; the incremental branch can.
    state = isCheckpointEvent(event)
      ? checkpointFoldState(event.state)
      : applyChatDelta(state, event);
  }

  chatFoldCache.set(chatEvents, { index: targetIndex, state });
  return state;
}

export function getChatReplayResult({
  chatEvents,
  currentTime,
  lastAppliedIndex,
  isResync = false,
}: {
  chatEvents: ChatRecordingEvent[];
  currentTime: number;
  lastAppliedIndex: number;
  /** See `isReplayResync`: the apply re-asserts the transcript at `currentTime`. */
  isResync?: boolean;
}): ChatReplayResult {
  const replayCursor = advanceReplayCursor({
    events: chatEvents,
    currentTime,
    lastAppliedIndex,
  });

  // Before the first chat event the transcript is empty. Applying nothing there left
  // a later transcript on screen after a backward seek, STOP or restart. A tick applies
  // the baseline only when it rewinds the cursor past that event, so ticks that have
  // not reached it yet never rewrite the store.
  if (replayCursor.nextIndex < 0 && (isResync || lastAppliedIndex >= 0)) {
    return { nextIndex: -1, snapshotToApply: EMPTY_CHAT_CHECKPOINT };
  }

  if (!replayCursor.latestEvent || replayCursor.nextIndex === lastAppliedIndex) {
    return { nextIndex: replayCursor.nextIndex };
  }

  const folded = foldChatEventsUpTo(chatEvents, replayCursor.nextIndex);

  return {
    nextIndex: replayCursor.nextIndex,
    snapshotToApply: { items: folded.items, status: folded.status, draft: folded.draft },
  };
}
