/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  WhiteboardElementJSON,
  WhiteboardSceneState,
  WhiteboardView,
} from "../core/src/whiteboard";
import {
  createWhiteboardStore,
  type WhiteboardSceneUpdateSource,
  type WhiteboardStoreInstance,
} from "../stores/whiteboardStore";

const updateScene = vi.fn();
// What the canvas holds after updateScene, as Excalidraw tidied it.
let canvasElements: unknown[] = [];
const getSceneElementsIncludingDeleted = vi.fn(() => canvasElements);
// The canvas's gesture state, read before a refit.
let canvasAppState: Record<string, unknown> = { cursorButton: "up" };
const getAppState = vi.fn(() => canvasAppState);
// Excalidraw hands over one API object per mounted canvas.
const excalidrawApi = { updateScene, getSceneElementsIncludingDeleted, getAppState };
const stopFollowing = vi.fn();
let usesPlaybackModel = false;
let isInPlaybackSession = false;
let whiteboardState: ReturnType<typeof makeWhiteboardState>;
let whiteboardStore: WhiteboardStoreInstance;
let excalidrawOnChange: (elements: unknown[], appState: unknown, files: unknown) => void;
let excalidrawInitialData: unknown;
// When set, the mocked canvas reports this view from its commit phase, the way
// Excalidraw's componentDidUpdate calls onChange before the panel's effects run.
let viewReportedOnCommit: WhiteboardView | null = null;

vi.mock("@excalidraw/excalidraw", async () => {
  const { useLayoutEffect } = await import("react");
  const Empty = () => null;
  const MainMenu = Object.assign(Empty, {
    DefaultItems: {
      LoadScene: Empty,
      SaveToActiveFile: Empty,
      Export: Empty,
      SaveAsImage: Empty,
      SearchMenu: Empty,
      Help: Empty,
      ClearCanvas: Empty,
      ChangeCanvasBackground: Empty,
    },
    Separator: Empty,
  });
  return {
    CaptureUpdateAction: { NEVER: "never" },
    Excalidraw: ({
      excalidrawAPI,
      onChange,
      initialData,
    }: {
      excalidrawAPI: (api: unknown) => void;
      onChange: typeof excalidrawOnChange;
      initialData: unknown;
    }) => {
      excalidrawAPI(excalidrawApi);
      excalidrawOnChange = onChange;
      excalidrawInitialData = initialData;
      useLayoutEffect(() => {
        if (!viewReportedOnCommit) return;
        const { scrollX, scrollY, zoom } = viewReportedOnCommit;
        onChange([], { scrollX, scrollY, zoom: { value: zoom } }, {});
      });
      return null;
    },
    MainMenu,
  };
});
vi.mock("../contexts/WhiteboardContext", () => ({
  useWhiteboardContext: () => whiteboardState,
}));
vi.mock("../contexts/WhiteboardStoreContext", () => ({
  useWhiteboardStore: () => ({ store: whiteboardStore }),
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ usesPlaybackModel, isInPlaybackSession }),
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => ({
    provider: {},
    canWrite: true,
    stopFollowing,
  }),
}));

import WhiteboardPanel from "./WhiteboardPanel";
import { clearTextMeasurements } from "../utils/whiteboardTextFit";

function element(id: string, points: number[][]): WhiteboardElementJSON {
  return { id, version: 1, versionNonce: 1, isDeleted: false, type: "freedraw", points };
}

function makeWhiteboardState(
  sceneUpdateSource: WhiteboardSceneUpdateSource,
  elements: WhiteboardElementJSON[] = [],
  view: WhiteboardView = { scrollX: 0, scrollY: 0, zoom: 1 },
) {
  const scene: WhiteboardSceneState = {
    elements,
    view,
    isOpen: true,
    isMaximized: false,
  };
  return {
    scene,
    sceneUpdateSource,
    isOpen: true,
    setOpen: vi.fn(),
    setMaximized: vi.fn(),
    handleExcalidrawChange: vi.fn(),
    markCanvasSynced: vi.fn(),
  };
}

