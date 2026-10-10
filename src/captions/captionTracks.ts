import type { CaptionCue, CaptionTrack } from "../core/src/types";

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

/** What a generated track's label carries after its language tag: "EN (auto)". */
const AUTO_SUFFIX = " (auto)";

/**
 * A track for the recording, labelled by its language tag ("EN", or "EN (auto)" when it
 * was generated). Importing, generating and loading a sibling VTT all build their tracks
 * here, so captionTrackLabel reads back the one label shape they write.
 */
export function createCaptionTrack({
  id,
  language,
  cues,
  generated = false,
  isDefault,
}: {
  id: string;
  language: string;
  cues: CaptionCue[];
  generated?: boolean;
  isDefault: boolean;
}): CaptionTrack {
  return {
    id,
    language,
    label: `${language.toUpperCase()}${generated ? AUTO_SUFFIX : ""}`,
    cues,
    default: isDefault,
  };
}

// A bare language tag, as tracks are often labelled ("my-MM", "EN"), with the
// AUTO_SUFFIX a generated track carries (escaped: it holds parentheses).
const TAGGED_LABEL = new RegExp(
  `^([a-z]{2,3}(?:-[a-z0-9]{2,8})*)(${AUTO_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?$`,
  "i",
);

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

const primarySubtag = (tag: string) => tag.split("-")[0].toLowerCase();

/**
 * The name to show for a track: its label, with a bare language tag ("my-MM",
 * "EN (auto)") read out as the language's name. Only a tag in the track's own language
 * counts, so a short written label ("New", "SDH") is not read as some other language's
 * code. What is stored stays as it is.
 */
export function captionTrackLabel(track: CaptionTrack): string {
  const label = track.label || track.language;
  const tagged = TAGGED_LABEL.exec(label);
  if (!tagged || primarySubtag(tagged[1]) !== primarySubtag(track.language)) return label;
  const name = languageName(tagged[1]);
  return name ? `${name}${tagged[2] ?? ""}` : label;
}
