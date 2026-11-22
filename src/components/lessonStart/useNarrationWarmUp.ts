import { useEffect } from "react";
import { warmNarration } from "../../core/src/machine/audioActor";
import { prefersSavingData } from "../../utils/saveData";
import { whenCodeEditorLoaded } from "../codeEditorLoader";
import type { NarrationPlayer } from "./useNarrationLoad";

/**
 * Has the lesson's narration load its start ahead of Play, so that Play has sound at
 * once. It waits for the code editor's chunk, so the narration never competes with it
 * for a slow connection, and a viewer who asked the browser to save data gets nothing
 * loaded ahead: their narration loads when they play it, as before.
 *
 * Returns whether warming up is wanted at all, which is known before the lesson (and so
 * its player) is there.
 */
export function useNarrationWarmUp(player: NarrationPlayer | undefined): boolean {
  const wanted = !prefersSavingData();

  useEffect(() => {
    if (!player || !wanted) return;
    let cancelled = false;
    void whenCodeEditorLoaded().then(() => {
      if (!cancelled) warmNarration(player);
    });
    return () => {
      cancelled = true;
    };
  }, [player, wanted]);

  return wanted;
}
