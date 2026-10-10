import { whenCodeEditorLoaded } from "../components/codeEditorLoader";
import { selectIsPlaying, type EditorActorRef } from "../core/src/useNextEditor";

/**
 * When a lesson loaded from a URL may start downloading its narration: once the code
 * editor's chunk has loaded or playback starts, whichever comes first. Nothing plays the
 * narration before Play, and downloading it earlier only shares the network with Monaco,
 * whose code is what the lesson page paints largest. Also settles when `signal` aborts,
 * so a lesson that was left stops waiting (and stops watching the editor).
 */
export function whenNarrationMayDownload(
  editorActor: EditorActorRef,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || selectIsPlaying(editorActor.getSnapshot())) {
      resolve();
      return;
    }
    let open = false;
    const subscription = editorActor.subscribe((snapshot) => {
      if (selectIsPlaying(snapshot)) settle();
    });
    function settle() {
      if (open) return;
      open = true;
      subscription.unsubscribe();
      signal.removeEventListener("abort", settle);
      resolve();
    }
    signal.addEventListener("abort", settle, { once: true });
    void whenCodeEditorLoaded().then(settle);
  });
}
