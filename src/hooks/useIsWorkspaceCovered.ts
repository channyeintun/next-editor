import { useSlidesContext } from "../contexts/SlidesContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";

/**
 * Whether an overlay is drawn over the whole workspace: a maximized slide deck
 * or the whiteboard (a non-maximized deck is not drawn at all). While one is,
 * the workspace is inert: keyboard focus and screen readers cannot reach
 * controls hidden under the overlay's scrim, just as a pointer cannot, and
 * nothing under it opens. The player bar sits outside.
 */
export function useIsWorkspaceCovered(): boolean {
  const slides = useSlidesContext();
  const whiteboard = useWhiteboardContext();
  return (
    (slides.previewState.isOpen && slides.previewState.isMaximized === true) || whiteboard.isOpen
  );
}
