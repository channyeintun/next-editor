import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RECORDED_CURSOR_VISIBILITY_EVENT } from "../core/src/utils/recordedCursorVisibility";
import type { StudioPreviewTargetBox } from "../utils/iframeStudioCommandBridge";
import { createStudioDriver, type StudioDriverDeps } from "./driver";
import { previewPointAim } from "./driver/webContainer";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

const VIEWPORT = { viewportWidth: 800, viewportHeight: 600 };

describe("previewPointAim", () => {
  it("points from just under the middle of a line's words", () => {
    expect(
      previewPointAim({
        left: 0,
        top: 100,
        width: 600,
        height: 40,
        ...VIEWPORT,
        content: { left: 20, top: 104, width: 200, height: 32 },
      }),
    ).toEqual({ x: 120, y: 138 });
  });

  it("uses the element's own box when it reports no content box", () => {
    expect(previewPointAim({ left: 100, top: 100, width: 200, height: 40, ...VIEWPORT })).toEqual({
      x: 200,
      y: 142,
    });
  });

  it("points at the middle of a region taller than a line", () => {
    expect(previewPointAim({ left: 100, top: 100, width: 400, height: 300, ...VIEWPORT })).toEqual({
      x: 300,
      y: 250,
    });
  });

  it("points at the middle of the visible part of a region below the fold", () => {
    expect(previewPointAim({ left: 0, top: 400, width: 800, height: 600, ...VIEWPORT })).toEqual({
      x: 400,
      y: 500,
    });
  });

  it("points at the middle of a line whose underside would leave the viewport", () => {
    expect(previewPointAim({ left: 0, top: 570, width: 100, height: 30, ...VIEWPORT })).toEqual({
      x: 50,
      y: 585,
    });
  });

  it("has no aim for an element off screen or without size", () => {
    expect(previewPointAim({ left: 0, top: 700, width: 100, height: 30, ...VIEWPORT })).toBeNull();
    expect(previewPointAim({ left: 100, top: 100, width: 0, height: 0, ...VIEWPORT })).toBeNull();
  });
});

const TITLE_BOX: StudioPreviewTargetBox = {
  left: 0,
  top: 100,
  width: 800,
  height: 40,
  ...VIEWPORT,
  content: { left: 20, top: 104, width: 200, height: 32 },
};

function inspected(targetBox: StudioPreviewTargetBox) {
  return { command: "inspect" as const, route: "/", scrollLeft: 0, scrollTop: 0, targetBox };
}

