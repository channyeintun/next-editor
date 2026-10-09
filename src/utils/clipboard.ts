/**
 * Copies `text` to the clipboard and resolves whether it did. It writes through
 * the async Clipboard API; where that API is missing, or refuses the write (an
 * unfocused document, or a cross-origin embed without clipboard-write), it falls
 * back to selecting an off-screen textarea and running the copy command.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused: try the copy command below before reporting a failure.
    }
  }

  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  // Selecting the textarea focuses it, and removing it would then drop focus to
  // the page, so focus goes back to whatever held it.
  const previousFocus = document.activeElement;
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    if (previousFocus instanceof HTMLElement && document.activeElement !== previousFocus) {
      previousFocus.focus({ preventScroll: true });
    }
  }
}
