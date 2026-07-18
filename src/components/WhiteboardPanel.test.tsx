/* oxlint-disable vitest/require-mock-type-parameters */
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhiteboardElementJSON, WhiteboardSceneState } from "../core/src/whiteboard";
import type { WhiteboardSceneUpdateSource } from "../stores/whiteboardStore";

const updateScene = vi.fn();
const stopFollowing = vi.fn();
let usesPlaybackModel = false;
let whiteboardState: ReturnType<typeof makeWhiteboardState>;

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
    Excalidraw: ({ excalidrawAPI }: { excalidrawAPI: (api: unknown) => void }) => {
      excalidrawAPI({ updateScene });
      return null;
    },
    MainMenu,
  };
});
vi.mock("../contexts/WhiteboardContext", () => ({
  useWhiteboardContext: () => whiteboardState,
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
) {
  const scene: WhiteboardSceneState = {
    elements,
    view: { scrollX: 0, scrollY: 0, zoom: 1 },
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