function makeDriver(runtime?: StudioDriverDeps["runtime"]) {
  const executeCommand = vi.fn<StudioDriverDeps["preview"]["executeCommand"]>(async () =>
    inspected(TITLE_BOX),
  );
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
      getProject: () => ({ lessonType: "typescript" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    notifyRuntimeEvent: () => {},
    runtimePanelStore: {} as StudioDriverDeps["runtimePanelStore"],
    slidesStore: {} as StudioDriverDeps["slidesStore"],
    whiteboardStore: {} as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: () => {},
    notifyPreviewEvent: () => {},
    runtimeMode: "live",
    runtime:
      runtime ??
      ({
        kind: "webcontainer",
        adapterVersion: 1,
        defaultMode: "live",
        initCommand: "npm ci --no-audit --no-fund",
        runCommand: "npm run dev",
        expectedPort: 5173,
        lockfilePath: "package-lock.json",
        environment: {},
      } as StudioDriverDeps["runtime"]),
    planSeed: 29,
    whiteboardAssets: [],
    webContainerRuntime: {
      getActions: () => ({
        startRuntime: async () => {},
        resetRuntime: () => {},
        configureRuntime: () => {},
      }),
      getMetadata: () => ({}) as never,
      getSnapshot: () => snapshot,
    },
    preview: {
      open: () => {},
      close: () => {},
      getState: () => ({ isOpen: true }) as never,
      executeCommand,
      captureScreenshot: async () => ({ dataUrl: "data:image/png;base64,", width: 1, height: 1 }),
    },
    signal: new AbortController().signal,
  } satisfies StudioDriverDeps;

  return { driver: createStudioDriver(deps), executeCommand };
}

/** The preview frame inside the app root, at (500, 100) and 400×300: half the page's 800×600. */
function mountPreviewFrame() {
  const app = document.createElement("div");
  app.setAttribute("data-cursor-replay-target", "app");
  const frame = document.createElement("iframe");
  frame.setAttribute("data-cursor-replay-target", "preview-frame");
  app.append(frame);
  document.body.append(app);
  frame.getBoundingClientRect = () =>
    ({
      left: 500,
      top: 100,
      width: 400,
      height: 300,
      right: 900,
      bottom: 400,
      x: 500,
      y: 100,
    }) as DOMRect;
  return frame;
}

const POINT = { target: { by: "testId" as const, value: "title" }, durationMs: 800 };

describe("StudioDriver pointPreview", () => {
  let visibility: { x: number; y: number; visible: boolean }[] = [];
  const onVisibility = (event: Event) => {
    visibility.push((event as CustomEvent<{ x: number; y: number; visible: boolean }>).detail);
  };

  beforeEach(() => {
    visibility = [];
    // jsdom has no PointerEvent; the driver only needs a MouseEvent's fields.
    if (typeof globalThis.PointerEvent === "undefined") {
      vi.stubGlobal("PointerEvent", MouseEvent);
    }
    window.addEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
  });

  afterEach(() => {
    window.removeEventListener(RECORDED_CURSOR_VISIBILITY_EVENT, onVisibility);
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("asks the bridge where the element is and reveals the pointer under its words", async () => {
    mountPreviewFrame();
    const { driver, executeCommand } = makeDriver();

    const result = await driver.pointPreview({ ...POINT, timeoutMs: 1_000 });

    expect(executeCommand).toHaveBeenCalledWith(
      { type: "inspect", target: { testId: "title" } },
      expect.anything(),
    );
    // (120, 138) in the 800×600 page, scaled into the 400×300 frame at (500, 100).
    expect(visibility.filter((entry) => entry.visible)).toEqual([
      { x: 560, y: 169, visible: true },
    ]);
    expect(result).toEqual({ testId: "title", travelMs: 0 });
  });

  it("fails for an element scrolled out of the preview's view", async () => {
    mountPreviewFrame();
    const { driver, executeCommand } = makeDriver();
    executeCommand.mockResolvedValue(inspected({ ...TITLE_BOX, top: 900, content: undefined }));

    await expect(driver.pointPreview({ ...POINT, timeoutMs: 1_000 })).rejects.toThrow(
      /scrolled out of the preview's view/,
    );
  });

  it("keeps looking for a missing element, then fails with the bridge's reason", async () => {
    mountPreviewFrame();
    const { driver, executeCommand } = makeDriver();
    executeCommand.mockRejectedValue(new Error('Preview target data-testid="title" was not found'));

    const failure = driver.pointPreview({ ...POINT, timeoutMs: 250 });

    await expect(failure).rejects.toThrow("could not be found");
    await expect(failure).rejects.toThrow('Preview target data-testid="title" was not found');
    expect(executeCommand.mock.calls.length).toBeGreaterThan(1);
  });

  it("points at an element that mounts on the second look", async () => {
    mountPreviewFrame();
    const { driver, executeCommand } = makeDriver();
    executeCommand.mockRejectedValueOnce(
      new Error('Preview target data-testid="title" was not found'),
    );

    await expect(driver.pointPreview({ ...POINT, timeoutMs: 1_000 })).resolves.toEqual({
      testId: "title",
      travelMs: 0,
    });
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("refuses a runtime that has no preview", async () => {
    mountPreviewFrame();
    const { driver, executeCommand } = makeDriver({
      kind: "rust-playground",
    } as StudioDriverDeps["runtime"]);

    await expect(driver.pointPreview({ ...POINT, timeoutMs: 1_000 })).rejects.toThrow(
      /requires runtime kind "webcontainer"/,
    );
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
