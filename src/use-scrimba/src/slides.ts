export interface Slide {
  id: string;
  imageUrl: string;
  name?: string;
  order: number;
}

export interface SlidePreviewState {
  isOpen: boolean;
  isMaximized: boolean;
  currentSlideId: string | null;
}

export interface SlideEvent {
  type: 'slide_open' | 'slide_close' | 'slide_change' | 'slide_maximize' | 'slide_minimize';
  timestamp: number;
  slideId?: string;
  isMaximized?: boolean;
}

/**
 * Preview panel state (for code preview iframe)
 */
export type PreviewSize = 'small' | 'medium' | 'large';

export interface PreviewState {
  size: PreviewSize;
}

export interface PreviewEvent {
  type: 'preview_open' | 'preview_minimize' | 'preview_maximize';
  timestamp: number;
  size: PreviewSize;
}