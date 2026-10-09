import type { IframeInteractionEvent } from "./preview";

export type SlideContentType = "html" | "markdown" | "google-svg";

/**
 * Google Slides build steps, produced by parsePublishedDeck (src/googleSlides) and
 * carried on imported slides. Defined here, with the rest of the slide model the
 * recording stores, so core depends on no app module; src/googleSlides re-exports
 * them.
 */
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

export interface Slide {
  id: string;
  content: string; // for google-svg: normalized SVG markup
  contentType: SlideContentType;
  name?: string;
  order: number;
  background?: string; // preset id or custom image data URL (src/config/slideBackgrounds.ts)
  title?: string; // google-svg: slide title from the deck
  steps?: DeckStep[]; // google-svg: build steps
  sourceUrl?: string; // google-svg: published deck URL (same on every deck slide)
}

export interface SlidePreviewState {
  isOpen: boolean;
  isMaximized?: boolean;
  currentSlideId?: string | null;
  /**
   * Build steps revealed on the current slide: 0 = none, slide.steps.length = all
   * (google-svg only; always 0 for html/markdown). Named after reveal.js's vertical
   * index; the name is part of the recording format (persisted slide events), so a
   * rename needs a format change. Collaboration rooms never carry it.
   */
  indexv?: number;
  currentInteraction?: IframeInteractionEvent;
}

/**
 * Whether the slide panel changed between two recorded states: opened or closed,
 * maximized, moved to another slide, or revealed another build step. The one home
 * for "did the slide panel change", read by the frame delta encoder and the frame
 * replay mirror. `currentInteraction` is not compared: it is ephemeral, and
 * nothing replays it from a frame.
 */
export function slidePreviewStateChanged(
  prev: SlidePreviewState | undefined,
  next: SlidePreviewState | undefined,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return (
    prev.isOpen !== next.isOpen ||
    prev.isMaximized !== next.isMaximized ||
    prev.currentSlideId !== next.currentSlideId ||
    prev.indexv !== next.indexv
  );
}

export interface SlideEvent {
  type:
    | "slide_open"
    | "slide_close"
    | "slide_change"
    | "slide_maximize"
    | "slide_minimize"
    | "slide_interaction";
  timestamp: number;
  slideId?: string;
  isMaximized?: boolean;
  /**
   * Build steps revealed on the current slide: 0 = none, slide.steps.length = all
   * (google-svg only; always 0 for html/markdown). Named after reveal.js's vertical
   * index; the name is part of the recording format (persisted slide events), so a
   * rename needs a format change. Collaboration rooms never carry it.
   */
  indexv?: number;
  interaction?: IframeInteractionEvent;
}
