import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

// One state stands in for both of the collaboration provider's contexts.
vi.mock("../contexts/CollaborationContext", () => ({
  useCollaboration: () => collaborationState,
}));
vi.mock("../contexts/collaboration/RoomPresenceContext", () => ({
  useRoomPresence: () => collaborationState,
}));

// Voice UI behavior has its own suite (CollaborationPanel.voice.test.tsx);
// here voice is server-disabled so the panel renders without voice controls.
vi.mock("../contexts/CollaborationVoiceContext", () => ({
  useCollaborationVoice: () => ({
    subscribe: () => () => undefined,
    getState: () => null,
    join: () => undefined,
    leave: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    retry: () => undefined,
    enableAudio: () => undefined,
  }),
  useCollaborationVoiceState: () => ({
    state: "unavailable",
    unavailableReason: "feature-disabled",
    errorCode: null,
    wantsMicrophone: false,
    autoplayBlocked: false,
    roster: [],
    isLocalSpeaking: false,
  }),
}));

import CollaborationPanel from "./CollaborationPanel";
import { collaborationParticipantKey } from "../collaboration/participantKey";

const OWN_SESSION = "10000000-0000-4000-8000-000000000001";
const OWN_ACTOR_ID = "30000000-0000-4000-8000-000000000001";

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

function makeCollaborationState(followedParticipantKey: string | null = null) {
  const participants = [
    participant({
      actorId: OWN_ACTOR_ID,
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
    participants.find((item) => collaborationParticipantKey(item) === followedParticipantKey) ??
    null;
  return {
    provider: { awarenessSessionId: OWN_SESSION },
    connectionState: "live",
    role: "viewer",
    isHost: false,
    hasOfflineChanges: false,
    participants,
    ownParticipantKey: collaborationParticipantKey({
      actorId: OWN_ACTOR_ID,
      sessionId: OWN_SESSION,
    }),
    followedParticipantKey,
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

    expect(screen.queryByRole("button", { name: "Following Self" })).toBeNull();
    for (const name of ["Ada", "Grace", "Lin"]) {
      const button = screen.getByRole("button", { name: `Following ${name}` });
      expect(button).toHaveAttribute("aria-pressed", "false");
      expect(button).toHaveAccessibleDescription(`Follow ${name}`);
    }
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("Slides · 2/2")).toBeInTheDocument();
    expect(screen.getByText("Whiteboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Following Grace" }));
    expect(mocks.followParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "30000000-0000-4000-8000-000000000003",
        sessionId: "40000000-0000-4000-8000-000000000003",
      }),
    );
  });

  it("marks only this member's own session as (you)", () => {
    const state = makeCollaborationState();
    const reusingOwnSession = participant({
      actorId: "30000000-0000-4000-8000-000000000005",
      sessionId: OWN_SESSION,
      name: "Mallory",
      role: "viewer",
      surface: { kind: "editor", fileNodeId: null, viewport: null },
    });
    collaborationState = { ...state, participants: [...state.participants, reusingOwnSession] };
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    expect(screen.getByText("Self (you)")).toBeInTheDocument();
    expect(screen.getByText("Mallory")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Following Mallory" }));
    expect(mocks.followParticipant).toHaveBeenCalledWith(reusingOwnSession);
  });

  it("marks the exact followed session as pressed and exposes keyboard-operable stop", () => {
    collaborationState = makeCollaborationState(
      collaborationParticipantKey({
        actorId: "30000000-0000-4000-8000-000000000002",
        sessionId: "40000000-0000-4000-8000-000000000002",
      }),
    );
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const stop = screen.getByRole("button", { name: "Following Ada" });
    expect(stop).toHaveAttribute("aria-pressed", "true");
    expect(stop).toHaveAccessibleDescription("Stop following Ada");
    stop.focus();
    fireEvent.keyDown(stop, { key: "Enter" });
    fireEvent.click(stop);
    expect(mocks.stopFollowing).toHaveBeenCalledWith("user");
  });

  it("names the panel by its level-2 title, above its level-3 sections", () => {
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const panel = screen.getByRole("dialog", { name: "Live collaboration" });
    expect(within(panel).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Live collaboration",
    );
    expect(
      within(panel).getByRole("heading", { level: 3, name: "Online now" }),
    ).toBeInTheDocument();
  });

  it("returns focus to the header button when the panel is closed", () => {
    render(<CollaborationPanel />);
    const trigger = screen.getByRole("button", { name: /^Live/ });
    fireEvent.click(trigger);

    const close = screen.getByRole("button", { name: "Close collaboration panel" });
    close.focus();
    fireEvent.click(close);

    expect(screen.queryByRole("dialog", { name: "Live collaboration" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
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

describe("CollaborationPanel participant surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborationState = makeCollaborationState();
  });

  /** The line under a participant's name that says what they have open. */
  function surfaceOf(name: string) {
    return screen.getByText(name).nextElementSibling?.textContent;
  }

  it("describes a participant on slides by the state of the shared slide", () => {
    collaborationState = { ...makeCollaborationState(), isTeachingLoading: true };
    const view = render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));
    expect(surfaceOf("Grace")).toBe("Loading shared slide…");

    collaborationState = { ...makeCollaborationState(), teachingSlides: null };
    view.rerender(<CollaborationPanel />);
    expect(surfaceOf("Grace")).toBe("Shared slide unavailable");

    const state = makeCollaborationState();
    collaborationState = { ...state, teaching: { ...state.teaching, currentSlideId: "slide-9" } };
    view.rerender(<CollaborationPanel />);
    expect(surfaceOf("Grace")).toBe("Slides");
  });

  it("names the file a participant has open, or just the editor when it is unknown", () => {
    const view = render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));
    expect(surfaceOf("Ada")).toBe("index.ts");
    expect(surfaceOf("Self (you)")).toBe("Editor");

    collaborationState = { ...makeCollaborationState(), getPathForNodeId: () => null };
    view.rerender(<CollaborationPanel />);
    expect(surfaceOf("Ada")).toBe("Editor");
  });
});

