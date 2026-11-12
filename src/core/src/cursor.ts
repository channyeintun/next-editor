/**
 * The cursor track's model: the pointer samples a recording stores, and the
 * target rects and cell anchors that let playback put a sample back on the
 * viewer's layout. types.ts re-exports these for the Recording that carries them.
 */

/**
 * Bounding box for the UI region that a cursor sample was recorded against.
 */
export interface CursorTargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A place in a target's own content, for targets whose content can move under
 * a still pointer. Over a terminal it is the written line, the character
 * offset within it, and where inside that character's cell (0–1 each way).
 * Over the whiteboard it is a scene point: `line` and `offset` are the whole
 * scene y and x, `dy` and `dx` their fractions. Only the target's own provider
 * (cursorCellAnchors.ts) reads the numbers.
 */
export interface CursorCellAnchor {
  line: number;
  offset: number;
  dx: number;
  dy: number;
}

/**
 * Cursor coordinates relative to a stable UI region. Playback can use this
 * to remap a recorded position onto the current layout.
 */
export interface CursorTargetSnapshot {
  id: string;
  rect: CursorTargetRect;
  x: number;
  y: number;
  /** Set over a terminal or the whiteboard: replay resolves it before the pixel offset. */
  cell?: CursorCellAnchor;
}

export type CursorCoordinateSpace = "viewport" | "root";

export interface CursorTweenEndpoint {
  x: number;
  y: number;
  visible: boolean;
  coordinateSpace?: CursorCoordinateSpace;
  target?: CursorTargetSnapshot;
}

export interface CursorTweenSnapshot {
  from: CursorTweenEndpoint;
  to: CursorTweenEndpoint;
  progress: number;
}

/**
 * Mouse cursor position. New recordings use root-relative pixels; older
 * recordings omit coordinateSpace and remain viewport-relative.
 */
export interface MouseCursorPosition {
  x: number;
  y: number;
  visible: boolean; // Whether cursor is within editor bounds
  coordinateSpace?: CursorCoordinateSpace;
  flags?: number;
  hover?: string | null;
  angle?: number;
  pressure?: number;
  target?: CursorTargetSnapshot;
  tween?: CursorTweenSnapshot;
}

/**
 * Lightweight cursor sample used for smooth fake-cursor playback.
 */
export interface CursorRecordingEvent extends MouseCursorPosition {
  timestamp: number;
}
