export interface TextEditChange {
  offset: number;
  deleteLength: number;
  text: string;
}

/**
 * The shared representation of an ordinary Monaco content change.
 *
 * Offsets and lengths are UTF-16 code units, matching both Monaco and
 * JavaScript string slicing. Lengths make stale events rejectable without
 * reading or comparing the whole editor model.
 */
export interface TextEditEvent {
  fileId: string;
  path: string;
  beforeVersion: number;
  afterVersion: number;
  beforeLength: number;
  afterLength: number;
  changes: readonly TextEditChange[];
}

export interface PreparedTextEditEvent {
  /** Changes ordered so they can be applied without rebasing later offsets. */
  changes: readonly TextEditChange[];
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The event-level checks: a file identity, advancing versions, and a fresh length. */
function hasValidEventIdentity(event: TextEditEvent, actualBeforeLength: number): boolean {
  return (
    event.fileId.length !== 0 &&
    event.path.length !== 0 &&
    isNonNegativeInteger(event.beforeVersion) &&
    isNonNegativeInteger(event.afterVersion) &&
    event.afterVersion > event.beforeVersion &&
    isNonNegativeInteger(event.beforeLength) &&
    event.beforeLength === actualBeforeLength
  );
}

/**
 * Validate and order an edit event without materializing the current text:
 * its identity, versions and length against the model, then its changes (see
 * {@link prepareTextEditChanges}).
 */
export function prepareTextEditEvent(
  event: TextEditEvent,
  actualBeforeLength: number,
): PreparedTextEditEvent | null {
  if (!hasValidEventIdentity(event, actualBeforeLength)) return null;
  return prepareTextEditChanges(event.changes, actualBeforeLength, event.afterLength);
}

/**
 * Validate and order a batch of changes against a text of `beforeLength` code
 * units that they must turn into one of `afterLength`, with no event identity
 * (recording replay has none). Monaco ranges are relative to the pre-edit
 * model, so applying from the end of the document toward the start preserves
 * every offset. For equal-offset insertions, reverse application preserves
 * Monaco's original text order.
 */
export function prepareTextEditChanges(
  changes: readonly TextEditChange[],
  beforeLength: number,
  afterLength: number,
): PreparedTextEditEvent | null {
  if (!isNonNegativeInteger(afterLength) || changes.length === 0) return null;

  let lengthDelta = 0;
  const indexedChanges = changes.map((change, index) => ({ change, index }));

  for (const { change } of indexedChanges) {
    if (
      !isNonNegativeInteger(change.offset) ||
      !isNonNegativeInteger(change.deleteLength) ||
      change.offset + change.deleteLength > beforeLength
    ) {
      return null;
    }
    lengthDelta += change.text.length - change.deleteLength;
    if (!Number.isSafeInteger(lengthDelta)) return null;
  }

  if (beforeLength + lengthDelta !== afterLength) return null;

  const ascendingChanges = indexedChanges.toSorted(
    (left, right) => left.change.offset - right.change.offset || left.index - right.index,
  );
  let consumedUntil = 0;
  let previousOffset = -1;
  let previousOffsetHasDeletion = false;

  for (const { change } of ascendingChanges) {
    if (change.offset < consumedUntil) return null;
    if (
      change.offset === previousOffset &&
      (change.deleteLength > 0 || previousOffsetHasDeletion)
    ) {
      return null;
    }
    if (change.offset !== previousOffset) previousOffsetHasDeletion = false;
    if (change.deleteLength > 0) {
      consumedUntil = change.offset + change.deleteLength;
      previousOffsetHasDeletion = true;
    }
    previousOffset = change.offset;
  }

  return {
    changes: indexedChanges
      .toSorted(
        (left, right) => right.change.offset - left.change.offset || right.index - left.index,
      )
      .map(({ change }) => change),
  };
}

export function applyTextEditEvent(content: string, event: TextEditEvent): string | null {
  if (!hasValidEventIdentity(event, content.length)) return null;
  return applyTextEditChanges(content, event.changes, event.afterLength);
}

/**
 * Applies a bare change batch (see {@link prepareTextEditChanges}) to
 * `content`, or returns null when the batch is invalid for it.
 */
export function applyTextEditChanges(
  content: string,
  changes: readonly TextEditChange[],
  afterLength: number,
): string | null {
  const prepared = prepareTextEditChanges(changes, content.length, afterLength);
  if (!prepared) return null;

  let nextContent = content;
  for (const change of prepared.changes) {
    nextContent =
      nextContent.slice(0, change.offset) +
      change.text +
      nextContent.slice(change.offset + change.deleteLength);
  }
  return nextContent;
}
