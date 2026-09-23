// Typed model for a Google Slides deck published via File → Share → Publish
// to web. Produced by parsePublishedDeck (see parse.ts); consumed by the
// slide model, renderer, and import UX in later phases.

import type { DeckStep } from "../core/src/slides";

// The build-step types live with the slide model the recording stores.
export type {
  DeckStep,
  DeckStepEntry,
  DeckStepTrack,
  DeckStepTrackOpacity,
  DeckStepTrackScale,
  DeckStepTrackTranslate,
} from "../core/src/slides";

export interface ParsedDeckSlide {
  pageId: string;
  title: string;
  svg: string;
  steps: DeckStep[];
}

export interface ParsedDeck {
  /** Normalized source URL (query/hash stripped). */
  sourceUrl: string;
  /** From docData[0], internal units — used for aspect ratio only. */
  width: number;
  height: number;
  slides: ParsedDeckSlide[];
}

export class GoogleSlidesParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleSlidesParseError";
  }
}
