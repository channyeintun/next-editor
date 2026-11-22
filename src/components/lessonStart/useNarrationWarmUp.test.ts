import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NarrationPlayer } from "./useNarrationLoad";
import { useNarrationWarmUp } from "./useNarrationWarmUp";

const mocks = vi.hoisted(() => ({
  warmNarration: vi.fn<(player: unknown) => void>(),
  /** Settles the wait for the code editor's chunk. */
  editorLoaded: null as (() => void) | null,
}));

vi.mock("../../core/src/machine/audioActor", () => ({ warmNarration: mocks.warmNarration }));
vi.mock("../codeEditorLoader", () => ({
  whenCodeEditorLoaded: () =>
    new Promise<void>((resolve) => {
      mocks.editorLoaded = resolve;
    }),
}));

const player = (name: string) => ({ name }) as unknown as NarrationPlayer;
const settleEditor = () =>
  act(async () => {
    mocks.editorLoaded?.();
    await Promise.resolve();
  });

beforeEach(() => {
  mocks.warmNarration.mockClear();
  mocks.editorLoaded = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNarrationWarmUp", () => {
  it("warms the narration up once the code editor's chunk is in, not before", async () => {
    const narration = player("lesson-1");
    const { result } = renderHook(() => useNarrationWarmUp(narration));

    expect(result.current).toBe(true);
    // The chunk still downloads: the narration must not share the connection with it.
    expect(mocks.warmNarration).not.toHaveBeenCalled();

    await settleEditor();
    expect(mocks.warmNarration).toHaveBeenCalledExactlyOnceWith(narration);
  });

  it("has nothing to warm up before the lesson has a narration player", async () => {
    const { result } = renderHook(() => useNarrationWarmUp(undefined));

    await settleEditor();
    // Wanted all the same: the lesson is still on its way.
    expect(result.current).toBe(true);
    expect(mocks.warmNarration).not.toHaveBeenCalled();
  });

  it("warms up the player of the lesson that is loaded now, not one that was replaced", async () => {
    const first = player("lesson-1");
    const second = player("lesson-2");
    const { rerender } = renderHook(({ narration }) => useNarrationWarmUp(narration), {
      initialProps: { narration: first },
    });
    const settleFirst = mocks.editorLoaded;

    rerender({ narration: second });
    await act(async () => {
      settleFirst?.();
      await Promise.resolve();
    });
    expect(mocks.warmNarration).not.toHaveBeenCalled();

    await settleEditor();
    expect(mocks.warmNarration).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("does nothing once the lesson is gone", async () => {
    const { unmount } = renderHook(() => useNarrationWarmUp(player("lesson-1")));

    unmount();
    await settleEditor();
    expect(mocks.warmNarration).not.toHaveBeenCalled();
  });

  it("loads nothing ahead for a viewer who asked the browser to save data", async () => {
    vi.stubGlobal("navigator", { ...navigator, connection: { saveData: true } });
    const { result } = renderHook(() => useNarrationWarmUp(player("lesson-1")));

    await settleEditor();
    expect(result.current).toBe(false);
    expect(mocks.warmNarration).not.toHaveBeenCalled();
  });
});
