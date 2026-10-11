import { useEffect } from "react";
import type * as monaco from "monaco-editor";
import { useSelector } from "@xstate/react";
import { selectIsPlaying, type EditorActorRef, type EditorMachineSnapshot } from "../useNextEditor";
import { isLetterKey } from "../utils/letterKey";
import { isPressableTarget, isTypingTarget } from "../utils/playerKeyTargets";

// ============================================================================
// Pausing playback when the learner takes over: typing or pasting in the editor,
// or pressing Space, sends USER_INTERACTION, which pauses a playing lesson (when
// pauseOnUserInteraction allows it).
// ============================================================================

const IGNORED_PLAYBACK_INPUT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

/**
 * Copy, select all, and find next or previous: Cmd/Ctrl chords that leave the text as
 * it is. Many other chords change it (Cmd+/, Cmd+], Cmd+Backspace), so the chords that
 * keep playing are listed rather than the ones that pause.
 */
const NON_MUTATING_CHORD_LETTERS = ["c", "a", "f", "g"];

/**
 * Whether a key pressed in the editor may change the text, so it pauses a playing
 * lesson. Navigation and modifier keys, and the chords above, do not. With Alt held the
 * chord is not a command: Ctrl+Alt is AltGr on Windows, which types a character.
 */
export function shouldPauseOnEditorKey(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">,
): boolean {
  if (IGNORED_PLAYBACK_INPUT_KEYS.has(event.key)) return false;
  const isCommandChord = (event.ctrlKey || event.metaKey) && !event.altKey;
  return !(
    isCommandChord && NON_MUTATING_CHORD_LETTERS.some((letter) => isLetterKey(event, letter))
  );
}

const selectEditor = (state: EditorMachineSnapshot) => state.context.editorRefs.editor;

/** Pauses playback on editor input or the Space key while a lesson plays. */
export const usePlaybackInteractionPause = (actorRef: EditorActorRef): void => {
  const isPlaying = useSelector(actorRef, selectIsPlaying);
  const editor = useSelector(actorRef, selectEditor);

  // Handle playback interaction detection via direct input listeners
  // This is more stable than onChange for preventing machine/user feedback loops
  useEffect(() => {
    if (isPlaying && editor) {
      const disposables: monaco.IDisposable[] = [];

      // Listen for user keyboard input during replay
      disposables.push(
        editor.onKeyDown((e) => {
          // Pause only on keys that may change the text
          if (shouldPauseOnEditorKey(e.browserEvent)) {
            actorRef.send({ type: "USER_INTERACTION" });
          }
        }),
      );

      // Listen for paste events
      disposables.push(
        editor.onDidPaste(() => {
          actorRef.send({ type: "USER_INTERACTION" });
        }),
      );

      return () => {
        disposables.forEach((d) => d.dispose());
      };
    }
  }, [isPlaying, editor, actorRef]);

  // Global space key listener to pause playback
  useEffect(() => {
    if (isPlaying) {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (!(e.code === "Space" || e.key === " ")) return;
        // Typed into a field, the editor, the terminal or the whiteboard, Space pauses and
        // still types, like every other key there.
        if (isTypingTarget(e.target)) {
          actorRef.send({ type: "USER_INTERACTION" });
          return;
        }
        // On a button, a link, a tab or a summary the press is the control's, as when paused.
        if (isPressableTarget(e.target)) return;
        // Anywhere else Space pauses, and the page does not scroll.
        e.preventDefault();
        actorRef.send({ type: "USER_INTERACTION" }); // This triggers PAUSE in the machine
      };

      window.addEventListener("keydown", handleGlobalKeyDown, true); // Use capture phase to catch it early
      return () => {
        window.removeEventListener("keydown", handleGlobalKeyDown, true);
      };
    }
  }, [isPlaying, actorRef]);
};