describe("WhiteboardPanel scene projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasElements = [];
    usesPlaybackModel = false;
    isInPlaybackSession = false;
    whiteboardState = makeWhiteboardState("external");
    whiteboardStore = createWhiteboardStore();
  });

  it("does not feed a throttled canvas checkpoint back into the active gesture", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));

    const partialStroke = element("stroke", [[0, 0]]);
    whiteboardState = makeWhiteboardState("canvas", [partialStroke]);
    view.rerender(<WhiteboardPanel />);
    await Promise.resolve();
    expect(updateScene).toHaveBeenCalledTimes(1);

    const remoteStroke = element("remote", [
      [0, 0],
      [1, 1],
    ]);
    whiteboardState = makeWhiteboardState("external", [partialStroke, remoteStroke]);
    view.rerender(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(2));
    expect(updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        elements: expect.arrayContaining([expect.objectContaining({ id: "remote" })]),
      }),
    );
  });

  it("continues applying playback scenes regardless of their store origin", async () => {
    whiteboardState = makeWhiteboardState("canvas", [element("recorded", [[0, 0]])]);
    usesPlaybackModel = true;
    isInPlaybackSession = true;

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
  });

  it("tells the controller what the canvas holds after each scene it is given", async () => {
    const authored = element("box", [[0, 0]]);
    // Excalidraw gives an authored element a z-order index and bumps its version.
    const tidied = { ...authored, version: 2, versionNonce: 7, index: "a0" };
    canvasElements = [tidied];
    whiteboardState = makeWhiteboardState("external", [authored]);

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    expect(whiteboardState.markCanvasSynced).toHaveBeenCalledExactlyOnceWith(
      [tidied],
      whiteboardState.scene.elements,
    );
  });

  it("treats the first report of a new canvas as its loaded scene, not an edit", async () => {
    const appState = { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
    render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    vi.mocked(whiteboardState.markCanvasSynced).mockClear();

    const loaded = [element("box", [[0, 0]])];
    act(() => excalidrawOnChange(loaded, appState, {}));
    expect(whiteboardState.markCanvasSynced).toHaveBeenCalledExactlyOnceWith(loaded);
    expect(whiteboardState.handleExcalidrawChange).not.toHaveBeenCalled();

    const drawn = [element("box", [[0, 0]]), element("stroke", [[0, 0]])];
    act(() => excalidrawOnChange(drawn, appState, {}));
    expect(whiteboardState.handleExcalidrawChange).toHaveBeenCalledExactlyOnceWith(
      drawn,
      { scrollX: 0, scrollY: 0, zoom: 1 },
      false,
    );
  });

  it("does not copy the canvas on every playback frame", async () => {
    usesPlaybackModel = true;
    isInPlaybackSession = true;

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    expect(getSceneElementsIncludingDeleted).not.toHaveBeenCalled();
    expect(whiteboardState.markCanvasSynced).not.toHaveBeenCalled();
  });
});

