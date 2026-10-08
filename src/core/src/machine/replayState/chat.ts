import {
  CHAT_CHECKPOINT_DELTA_INTERVAL,
  type ChatCheckpoint,
  type ChatRecordingEvent,
} from "../../../../types/chat";
import { applyChatDelta, INITIAL_CHAT_FOLD_STATE, type ChatFoldState } from "../../utils/chatDelta";
import { findTimedEventIndexAtOrBefore } from "./cursor";

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
//
// A fold that would apply far more item-list deltas than the recorder ever writes
// between checkpoints throws instead (`MAX_ITEM_LIST_DELTAS_PER_FOLD`): the apply
// action reports it and stops the chat track, rather than a crafted track with no
// checkpoints freezing the tab.
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

/**
 * Whether folding an event of each kind copies the item list (see `applyChatDelta`),
 * which costs O(items). Exhaustive, so a new delta kind has to be classified here.
 */
const REBUILDS_ITEM_LIST: Record<ChatRecordingEvent["event"]["k"], boolean> = {
  message_start: true,
  content: true,
  tool_call: true,
  tool_result: true,
  remove: true,
  reset: false,
  draft: false,
  status: false,
  checkpoint: false,
};

/**
 * The agent recorder checkpoints at least every `CHAT_CHECKPOINT_DELTA_INTERVAL` of
 * its deltas, so a longer run of item-list deltas is a damaged or hostile track. Each
 * one copies the item list, so an unbounded run is O(deltas × items) on the main
 * thread. Prompt drafts do not count: the agent panel records them per keystroke
 * outside the recorder's count, so a long typed prompt is a legit run with no
 * checkpoint, and each folds in O(1).
 */
const MAX_ITEM_LIST_DELTAS_PER_FOLD = CHAT_CHECKPOINT_DELTA_INTERVAL * 10;

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
  // Where the fold may start: just after the last fold when moving forward,
  // otherwise the start of the track, since deltas are not invertible.
  const cached = chatFoldCache.get(chatEvents);
  const resumed = cached && cached.index <= targetIndex ? cached : null;
  const floor = resumed ? resumed.index : -1;
  let state = resumed ? resumed.state : INITIAL_CHAT_FOLD_STATE;
  let foldStart = floor + 1;

  // A checkpoint above the floor is a better start, so no delta before it is
  // applied only to be thrown away. A playback tick advances one event, so this
  // usually scans one event.
  for (let index = targetIndex; index > floor; index -= 1) {
    const event = chatEvents[index].event;
    if (isCheckpointEvent(event)) {
      state = checkpointFoldState(event.state);
      foldStart = index + 1;
      break;
    }
  }

  let itemListDeltas = 0;
  for (let index = foldStart; index <= targetIndex; index += 1) {
    const event = chatEvents[index].event;
    if (REBUILDS_ITEM_LIST[event.k]) {
      itemListDeltas += 1;
      if (itemListDeltas > MAX_ITEM_LIST_DELTAS_PER_FOLD) {
        throw new Error(
          "The recorded agent chat has too many changes between checkpoints to replay",
        );
      }
    }
    // Only deltas follow the scan's start; the checkpoint case narrows the event type.
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
  const nextIndex = findTimedEventIndexAtOrBefore(chatEvents, currentTime, lastAppliedIndex);

  // Before the first chat event the transcript is empty. Applying nothing there left
  // a later transcript on screen after a backward seek, STOP or restart. A tick applies
  // the baseline only when it rewinds the cursor past that event, so ticks that have
  // not reached it yet never rewrite the store.
  if (nextIndex < 0 && (isResync || lastAppliedIndex >= 0)) {
    return { nextIndex: -1, snapshotToApply: EMPTY_CHAT_CHECKPOINT };
  }

  if (nextIndex < 0 || nextIndex === lastAppliedIndex) {
    return { nextIndex };
  }

  const folded = foldChatEventsUpTo(chatEvents, nextIndex);

  return {
    nextIndex,
    snapshotToApply: { items: folded.items, status: folded.status, draft: folded.draft },
  };
}
