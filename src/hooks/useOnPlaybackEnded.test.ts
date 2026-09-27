import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { useOnPlaybackEnded } from "./useOnPlaybackEnded";

describe("useOnPlaybackEnded", () => {
  it("fires once per transition into the ended state", () => {
    const onEnded = vi.fn<() => void>();
    const { rerender } = renderHook(({ hasEnded }) => useOnPlaybackEnded(hasEnded, onEnded), {
      initialProps: { hasEnded: false },
    });
    expect(onEnded).not.toHaveBeenCalled();

    rerender({ hasEnded: true });
    rerender({ hasEnded: true });
    expect(onEnded).toHaveBeenCalledTimes(1);

    // A seek or replay that leaves the end re-arms it.
    rerender({ hasEnded: false });
    rerender({ hasEnded: true });
    expect(onEnded).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a callback", () => {
    expect(() => renderHook(() => useOnPlaybackEnded(true, undefined))).not.toThrow();
  });
});
