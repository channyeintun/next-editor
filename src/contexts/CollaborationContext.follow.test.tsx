/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  handleSlideEvent: vi.fn(),
  handleWhiteboardEvent: vi.fn(),
  providers: [] as Array<{
    awarenessSessionId: string;
    emitDocumentChange: () => void;
    emitAwareness: (event: Record<string, unknown>) => void;
    setConnectionState: (state: string) => void;
  }>,
}));

let usesPlaybackModel = false;

vi.mock("@next-editor/infra", () => ({
  claimCollaborationInvitation: vi.fn(),
  closeCollaborationRoom: vi.fn(),
  createCollaborationInvitation: vi.fn(),
  createCollaborationRoom: vi.fn(),
  downloadCollaborationAsset: vi.fn(),
  exportCollaborationRoom: vi.fn(),
  getCollaborationRoom: vi.fn(),
  initializeCollaborationTeachingSurfaces: vi.fn(),
  listCollaborationInvitations: vi.fn(async () => []),
  listCollaborationMembers: vi.fn(async () => ({ members: [], roleVersion: 1 })),
  removeCollaborationMember: vi.fn(),
  revokeCollaborationInvitation: vi.fn(),
  updateCollaborationMemberRole: vi.fn(),
  uploadCollaborationAsset: vi.fn(),
  useAuth: () => ({
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      username: "self",
      name: "Self",
      avatarUrl: null,
    },
    isSignedIn: true,
    isLoading: false,
  }),
}));

vi.mock("../collaboration/roomProvider", async () => {
  const Y = await import("yjs");
  class FakeCollaborationRoomProvider {
    readonly doc = new Y.Doc();
    readonly clientId = "20000000-0000-4000-8000-000000000001";
    readonly awarenessSessionId = "30000000-0000-4000-8000-000000000001";
    readonly session = {
      room: {
        id: "40000000-0000-4000-8000-000000000001",
        ownerId: "10000000-0000-4000-8000-000000000001",
        hostUserId: "10000000-0000-4000-8000-000000000001",
        status: "active",
        protocolVersion: 2,
        documentSchemaVersion: 1,
        roleVersion: 1,
        maxMembers: 10,
        createdAt: 1,
        updatedAt: 1,
      },
      membership: { role: "editor" },
    };
    readonly actor = {
      getSnapshot: () => ({
        value: this.state,
        context: { role: "editor", hasOfflineChanges: false, error: null },
      }),
    };
    private state = "live";
    private readonly listeners = new Set<() => void>();
    private readonly options: {
      onAwarenessEvent?: (event: Record<string, unknown>) => void;
      onDocumentChange?: (
        doc: InstanceType<typeof Y.Doc>,
        transaction: InstanceType<typeof Y.Transaction>,
      ) => void;
    };

    constructor(options: {
      onAwarenessEvent?: (event: Record<string, unknown>) => void;
      onDocumentChange?: (
        doc: InstanceType<typeof Y.Doc>,
        transaction: InstanceType<typeof Y.Transaction>,
      ) => void;
    }) {
      this.options = options;
      controls.providers.push(this);
    }

    get connectionState() {
      return this.state;
    }

    get hasPendingUpdates() {
      return false;
    }

    subscribe(listener: () => void) {
      this.listeners.add(listener);
      return { unsubscribe: () => this.listeners.delete(listener) };
    }

    async start() {}
    stop() {}
    async flushNow() {}
    async retryNow() {}
    async publishAwareness() {}
    setAwarenessPublicationSuppressed() {}

    emitAwareness(event: Record<string, unknown>) {
      this.options.onAwarenessEvent?.(event);
    }

    emitDocumentChange() {
      this.options.onDocumentChange?.(this.doc, {} as InstanceType<typeof Y.Transaction>);
    }

    setConnectionState(state: string) {
      this.state = state;
      for (const listener of this.listeners) listener();
    }
  }

  return { CollaborationRoomProvider: FakeCollaborationRoomProvider };
});