/** The room as its owner sees it: two members and three invitations, one revoked. */
function makeOwnerCollaborationState() {
  const member = (userId: string, name: string, role: "owner" | "editor" | "viewer") => ({
    userId,
    role,
    username: name.toLowerCase(),
    name,
    avatarUrl: null,
    joinedAt: 1,
    updatedAt: 1,
  });
  const invitation = (id: string, role: "editor" | "viewer", revokedAt: number | null = null) => ({
    id,
    roomId: "20000000-0000-4000-8000-000000000001",
    role,
    maxUses: 10,
    useCount: role === "editor" ? 2 : 0,
    expiresAt: Date.now() + 86_400_000,
    revokedAt,
    createdAt: 1,
  });
  return {
    ...makeCollaborationState(),
    role: "owner",
    members: [
      member("30000000-0000-4000-8000-000000000002", "Ada", "owner"),
      member("30000000-0000-4000-8000-000000000003", "Grace", "editor"),
    ],
    invitations: [
      invitation("70000000-0000-4000-8000-000000000001", "editor"),
      invitation("70000000-0000-4000-8000-000000000002", "viewer"),
      invitation("70000000-0000-4000-8000-000000000003", "viewer", 1),
    ],
  };
}

describe("CollaborationPanel lists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collaborationState = makeCollaborationState();
  });

  /** The list under one of the panel's section headings. */
  function listUnder(heading: string) {
    const section = screen.getByRole("heading", { name: heading }).closest("section");
    if (!section) throw new Error(`No section for ${heading}`);
    return within(section).getByRole("list");
  }

  it("lists the people online, one item each", () => {
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const items = within(listUnder("Online now")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Self (you)"),
      expect.stringContaining("Ada"),
      expect.stringContaining("Grace"),
      expect.stringContaining("Lin"),
    ]);
    expect(within(items[1]).getByRole("button", { name: "Following Ada" })).toBeInTheDocument();
  });

  it("shows the waiting message instead of an empty online list", () => {
    collaborationState = { ...makeCollaborationState(), participants: [] };
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const section = screen.getByRole("heading", { name: "Online now" }).closest("section");
    if (!section) throw new Error("No section for Online now");
    expect(within(section).queryByRole("list")).toBeNull();
    expect(within(section).getByText("Waiting for presence…")).toBeInTheDocument();
  });

  it("lists the members and the unrevoked invitations for the room owner", () => {
    collaborationState = makeOwnerCollaborationState();
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const members = within(listUnder("Members")).getAllByRole("listitem");
    expect(members.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Ada"),
      expect.stringContaining("Grace"),
    ]);
    expect(
      within(members[1]).getByRole("combobox", { name: "Role for Grace" }),
    ).toBeInTheDocument();

    const invitations = within(listUnder("Active invitation records")).getAllByRole("listitem");
    expect(invitations.map((item) => item.textContent)).toEqual([
      expect.stringContaining("editor · 2/10 used"),
      expect.stringContaining("viewer · 0/10 used"),
    ]);
  });

  it("names each Revoke button after the invitation it revokes", async () => {
    const state = makeOwnerCollaborationState();
    collaborationState = state;
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    const list = listUnder("Active invitation records");
    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Revoke", "Revoke"]);
    expect(
      within(list).getByRole("button", { name: "Revoke viewer invitation, 0 of 10 used" }),
    ).toBeInTheDocument();

    const revoke = within(list).getByRole("button", {
      name: "Revoke editor invitation, 2 of 10 used",
    });
    fireEvent.click(revoke);
    expect(state.revokeInvitation).toHaveBeenCalledWith("70000000-0000-4000-8000-000000000001");
    await waitFor(() => expect(revoke).toBeEnabled());
  });
});

