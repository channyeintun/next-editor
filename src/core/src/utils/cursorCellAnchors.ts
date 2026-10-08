import type { CursorCellAnchor } from "../types";

/**
 * Replay targets whose content can scroll or reflow under a still pointer —
 * a terminal — register a provider that turns a client point into a place in
 * the content (line and character, plus where in that cell) and back. Cursor
 * samples over such a target carry that place, so playback puts the pointer on
 * the same line of output however many rows the viewer's console fits, rather
 * than at the same pixel offset, which on a taller or shorter console is a
 * different line. Weakly held: an unmounted target takes its provider along.
 */
export interface CursorCellAnchorProvider {
  toCell(clientX: number, clientY: number): CursorCellAnchor | null;
  /** The client point for a cell, or null when that cell is not on screen. */
  toClient(cell: CursorCellAnchor): { x: number; y: number } | null;
}

const providers = new WeakMap<Element, CursorCellAnchorProvider>();

export function registerCursorCellAnchor(
  element: Element,
  provider: CursorCellAnchorProvider,
): void {
  providers.set(element, provider);
}

export function unregisterCursorCellAnchor(
  element: Element,
  provider: CursorCellAnchorProvider,
): void {
  if (providers.get(element) === provider) {
    providers.delete(element);
  }
}

export function getCursorCellAnchor(element: Element): CursorCellAnchorProvider | undefined {
  return providers.get(element);
}
