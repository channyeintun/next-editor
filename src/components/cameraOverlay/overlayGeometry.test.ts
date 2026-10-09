import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { nextCornerPosition } from "./overlayGeometry";

// jsdom's window is 1024 × 768. The corners sit 24px in from each edge, with the bottom row
// 88px above the bottom edge to leave room for the player bar.
const TOP_LEFT = { x: 24, y: 24 };
const TOP_RIGHT = { x: 1024 - 176 - 24, y: 24 };
const BOTTOM_RIGHT = { x: 1024 - 176 - 24, y: 768 - 176 - 88 };
const BOTTOM_LEFT = { x: 24, y: 768 - 176 - 88 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nextCornerPosition", () => {
  it("steps clockwise through the four corners and back to the start", () => {
    expect(nextCornerPosition(TOP_LEFT)).toEqual(TOP_RIGHT);
    expect(nextCornerPosition(TOP_RIGHT)).toEqual(BOTTOM_RIGHT);
    expect(nextCornerPosition(BOTTOM_RIGHT)).toEqual(BOTTOM_LEFT);
    expect(nextCornerPosition(BOTTOM_LEFT)).toEqual(TOP_LEFT);
  });

  it("moves on from the corner nearest a dragged position", () => {
    // Dragged near the top-right corner, but not into it.
    expect(nextCornerPosition({ x: 700, y: 90 })).toEqual(BOTTOM_RIGHT);
    // Dragged a little up and in from the bottom-left corner.
    expect(nextCornerPosition({ x: 120, y: 400 })).toEqual(TOP_LEFT);
  });

  it("uses the current window size", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);

    expect(nextCornerPosition({ x: 24, y: 24 })).toEqual({ x: 800 - 176 - 24, y: 24 });
    expect(nextCornerPosition({ x: 600, y: 24 })).toEqual({ x: 600, y: 600 - 176 - 88 });
  });
});
