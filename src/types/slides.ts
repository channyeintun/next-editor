export type SlideContentType = "html" | "markdown";

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
  indexv?: number;
  interaction?: IframeInteractionEvent;
}

/**
 * Preview panel state (for code preview iframe)
 */
export type PreviewSize = "small" | "medium" | "large" | { width: number; height: number };
export type PreviewPanelMode = "floating" | "docked";

/**
 * Iframe interaction event types
 */
export type IframeInteractionType =
  | "click"
  | "focus"
  | "blur"
  | "hover_start"
  | "hover_end"
  | "keydown"
  | "keyup"
  | "scroll"
  | "input";

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
  buttons?: number;
  windowWidth?: number;
  windowHeight?: number;
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

export const PREVIEW_DOM_PATCH_FORMAT_VERSION = 1;

export type PreviewDomPatchSource = "runtime-preview" | "static-preview";

export interface PreviewNodeRef {
  id?: string;
  path: number[];
}

export interface SerializedPreviewNode {
  kind: "element" | "text" | "comment" | "doctype";
  tagName?: string;
  namespaceURI?: string | null;
  attributes?: Array<[string, string]>;
  text?: string;
  children?: SerializedPreviewNode[];
}

export interface PreviewSetTextOp {
  op: "set_text";
  target: PreviewNodeRef;
  text: string;
}

export interface PreviewSetAttributeOp {
  op: "set_attribute";
  target: PreviewNodeRef;
  name: string;
  value: string;
  namespaceURI?: string | null;
}

export interface PreviewRemoveAttributeOp {
  op: "remove_attribute";
  target: PreviewNodeRef;
  name: string;
  namespaceURI?: string | null;
}

export interface PreviewInsertNodeOp {
  op: "insert_node";
  parent: PreviewNodeRef;
  index: number;
  node: SerializedPreviewNode;
}

export interface PreviewRemoveNodeOp {
  op: "remove_node";
  target: PreviewNodeRef;
}

export interface PreviewMoveNodeOp {
  op: "move_node";
  target: PreviewNodeRef;
  parent: PreviewNodeRef;
  index: number;
}

export interface PreviewReplaceSubtreeOp {
  op: "replace_subtree";
  target: PreviewNodeRef;
  html: string;
  mode: "children" | "node";
}

export interface PreviewSetPropertyOp {
  op: "set_property";
  target: PreviewNodeRef;
  name: "value" | "checked" | "selected";
  value: string | boolean;
}

export type PreviewDomPatchOp =
  | PreviewSetTextOp
  | PreviewSetAttributeOp
  | PreviewRemoveAttributeOp
  | PreviewInsertNodeOp
  | PreviewRemoveNodeOp
  | PreviewMoveNodeOp
  | PreviewReplaceSubtreeOp
  | PreviewSetPropertyOp;

export interface PreviewInitialDocument {
  version: typeof PREVIEW_DOM_PATCH_FORMAT_VERSION;
  time: number;
  documentId: string;
  route?: string;
  html: string;
}

export interface PreviewDomPatchBatch {
  version: typeof PREVIEW_DOM_PATCH_FORMAT_VERSION;
  time: number;
  source: PreviewDomPatchSource;
  documentId: string;
  baseRevision: number;
  revision: number;
  route?: string;
  ops: PreviewDomPatchOp[];
}

export interface PreviewState {
  size: PreviewSize;
  isOpen?: boolean;
  mode?: PreviewPanelMode;
  content?: string;
  route?: string;
  scrollTop?: number;
  scrollLeft?: number;
  refreshKey?: number;
  // Current interaction being replayed (for visualization)
  currentInteraction?: IframeInteractionEvent;
}

export interface PreviewEvent {
  type:
    | "preview_open"
    | "preview_close"
    | "preview_float"
    | "preview_unfloat"
    | "preview_minimize"
    | "preview_maximize"
    | "preview_scroll"
    | "preview_interaction"
    | "preview_route_change"
    | "preview_refresh"
    | "preview_resize";
  timestamp: number;
  size?: PreviewSize;
  isOpen?: boolean;
  mode?: PreviewPanelMode;
  content?: string;
  route?: string;
  scrollTop?: number;
  scrollLeft?: number;
  interaction?: IframeInteractionEvent;
}
