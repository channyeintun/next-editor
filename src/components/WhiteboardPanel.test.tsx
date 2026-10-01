/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
const stopFollowing = vi.fn();
let usesPlaybackModel = false;
let whiteboardState: ReturnType<typeof makeWhiteboardState>;
let whiteboardStore: WhiteboardStoreInstance;
let excalidrawOnChange: (elements: unknown[], appState: unknown, files: unknown) => void;
let excalidrawInitialData: unknown;

vi.mock("@excalidraw/excalidraw", () => {
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
      excalidrawAPI({ updateScene });
      excalidrawOnChange = onChange;
      excalidrawInitialData = initialData;
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
  useNextEditorMetadata: () => ({ usesPlaybackModel }),
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => ({
    provider: {},
    canWrite: true,
    stopFollowing,
  }),
}));

import WhiteboardPanel from "./WhiteboardPanel";

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
  };
}

describe("WhiteboardPanel scene projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usesPlaybackModel = false;
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

    render(<WhiteboardPanel />);

    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
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
    usesPlaybackModel = true;
    whiteboardStore = createWhiteboardStore();
    whiteboardState = makeWhiteboardState("external", [], recordedView);
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

  it("shows the recorded view again when the viewer's view is released", async () => {
    const view = render(<WhiteboardPanel />);
    await waitFor(() => expect(updateScene).toHaveBeenCalledTimes(1));
    act(() => excalidrawOnChange([], canvasAppState(pinchedView), {}));
    updateScene.mockClear();

    // Playback hands the canvas back to live editing (the controller releases the view).
    usesPlaybackModel = false;
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
