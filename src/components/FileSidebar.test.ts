import { describe, expect, it } from "vitest";
import {
  getClampedFileSidebarWidth,
  MAX_FILE_SIDEBAR_WIDTH,
  MIN_FILE_SIDEBAR_WIDTH,
} from "../utils/sidebarLayout";
import { getViewportClampedContextMenuPlacement } from "./FileSidebar";

describe("getViewportClampedContextMenuPlacement", () => {
  it("keeps a menu opened near the bottom fully inside the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 120,
      anchorY: 780,
      menuWidth: 224,
      menuHeight: 280,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.top).toBe(512);
    expect(placement.top + 280).toBeLessThanOrEqual(792);
    expect(placement.maxHeight).toBe(784);
  });

  it("keeps a menu opened near the right edge fully inside the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 980,
      anchorY: 120,
      menuWidth: 224,
      menuHeight: 280,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.left).toBe(792);
    expect(placement.left + 224).toBeLessThanOrEqual(1016);
  });

  it("uses max height when the menu is taller than the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 40,
      anchorY: 40,
      menuWidth: 224,
      menuHeight: 900,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(784);
  });
});

describe("getClampedFileSidebarWidth", () => {
  it("keeps the sidebar width inside the configured bounds", () => {
    expect(getClampedFileSidebarWidth(120, 1200)).toBe(MIN_FILE_SIDEBAR_WIDTH);
    expect(getClampedFileSidebarWidth(320, 1200)).toBe(320);
    expect(getClampedFileSidebarWidth(900, 1200)).toBe(MAX_FILE_SIDEBAR_WIDTH);
  });

  it("reserves room for the main editor on narrow screens", () => {
    expect(getClampedFileSidebarWidth(320, 640)).toBe(280);
  });
});
