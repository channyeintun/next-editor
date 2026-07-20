// .srt is accepted at pick time but canonicalized to WebVTT before upload —
// the URL loader's sibling-caption fetch (src/hooks/useUrlLoader.ts) only
// accepts documents starting with "WEBVTT", so raw .srt bytes would never load.
export const CAPTION_ACCEPT = ".vtt,.srt";
// Hard backstop for a text subtitle file — hours of captions fit well under this.
export const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
