import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WebNode } from "../../core/webnode/api";
import { isNodeRuntimeSupported } from "./sharedNodeRuntime";

// Stands in for WebNode.boot, which getOrBootSharedNodeRuntime imports lazily.
const bootNodeRuntime = vi.hoisted(() => vi.fn<() => Promise<WebNode>>());

vi.mock("../../core/webnode/api", () => ({ WebNode: { boot: bootNodeRuntime } }));

describe("isNodeRuntimeSupported", () => {
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
    expect(isNodeRuntimeSupported()).toBe(true);

    // Cross-origin isolation off → unsupported even on desktop.
    vi.stubGlobal("crossOriginIsolated", false);
    expect(isNodeRuntimeSupported()).toBe(false);

    // Mobile is excluded even with cross-origin isolation on.
    vi.stubGlobal("navigator", phone);
    vi.stubGlobal("crossOriginIsolated", true);
    expect(isNodeRuntimeSupported()).toBe(false);
  });
});

describe("shared WebNode lifetime", () => {
  // A fresh module per test, so each one starts with no container, boot or holder.
  let sharedNodeRuntime: typeof import("./sharedNodeRuntime");
  // Settles once the boot imports the recorder payload module, also lazily.
  let previewScriptLoaded: Promise<void>;

  beforeEach(async () => {
    bootNodeRuntime.mockReset();
    let markPreviewScriptLoaded = () => {};
    previewScriptLoaded = new Promise((resolve) => {
      markPreviewScriptLoaded = resolve;
    });
    vi.doMock("./previewScript", () => {
      markPreviewScriptLoaded();
      return { createRuntimePreviewScript: () => "preview recorder script" };
    });
    vi.resetModules();
    sharedNodeRuntime = await import("./sharedNodeRuntime");
  });

  function createStandInNodeRuntime() {
    return {
      setPreviewScript: vi.fn<(script: string) => Promise<void>>(async () => {}),
      teardown: vi.fn<() => void>(),
    };
  }

  type StandInNodeRuntime = ReturnType<typeof createStandInNodeRuntime>;

  function bootsInto(instance: StandInNodeRuntime) {
    bootNodeRuntime.mockResolvedValueOnce(instance as unknown as WebNode);
  }

  /** Holds the next boot open; the returned function lands it with an instance. */
  function deferNextBoot(): (instance: StandInNodeRuntime) => void {
    let land: ((instance: WebNode) => void) | null = null;
    bootNodeRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        land = resolve;
      }),
    );
    return (instance) => land?.(instance as unknown as WebNode);
  }

  it("tears down a boot that lands after the last holder let go", async () => {
    const landBoot = deferNextBoot();
    const release = sharedNodeRuntime.holdSharedNodeRuntime();
    const booting = sharedNodeRuntime.getOrBootSharedNodeRuntime();
    release();

    const orphan = createStandInNodeRuntime();
    landBoot(orphan);
    await booting;

    expect(orphan.teardown).toHaveBeenCalledOnce();

    // Nothing hands the torn-down container out again: the next caller boots anew.
    const next = createStandInNodeRuntime();
    bootsInto(next);
    await expect(sharedNodeRuntime.getOrBootSharedNodeRuntime()).resolves.toBe(next);
    expect(bootNodeRuntime).toHaveBeenCalledTimes(2);
  });

  it("keeps a boot that lands while another editor holds the container", async () => {
    const landBoot = deferNextBoot();
    const releaseFirst = sharedNodeRuntime.holdSharedNodeRuntime();
    const booting = sharedNodeRuntime.getOrBootSharedNodeRuntime();
    releaseFirst();
    const releaseSecond = sharedNodeRuntime.holdSharedNodeRuntime();

    const instance = createStandInNodeRuntime();
    landBoot(instance);
    await expect(booting).resolves.toBe(instance);

    expect(instance.teardown).not.toHaveBeenCalled();

    releaseSecond();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  it("fetches the preview recorder while booting and installs it before handing the container out", async () => {
    const landBoot = deferNextBoot();
    const booting = sharedNodeRuntime.getOrBootSharedNodeRuntime();
    // The boot has not landed yet, so only a fetch started alongside it gets here.
    await previewScriptLoaded;

    const instance = createStandInNodeRuntime();
    landBoot(instance);
    await expect(booting).resolves.toBe(instance);

    expect(instance.setPreviewScript).toHaveBeenCalledExactlyOnceWith("preview recorder script");
  });

  it("tears down a boot that a reset gave up on, and boots the next caller afresh after it", async () => {
    const landFirstBoot = deferNextBoot();
    const joined = sharedNodeRuntime.getOrBootSharedNodeRuntime();
    sharedNodeRuntime.resetSharedNodeRuntime();
    const second = createStandInNodeRuntime();
    bootsInto(second);
    const next = sharedNodeRuntime.getOrBootSharedNodeRuntime("runtime");
    // Only one WebNode boots at a time: the next boot waits for the first.
    await vi.waitFor(() => expect(bootNodeRuntime).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bootNodeRuntime).toHaveBeenCalledOnce();

    const first = createStandInNodeRuntime();
    landFirstBoot(first);

    await expect(joined).resolves.toBe(first);
    expect(first.teardown).toHaveBeenCalledOnce();
    await expect(next).resolves.toBe(second);
    expect(bootNodeRuntime).toHaveBeenCalledTimes(2);
    await expect(sharedNodeRuntime.getOrBootSharedNodeRuntime()).resolves.toBe(second);
  });

  it("gives the runtime its own container in place of one only the agent used", async () => {
    const agentOnly = createStandInNodeRuntime();
    bootsInto(agentOnly);
    await sharedNodeRuntime.getOrBootSharedNodeRuntime();
    const own = createStandInNodeRuntime();
    bootsInto(own);

    await expect(sharedNodeRuntime.getOrBootSharedNodeRuntime("runtime")).resolves.toBe(own);
    expect(agentOnly.teardown).toHaveBeenCalledOnce();

    // From then on the agent joins the runtime's container, and so does the runtime.
    await expect(sharedNodeRuntime.getOrBootSharedNodeRuntime()).resolves.toBe(own);
    await expect(sharedNodeRuntime.getOrBootSharedNodeRuntime("runtime")).resolves.toBe(own);
    expect(own.teardown).not.toHaveBeenCalled();
  });

  it("counts a holder's repeated release once", async () => {
    const instance = createStandInNodeRuntime();
    bootsInto(instance);
    const releaseFirst = sharedNodeRuntime.holdSharedNodeRuntime();
    const releaseSecond = sharedNodeRuntime.holdSharedNodeRuntime();
    await sharedNodeRuntime.getOrBootSharedNodeRuntime();

    // A second release by the same holder must not let go on the other's behalf.
    releaseFirst();
    releaseFirst();
    expect(instance.teardown).not.toHaveBeenCalled();

    releaseSecond();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });
});
