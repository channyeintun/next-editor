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

/**
 * Validate and order an edit event without materializing the current text.
 * Monaco ranges are relative to the pre-edit model, so applying from the end
 * of the document toward the start preserves every offset. For equal-offset
 * insertions, reverse application preserves Monaco's original text order.
 */
export function prepareTextEditEvent(
  event: TextEditEvent,
  actualBeforeLength: number,
): PreparedTextEditEvent | null {
  if (
    event.fileId.length === 0 ||
    event.path.length === 0 ||
    !isNonNegativeInteger(event.beforeVersion) ||
    !isNonNegativeInteger(event.afterVersion) ||
    event.afterVersion <= event.beforeVersion ||
    !isNonNegativeInteger(event.beforeLength) ||
    !isNonNegativeInteger(event.afterLength) ||
    event.beforeLength !== actualBeforeLength ||
    event.changes.length === 0
  ) {
    return null;
  }

  let lengthDelta = 0;
  const indexedChanges = event.changes.map((change, index) => ({ change, index }));

  for (const { change } of indexedChanges) {
    if (
      !isNonNegativeInteger(change.offset) ||
      !isNonNegativeInteger(change.deleteLength) ||
      change.offset + change.deleteLength > actualBeforeLength
    ) {
      return null;
    }
    lengthDelta += change.text.length - change.deleteLength;
    if (!Number.isSafeInteger(lengthDelta)) return null;
  }

  if (actualBeforeLength + lengthDelta !== event.afterLength) return null;

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
  const prepared = prepareTextEditEvent(event, content.length);
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
