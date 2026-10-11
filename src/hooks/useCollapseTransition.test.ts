import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useCollapseTransition } from "./useCollapseTransition";

const DURATION_MS = 200;
const SETTLE_MS = DURATION_MS + 60;

function renderTransition(isCollapsed: boolean, enabled: boolean) {
  return renderHook(
    (props: { isCollapsed: boolean; enabled: boolean }) =>
      useCollapseTransition(props.isCollapsed, { durationMs: DURATION_MS, enabled: props.enabled }),
    { initialProps: { isCollapsed, enabled } },
  );
}

describe("useCollapseTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at its resting state without animating", () => {
    const open = renderTransition(false, false);
    expect(open.result.current).toEqual({ isMounted: true, isExpanded: true, isAnimating: false });

    const closed = renderTransition(true, false);
    expect(closed.result.current).toEqual({
      isMounted: false,
      isExpanded: false,
      isAnimating: false,
    });
  });

  it("animates a toggle and settles once the slide is over", () => {
    const { result, rerender } = renderTransition(false, true);

    rerender({ isCollapsed: true, enabled: true });
    expect(result.current).toEqual({ isMounted: true, isExpanded: false, isAnimating: true });

    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(result.current).toEqual({ isMounted: false, isExpanded: false, isAnimating: false });

    rerender({ isCollapsed: false, enabled: true });
    expect(result.current).toEqual({ isMounted: true, isExpanded: false, isAnimating: true });

    act(() => vi.advanceTimersToNextFrame());
    expect(result.current).toEqual({ isMounted: true, isExpanded: true, isAnimating: true });

    act(() => vi.advanceTimersByTime(SETTLE_MS));
    expect(result.current).toEqual({ isMounted: true, isExpanded: true, isAnimating: false });
  });

  it("snaps a closing slide shut when transitions turn off part way", () => {
    const { result, rerender } = renderTransition(false, true);

    rerender({ isCollapsed: true, enabled: true });
    act(() => vi.advanceTimersByTime(DURATION_MS / 2));
    rerender({ isCollapsed: true, enabled: false });

    expect(result.current).toEqual({ isMounted: false, isExpanded: false, isAnimating: false });
  });

  it("snaps an opening slide open when transitions turn off before its first frame", () => {
    const { result, rerender } = renderTransition(true, true);

    rerender({ isCollapsed: false, enabled: true });
    rerender({ isCollapsed: false, enabled: false });

    expect(result.current).toEqual({ isMounted: true, isExpanded: true, isAnimating: false });
  });
});
