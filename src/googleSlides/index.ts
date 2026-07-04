export {
  GoogleSlidesParseError,
  type DeckStep,
  type DeckStepEntry,
  type DeckStepTrack,
  type DeckStepTrackOpacity,
  type DeckStepTrackScale,
  type DeckStepTrackTranslate,
  type ParsedDeck,
  type ParsedDeckSlide,
} from "./types";
export { isPublishedDeckUrl, parsePublishedDeck } from "./parse";
export { normalizeSvg } from "./normalizeSvg";
export { fetchPublishedDeck } from "./fetchPublishedDeck";
