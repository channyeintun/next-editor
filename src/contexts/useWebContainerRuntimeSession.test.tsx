import { act, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";

vi.mock("../runtime/webcontainer/sharedContainer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/webcontainer/sharedContainer")>();
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

function renderRuntimeSessionHook(options: { onServerReady?: () => void } = {}) {
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

/** A runner whose output the test writes chunk by chunk and whose exit it triggers. */
function createControlledRunner() {
  let output: WritableStream<string> | null = null;
  let exit: (code: number) => void = () => {};
  const process = {
    output: {
      pipeTo: (destination: WritableStream<string>) => {
        output = destination;
        return new Promise(() => {});
      },
    },
    input: new WritableStream(),
    exit: new Promise<number>((resolve) => {
      exit = resolve;
    }),
    kill: vi.fn<() => void>(),
    resize: vi.fn<() => void>(),
  } as unknown as WebContainerProcess;

  return {
    process,
    exit: (code: number) => exit(code),
    getWriter: () => {
      if (!output) {
        throw new Error("Expected the runner's output to be piped");
      }
      return output.getWriter();
    },
  };
}

/** Renders the hook and keeps the latest render's value and the render count. */
function renderTrackedRuntimeSession() {
  const tracked: {
    hook: ReturnType<typeof useWebContainerRuntimeSession> | null;
    renders: number;
  } = { hook: null, renders: 0 };

  function Harness() {
    tracked.hook = useWebContainerRuntimeSession({ environmentVariables: {} });
    tracked.renders += 1;
    return null;
  }

  render(<Harness />);
  return tracked;
}

/** Holds requestAnimationFrame callbacks until the test runs them. */
function stubAnimationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
    frames.delete(frame);
  });

  return {
    get pending() {
      return frames.size;
    },
    run: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    },
  };
}

describe("useWebContainerRuntimeSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders streamed output once a frame while the recording snapshot sees every chunk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const frames = stubAnimationFrames();
    const { instance } = createFakeInstance();
    const runner = createControlledRunner();
    vi.mocked(instance.spawn).mockResolvedValue(runner.process);
    const tracked = renderTrackedRuntimeSession();

    await act(async () => {
      await tracked.hook?.startRunnerProcess(instance, "npm run dev");
    });
    act(() => frames.run());

    const writer = runner.getWriter();
    const rendersBeforeChunks = tracked.renders;
    await act(async () => {
      await writer.write("one\n");
      await writer.write("two\n");
      await writer.write("three\n");
    });

    expect(tracked.hook?.getRecordingSnapshot().lastOutput).toBe(
      "$ npm run dev\none\ntwo\nthree\n",
    );
    expect(tracked.hook?.lastOutput).toBe("$ npm run dev\n");
    expect(tracked.renders).toBe(rendersBeforeChunks);
    expect(frames.pending).toBe(1);

    act(() => frames.run());

    expect(tracked.hook?.lastOutput).toBe("$ npm run dev\none\ntwo\nthree\n");
    expect(tracked.renders).toBe(rendersBeforeChunks + 1);

    // A hidden tab runs no frames; the fallback timeout publishes instead.
    await act(async () => {
      await writer.write("four\n");
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(tracked.hook?.lastOutput).toBe("$ npm run dev\none\ntwo\nthree\nfour\n");
    expect(frames.pending).toBe(0);

    // The exit line renders with the exit, not a frame later.
    await act(async () => {
      await writer.write("five\n");
      runner.exit(0);
      await Promise.resolve();
    });

    expect(tracked.hook?.lastOutput).toBe(
      "$ npm run dev\none\ntwo\nthree\nfour\nfive\n\nRunner exited with code 0\n",
    );
    expect(tracked.hook?.status).toBe("ready");
    expect(frames.pending).toBe(0);
  });

  // The recorded shape keeps activeCommand for older recordings; nothing sets it.
  it("records no active command while or after a foreground command runs", async () => {
    const { instance } = createFakeInstance();
    const runner = createControlledRunner();
    vi.mocked(instance.spawn).mockResolvedValue(runner.process);
    const tracked = renderTrackedRuntimeSession();

    let exitCode: Promise<number> | undefined;
    await act(async () => {
      exitCode = tracked.hook?.runForegroundCommand(instance, "npm install");
      await Promise.resolve();
    });

    expect(tracked.hook?.getRecordingSnapshot()).toMatchObject({
      activeCommand: null,
      lastOutput: "$ npm install\n",
    });

    await act(async () => {
      runner.exit(0);
      await exitCode;
    });

    expect(await exitCode).toBe(0);
    expect(tracked.hook?.getRecordingSnapshot().activeCommand).toBeNull();
  });

  it("invokes onServerReady when the dev server reports ready with an active runner", async () => {
    const { instance, listeners } = createFakeInstance();
    const { getOrBootSharedWebContainer } = await import("../runtime/webcontainer/sharedContainer");
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
    const { getOrBootSharedWebContainer } = await import("../runtime/webcontainer/sharedContainer");
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

  // The shell fallback exists for a shell missing from the container image. A
  // terminal the user closed while its shell spawned is a cancellation: no
  // other shell should start, and nothing should be reported as an error.
  it("stops starting a terminal the user closed while its shell spawned", async () => {
    const { instance } = createFakeInstance();
    const spawned: string[] = [];
    let finishFirstSpawn: () => void = () => {};
    vi.mocked(instance.spawn).mockImplementation((async (command: string) => {
      spawned.push(command);
      if (spawned.length === 1) {
        await new Promise<void>((resolve) => {
          finishFirstSpawn = resolve;
        });
      }
      return createFakeProcess();
    }) as never);
    const hook = renderRuntimeSessionHook();

    let started: Promise<void> | undefined;
    await act(async () => {
      started = hook.createTerminalSession(instance);
      await Promise.resolve();
      hook.closeTerminalSession("terminal-1");
      finishFirstSpawn();
      await started.catch(() => undefined);
    });

    await expect(started).resolves.toBeUndefined();
    expect(spawned).toEqual(["jsh"]);
  });
});
