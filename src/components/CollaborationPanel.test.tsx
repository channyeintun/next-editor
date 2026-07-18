import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useCollaboration } from "../contexts/CollaborationContext";

type CollaborationContextValue = ReturnType<typeof useCollaboration>;

const mocks = vi.hoisted(() => ({
  followParticipant: vi.fn<CollaborationContextValue["followParticipant"]>(),
  stopFollowing: vi.fn<CollaborationContextValue["stopFollowing"]>(),
}));

let collaborationState: Record<string, unknown>;

vi.mock("@next-editor/infra", () => ({
  avatarProxyUrl: (url: string) => url,
  signInUrl: (url: string) => url,
  useAuth: () => ({ isSignedIn: true }),
}));

vi.mock("../contexts/CollaborationContext", () => ({
  useCollaboration: () => collaborationState,
}));

import CollaborationPanel from "./CollaborationPanel";

const OWN_SESSION = "10000000-0000-4000-8000-000000000001";

function participant({
  actorId,
  sessionId,
  name,
  role,
  surface,
  isHost = false,
}: {
  actorId: string;
  sessionId: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  surface: Record<string, unknown>;
  isHost?: boolean;
}) {
  return {
    kind: "state",
    roomId: "20000000-0000-4000-8000-000000000001",
    actorId,
    sessionId,
    revision: 1,
    role,
    username: name.toLowerCase(),
    name,
    avatarUrl: null,
    isHost,
    surface,
    cursor: null,
    occurredAt: 1,
    expiresAt: Date.now() + 30_000,
  };
}

function makeCollaborationState(followedSessionId: string | null = null) {
  const participants = [
    participant({
      actorId: "30000000-0000-4000-8000-000000000001",
      sessionId: OWN_SESSION,
      name: "Self",
      role: "viewer",
      surface: { kind: "editor", fileNodeId: null, viewport: null },
    }),
    participant({
      actorId: "30000000-0000-4000-8000-000000000002",
      sessionId: "40000000-0000-4000-8000-000000000002",
      name: "Ada",
      role: "owner",
      isHost: true,
      surface: {
        kind: "editor",
        fileNodeId: "50000000-0000-4000-8000-000000000001",
        viewport: null,
      },
    }),
    participant({
      actorId: "30000000-0000-4000-8000-000000000003",
      sessionId: "40000000-0000-4000-8000-000000000003",
      name: "Grace",
      role: "editor",
      surface: { kind: "slides", isMaximized: true },
    }),
    participant({
      actorId: "30000000-0000-4000-8000-000000000004",
      sessionId: "40000000-0000-4000-8000-000000000004",
      name: "Lin",
      role: "viewer",
      surface: {
        kind: "whiteboard",
        isMaximized: false,
        viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
      },
    }),
  ];
  const followedParticipant =
    participants.find((item) => item.sessionId === followedSessionId) ?? null;
  return {
    provider: { awarenessSessionId: OWN_SESSION },
    connectionState: "live",
    role: "viewer",
    isHost: false,
    hasOfflineChanges: false,
    participants,
    followedSessionId,
    followedParticipant,
    teaching: {
      initialized: true,
      currentSlideId: "slide-2",
      slideOrder: ["slide-1", "slide-2"],
    },
    teachingSlides: [{ id: "slide-1" }, { id: "slide-2" }],
    isTeachingLoading: false,
    canRetryAssets: false,
    members: [],
    invitations: [],
    error: null,
    getPathForNodeId: () => "src/index.ts",
    followParticipant: mocks.followParticipant,
    stopFollowing: mocks.stopFollowing,
    clearError: vi.fn<CollaborationContextValue["clearError"]>(),
    createRoom: vi.fn<CollaborationContextValue["createRoom"]>(),
    retry: vi.fn<CollaborationContextValue["retry"]>(),
    initializeTeachingSurfaces: vi.fn<CollaborationContextValue["initializeTeachingSurfaces"]>(),
    createInvitation: vi.fn<CollaborationContextValue["createInvitation"]>(),
    updateMemberRole: vi.fn<CollaborationContextValue["updateMemberRole"]>(),
    removeMember: vi.fn<CollaborationContextValue["removeMember"]>(),
    revokeInvitation: vi.fn<CollaborationContextValue["revokeInvitation"]>(),
    exportRoom: vi.fn<CollaborationContextValue["exportRoom"]>(),
    retryAssets: vi.fn<CollaborationContextValue["retryAssets"]>(),
    closeRoom: vi.fn<CollaborationContextValue["closeRoom"]>(),
    leaveRoom: vi.fn<CollaborationContextValue["leaveRoom"]>(),
  };
}

describe("CollaborationPanel follow actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborationState = makeCollaborationState();
  });

  it("offers an accessible follow action for every remote role but never for self", () => {
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    expect(screen.queryByRole("button", { name: "Follow Self" })).toBeNull();
    for (const name of ["Ada", "Grace", "Lin"]) {
      const button = screen.getByRole("button", { name: `Follow ${name}` });
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("Slides · 2/2")).toBeInTheDocument();
    expect(screen.getByText("Whiteboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Follow Grace" }));
    expect(mocks.followParticipant).toHaveBeenCalledWith("40000000-0000-4000-8000-000000000003");
  });

  it("marks the exact followed session as pressed and exposes keyboard-operable stop", () => {
    collaborationState = makeCollaborationState("40000000-0000-4000-8000-000000000002");
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const stop = screen.getByRole("button", { name: "Stop following Ada" });
    expect(stop).toHaveAttribute("aria-pressed", "true");
    stop.focus();
    fireEvent.keyDown(stop, { key: "Enter" });
    fireEvent.click(stop);
    expect(mocks.stopFollowing).toHaveBeenCalledWith("user");
  });

  it("offers asset retry only for a retryable hydration failure", () => {
    collaborationState = {
      ...makeCollaborationState(),
      error: "Room permissions could not be refreshed.",
    };
    const view = render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));
    expect(screen.queryByRole("button", { name: "Retry shared assets" })).toBeNull();

    collaborationState = {
      ...collaborationState,
      error: "The shared presentation could not be downloaded.",
      canRetryAssets: true,
    };
    view.rerender(<CollaborationPanel />);
    expect(screen.getByRole("button", { name: "Retry shared assets" })).toBeInTheDocument();
  });
});