describe("WhiteboardPanel playback viewport", () => {
  const recordedView = { scrollX: 0, scrollY: 0, zoom: 1 };
  const pinchedView = { scrollX: -150, scrollY: 60, zoom: 2.4 };
  const canvasAppState = (view: WhiteboardView) => ({
    scrollX: view.scrollX,
    scrollY: view.scrollY,
    zoom: { value: view.zoom },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    canvasElements = [];
    usesPlaybackModel = true;
    isInPlaybackSession = true;
    viewReportedOnCommit = null;
    whiteboardStore = createWhiteboardStore();
    whiteboardState = makeWhiteboardState("external", [], recordedView);
  });

  it("still follows recorded views after a pan made before PLAY", async () => {
    // The lesson is loaded (ready): no session yet, the canvas is live.
    usesPlaybackModel = false;
    isInPlaybackSession = false;
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    act(() => excalidrawOnChange([], canvasAppState(recordedView), {}));

    // The viewer drags the board; the controller flushes a canvas-origin scene,
    // which the panel does not feed back to the canvas.
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    expect(whiteboardState.handleExcalidrawChange).toHaveBeenCalledWith([], pinchedView, false);
    whiteboardState = makeWhiteboardState("canvas", [], pinchedView);
    view.rerender(<WhiteboardPanel />);
    expect(updateScene).toHaveBeenCalledTimes(1);

    // PLAY: the canvas re-renders (now in view mode) and reports the pre-play pan
    // before the panel's scene effect applies the replay's first scene.
    viewReportedOnCommit = pinchedView;
    usesPlaybackModel = true;
    isInPlaybackSession = true;
    whiteboardState = makeWhiteboardState("external", [], recordedView);
    view.rerender(<WhiteboardPanel />);
    viewReportedOnCommit = null;

    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toBeNull();
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith(
        expect.objectContaining({ appState: canvasAppState(recordedView) }),
      ),
    );
    act(() => excalidrawOnChange([], canvasAppState(recordedView), {}));

    // A later recorded view still moves the canvas.
    const pannedByRecording = { scrollX: 200, scrollY: 0, zoom: 1 };
    whiteboardState = makeWhiteboardState("external", [], pannedByRecording);
    view.rerender(<WhiteboardPanel />);
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith(
        expect.objectContaining({ appState: canvasAppState(pannedByRecording) }),
      ),
    );
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toBeNull();
  });

  it("follows recorded views until the viewer pans or zooms, then only updates content", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    expect(updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ appState: canvasAppState(recordedView) }),
    );

    // Excalidraw's onChange after our own updateScene echoes the applied view.
    act(() => excalidrawOnChange([], canvasAppState(recordedView), {}));
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toBeNull();

    // A later recorded view still moves the canvas.
    const pannedByRecording = { scrollX: 200, scrollY: 0, zoom: 1 };
    whiteboardState = makeWhiteboardState("external", [], pannedByRecording);
    view.rerender(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(2));
    expect(updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ appState: canvasAppState(pannedByRecording) }),
    );
    act(() => excalidrawOnChange([], canvasAppState(pannedByRecording), {}));
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toBeNull();

    // The viewer pinches.
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pinchedView);
    expect(whiteboardState.handleExcalidrawChange).not.toHaveBeenCalled();
    updateScene.mockClear();

    // The next recorded change draws a stroke and moves the recorded view.
    whiteboardState = makeWhiteboardState("external", [element("stroke", [[0, 0]])], {
      scrollX: 900,
      scrollY: -40,
      zoom: 0.5,
    });
    view.rerender(<WhiteboardPanel />);
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith(
        expect.objectContaining({
          elements: [expect.objectContaining({ id: "stroke" })],
        }),
      ),
    );
    for (const [update] of updateScene.mock.calls) expect(update).not.toHaveProperty("appState");

    // The onChange that follows the content-only update does not look like the viewer.
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pinchedView);
    expect(whiteboardState.handleExcalidrawChange).not.toHaveBeenCalled();
  });

  it("keeps the viewer's view through a pause and the resume after it", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    updateScene.mockClear();

    // PAUSE hands the workspace to the viewer (usesPlaybackModel goes false) while the
    // session goes on. The last replay write left the scene external.
    usesPlaybackModel = false;
    view.rerender(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    expect(updateScene.mock.calls[0]?.[0]).not.toHaveProperty("appState");

    // Paused, the canvas is editable: onChange takes the live path as before, and a pan
    // still belongs to the viewer.
    const pannedWhilePaused = { scrollX: -400, scrollY: 90, zoom: 3 };
    act(() => excalidrawOnChange([], canvasAppState(pannedWhilePaused), {}));
    expect(whiteboardState.handleExcalidrawChange).toHaveBeenCalledWith(
      [],
      pannedWhilePaused,
      false,
    );
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pannedWhilePaused);

    // PLAY reattaches and the replay writes the recorded scene again.
    usesPlaybackModel = true;
    whiteboardState = makeWhiteboardState("external", [element("stroke", [[0, 0]])], recordedView);
    view.rerender(<WhiteboardPanel />);
    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith(
        expect.objectContaining({ elements: [expect.objectContaining({ id: "stroke" })] }),
      ),
    );
    for (const [update] of updateScene.mock.calls) expect(update).not.toHaveProperty("appState");
  });

  it("lets a pan made while paused outlast the resume", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    act(() => excalidrawOnChange([], canvasAppState(recordedView), {}));

    usesPlaybackModel = false;
    view.rerender(<WhiteboardPanel />);
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    expect(whiteboardStore.getSnapshot().context.playbackViewerView).toEqual(pinchedView);
    updateScene.mockClear();

    usesPlaybackModel = true;
    whiteboardState = makeWhiteboardState("external", [], { scrollX: 700, scrollY: 0, zoom: 1 });
    view.rerender(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalled());
    for (const [update] of updateScene.mock.calls) expect(update).not.toHaveProperty("appState");
  });

  it("shows the recorded view again when the playback session ends", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    updateScene.mockClear();

    // STOP ends the session (the controller releases the view in a layout effect).
    usesPlaybackModel = false;
    isInPlaybackSession = false;
    act(() => whiteboardStore.trigger.releasePlaybackViewerView());
    view.rerender(<WhiteboardPanel />);

    await waitFor(() =>
      expect(updateScene).toHaveBeenLastCalledWith(
        expect.objectContaining({ appState: canvasAppState(recordedView) }),
      ),
    );
    // Live edits go back through the controller, as before.
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    expect(whiteboardState.handleExcalidrawChange).toHaveBeenCalledWith([], pinchedView, false);
  });

  it("reopens on the viewer's view during the same playback", async () => {
    act(() =>
      whiteboardStore.trigger.observePlaybackCanvasView({
        view: pinchedView,
        appliedView: recordedView,
      }),
    );

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    expect(excalidrawInitialData).toMatchObject({ appState: canvasAppState(pinchedView) });
    expect(updateScene.mock.calls[0]?.[0]).not.toHaveProperty("appState");
  });
});

