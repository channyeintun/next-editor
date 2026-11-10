import type { WhiteboardElementJSON } from "./whiteboard";

/**
 * The Excalidraw element types a Next Editor whiteboard holds: shapes, lines,
 * strokes, text and frames. Everything else is left out on purpose. An iframe
 * element renders the HTML in its customData as a frame that runs scripts, an
 * embeddable loads a third-party page, a magic frame drives AI generation, and
 * an image needs binary files that no recording or room carries.
 *
 * This is the one home of that rule. The room's element schema accepts exactly
 * these types (teachingWhiteboard), and WhiteboardPanel drops every other
 * element before Excalidraw sees a scene, whatever its source: a replayed .ne
 * lesson, a room, or a restored store.
 */
export const WHITEBOARD_ELEMENT_TYPES = [
  "rectangle",
  "diamond",
  "ellipse",
  "text",
  "line",
  "arrow",
  "freedraw",
  "frame",
] as const;

export type WhiteboardElementType = (typeof WHITEBOARD_ELEMENT_TYPES)[number];

const allowedWhiteboardElementTypes: ReadonlySet<unknown> = new Set(WHITEBOARD_ELEMENT_TYPES);

/** Whether the element is one of the {@link WHITEBOARD_ELEMENT_TYPES}. */
export function isAllowedWhiteboardElement(element: WhiteboardElementJSON): boolean {
  return allowedWhiteboardElementTypes.has(element.type);
}
