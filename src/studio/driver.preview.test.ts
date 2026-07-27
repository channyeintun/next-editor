import { describe, expect, it, vi } from "vite-plus/test";
import type { PreviewEvent, PreviewPanelMode, PreviewState } from "../types/slides";
import { createStudioDriver, StudioActionError, type StudioDriverDeps } from "./driver";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

function makeDriver(options: { lessonType?: "python" | "typescript" } = {}) {
  let previewState = { isOpen: false } as PreviewState;
  const previewEvents: PreviewEvent[] = [];
  const startRuntime = vi.fn<() => Promise<void>>(async () => {});
  const executeCommand = vi.fn<StudioDriverDeps["preview"]["executeCommand"]>(async (command) => ({
    command: command.type,
    route: "/hello?name=Ada",
    scrollLeft: 0,
    scrollTop: 0,
    ...(command.type === "inspect"
      ? {
          target: {
            attributes: { "data-state": "ready", "data-testid": "greeting" },
            tagName: "output",
            testId: "greeting",
            text: "Hello, Ada!",
            value: null,
          },
        }
      : {}),
  }));
  const captureScreenshot = vi.fn<StudioDriverDeps["preview"]["captureScreenshot"]>(async () => ({
    dataUrl: "data:image/png;base64,cHJldmlldw==",
    height: 480,
    width: 640,
  }));
  const snapshot = {
    status: "ready",
    previewUrl: "https://preview.local",
    previewPort: 5173,
    errorMessage: null,
    latestPreviewMessage: null,
  } as ReturnType<StudioDriverDeps["webContainerRuntime"]["getSnapshot"]>;

  const deps = {
    getEditor: () => null,
    workspace: {
      getFile: () => null,
      getProject: () => ({ lessonType: options.lessonType ?? "typescript" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    runtimePanelStore: {} as StudioDriverDeps["runtimePanelStore"],
    slidesStore: {} as StudioDriverDeps["slidesStore"],
    whiteboardStore: {} as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: () => {},
    notifyPreviewEvent: (event: PreviewEvent) => previewEvents.push(event),
    runtimeMode: "live",
    runtime: (options.lessonType === "python"
      ? {
          kind: "webcontainer",
          adapterVersion: 1,
          defaultMode: "live",
          initCommand: "",
          runCommand: "python3 main.py",
          environment: {},
        }
      : {
          kind: "webcontainer",
          adapterVersion: 1,
          defaultMode: "live",
          initCommand: "npm ci --no-audit --no-fund",
          runCommand: "npm run dev",
          expectedPort: 5173,
          lockfilePath: "package-lock.json",
          environment: {},
        }) as StudioDriverDeps["runtime"],
    planSeed: 29,
    whiteboardAssets: [],
    webContainerRuntime: {
      getActions: () => ({
        startRuntime,
        resetRuntime: () => {},
        configureRuntime: () => {},
      }),
      getMetadata: () => ({}) as never,
      getSnapshot: () => snapshot,
    },
    preview: {
      open: (mode: PreviewPanelMode) => {
        previewState = { ...previewState, isOpen: true, mode };
      },
      close: () => {
        previewState = { ...previewState, isOpen: false };
      },
      getState: () => previewState,
      executeCommand,
      captureScreenshot,
    },
    signal: new AbortController().signal,
  } satisfies StudioDriverDeps;

  return {
    captureScreenshot,
    driver: createStudioDriver(deps),
    executeCommand,
    previewEvents,
    snapshot,
    startRuntime,
  };
}

describe("StudioDriver WebContainer preview adapter", () => {
  it("starts, awaits, opens, acknowledges, and records a DOM checkpoint", async () => {
    const { driver, executeCommand, previewEvents, startRuntime } = makeDriver();

    await driver.startRuntime(100);
    await driver.waitForRuntimeReady(100);
    await driver.openPreview({ mode: "docked", timeoutMs: 100 });
    await driver.executePreviewCommand({
      command: { type: "input", target: { testId: "name-input" }, value: "Ada" },
      timeoutMs: 100,
    });
    await driver.expectPreview({
      actionId: "expect-greeting",
      target: { by: "testId", value: "greeting" },
      textContains: "Hello, Ada!",
      route: "/hello?name=Ada",
      attribute: { name: "data-state", value: "ready" },
      timeoutMs: 100,
    });

    expect(startRuntime).toHaveBeenCalledOnce();
    expect(executeCommand.mock.calls.map(([command]) => command.type)).toEqual([
      "ping",
      "input",
      "inspect",
    ]);
    expect(previewEvents).toEqual([
      expect.objectContaining({
        type: "preview_checkpoint",
        checkpoint: expect.objectContaining({
          actionId: "expect-greeting",
          route: "/hello?name=Ada",
          target: expect.objectContaining({ testId: "greeting", text: "Hello, Ada!" }),
        }),
      }),
    ]);
  });

  it("keeps knocking until the frame has loaded the injected bridge", async () => {
    const { driver, executeCommand } = makeDriver();
    // The frame is still navigating to the dev server, so the command message
    // lands in a document with no listener and the request can only time out.
    let unloadedAttempts = 1;
    executeCommand.mockImplementation(async (command, options) => {
      if (unloadedAttempts > 0) {
        unloadedAttempts -= 1;
        await new Promise((resolve) => window.setTimeout(resolve, options.timeoutMs));
        throw new Error(`Preview command timed out after ${options.timeoutMs}ms`);
      }
      return { command: command.type, route: "/", scrollLeft: 0, scrollTop: 0 };
    });

    await expect(driver.openPreview({ mode: "docked", timeoutMs: 2_000 })).resolves.toMatchObject({
      bridge: "ready",
    });
    // One dropped ping must not spend the action's whole budget: the second
    // attempt is what proves the handshake re-sends rather than waiting.
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("fails inside its own budget when the preview bridge never answers", async () => {
    const { driver, executeCommand } = makeDriver();
    executeCommand.mockImplementation(async (_command, options) => {
      await new Promise((resolve) => window.setTimeout(resolve, options.timeoutMs));
      throw new Error(`Preview command timed out after ${options.timeoutMs}ms`);
    });

    const startedAt = performance.now();
    await expect(driver.openPreview({ mode: "docked", timeoutMs: 1_200 })).rejects.toMatchObject({
      name: StudioActionError.name,
      message: expect.stringContaining("did not become ready within 1200ms"),
      detail: expect.objectContaining({
        runtime: expect.objectContaining({ previewPort: 5173 }),
      }),
    });
    // The Performer races this call against the same timeoutMs, so overrunning
    // it would replace this diagnostic with a bare "did not acknowledge".
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("does not acknowledge a Python runtime until its one-shot process exits cleanly", async () => {
    const { driver, snapshot, startRuntime } = makeDriver({ lessonType: "python" });
    Object.assign(snapshot, {
      status: "starting",
      previewUrl: null,
      previewPort: null,
    });
    startRuntime.mockImplementationOnce(async () => {
      window.setTimeout(() => {
        Object.assign(snapshot, { status: "ready" });
      }, 20);
    });

    let settled = false;
    const result = driver.startRuntime(250).then((detail) => {
      settled = true;
      return detail;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(result).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a Python runtime whose one-shot process exits with an error", async () => {
    const { driver, snapshot, startRuntime } = makeDriver({ lessonType: "python" });
    Object.assign(snapshot, {
      status: "starting",
      errorMessage: null,
      previewUrl: null,
      previewPort: null,
    });
    startRuntime.mockImplementationOnce(async () => {
      window.setTimeout(() => {
        Object.assign(snapshot, {
          status: "error",
          errorMessage: 'Command "python3 main.py" exited with code 1',
        });
      }, 20);
    });

    await expect(driver.startRuntime(250)).rejects.toThrow("exited with code 1");
  });

  it("fails closed and attaches one screenshot when the DOM is wrong", async () => {
    const { captureScreenshot, driver } = makeDriver();

    await expect(
      driver.expectPreview({
        actionId: "expect-wrong-copy",
        target: { by: "testId", value: "greeting" },
        textContains: "Goodbye",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: StudioActionError.name,
      detail: expect.objectContaining({
        diagnosticScreenshot: expect.objectContaining({ width: 640, height: 480 }),
      }),
    });
    expect(captureScreenshot).toHaveBeenCalledOnce();
  });

  it("fails closed when the target is missing or the preview server errors", async () => {
    const missingTarget = makeDriver();
    missingTarget.executeCommand.mockRejectedValueOnce(
      new Error('Preview target data-testid="missing" was not found'),
    );
    await expect(
      missingTarget.driver.expectPreview({
        actionId: "expect-missing",
        target: { by: "testId", value: "missing" },
        textContains: "Ready",
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/was not found/);
    expect(missingTarget.captureScreenshot).toHaveBeenCalledOnce();

    const serverError = makeDriver();
    Object.assign(serverError.snapshot, {
      errorMessage: "Vite exited before opening its port",
      status: "error",
    });
    await expect(
      serverError.driver.expectPreview({
        actionId: "expect-after-server-error",
        route: "/",
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/Vite exited before opening its port/);
    expect(serverError.captureScreenshot).toHaveBeenCalledOnce();
  });
});
