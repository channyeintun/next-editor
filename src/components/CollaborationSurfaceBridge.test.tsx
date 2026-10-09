import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { useCollaboration } from "../contexts/CollaborationContext";
import type { useSlidesContext } from "../contexts/SlidesContext";
import type { WorkspaceActions } from "../stores/workspaceActions";
import type { useWhiteboardContext } from "../contexts/WhiteboardContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;
type SlidesContextValue = ReturnType<typeof useSlidesContext>;
type WhiteboardContextValue = ReturnType<typeof useWhiteboardContext>;

const mocks = vi.hoisted(() => ({
  applyView: vi.fn<WhiteboardContextValue["applyView"]>(),
  closePresentation: vi.fn<SlidesContextValue["closePresentation"]>(),
  handleSlideEvent: vi.fn<SlidesContextValue["handleSlideEvent"]>(),
  publishSurface: vi.fn<CollaborationContextValue["publishSurface"]>(),
  runFollowApplication: vi.fn<CollaborationContextValue["runFollowApplication"]>((application) =>
    application(),
  ),
  setActiveFilePath: vi.fn<WorkspaceActions["setActiveFilePath"]>(),
  setWhiteboardOpen: vi.fn<WhiteboardContextValue["setOpen"]>(),
}));

let collaborationState: Record<string, unknown>;
let presenceState: Record<string, unknown>;
let slidesState: Record<string, unknown>;
let whiteboardState: Record<string, unknown>;
let activeFilePath = "index.html";
let workspaceTreeVersion = 0;

vi.mock("../contexts/CollaborationContext", () => ({
  useCollaboration: () => collaborationState,
}));
vi.mock("../contexts/collaboration/RoomPresenceContext", () => ({
  useRoomPresence: () => presenceState,
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

const TARGET_ACTOR_ID = "30000000-0000-4000-8000-000000000003";

function participant(
  revision: number,
  surface: Record<string, unknown>,
  actorId = TARGET_ACTOR_ID,
) {
  return {
    actorId,
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
    teaching: { currentSlideId: "slide-1" },
    publishSurface: mocks.publishSurface,
    runFollowApplication: mocks.runFollowApplication,
    getNodeIdForPath: (path: string) => (path === "index.html" ? "file-1" : "file-2"),
    getPathForNodeId: (nodeId: string) => (nodeId === "file-2" ? "lesson.ts" : null),
  };
  presenceState = {
    followedParticipantKey: `${TARGET_ACTOR_ID}:20000000-0000-4000-8000-000000000002`,
    followedParticipant: participant(1, { kind: "slides", isMaximized: true }),
    surfaceRepublishVersion: 0,
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

    presenceState = {
      ...presenceState,
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

    presenceState = {
      ...presenceState,
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

  it("applies a new target that shares the previous target's session ID", async () => {
    presenceState = {
      ...presenceState,
      followedParticipant: participant(5, { kind: "editor", fileNodeId: "file-2", viewport: null }),
    };
    const view = render(<CollaborationSurfaceBridge />);
    expect(mocks.setActiveFilePath).toHaveBeenCalledWith("lesson.ts");

    // Another member reusing the session ID, at a lower revision of their own.
    presenceState = {
      ...presenceState,
      followedParticipant: participant(
        3,
        { kind: "whiteboard", isMaximized: false, viewport: { scrollX: 5, scrollY: 5, zoom: 1 } },
        "30000000-0000-4000-8000-000000000004",
      ),
    };
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));

    expect(mocks.setWhiteboardOpen).toHaveBeenCalledWith(true);
    expect(mocks.applyView).toHaveBeenCalledWith({ scrollX: 5, scrollY: 5, zoom: 1 }, false);
    view.unmount();
  });

  it("repairs a legacy both-open state with whiteboard winning", () => {
    presenceState = { ...presenceState, followedParticipant: null };
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

  // While following, the provider drops what the bridge publishes; a stop
  // changes only room presence, not the rest of the collaboration state.
  it("publishes the surface it shows once following stops", async () => {
    presenceState = {
      ...presenceState,
      followedParticipant: participant(1, { kind: "editor", fileNodeId: null, viewport: null }),
    };
    const view = render(<CollaborationSurfaceBridge />);
    const editorSurface = { kind: "editor", fileNodeId: "file-1", viewport: null };
    expect(mocks.publishSurface).toHaveBeenCalledTimes(1);

    presenceState = { ...presenceState, followedParticipantKey: null, followedParticipant: null };
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));

    expect(mocks.publishSurface).toHaveBeenCalledTimes(2);
    expect(mocks.publishSurface).toHaveBeenLastCalledWith(editorSurface);
    view.unmount();
  });

  it("republishes the current surface when the provider asks for it", async () => {
    presenceState = { ...presenceState, followedParticipantKey: null, followedParticipant: null };
    const view = render(<CollaborationSurfaceBridge />);
    const editorSurface = { kind: "editor", fileNodeId: "file-1", viewport: null };
    expect(mocks.publishSurface).toHaveBeenCalledTimes(1);
    expect(mocks.publishSurface).toHaveBeenLastCalledWith(editorSurface);

    presenceState = { ...presenceState, surfaceRepublishVersion: 1 };
    await act(async () => view.rerender(<CollaborationSurfaceBridge />));

    expect(mocks.publishSurface).toHaveBeenCalledTimes(2);
    expect(mocks.publishSurface).toHaveBeenLastCalledWith(editorSurface);
    view.unmount();
  });

  it("retries the same target revision after its editor file becomes projectable", async () => {
    collaborationState = { ...collaborationState, getPathForNodeId: () => null };
    presenceState = {
      ...presenceState,
      followedParticipant: participant(4, {
        kind: "editor",
        fileNodeId: "late-file",
        viewport: null,
      }),
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
