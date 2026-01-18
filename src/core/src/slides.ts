export type SlideContentType = 'html' | 'markdown';

export interface Slide {
  id: string;
  content: string;
  contentType: SlideContentType;
  name?: string;
  order: number;
}

export interface SlidePreviewState {
  isOpen: boolean;
  isMaximized?: boolean;
  currentSlideId?: string | null;
  indexv?: number;
  currentInteraction?: IframeInteractionEvent;
}

export interface SlideEvent {
  type: 'slide_open' | 'slide_close' | 'slide_change' | 'slide_maximize' | 'slide_minimize' | 'slide_interaction';
  timestamp: number;
  slideId?: string;
  isMaximized?: boolean;
  indexv?: number;
  interaction?: IframeInteractionEvent;
}

/**
 * Preview panel state (for code preview iframe)
 */
export type PreviewSize = 'small' | 'medium' | 'large';

/**
 * Iframe interaction event types
 */
export type IframeInteractionType =
  | 'click'
  | 'focus'
  | 'blur'
  | 'hover_start'
  | 'hover_end'
  | 'keydown'
  | 'keyup'
  | 'scroll'
  | 'input';

/**
 * Target element info for precise element targeting during playback
 */
export interface IframeInteractionTarget {
  tagName: string;
  id?: string;
  className?: string;
  xpath: string;
}

/**
 * Data payload for different interaction types
 */
export interface IframeInteractionData {
  clientX?: number;
  clientY?: number;
  button?: number;
  key?: string;
  code?: string;
  scrollTop?: number;
  scrollLeft?: number;
  value?: string;
  isDocument?: boolean;
}

/**
 * Iframe interaction event
 */
export interface IframeInteractionEvent {
  type: IframeInteractionType;
  timestamp: number;
  target: IframeInteractionTarget;
  data?: IframeInteractionData;
}

export interface PreviewState {
  size: PreviewSize;
  scrollTop?: number;
  scrollLeft?: number;
  currentInteraction?: IframeInteractionEvent;
}

export interface PreviewEvent {
  type: 'preview_open' | 'preview_minimize' | 'preview_maximize' | 'preview_scroll' | 'preview_interaction';
  timestamp: number;
  size?: PreviewSize;
  scrollTop?: number;
  scrollLeft?: number;
  interaction?: IframeInteractionEvent;
}