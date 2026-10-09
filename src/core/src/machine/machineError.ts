import type { EditorMachineContext } from "./types";

// ============================================================================
// Reporting a machine failure
//
// Both sides of the machine report through this leaf: capture-side failures
// (notifyError in editorMachine.ts) and records the replay skips (replayActions.ts,
// frameReplay.ts).
// ============================================================================

/**
 * Hand a machine failure to the host's `onError`, or to the console when the host supplies none
 * (the app's own provider does not). Without the fallback a denied microphone, a failed load or
 * a damaged frame skipped during replay left no trace at all. Pass the Error itself so the stack
 * and class (ContentEditBaseMismatchError, DmpBaseMismatchError) survive into the log.
 */
export const reportMachineError = (
  context: Pick<EditorMachineContext, "onError">,
  error: Error,
): void => {
  if (context.onError) {
    context.onError(error);
    return;
  }
  console.error("[editorMachine]", error);
};