/** The panel's one status region, found through a message it is reading. */
function statusRegionOf(message: string) {
  return screen.getByText(message).closest('[role="status"]');
}

describe("CollaborationPanel status messages", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    collaborationState = makeCollaborationState();
  });

  afterEach(() => {
    // An own property added above; deleting it restores jsdom's default.
    Reflect.deleteProperty(navigator, "clipboard");
  });

  /** An owner's room whose next invitation carries the token "invite-token". */
  function makeInvitingOwnerState() {
    const createInvitation = vi.fn<CollaborationContextValue["createInvitation"]>(async (role) => ({
      id: "70000000-0000-4000-8000-000000000001",
      roomId: "20000000-0000-4000-8000-000000000001",
      role,
      maxUses: 10,
      useCount: 0,
      expiresAt: Date.now() + 86_400_000,
      revokedAt: null,
      createdAt: Date.now(),
      token: "invite-token",
    }));
    return { ...makeCollaborationState(), role: "owner", createInvitation };
  }

  it("announces a copied invitation link, and shows a copy that failed", async () => {
    collaborationState = makeInvitingOwnerState();
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    fireEvent.click(screen.getByRole("button", { name: "Editor link" }));
    const copied = await screen.findByText("Invitation link copied to clipboard.");
    expect(copied.closest('[role="status"]')).not.toBeNull();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("invite=invite-token"));

    writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copied invitation link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The invitation link could not be copied. Select and copy it manually.",
    );
  });

  it("names the invitation link button by its copy action as well as the link", async () => {
    collaborationState = makeInvitingOwnerState();
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    // A first copy that fails leaves the link on screen, not yet copied.
    writeText.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    fireEvent.click(screen.getByRole("button", { name: "Editor link" }));
    const copyLink = await screen.findByRole("button", {
      name: /^Copy invitation link: http:\/\/\S+\/code\?invite=invite-token$/,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The invitation link could not be copied. Select and copy it manually.",
    );

    fireEvent.click(copyLink);
    expect(
      await screen.findByRole("button", { name: "Copied invitation link" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("invite=invite-token"));
  });

  it("announces connection changes while the panel is closed", () => {
    const view = render(<CollaborationPanel />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(statusRegionOf("Live collaboration: Live")).not.toBeNull();

    collaborationState = { ...makeCollaborationState(), connectionState: "failed" };
    view.rerender(<CollaborationPanel />);
    expect(statusRegionOf("Live collaboration: Connection failed")).not.toBeNull();

    collaborationState = {
      ...makeCollaborationState(),
      connectionState: "reconnecting",
      hasOfflineChanges: true,
    };
    view.rerender(<CollaborationPanel />);
    expect(statusRegionOf("Live collaboration: Reconnecting…, changes waiting")).not.toBeNull();

    collaborationState = { ...makeCollaborationState(), provider: null };
    view.rerender(<CollaborationPanel />);
    expect(screen.queryByText(/^Live collaboration:/)).toBeNull();
  });

  it("announces who joins and leaves, but not who was already in the room", () => {
    const state = makeCollaborationState();
    const [self, ada, grace, lin] = state.participants;
    const view = render(<CollaborationPanel />);
    expect(screen.queryByText(/ (joined|left)$/)).toBeNull();

    collaborationState = { ...state, participants: [self, ada, lin] };
    view.rerender(<CollaborationPanel />);
    expect(statusRegionOf("Grace left")).not.toBeNull();

    const noor = participant({
      actorId: "30000000-0000-4000-8000-000000000006",
      sessionId: "40000000-0000-4000-8000-000000000006",
      name: "Noor",
      role: "editor",
      surface: { kind: "editor", fileNodeId: null, viewport: null },
    });
    collaborationState = { ...state, participants: [self, ada, grace, lin, noor] };
    view.rerender(<CollaborationPanel />);
    expect(statusRegionOf("Grace joined. Noor joined")).not.toBeNull();

    // Leaving the room empties the list; that is not everyone else leaving.
    collaborationState = { ...state, provider: null, participants: [] };
    view.rerender(<CollaborationPanel />);
    expect(screen.queryByText(/ (joined|left)/)).toBeNull();
  });
});

describe("CollaborationPanel invitation prompt", () => {
  const acceptInvitation = vi.fn<CollaborationContextValue["acceptInvitation"]>(async () => {});
  const declineInvitation = vi.fn<CollaborationContextValue["declineInvitation"]>();

  beforeEach(() => {
    vi.clearAllMocks();
    collaborationState = {
      ...makeCollaborationState(),
      pendingInviteToken: "invite-token",
      isAcceptingInvitation: false,
      acceptInvitation,
      declineInvitation,
    };
  });

  it("asks before joining, and joins or declines only on request", () => {
    render(<CollaborationPanel />);
    const prompt = screen.getByRole("dialog", { name: "Collaboration invitation" });
    expect(within(prompt).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Join this collaboration room?",
    );
    expect(acceptInvitation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Join room" }));
    expect(acceptInvitation).toHaveBeenCalledOnce();
    expect(acceptInvitation).toHaveBeenCalledWith();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(declineInvitation).toHaveBeenCalledOnce();
  });

  it("disables both choices while the invitation is being accepted", () => {
    collaborationState = { ...collaborationState, isAcceptingInvitation: true };
    render(<CollaborationPanel />);

    expect(screen.getByRole("button", { name: "Joining…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
  });

  it("shows no prompt without a staged invitation", () => {
    collaborationState = { ...collaborationState, pendingInviteToken: null };
    render(<CollaborationPanel />);

    expect(screen.queryByRole("dialog", { name: "Collaboration invitation" })).toBeNull();
  });

  it("announces the staged invitation and the joining state", () => {
    const view = render(<CollaborationPanel />);
    expect(
      screen.getByRole("dialog", { name: "Collaboration invitation" }),
    ).toHaveAccessibleDescription(/^Accepting replaces your current workspace/);
    expect(
      statusRegionOf(
        "Collaboration invitation: join this collaboration room? Use the Join room or Not now buttons in the editor header.",
      ),
    ).not.toBeNull();

    collaborationState = { ...collaborationState, isAcceptingInvitation: true };
    view.rerender(<CollaborationPanel />);
    expect(statusRegionOf("Joining collaboration room…")).not.toBeNull();
  });

  it("shows a failed claim in the prompt", () => {
    collaborationState = {
      ...collaborationState,
      error: "The collaboration invitation could not be accepted.",
    };
    render(<CollaborationPanel />);

    const prompt = screen.getByRole("dialog", { name: "Collaboration invitation" });
    expect(within(prompt).getByRole("alert")).toHaveTextContent(
      "The collaboration invitation could not be accepted.",
    );
  });

  it("shows collaboration errors in the panel outside a room", () => {
    collaborationState = {
      ...collaborationState,
      provider: null,
      pendingInviteToken: null,
      error: "Sign in to accept this collaboration invitation.",
    };
    render(<CollaborationPanel />);
    fireEvent.click(screen.getByRole("button", { name: /^Live/ }));

    expect(screen.getByRole("button", { name: "Start live room" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign in to accept this collaboration invitation.",
    );
  });
});
