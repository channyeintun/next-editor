import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WebContainer } from "@webcontainer/api";
import { isWebContainerRuntimeSupported } from "./sharedContainer";

// Stands in for WebContainer.boot, which getOrBootSharedWebContainer imports lazily.
const bootWebContainer = vi.hoisted(() => vi.fn<() => Promise<WebContainer>>());

vi.mock("@webcontainer/api", () => ({ WebContainer: { boot: bootWebContainer } }));

describe("isWebContainerRuntimeSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires both cross-origin isolation and a non-mobile browser", () => {
    const desktop = {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120 Safari/537.36",
      maxTouchPoints: 0,
    };
    const phone = {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148",
      maxTouchPoints: 5,
    };

    vi.stubGlobal("navigator", desktop);
    vi.stubGlobal("crossOriginIsolated", true);
    expect(isWebContainerRuntimeSupported()).toBe(true);

    // Cross-origin isolation off → unsupported even on desktop.
    vi.stubGlobal("crossOriginIsolated", false);
    expect(isWebContainerRuntimeSupported()).toBe(false);

    // Mobile is excluded even with cross-origin isolation on.
    vi.stubGlobal("navigator", phone);
    vi.stubGlobal("crossOriginIsolated", true);
    expect(isWebContainerRuntimeSupported()).toBe(false);
  });
});

describe("shared WebContainer lifetime", () => {
  // A fresh module per test, so each one starts with no container, boot or holder.
  let sharedContainer: typeof import("./sharedContainer");

  beforeEach(async () => {
    bootWebContainer.mockReset();
    vi.resetModules();
    sharedContainer = await import("./sharedContainer");
  });

  function createStandInWebContainer() {
    return {
      setPreviewScript: vi.fn<(script: string) => Promise<void>>(async () => {}),
      teardown: vi.fn<() => void>(),
    };
  }

  type StandInWebContainer = ReturnType<typeof createStandInWebContainer>;

  function bootsInto(instance: StandInWebContainer) {
    bootWebContainer.mockResolvedValueOnce(instance as unknown as WebContainer);
  }

  /** Holds the next boot open; the returned function lands it with an instance. */
  function deferNextBoot(): (instance: StandInWebContainer) => void {
    let land: ((instance: WebContainer) => void) | null = null;
    bootWebContainer.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    return (instance) => land?.(instance as unknown as WebContainer);
  }

  it("tears down a boot that lands after the last holder let go", async () => {
    const landBoot = deferNextBoot();
    const release = sharedContainer.holdSharedWebContainer();
    const booting = sharedContainer.getOrBootSharedWebContainer();
    release();

    const orphan = createStandInWebContainer();
    landBoot(orphan);
    await booting;

    expect(orphan.teardown).toHaveBeenCalledOnce();

    // Nothing hands the torn-down container out again: the next caller boots anew.
    const next = createStandInWebContainer();
    bootsInto(next);
    await expect(sharedContainer.getOrBootSharedWebContainer()).resolves.toBe(next);
    expect(bootWebContainer).toHaveBeenCalledTimes(2);
  });

  it("keeps a boot that lands while another editor holds the container", async () => {
    const landBoot = deferNextBoot();
    const releaseFirst = sharedContainer.holdSharedWebContainer();
    const booting = sharedContainer.getOrBootSharedWebContainer();
    releaseFirst();
    const releaseSecond = sharedContainer.holdSharedWebContainer();

    const instance = createStandInWebContainer();
    landBoot(instance);
    await expect(booting).resolves.toBe(instance);

    expect(instance.teardown).not.toHaveBeenCalled();

    releaseSecond();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it("counts a holder's repeated release once", async () => {
    const instance = createStandInWebContainer();
    bootsInto(instance);
    const releaseFirst = sharedContainer.holdSharedWebContainer();
    const releaseSecond = sharedContainer.holdSharedWebContainer();
    await sharedContainer.getOrBootSharedWebContainer();

    // A second release by the same holder must not let go on the other's behalf.
    releaseFirst();
    releaseFirst();
    expect(instance.teardown).not.toHaveBeenCalled();

    releaseSecond();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });
});
