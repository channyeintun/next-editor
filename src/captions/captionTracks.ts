import type { CaptionTrack } from "../core/src/types";

/** What the viewer last picked: that track, and its language for lessons without it. */
export interface CaptionTrackPreference {
  trackId: string | null;
  language: string | null;
}

/**
 * The track the viewer sees: the one they picked, else one in the language they last
 * picked (a track id belongs to one lesson, the language carries to the next), else the
 * lesson's default, else its first.
 */
export function selectCaptionTrack(
  tracks: readonly CaptionTrack[] | undefined,
  preference: CaptionTrackPreference,
): CaptionTrack | null {
  if (!tracks || tracks.length === 0) return null;
  if (preference.trackId) {
    const picked = tracks.find((track) => track.id === preference.trackId);
    if (picked) return picked;
  }
  if (preference.language) {
    const sameLanguage = tracks.find((track) => track.language === preference.language);
    if (sameLanguage) return sameLanguage;
  }
  return tracks.find((track) => track.default) ?? tracks[0];
}