const workspaceActions = {
  getProject: () => ({
    id: "project",
    name: "Project",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: [],
    files: {},
  }),
  getActiveFilePath: () => "index.html",
  getCollapsedFolders: () => [],
  getSidebarScrollTop: () => 0,
  getSidebarWidth: () => 260,
  getWorkspaceRevision: () => 0,
  getFile: () => null,
  listFiles: () => [],
  subscribeWorkspaceSync: () => () => {},
};

vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => workspaceActions,
  useWorkspaceActiveFilePath: () => "index.html",
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ usesPlaybackModel, isRecording: false }),
  useNextEditorActions: () => ({
    handleSlideEvent: controls.handleSlideEvent,
    handleWhiteboardEvent: controls.handleWhiteboardEvent,
  }),
}));

import { CollaborationProvider, useCollaboration } from "./CollaborationContext";
import { SlidesStoreProvider, useSlidesStore } from "./SlidesStoreContext";
import { WhiteboardStoreProvider, useWhiteboardStore } from "./WhiteboardStoreContext";
import type { SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";

function Providers({ children }: { children: ReactNode }) {
  return (
    <SlidesStoreProvider>
      <WhiteboardStoreProvider>
        <CollaborationProvider>{children}</CollaborationProvider>
      </WhiteboardStoreProvider>
    </SlidesStoreProvider>
  );
}

function participant({
  actorId,
  sessionId,
  revision = 1,
  role = "editor",
}: {
  actorId: string;
  sessionId: string;
  revision?: number;
  role?: "owner" | "editor" | "viewer";
}) {
  return {
    kind: "state",
    roomId: "40000000-0000-4000-8000-000000000001",
    actorId,
    sessionId,
    revision,
    role,
    username: actorId,
    name: role,
    avatarUrl: null,
    isHost: role === "owner",
    surface: { kind: "editor", fileNodeId: null, viewport: null },
    cursor: null,
    occurredAt: 1,
    expiresAt: Date.now() + 30_000,
  };
}

describe("CollaborationContext follow lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
    localStorage.clear();
  });

  it("rejects self-follow and switches exactly between owner, editor, and viewer sessions", async () => {
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    const remotes = [
      participant({
        actorId: "50000000-0000-4000-8000-000000000001",
        sessionId: "60000000-0000-4000-8000-000000000001",
        role: "owner",
      }),
      participant({
        actorId: "50000000-0000-4000-8000-000000000002",
        sessionId: "60000000-0000-4000-8000-000000000002",
        role: "editor",
      }),
      participant({
        actorId: "50000000-0000-4000-8000-000000000003",
        sessionId: "60000000-0000-4000-8000-000000000003",
        role: "viewer",
      }),
    ];
    act(() => {
      for (const remote of remotes) provider.emitAwareness(remote);
    });

    act(() => collaboration!.followParticipant(provider.awarenessSessionId));
    expect(collaboration!.followedSessionId).toBeNull();
    for (const remote of remotes) {
      act(() => collaboration!.followParticipant(remote.sessionId));
      expect(collaboration!.followedSessionId).toBe(remote.sessionId);
    }
    view.unmount();
  });

  it("consumes first Escape, retains follow through reconnect, and stops on leave or playback", async () => {
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    const target = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: "60000000-0000-4000-8000-000000000001",
    });
    act(() => provider.emitAwareness(target));
    act(() => collaboration!.followParticipant(target.sessionId));

    const downstreamEscape = vi.fn();
    window.addEventListener("keydown", downstreamEscape);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(downstreamEscape).not.toHaveBeenCalled();
    expect(collaboration!.followedSessionId).toBeNull();
    window.removeEventListener("keydown", downstreamEscape);

    act(() => collaboration!.followParticipant(target.sessionId));
    act(() => provider.setConnectionState("reconnecting"));
    expect(collaboration!.followedSessionId).toBe(target.sessionId);
    act(() => provider.setConnectionState("live"));
    expect(collaboration!.followedSessionId).toBe(target.sessionId);

    act(() =>
      provider.emitAwareness({
        kind: "leave",
        roomId: target.roomId,
        actorId: target.actorId,
        sessionId: target.sessionId,
        revision: 2,
        occurredAt: 2,
      }),
    );
    await waitFor(() => expect(collaboration!.followedSessionId).toBeNull());

    act(() => provider.emitAwareness({ ...target, revision: 3 }));
    act(() => collaboration!.followParticipant(target.sessionId));
    usesPlaybackModel = true;
    view.rerender(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(collaboration!.followedSessionId).toBeNull());
    view.unmount();
  });

  it("keeps the exact expired target visible while reconnecting and stops if it is absent live", async () => {
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    const target = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: "60000000-0000-4000-8000-000000000001",
    });
    act(() => provider.emitAwareness(target));
    act(() => collaboration!.followParticipant(target.sessionId));

    const now = vi.spyOn(Date, "now").mockReturnValue(target.expiresAt + 1);
    try {
      act(() => provider.setConnectionState("reconnecting"));
      expect(collaboration!.followedSessionId).toBe(target.sessionId);
      expect(collaboration!.followedParticipant?.sessionId).toBe(target.sessionId);

      act(() => provider.setConnectionState("live"));
      await waitFor(() => expect(collaboration!.followedSessionId).toBeNull());
    } finally {
      now.mockRestore();
      view.unmount();
    }
  });

  it("isolates room switches from late providers and restores the exact standalone stores", async () => {
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    let slidesStore: SlidesStoreInstance | null = null;
    let whiteboardStore: WhiteboardStoreInstance | null = null;
    function Probe() {
      collaboration = useCollaboration();
      slidesStore = useSlidesStore().store;
      whiteboardStore = useWhiteboardStore().store;
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    const standaloneSlides = {
      slides: [{ id: "standalone", order: 0, content: "standalone", contentType: "html" as const }],
      previewState: {
        isOpen: true,
        isMaximized: true,
        currentSlideId: "standalone",
        indexv: 2,
      },
    };
    const standaloneWhiteboard = {
      elements: [],
      view: { scrollX: 12, scrollY: -8, zoom: 1.5 },
      isOpen: true,
      isMaximized: true,
    };
    act(() => {
      slidesStore!.trigger.setSlides({ slides: standaloneSlides.slides });
      slidesStore!.trigger.setPreviewState({ previewState: standaloneSlides.previewState });
      whiteboardStore!.trigger.setScene({ scene: standaloneWhiteboard });
      collaboration!.joinRoom("40000000-0000-4000-8000-000000000001");
    });

    await waitFor(() => expect(controls.providers).toHaveLength(1));
    expect(slidesStore!.getSnapshot().context.slides).toEqual([]);
    expect(whiteboardStore!.getSnapshot().context.scene).toMatchObject({
      elements: [],
      view: { scrollX: 0, scrollY: 0, zoom: 1 },
      isOpen: false,
      isMaximized: false,
    });

    const oldProvider = controls.providers[0]!;
    act(() => {
      collaboration!.joinRoom("40000000-0000-4000-8000-000000000002");
    });
    await waitFor(() => expect(controls.providers).toHaveLength(2));
    const newRoomSlides = [
      { id: "new-room", order: 0, content: "new-room", contentType: "html" as const },
    ];
    const newRoomWhiteboard = {
      elements: [],
      view: { scrollX: 99, scrollY: 101, zoom: 2 },
      isOpen: false,
      isMaximized: false,
    };
    act(() => {
      slidesStore!.trigger.setSlides({ slides: newRoomSlides });
      whiteboardStore!.trigger.setScene({ scene: newRoomWhiteboard });
      oldProvider.emitDocumentChange();
    });
    expect(slidesStore!.getSnapshot().context.slides).toEqual(newRoomSlides);
    expect(whiteboardStore!.getSnapshot().context.scene).toEqual(newRoomWhiteboard);

    await act(async () => {
      await collaboration!.leaveRoom();
    });
    await waitFor(() => expect(collaboration!.provider).toBeNull());
    expect(slidesStore!.getSnapshot().context).toEqual(standaloneSlides);
    expect(whiteboardStore!.getSnapshot().context.scene).toEqual(standaloneWhiteboard);
    view.unmount();
  });
});
