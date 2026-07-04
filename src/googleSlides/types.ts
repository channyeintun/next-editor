// Typed model for a Google Slides deck published via File → Share → Publish
// to web. Produced by parsePublishedDeck (see parse.ts); consumed by the
// slide model, renderer, and import UX in later phases.

export interface DeckStepTrackOpacity {
  kind: "opacity";
  from: number;
  to: number;
}

export interface DeckStepTrackScale {
  kind: "scale";
  from: number;
  to: number;
}

export interface DeckStepTrackTranslate {
  kind: "translate";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export type DeckStepTrack = DeckStepTrackOpacity | DeckStepTrackScale | DeckStepTrackTranslate;

export interface DeckStepEntry {
  elementId: string;
  durationMs: number;
  delayMs: number;
  tracks: DeckStepTrack[];
}

/** One step = entries animated together. */
export type DeckStep = DeckStepEntry[];

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
