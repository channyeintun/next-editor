import type { CaptionTrack } from "../core/src/types";

/** What the viewer last picked: that track, and its language for lessons without it. */
export interface CaptionTrackPreference {
  trackId: string | null;
  language: string | null;
}

/**
 * The track the viewer sees: the one they picked, else one in the language they last
 * picked, else the lesson's default, else its first. The id only tells apart tracks in
 * the picked language: ids repeat across lessons (every studio lesson's narration is
 * "studio-narration"), so a matching id in another language must not beat the language.
 */
export function selectCaptionTrack(
  tracks: readonly CaptionTrack[] | undefined,
  preference: CaptionTrackPreference,
): CaptionTrack | null {
  if (!tracks || tracks.length === 0) return null;
  if (preference.trackId) {
    const picked = tracks.find((track) => track.id === preference.trackId);
    if (picked && (!preference.language || picked.language === preference.language)) {
      return picked;
    }
  }
  if (preference.language) {
    const sameLanguage = tracks.find((track) => track.language === preference.language);
    if (sameLanguage) return sameLanguage;
  }
  return tracks.find((track) => track.default) ?? tracks[0];
}

// A bare language tag, as tracks are often labelled ("my-MM", "EN"), with the
// " (auto)" a generated track carries.
const TAGGED_LABEL = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)( \(auto\))?$/i;

let languageNames: Intl.DisplayNames | null | undefined;

/** "Burmese" for "my". The player's words are English, so the names are too. */
function languageName(tag: string): string | undefined {
  if (languageNames === undefined) {
    try {
      languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      languageNames = null;
    }
  }
  try {
    return languageNames?.of(tag);
  } catch {
    // Shaped like a tag, but not a well-formed one.
    return undefined;
  }
}

/**
 * The name to show for a track: its label, with a bare language tag ("my-MM",
 * "EN (auto)") read out as the language's name. What is stored stays as it is.
 */
export function captionTrackLabel(track: CaptionTrack): string {
  const label = track.label || track.language;
  const tagged = TAGGED_LABEL.exec(label);
  if (!tagged) return label;
  const name = languageName(tagged[1]);
  return name ? `${name}${tagged[2] ?? ""}` : label;
}
