import { describe, expect, it, vi } from "vite-plus/test";
import type { PreviewEvent, PreviewPanelMode, PreviewState } from "../types/slides";
import type { StudioPreviewCommand } from "../utils/iframeStudioCommandBridge";
import { createStudioDriver, StudioActionError, type StudioDriverDeps } from "./driver";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn(),
}));

function makeDriver() {
  let previewState = { isOpen: false } as PreviewState;
  const previewEvents: PreviewEvent[] = [];
  const startRuntime = vi.fn(async () => {});
  const executeCommand = vi.fn(async (command: StudioPreviewCommand) => ({
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
  const captureScreenshot = vi.fn(async () => ({
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
      getProject: () => ({}) as never,
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
    runtime: {
      kind: "webcontainer",
      adapterVersion: 1,
      defaultMode: "live",
      initCommand: "npm ci --no-audit --no-fund",
      runCommand: "npm run dev",
      expectedPort: 5173,
      lockfilePath: "package-lock.json",
      environment: {},
    },
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

    await driver.startRuntime();
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
