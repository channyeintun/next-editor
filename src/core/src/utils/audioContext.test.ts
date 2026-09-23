import { afterEach, describe, expect, it, vi } from "vite-plus/test";

class SuspendedAudioContext {
  state: AudioContextState = "suspended";
  resume = vi.fn<() => Promise<void>>(() => Promise.resolve());
}

describe("resumeSharedAudioContext", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Every play/pause click and every seek asks for the unlock. While the context is
  // still suspended each call used to add four more window listeners, and a context
  // that never reaches "running" kept them for the life of the page.
  it("installs one set of gesture listeners however often it is asked", async () => {
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const addListener = vi.spyOn(window, "addEventListener");
    const { resumeSharedAudioContext } = await import("./audioContext");

    const context = resumeSharedAudioContext();
    expect(resumeSharedAudioContext()).toBe(context);

    expect(addListener).toHaveBeenCalledTimes(4);
    expect(context.resume).toHaveBeenCalledTimes(2);
  });

  it("stops listening once a gesture gets the context running", async () => {
    vi.stubGlobal("AudioContext", SuspendedAudioContext);
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { resumeSharedAudioContext } = await import("./audioContext");

    const context = resumeSharedAudioContext() as unknown as SuspendedAudioContext;
    context.state = "running";
    window.dispatchEvent(new Event("mousedown"));
    await Promise.resolve();

    expect(removeListener).toHaveBeenCalledTimes(4);

    resumeSharedAudioContext();
    expect(addListener).toHaveBeenCalledTimes(4);
  });
});
