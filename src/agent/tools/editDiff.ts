export interface EditOperation {
  oldText: string;
  newText: string;
}

export interface ApplyEditsResult {
  content: string;
  diff: string;
}

export class EditApplyError extends Error {}

function countOccurrences(source: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let searchIndex = 0;

  while (true) {
    const foundIndex = source.indexOf(needle, searchIndex);

    if (foundIndex === -1) {
      return count;
    }

    count += 1;
    searchIndex = foundIndex + needle.length;
  }
}

function truncateForMessage(text: string, maxLength = 80): string {
  const singleLine = text.replace(/\n/g, "\\n");
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}…` : singleLine;
}

function buildHunk(before: string, index: number, oldText: string, newText: string): string {
  const lineNumber = before.slice(0, index).split("\n").length;
  const removedLines = oldText.split("\n").map((line) => `-${line}`);
  const addedLines = newText.split("\n").map((line) => `+${line}`);
  return [`@@ line ${lineNumber} @@`, ...removedLines, ...addedLines].join("\n");
}

/**
 * Applies `edits` in order against LF-normalized `content`. Each `oldText` must be a
 * unique substring of the content *as of that edit* (earlier edits in the same call
 * can create or remove the uniqueness a later one depends on). The returned diff is
 * built directly from the edit operations — exact by construction, no LCS needed.
 */
export function applyEdits(content: string, edits: EditOperation[]): ApplyEditsResult {
  let next = content.replace(/\r\n/g, "\n");
  const hunks: string[] = [];

  for (const edit of edits) {
    const oldText = edit.oldText.replace(/\r\n/g, "\n");
    const newText = edit.newText.replace(/\r\n/g, "\n");
    const occurrences = countOccurrences(next, oldText);

    if (occurrences === 0) {
      throw new EditApplyError(`oldText not found in file: "${truncateForMessage(oldText)}"`);
    }

    if (occurrences > 1) {
      throw new EditApplyError(
        `oldText matches ${occurrences} locations, must be unique: "${truncateForMessage(oldText)}"`,
      );
    }

    const index = next.indexOf(oldText);
    hunks.push(buildHunk(next, index, oldText, newText));
    next = next.slice(0, index) + newText + next.slice(index + oldText.length);
  }

  return { content: next, diff: hunks.join("\n") };
}
