import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyView: vi.fn(),
  closePresentation: vi.fn(),
  handleSlideEvent: vi.fn(),
  publishSurface: vi.fn(),
  runFollowApplication: vi.fn((application: () => void) => application()),
  setActiveFilePath: vi.fn(),
  setWhiteboardOpen: vi.fn(),
}));

let collaborationState: Record<string, unknown>;
let slidesState: Record<string, unknown>;
let whiteboardState: Record<string, unknown>;
let activeFilePath = "index.html";
let workspaceTreeVersion = 0;

vi.mock("../contexts/CollaborationContext", () => ({
  useCollaboration: () => collaborationState,
}));
vi.mock("../contexts/SlidesContext", () => ({ useSlidesContext: () => slidesState }));
vi.mock("../contexts/WhiteboardContext", () => ({
  useWhiteboardContext: () => whiteboardState,
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ usesPlaybackModel: false }),
}));
vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActiveFilePath: () => activeFilePath,
  useWorkspaceTreeVersion: () => workspaceTreeVersion,
  useWorkspaceActions: () => ({ setActiveFilePath: mocks.setActiveFilePath }),
}));

import CollaborationSurfaceBridge from "./CollaborationSurfaceBridge";

function participant(revision: number, surface: Record<string, unknown>) {
  return {
    sessionId: "20000000-0000-4000-8000-000000000002",
    revision,
    surface,
  };
}

function resetState() {
  activeFilePath = "index.html";
  workspaceTreeVersion = 0;
  collaborationState = {
    provider: {},
    connectionState: "live",
    followedParticipant: participant(1, { kind: "slides", isMaximized: true }),
    teaching: { currentSlideId: "slide-1" },
    publishSurface: mocks.publishSurface,
    runFollowApplication: mocks.runFollowApplication,
    getNodeIdForPath: (path: string) => (path === "index.html" ? "file-1" : "file-2"),
    getPathForNodeId: (nodeId: string) => (nodeId === "file-2" ? "lesson.ts" : null),
  };
  slidesState = {
    previewState: {
      isOpen: false,
      isMaximized: false,
      currentSlideId: "slide-1",
    },
    closePresentation: mocks.closePresentation,
    handleSlideEvent: mocks.handleSlideEvent,
  };
  whiteboardState = {
    isOpen: false,
    scene: {
      isMaximized: false,
      view: { scrollX: 0, scrollY: 0, zoom: 1 },
    },
    setOpen: mocks.setWhiteboardOpen,
    applyView: mocks.applyView,
  };
}

describe("CollaborationSurfaceBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("applies only the selected session's latest cross-surface view", async () => {
    const view = render(<CollaborationSurfaceBridge />);
    expect(mocks.handleSlideEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "slide_open", slideId: "slide-1" }),
    );

    collaborationState = {
      ...collaborationState,
      followedParticipant: participant(2, {
        kind: "whiteboard",
        isMaximized: true,
        viewport: { scrollX: 25, scrollY: -10, zoom: 2 },
      }),
    };
    slidesState = {
      ...slidesState,
      previewState: { isOpen: true, isMaximized: true, currentSlideId: "slide-1" },
    };
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));
    expect(mocks.closePresentation).toHaveBeenCalled();
    expect(mocks.setWhiteboardOpen).toHaveBeenCalledWith(true);
    expect(mocks.applyView).toHaveBeenCalledWith({ scrollX: 25, scrollY: -10, zoom: 2 }, true);

    collaborationState = {
      ...collaborationState,
      followedParticipant: participant(3, {
        kind: "editor",
        fileNodeId: "file-2",
        viewport: null,
      }),
    };
    slidesState = {
      ...slidesState,
      previewState: { isOpen: false, isMaximized: false, currentSlideId: "slide-1" },
    };
    whiteboardState = { ...whiteboardState, isOpen: true };
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));
    expect(mocks.setWhiteboardOpen).toHaveBeenLastCalledWith(false);
    expect(mocks.setActiveFilePath).toHaveBeenCalledWith("lesson.ts");
    view.unmount();
  });

  it("repairs a legacy both-open state with whiteboard winning", () => {
    collaborationState = { ...collaborationState, followedParticipant: null };
    slidesState = {
      ...slidesState,
      previewState: { isOpen: true, isMaximized: true, currentSlideId: "slide-1" },
    };
    whiteboardState = { ...whiteboardState, isOpen: true };
    const view = render(<CollaborationSurfaceBridge />);

    expect(mocks.closePresentation).toHaveBeenCalledTimes(1);
    expect(mocks.runFollowApplication).toHaveBeenCalled();
    view.unmount();
  });

  it("retries the same target revision after its editor file becomes projectable", async () => {
    collaborationState = {
      ...collaborationState,
      followedParticipant: participant(4, {
        kind: "editor",
        fileNodeId: "late-file",
        viewport: null,
      }),
      getPathForNodeId: () => null,
    };
    const view = render(<CollaborationSurfaceBridge />);
    expect(mocks.setActiveFilePath).not.toHaveBeenCalled();

    collaborationState.getPathForNodeId = (nodeId: string) =>
      nodeId === "late-file" ? "late.ts" : null;
    workspaceTreeVersion += 1;
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));

    expect(mocks.setActiveFilePath).toHaveBeenCalledWith("late.ts");
    view.unmount();
  });
});
