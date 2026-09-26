import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { useLinkedStartTime } from "./useLinkedStartTime";

const recording = (id: string, duration = 600_000) =>
  ({ id, duration, frames: [] }) as unknown as Recording;

describe("useLinkedStartTime", () => {
  it("opens the loaded lesson at the linked moment, once", () => {
    const seekTo = vi.fn<(time: number) => void>();
    const lesson = recording("lesson");
    const { result, rerender } = renderHook(
      ({ current }) => useLinkedStartTime(current, "1m30s", seekTo),
      { initialProps: { current: null as Recording | null } },
    );
    expect(seekTo).not.toHaveBeenCalled();

    rerender({ current: lesson });
    expect(seekTo).toHaveBeenCalledWith(90_000);
    expect(result.current("lesson")).toBe(90_000);

    // The same lesson, changed in place (chapters renamed), is not sent back there.
    rerender({ current: { ...lesson } });
    expect(seekTo).toHaveBeenCalledTimes(1);
  });

  it("keeps a link inside the lesson, and leaves a lesson without one at its start", () => {
    const seekTo = vi.fn<(time: number) => void>();
    const { result, rerender } = renderHook(
      ({ current, t }) => useLinkedStartTime(current, t, seekTo),
      { initialProps: { current: recording("short", 5_000), t: "90" as string | null } },
    );
    expect(seekTo).toHaveBeenCalledWith(5_000);

    rerender({ current: recording("unlinked"), t: null });
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(result.current("unlinked")).toBe(0);
  });
});
