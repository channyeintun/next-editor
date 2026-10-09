// Rounded-rectangle picture-in-picture framing: a square card whose corner radius stays modest
// (~11% of its width) so the face crop reads as a framed webcam tile rather than a blurred-out
// bubble. Paired with the bright hairline border below, this matches the familiar screen-recording
// PiP look.
export const OVERLAY_WIDTH = 176;
export const OVERLAY_HEIGHT = 176;
export const OVERLAY_RADIUS = 20;
const EDGE_PADDING = 24;
const MEDIA_CONTROLS_CLEARANCE = 88;
const MINIMIZED_HANDLE_HEIGHT = 56;

export interface OverlayPosition {
  x: number;
  y: number;
}

export function getDefaultPosition(): OverlayPosition {
  if (typeof window === "undefined") {
    return { x: EDGE_PADDING, y: EDGE_PADDING };
  }

  return {
    x: window.innerWidth - OVERLAY_WIDTH - EDGE_PADDING,
    y: window.innerHeight - OVERLAY_HEIGHT - MEDIA_CONTROLS_CLEARANCE,
  };
}

export function clampPosition(position: OverlayPosition): OverlayPosition {
  if (typeof window === "undefined") return position;

  return {
    x: Math.min(
      Math.max(position.x, EDGE_PADDING),
      window.innerWidth - OVERLAY_WIDTH - EDGE_PADDING,
    ),
    y: Math.min(
      Math.max(position.y, EDGE_PADDING),
      window.innerHeight - OVERLAY_HEIGHT - MEDIA_CONTROLS_CLEARANCE,
    ),
  };
}

/**
 * The corner after the one nearest `position`, going clockwise (top-left → top-right →
 * bottom-right → bottom-left), inside the same bounds a drag is clamped to. Lets the overlay be
 * moved with a single click or key press instead of a drag.
 */
export function nextCornerPosition(position: OverlayPosition): OverlayPosition {
  if (typeof window === "undefined") return position;

  const minX = EDGE_PADDING;
  const maxX = window.innerWidth - OVERLAY_WIDTH - EDGE_PADDING;
  const minY = EDGE_PADDING;
  const maxY = window.innerHeight - OVERLAY_HEIGHT - MEDIA_CONTROLS_CLEARANCE;
  const corners: OverlayPosition[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  corners.forEach((corner, index) => {
    const distance = Math.hypot(corner.x - position.x, corner.y - position.y);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });

  return corners[(nearest + 1) % corners.length];
}

/** The screen edge the minimized handle docks to, based on which half the overlay sits in. */
export function getDockSide(position: OverlayPosition): "left" | "right" {
  if (typeof window === "undefined") return "right";
  return position.x + OVERLAY_WIDTH / 2 < window.innerWidth / 2 ? "left" : "right";
}

/** Vertical offset for the minimized handle, centered on the overlay and clamped to the viewport. */
export function getMinimizedHandleTop(position: OverlayPosition): number {
  const centeredTop = position.y + OVERLAY_HEIGHT / 2 - MINIMIZED_HANDLE_HEIGHT / 2;
  if (typeof window === "undefined") return Math.max(centeredTop, EDGE_PADDING);
  return Math.min(
    Math.max(centeredTop, EDGE_PADDING),
    window.innerHeight - MINIMIZED_HANDLE_HEIGHT - EDGE_PADDING,
  );
}
