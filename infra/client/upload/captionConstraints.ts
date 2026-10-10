// .srt is accepted at pick time but canonicalized to WebVTT before upload —
// the URL loader's sibling-caption fetch (src/storage/recordingSiblingMedia.ts) only
// accepts documents starting with "WEBVTT", so raw .srt bytes would never load.
// The byte limit lives with the other upload limits in infra/lessons/uploadLimits.ts.
export const CAPTION_ACCEPT = ".vtt,.srt";