describe("WhiteboardPanel text sizing", () => {
  // The fake canvas measures every character this wide, whatever the font.
  let glyphWidth = 20;
  let fonts: EventTarget & { ready: Promise<void> };

  function text(id: string, value: string, width: number): WhiteboardElementJSON {
    return {
      id,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      type: "text",
      x: 290,
      y: 160,
      width,
      height: 46,
      text: value,
      fontSize: 36,
      fontFamily: 1,
      lineHeight: 1.25,
      textAlign: "left",
      containerId: null,
      autoResize: true,
    };
  }

  function pushedElements(call: number): WhiteboardElementJSON[] {
    return (updateScene.mock.calls[call][0] as { elements: WhiteboardElementJSON[] }).elements;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    canvasElements = [];
    canvasAppState = { cursorButton: "up" };
    usesPlaybackModel = false;
    isInPlaybackSession = false;
    whiteboardState = makeWhiteboardState("external");
    whiteboardStore = createWhiteboardStore();
    glyphWidth = 20;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (line: string) => ({ width: line.length * glyphWidth }),
    } as never);
    clearTextMeasurements();
    fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "fonts");
  });

  it("hands Excalidraw text sized to its measured glyphs, leaving the scene's own copy alone", async () => {
    // Burmese drawn in the system fallback font runs wider than the authored box.
    const title = text("title", "Compound type က", 100);
    whiteboardState = makeWhiteboardState("external", [title]);

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalled());
    const width = "Compound type က".length * 20;
    expect(pushedElements(0)[0]).toMatchObject({ id: "title", x: 290, y: 160, width });
    expect(
      (excalidrawInitialData as { elements: WhiteboardElementJSON[] }).elements[0],
    ).toMatchObject({ width });
    expect(title.width).toBe(100);
  });

  it("fits the canvas's text again once fonts finish loading", async () => {
    const title = text("title", "Compound", 160);
    canvasElements = [title];
    whiteboardState = makeWhiteboardState("external", [title]);
    render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    await act(async () => {
      await fonts.ready;
    });
    // 8 glyphs at 20px fit the 160px box: nothing to refit yet.
    expect(updateScene).toHaveBeenCalledTimes(1);
    vi.mocked(whiteboardState.markCanvasSynced).mockClear();

    // Excalidraw's own font arrives and the same text measures wider.
    glyphWidth = 30;
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });

    expect(updateScene).toHaveBeenCalledTimes(2);
    expect(pushedElements(1)[0]).toMatchObject({ id: "title", x: 290, width: 240 });
    // A fit is not an edit, so the canvas baseline (and any edit waiting to be
    // saved) is left to the controller, which ignores fit-only changes.
    expect(whiteboardState.markCanvasSynced).not.toHaveBeenCalled();
  });

  it("fits text that arrives through the canvas itself, such as a loaded scene", async () => {
    render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    await act(async () => {
      await fonts.ready;
    });

    // Load scene puts text measured on another machine straight into the canvas.
    canvasElements = [text("loaded", "Compound type က", 100)];
    act(() => {
      excalidrawOnChange(canvasElements, { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, {});
    });

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(2));
    expect(pushedElements(1)[0]).toMatchObject({
      id: "loaded",
      width: "Compound type က".length * 20,
    });
  });

  it("waits for a gesture on the canvas to end before refitting", async () => {
    canvasElements = [text("title", "Compound", 160)];
    render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    await act(async () => {
      await fonts.ready;
    });

    vi.useFakeTimers();
    glyphWidth = 30;
    canvasAppState = { selectedElementsAreBeingDragged: true };
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(updateScene).toHaveBeenCalledTimes(1);

    canvasAppState = { selectedElementsAreBeingDragged: false };
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(updateScene).toHaveBeenCalledTimes(2);
    expect(pushedElements(1)[0]).toMatchObject({ width: 240 });
  });
});
