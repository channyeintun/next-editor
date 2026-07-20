import type { ExtractedNarration } from "./markers";

/**
 * Dialog segmentation: narration splits at every `[[mark:…]]` and scene
 * boundary into independently synthesized spans. Because splits happen exactly
 * at the anchors, every marker lands on a dialog start whose time is known
 * precisely once the dialog is scheduled — no word-level alignment needed for
 * action timing (word timings inside a dialog remain estimated, bounded by
 * that dialog's few seconds).
 */

export interface NarrationDialog {
  /** Stable id: `<sceneId>.<n>` — the per-dialog synthesis cache keys off it via text. */
  id: string;
  sceneId: string;
  /** Global index of this dialog's first token in the extracted narration. */
  firstTokenIndex: number;
  tokens: string[];
}

export function splitIntoDialogs(extracted: ExtractedNarration): NarrationDialog[] {
  const dialogs: NarrationDialog[] = [];

  for (const scene of extracted.scenes) {
    const sceneEnd = scene.firstTokenIndex + scene.tokens.length;
    // Split points inside this scene: its start plus each marker position.
    const cuts = new Set<number>([scene.firstTokenIndex]);
    for (const marker of scene.markers) {
      if (marker.beforeTokenIndex < sceneEnd) {
        cuts.add(marker.beforeTokenIndex);
      }
    }

    const starts = Array.from(cuts).sort((left, right) => left - right);
    let index = 0;
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : sceneEnd;
      if (end <= start) {
        continue; // Adjacent markers with no words between them.
      }
      dialogs.push({
        id: `${scene.sceneId}.${index}`,
        sceneId: scene.sceneId,
        firstTokenIndex: start,
        tokens: extracted.tokens.slice(start, end),
      });
      index += 1;
    }
  }

  return dialogs;
}

/** Display text of one dialog (what the captions show for its span). */
export function dialogDisplayText(dialog: NarrationDialog): string {
  return dialog.tokens.join(" ");
}
