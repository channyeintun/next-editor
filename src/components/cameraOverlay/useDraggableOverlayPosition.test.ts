import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useDraggableOverlayPosition } from "./useDraggableOverlayPosition";

const POSITION_KEY = "next-editor-camera-overlay-position";

// jsdom's window is 1024 × 768: the default spot sits 24px in from the right edge and 88px
// above the bottom, which leaves room for the player bar.
const DEFAULT_POSITION = { x: 1024 - 176 - 24, y: 768 - 176 - 88 };

const stored = () => JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? "null");

const pointer = (clientX: number, clientY: number, captured = true) =>
  ({
    pointerId: 1,
    clientX,
    clientY,
    currentTarget: {
      setPointerCapture: vi.fn<(pointerId: number) => void>(),
      hasPointerCapture: () => captured,
    },
  }) as unknown as ReactPointerEvent<HTMLDivElement>;

const resizeWindowTo = (width: number, height: number) => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(height);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useDraggableOverlayPosition", () => {
  it("starts above the player bar's right end, and stores that spot", () => {
    const { result } = renderHook(() => useDraggableOverlayPosition());

    expect(result.current.position).toEqual(DEFAULT_POSITION);
    expect(stored()).toEqual(DEFAULT_POSITION);
  });

  it("starts from the stored position, moved inside the window", () => {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x: 5_000, y: -10 }));
    const { result } = renderHook(() => useDraggableOverlayPosition());

    expect(result.current.position).toEqual({ x: DEFAULT_POSITION.x, y: 24 });
    expect(stored()).toEqual({ x: DEFAULT_POSITION.x, y: 24 });
  });

  it("starts at the default spot when the stored value is not a position", () => {
    window.localStorage.setItem(POSITION_KEY, "{not json");
    expect(renderHook(() => useDraggableOverlayPosition()).result.current.position).toEqual(
      DEFAULT_POSITION,
    );

    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x: "10", y: 10 }));
    expect(renderHook(() => useDraggableOverlayPosition()).result.current.position).toEqual(
      DEFAULT_POSITION,
    );
  });

  it("starts at the default spot when storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    });

    const { result } = renderHook(() => useDraggableOverlayPosition());
    expect(result.current.position).toEqual(DEFAULT_POSITION);
  });

  it("follows the pointer that holds it, inside the window, storing where the drag ends", () => {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x: 100, y: 100 }));
    const { result } = renderHook(() => useDraggableOverlayPosition());
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const grab = pointer(150, 130);
    act(() => result.current.handlePointerDown(grab));
    expect(grab.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);

    // The overlay moves with every step, but nothing is stored mid-drag.
    act(() => result.current.handlePointerMove(pointer(250, 180)));
    expect(result.current.position).toEqual({ x: 200, y: 150 });
    act(() => result.current.handlePointerMove(pointer(-500, 180)));
    expect(result.current.position).toEqual({ x: 24, y: 150 });
    expect(setItem).not.toHaveBeenCalled();
    expect(stored()).toEqual({ x: 100, y: 100 });

    // A pointer that is not holding the overlay leaves it where it is.
    act(() => result.current.handlePointerMove(pointer(400, 300, false)));
    expect(result.current.position).toEqual({ x: 24, y: 150 });

    // Released: the last position is stored, once, though pointerup and the lost capture
    // both end the drag.
    act(() => result.current.handleDragEnd());
    act(() => result.current.handleDragEnd());
    expect(stored()).toEqual({ x: 24, y: 150 });
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("moves to the next corner clockwise without a drag, storing each step", () => {
    const { result } = renderHook(() => useDraggableOverlayPosition());

    // From the default bottom-right spot, the next corner clockwise is bottom-left.
    const bottomLeft = { x: 24, y: DEFAULT_POSITION.y };
    act(() => result.current.moveToNextCorner());
    expect(result.current.position).toEqual(bottomLeft);
    expect(stored()).toEqual(bottomLeft);

    act(() => result.current.moveToNextCorner());
    expect(result.current.position).toEqual({ x: 24, y: 24 });
    expect(stored()).toEqual({ x: 24, y: 24 });
  });

  it("moves back inside the window when the window shrinks", () => {
    const { result } = renderHook(() => useDraggableOverlayPosition());

    resizeWindowTo(800, 600);
    const inside = { x: 800 - 176 - 24, y: 600 - 176 - 88 };
    expect(result.current.position).toEqual(inside);
    expect(stored()).toEqual(inside);
  });

  it("stays put, and stores nothing, when a resize leaves it inside the window", () => {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify({ x: 100, y: 100 }));
    const { result } = renderHook(() => useDraggableOverlayPosition());
    const before = result.current.position;
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    resizeWindowTo(900, 700);
    expect(result.current.position).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
  });
});
