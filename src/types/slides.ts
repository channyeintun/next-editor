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
export type PreviewSize = 'small' | 'medium' | 'large' | { width: number; height: number };

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
  xpath: string; // For precise element targeting during playback
}

/**
 * Data payload for different interaction types
 */
export interface IframeInteractionData {
  // Click/mouse data
  clientX?: number;
  clientY?: number;
  button?: number;
  // Key data
  key?: string;
  code?: string;
  // Scroll data
  scrollTop?: number;
  scrollLeft?: number;
  // Input data
  value?: string;
  // Flag for document-level scroll
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
  content?: string;
  scrollTop?: number;
  scrollLeft?: number;
  refreshKey?: number;
  // Current interaction being replayed (for visualization)
  currentInteraction?: IframeInteractionEvent;
}

export interface PreviewEvent {
  type: 'preview_open' | 'preview_minimize' | 'preview_maximize' | 'preview_scroll' | 'preview_interaction' | 'preview_refresh' | 'preview_resize';
  timestamp: number;
  size?: PreviewSize;
  content?: string;
  scrollTop?: number;
  scrollLeft?: number;
  interaction?: IframeInteractionEvent;
}