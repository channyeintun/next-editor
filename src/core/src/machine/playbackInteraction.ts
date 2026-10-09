import { useEffect } from "react";
import type * as monaco from "monaco-editor";
import { useSelector } from "@xstate/react";
import { selectIsPlaying, type EditorActorRef, type EditorMachineSnapshot } from "../useNextEditor";
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
          // Ignore navigation/modifier keys to only pause on potential value changes
          if (!IGNORED_PLAYBACK_INPUT_KEYS.has(e.browserEvent.key)) {
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
