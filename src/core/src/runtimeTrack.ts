import type {
  RuntimeRecordingDelta,
  RuntimeRecordingEvent,
  RuntimeRecordingSnapshot,
  RuntimeTerminalOutputDelta,
  RuntimeTerminalSessionSnapshot,
} from "../../types/runtime";

// ============================================================================
// Runtime track: terminal output recorded as deltas.
//
// The runtime dock fires one event per stdout chunk while a command streams,
// and a snapshot holds every terminal session's whole output (a rolling window
// of up to TERMINAL_OUTPUT_LIMIT characters). Storing that window on every
// chunk made the track O(chunks × window) in memory and on disk — an
// `npm install` re-wrote the same ~50 KB hundreds of times, and a 50 KB repeat
// is past deflate's 32 KB window, so compression could not claw it back.
//
// So an event stores a full snapshot only as a checkpoint (the first event,
// then sparse seek anchors — see createRuntimeRecordingEvent), and otherwise a delta whose
// terminal output is "drop N characters from the front, append this". Every
// other field is small and stays whole. Checkpoints exist only as seek anchors:
// the delta log alone reconstructs every state.
// ============================================================================

/** Most delta events between checkpoints; bounds the fold a seek pays for. */
export const RUNTIME_CHECKPOINT_MAX_EVENTS = 256;

/**
 * Longest suffix of `previous` that is also a prefix of `next` (KMP over
 * `next`'s prefix function, then a single pass over `previous`): O(|previous| +
 * |next|), so it is safe to run once per stdout chunk on a 50 KB window.
 */
function longestSuffixPrefixOverlap(previous: string, next: string): number {
  const patternLength = Math.min(previous.length, next.length);
  if (patternLength === 0) return 0;

  const failure = new Int32Array(patternLength);
  for (let index = 1, matched = 0; index < patternLength; index++) {
    while (matched > 0 && next.charCodeAt(index) !== next.charCodeAt(matched)) {
      matched = failure[matched - 1];
    }
    if (next.charCodeAt(index) === next.charCodeAt(matched)) matched++;
    failure[index] = matched;
  }

  let matched = 0;
  for (let index = previous.length - patternLength; index < previous.length; index++) {
    while (matched > 0 && previous.charCodeAt(index) !== next.charCodeAt(matched)) {
      matched = failure[matched - 1];
    }
    if (previous.charCodeAt(index) === next.charCodeAt(matched)) matched++;
    if (matched === patternLength && index < previous.length - 1) {
      matched = failure[matched - 1];
    }
  }
  return matched;
}

/**
 * The delta that turns `previous` into `next`. Always exact — any overlap
 * reproduces `next` — and the longest one keeps `append` minimal: a pure append
 * is `{ drop: 0 }`, a window that scrolled drops what fell off the front, and
 * unrelated text (a cleared terminal) drops everything.
 */
export function diffTerminalOutput(previous: string, next: string): RuntimeTerminalOutputDelta {
  if (next.startsWith(previous)) {
    return { drop: 0, append: next.slice(previous.length) };
  }
  const overlap = longestSuffixPrefixOverlap(previous, next);
  return { drop: previous.length - overlap, append: next.slice(overlap) };
}

export function applyTerminalOutputDelta(
  previous: string,
  delta: RuntimeTerminalOutputDelta,
): string {
  if (delta.drop === 0) return previous + delta.append;
  return previous.slice(delta.drop) + delta.append;
}

function outputsById(sessions: RuntimeTerminalSessionSnapshot[] | undefined): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const session of sessions ?? []) outputs.set(session.id, session.output);
  return outputs;
}

export function diffRuntimeSnapshot(
  previous: RuntimeRecordingSnapshot,
  next: RuntimeRecordingSnapshot,
): RuntimeRecordingDelta {
  const { terminalSessions, ...rest } = next;
  if (!terminalSessions) return rest;
  const previousOutputs = outputsById(previous.terminalSessions);
  return {
    ...rest,
    terminalSessions: terminalSessions.map((session) => ({
      id: session.id,
      title: session.title,
      output: diffTerminalOutput(previousOutputs.get(session.id) ?? "", session.output),
    })),
  };
}

export function applyRuntimeDelta(
  previous: RuntimeRecordingSnapshot,
  delta: RuntimeRecordingDelta,
): RuntimeRecordingSnapshot {
  const { terminalSessions, ...rest } = delta;
  if (!terminalSessions) return rest;
  const previousOutputs = outputsById(previous.terminalSessions);
  return {
    ...rest,
    terminalSessions: terminalSessions.map((session) => ({
      id: session.id,
      title: session.title,
      output: applyTerminalOutputDelta(previousOutputs.get(session.id) ?? "", session.output),
    })),
  };
}

