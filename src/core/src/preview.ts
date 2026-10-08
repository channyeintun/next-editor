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
  testId?: string;
  className?: string;
  xpath?: string; // For precise element targeting during playback; absent on mousemove
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

export type PreviewDomPatchSource = "runtime-preview" | "static-preview";

/**
 * A single recorded rrweb event, carried verbatim through the recording engine.
 * Structurally compatible with rrweb's `eventWithTime` so it can be cast in the
 * preview area without the engine ever depending on rrweb. The engine treats it
 * as opaque JSON and only ever reads the envelope `time`/`documentId`.
 */
export interface PreviewRecordedEvent {
  type: number;
  data: unknown;
  timestamp: number;
  delay?: number;
}

export interface PreviewInitialDocument {
  version: number;
  time: number;
  documentId: string;
  route?: string;
  // rrweb Meta + FullSnapshot events that seed replay.
  events?: PreviewRecordedEvent[];
}

export interface PreviewDomPatchBatch {
  version: number;
  time: number;
  source: PreviewDomPatchSource;
  documentId: string;
  route?: string;
  // rrweb incremental events for this frame.
  events?: PreviewRecordedEvent[];
}

export interface ApiClientRecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface ApiClientRecordedResponse {
  ok: true;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  durationMs: number;
  truncated?: boolean;
  bodyBytes?: number;
}

export interface ApiClientRecordedError {
  ok: false;
  error: string;
  durationMs: number;
}

export type ApiClientRecordedResult = ApiClientRecordedResponse | ApiClientRecordedError;

export type PreviewActiveMode = "browser" | "api";
export type ApiClientRequestTab = "headers" | "body";

export interface ApiClientReplayHistoryEntry {
  id: string;
  request?: ApiClientRecordedRequest;
  result: ApiClientRecordedResult;
}

export interface ApiClientReplayState {
  request?: ApiClientRecordedRequest;
  result?: ApiClientRecordedResult;
  sending?: boolean;
  history?: ApiClientReplayHistoryEntry[];
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
  currentInteraction?: IframeInteractionEvent;
  activeMode?: PreviewActiveMode;
  requestTab?: ApiClientRequestTab;
  apiClientState?: ApiClientReplayState;
}

export interface PreviewCheckpointTarget {
  attributes: Record<string, string>;
  tagName: string;
  testId: string;
  text: string;
  value: string | null;
}

/** Artifact-resident observation produced by one authored expect.preview action. */
export interface PreviewCheckpoint {
  actionId: string;
  route: string;
  target?: PreviewCheckpointTarget;
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
    | "preview_resize"
    | "preview_checkpoint"
    | "api_client_mode"
    | "api_client_request"
    | "api_client_response"
    | "api_client_request_tab"
    | "api_client_inspect_history";
  timestamp: number;
  size?: PreviewSize;
  isOpen?: boolean;
  mode?: PreviewPanelMode;
  content?: string;
  route?: string;
  scrollTop?: number;
  scrollLeft?: number;
  interaction?: IframeInteractionEvent;
  activeMode?: PreviewActiveMode;
  requestTab?: ApiClientRequestTab;
  apiClientRequest?: ApiClientRecordedRequest;
  apiClientResult?: ApiClientRecordedResult;
  checkpoint?: PreviewCheckpoint;
}
