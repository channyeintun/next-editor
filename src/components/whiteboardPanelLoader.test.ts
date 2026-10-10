import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const chunk = vi.hoisted(() => ({ imports: 0 }));

// Excalidraw is not under test; this counts how often the chunk is imported.
vi.mock("./WhiteboardPanel", () => {
  chunk.imports += 1;
  return { default: () => null };
});

const { loadWhiteboardPanel, prefetchWhiteboardPanelWhenIdle } =
  await import("./whiteboardPanelLoader");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whiteboardPanelLoader", () => {
  it("prefetches at idle, sharing the one import with the panel", async () => {
    const requestIdleCallback = vi.fn<typeof window.requestIdleCallback>(() => 3);
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn<typeof window.cancelIdleCallback>());

    prefetchWhiteboardPanelWhenIdle();
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 2000 });

    expect(chunk.imports).toBe(0);
    requestIdleCallback.mock.calls[0][0]({ didTimeout: false, timeRemaining: () => 10 });
    await expect(loadWhiteboardPanel()).resolves.toHaveProperty("default");
    await expect(loadWhiteboardPanel()).resolves.toHaveProperty("default");
    expect(chunk.imports).toBe(1);
  });
});