function totalOutputLength(sessions: ReadonlyArray<{ output: string }> | undefined): number {
  let length = 0;
  for (const session of sessions ?? []) length += session.output.length;
  return length;
}

function totalAppendLength(delta: RuntimeRecordingDelta): number {
  let length = 0;
  for (const session of delta.terminalSessions ?? []) length += session.output.append.length;
  return length;
}

/** What the recorder carries between runtime events to place checkpoints. */
export interface RuntimeCheckpointProgress {
  /** Delta events written since the last checkpoint. */
  events: number;
  /** Terminal text those deltas appended. */
  appendedChars: number;
}

export const RUNTIME_CHECKPOINT_RESET: RuntimeCheckpointProgress = { events: 0, appendedChars: 0 };

/**
 * The event to record for `next`, given the resolved state of the previous
 * event. A checkpoint is written once the deltas since the last one have
 * appended as much text as a full snapshot holds — so checkpoints cost at most
 * as much as the deltas they follow, and the track stays O(total output) — or
 * after RUNTIME_CHECKPOINT_MAX_EVENTS deltas, which bounds a seek's fold when
 * the deltas are tiny (a spinner redrawing one character).
 */
export function createRuntimeRecordingEvent(
  timestamp: number,
  previous: RuntimeRecordingSnapshot | null,
  next: RuntimeRecordingSnapshot,
  progress: RuntimeCheckpointProgress,
): { event: RuntimeRecordingEvent; progress: RuntimeCheckpointProgress } {
  if (!previous || progress.events + 1 >= RUNTIME_CHECKPOINT_MAX_EVENTS) {
    return { event: { timestamp, snapshot: next }, progress: RUNTIME_CHECKPOINT_RESET };
  }
  const delta = diffRuntimeSnapshot(previous, next);
  const appendedChars = progress.appendedChars + totalAppendLength(delta);
  if (appendedChars >= totalOutputLength(next.terminalSessions)) {
    return { event: { timestamp, snapshot: next }, progress: RUNTIME_CHECKPOINT_RESET };
  }
  return { event: { timestamp, delta }, progress: { events: progress.events + 1, appendedChars } };
}

interface RuntimeResolverCache {
  index: number;
  snapshot: RuntimeRecordingSnapshot;
}

const runtimeResolverCache = new WeakMap<RuntimeRecordingEvent[], RuntimeResolverCache>();

const EMPTY_RUNTIME_SNAPSHOT: RuntimeRecordingSnapshot = { mode: "single-file", status: "idle" };

/**
 * Resolves the runtime state at `index`. Folds forward from the last resolved
 * index when playback moves ahead (the common case: one event per tick), and
 * otherwise from the nearest checkpoint at or before `index`. The cache is per
 * events array, which only ever grows in place (streamed playback appends), so
 * a cached state stays valid.
 *
 * A delta with no state before it — a track whose first event is not a
 * checkpoint, which no writer produces — resolves against an empty state rather
 * than throwing, so a damaged file degrades to missing terminal text.
 */
export function resolveRuntimeSnapshotAt(
  events: RuntimeRecordingEvent[],
  index: number,
): RuntimeRecordingSnapshot | null {
  if (index < 0 || index >= events.length) return null;

  const target = events[index];
  if (target.snapshot) {
    runtimeResolverCache.set(events, { index, snapshot: target.snapshot });
    return target.snapshot;
  }

  const cached = runtimeResolverCache.get(events);
  let startIndex: number;
  let snapshot: RuntimeRecordingSnapshot;

  if (cached && cached.index <= index) {
    startIndex = cached.index + 1;
    snapshot = cached.snapshot;
  } else {
    let checkpointIndex = index;
    while (checkpointIndex >= 0 && !events[checkpointIndex].snapshot) checkpointIndex--;
    if (checkpointIndex < 0) {
      startIndex = 0;
      snapshot = EMPTY_RUNTIME_SNAPSHOT;
    } else {
      startIndex = checkpointIndex + 1;
      snapshot = events[checkpointIndex].snapshot!;
    }
  }

  for (let cursor = startIndex; cursor <= index; cursor++) {
    const event = events[cursor];
    snapshot = event.snapshot ?? applyRuntimeDelta(snapshot, event.delta!);
  }

  runtimeResolverCache.set(events, { index, snapshot });
  return snapshot;
}

/** The runtime state after the last event, or null for an empty track. */
export function resolveLatestRuntimeSnapshot(
  events: RuntimeRecordingEvent[] | undefined,
): RuntimeRecordingSnapshot | null {
  return events?.length ? resolveRuntimeSnapshotAt(events, events.length - 1) : null;
}
