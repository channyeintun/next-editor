import { act, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { describe, expect, it, vi } from "vite-plus/test";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";

vi.mock("./webContainerRuntimeSupport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webContainerRuntimeSupport")>();
  return {
    ...actual,
    getOrBootSharedWebContainer: vi.fn<() => Promise<WebContainer>>(),
  };
});

function createFakeProcess(): WebContainerProcess {
  return {
    output: new ReadableStream(),
    input: new WritableStream(),
    exit: new Promise(() => {}),
    kill: vi.fn<() => void>(),
    resize: vi.fn<() => void>(),
  } as unknown as WebContainerProcess;
}

function createFakeInstance() {
  const listeners = new Map<string, (...args: unknown[]) => void>();

  const instance = {
    on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => () => void>(
      (event, handler) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
    ),
    spawn: vi.fn<() => Promise<WebContainerProcess>>(async () => createFakeProcess()),
    setPreviewScript: vi.fn<() => Promise<void>>(async () => {}),
  } as unknown as WebContainer;

  return { instance, listeners };
}

function renderRuntimeSessionHook(options: { onServerReady: () => void }) {
  const captured: {
    hook: ReturnType<typeof useWebContainerRuntimeSession> | null;
  } = { hook: null };

  function Harness() {
    captured.hook = useWebContainerRuntimeSession({
      environmentVariables: {},
      onServerReady: options.onServerReady,
    });
    return null;
  }

  render(<Harness />);

  if (!captured.hook) {
    throw new Error("Expected runtime session hook to render");
  }

  return captured.hook;
}

describe("useWebContainerRuntimeSession", () => {
  it("invokes onServerReady when the dev server reports ready with an active runner", async () => {
    const { instance, listeners } = createFakeInstance();
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const onServerReady = vi.fn<() => void>();
    const hook = renderRuntimeSessionHook({ onServerReady });

    await act(async () => {
      await hook.bootInstance();
    });

    await act(async () => {
      await hook.startRunnerProcess(instance, "npm run dev");
    });

    const serverReadyHandler = listeners.get("server-ready");
    expect(serverReadyHandler).toBeDefined();

    act(() => {
      serverReadyHandler?.(3000, "http://localhost:3000");
    });

    expect(onServerReady).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onServerReady before a runner process has started", async () => {
    const { instance, listeners } = createFakeInstance();
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const onServerReady = vi.fn<() => void>();
    const hook = renderRuntimeSessionHook({ onServerReady });
    await act(async () => {
      await hook.bootInstance();
    });

    const serverReadyHandler = listeners.get("server-ready");

    act(() => {
      serverReadyHandler?.(3000, "http://localhost:3000");
    });

    expect(onServerReady).not.toHaveBeenCalled();
  });
});
