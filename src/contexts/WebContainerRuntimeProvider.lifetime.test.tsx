import { act, cleanup, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import {
  getOrBootSharedWebContainer,
  holdSharedWebContainer,
  teardownSharedWebContainer,
} from "./webContainerRuntimeSupport";
import { useWebContainerRuntimeActions } from "../hooks/useWebContainerRuntime";
import type { WebContainerRuntimeActions } from "./WebContainerRuntimeContext";

// Only the boot is faked: the shared container's lifetime is the real one.
const bootWebContainer = vi.hoisted(() => vi.fn<() => Promise<WebContainer>>());

vi.mock("@webcontainer/api", () => ({ WebContainer: { boot: bootWebContainer } }));

function createStandInWebContainer() {
  return {
    setPreviewScript: vi.fn<(script: string) => Promise<void>>(async () => {}),
    teardown: vi.fn<() => void>(),
    on: vi.fn<() => () => void>(() => () => {}),
    mount: vi.fn<() => Promise<void>>(async () => {}),
  };
}

type StandInWebContainer = ReturnType<typeof createStandInWebContainer>;

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

async function renderEditor({ runner = false } = {}) {
  let runtime: WebContainerRuntimeActions | null = null;

  function Capture() {
    runtime = useWebContainerRuntimeActions();
    return null;
  }

  const view = render(
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={false}>
        <Capture />
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>,
  );

  const getRuntime = () => {
    if (!runtime) {
      throw new Error("Expected the runtime provider to render");
    }
    return runtime;
  };

  // No install and, unless asked, no runner: once the boot lands, starting only
  // mounts the project.
  await act(async () => {
    getRuntime().updateRunnerConfig(
      runner ? { initCommand: "" } : { enabled: false, initCommand: "" },
    );
  });

  /** Starts the runtime and returns the start, which settles once the boot lands. */
  const startRuntime = () => {
    let starting: Promise<void> = Promise.resolve();
    act(() => {
      starting = getRuntime().startRuntime();
    });
    return starting;
  };

  return { startRuntime, unmount: view.unmount };
}

describe("WebContainerRuntimeProvider shared container lifetime", () => {
  beforeEach(() => {
    bootWebContainer.mockReset();
    // isWebContainerRuntimeSupported() gates the runtime on cross-origin isolation.
    vi.stubGlobal("crossOriginIsolated", true);
  });

  // The shared container is module state, so a test that leaves one behind would
  // hand it to the next. Unmount what a failed test left mounted, check that a new
  // holder boots afresh and that its release is the last, and clear the container
  // either way.
  afterEach(async () => {
    vi.unstubAllGlobals();
    cleanup();

    const fresh = createStandInWebContainer();
    const freshInstance = fresh as unknown as WebContainer;
    bootWebContainer.mockReset();
    bootWebContainer.mockResolvedValueOnce(freshInstance);
    const release = holdSharedWebContainer();
    const shared = await getOrBootSharedWebContainer();
    release();
    const releasedLast = fresh.teardown.mock.calls.length === 1;
    teardownSharedWebContainer(shared);

    if (shared !== freshInstance) {
      throw new Error("The test left the shared container behind");
    }
    if (!releasedLast) {
      throw new Error("The test left a holder of the shared container behind");
    }
  });

  it("tears down a container whose boot lands after the editor left", async () => {
    const landBoot = deferNextBoot();
    const editor = await renderEditor();
    const starting = editor.startRuntime();
    editor.unmount();

    const instance = createStandInWebContainer();
    await act(async () => {
      landBoot(instance);
      await starting;
    });

    expect(instance.teardown).toHaveBeenCalledOnce();
    expect(instance.mount).not.toHaveBeenCalled();
  });

  it("hands a boot the previous editor left behind to the editor that replaced it", async () => {
    const landBoot = deferNextBoot();
    const previous = await renderEditor();
    void previous.startRuntime();
    previous.unmount();

    const next = await renderEditor();
    const starting = next.startRuntime();
    const instance = createStandInWebContainer();
    await act(async () => {
      landBoot(instance);
      await starting;
    });

    expect(bootWebContainer).toHaveBeenCalledOnce();
    expect(instance.mount).toHaveBeenCalledOnce();
    expect(instance.teardown).not.toHaveBeenCalled();

    next.unmount();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  // The provider resets before it releases, so its processes are stopped before
  // the container they run in is torn down.
  it("stops the editor's runner before it tears the container down", async () => {
    const kill = vi.fn<() => void>();
    const instance = {
      ...createStandInWebContainer(),
      // A dev server that keeps running.
      spawn: vi.fn<() => Promise<WebContainerProcess>>(
        async () =>
          ({
            output: new ReadableStream({ start: (controller) => controller.close() }),
            input: new WritableStream(),
            exit: new Promise<number>(() => {}),
            kill,
            resize: vi.fn<() => void>(),
          }) as unknown as WebContainerProcess,
      ),
    };
    bootWebContainer.mockResolvedValueOnce(instance as unknown as WebContainer);
    const editor = await renderEditor({ runner: true });
    const starting = editor.startRuntime();
    await act(async () => {
      await starting;
    });
    expect(instance.spawn).toHaveBeenCalledOnce();

    editor.unmount();

    expect(kill).toHaveBeenCalledOnce();
    expect(instance.teardown).toHaveBeenCalledOnce();
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(
      instance.teardown.mock.invocationCallOrder[0],
    );
  });
});
