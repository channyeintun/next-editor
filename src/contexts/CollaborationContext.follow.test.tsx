/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import { useContext, type ReactNode } from "react";
import { MemoryRouter, useSearchParams, type SetURLSearchParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { selectMetadata, type MetadataSelector } from "../test/selectMetadata";

const controls = vi.hoisted(() => ({
  handleSlideEvent: vi.fn() as (...args: unknown[]) => void,
  handleWhiteboardEvent: vi.fn(),
  // One object, like react-query's structurally shared `useAuth().user`.
  auth: {
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      username: "self",
      name: "Self",
      avatarUrl: null,
    },
    isSignedIn: true,
    isLoading: false,
  },
  providers: [] as Array<{
    doc: import("yjs").Doc;
    session: { room: { roleVersion: number; hostUserId: string }; membership: { role: string } };
    awarenessPublications: Array<{ kind: string }>;
    awarenessSessionId: string;
    emitDocumentChange: () => void;
    emitAwareness: (event: Record<string, unknown>) => void;
    setConnectionState: (state: string) => void;
    hasDivergedDocument: boolean;
    hasPendingUpdates: boolean;
    hasSynced: boolean;
    retries: number;
    stopped: boolean;
  }>,
}));

let usesPlaybackModel = false;
let isRecording = false;

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
  useAuth: () => controls.auth,
}));

vi.mock("../collaboration/roomProvider", async () => {
  const Y = await import("yjs");
  class FakeCollaborationRoomProvider {
    readonly doc = new Y.Doc();
    readonly clientId = "20000000-0000-4000-8000-000000000001";
    readonly awarenessSessionId = "30000000-0000-4000-8000-000000000001";
    session = {
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
      this.doc.on("afterTransaction", (transaction) =>
        this.options.onDocumentChange?.(this.doc, transaction),
      );
      controls.providers.push(this);
    }

    get connectionState() {
      return this.state;
    }

    hasPendingUpdates = false;

    subscribe(listener: () => void) {
      this.listeners.add(listener);
      return { unsubscribe: () => this.listeners.delete(listener) };
    }

    hasDivergedDocument = false;
    hasSynced = true;
    retries = 0;
    stopped = false;

    async start() {}
    stop() {
      this.stopped = true;
    }
    async flushNow() {}
    async retryNow() {
      this.retries += 1;
    }
    readonly awarenessPublications: Array<{ kind: string }> = [];

    async publishAwareness(input: { kind: string }) {
      this.awarenessPublications.push(input);
    }
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
  getFile: (_path: string): WorkspaceFile | null => null,
  subscribeWorkspaceSync: () => () => {},
  reconcileExternalProject: vi.fn(),
  updateFileContent: vi.fn(),
  notifyAssetAvailable: vi.fn(),
};

vi.mock("../collaboration/teachingDocument", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../collaboration/teachingDocument")>();
  return {
    ...actual,
    projectCollaborationTeachingDocument: vi.fn(actual.projectCollaborationTeachingDocument),
  };
});

vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => workspaceActions,
  useWorkspaceActiveFilePath: () => "index.html",
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: (select?: MetadataSelector) =>
    selectMetadata({ usesPlaybackModel, isRecording }, select),
  useNextEditorActions: () => ({
    handleSlideEvent: controls.handleSlideEvent,
    handleWhiteboardEvent: controls.handleWhiteboardEvent,
  }),
}));

import { CollaborationProvider, useCollaboration } from "./CollaborationContext";
import { useRoomPresence } from "./collaboration/RoomPresenceContext";
import { SlidesStoreProvider, useSlidesStore } from "./SlidesStoreContext";
import { WhiteboardStoreProvider, useWhiteboardStore } from "./WhiteboardStoreContext";
import type { SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";
import {
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
} from "../collaboration/teachingDocument";
import {
  COLLABORATION_SLIDE_ASSET_MIME_TYPE,
  collaborationSlidePayloadAssetId,
  encodeCollaborationSlidePayload,
} from "../collaboration/teachingSlides";
import {
  createCollaborationInvitation,
  downloadCollaborationAsset,
  listCollaborationInvitations,
  listCollaborationMembers,
  removeCollaborationMember,
  revokeCollaborationInvitation,
  updateCollaborationMemberRole,
  uploadCollaborationAsset,
} from "@next-editor/infra";
import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import {
  getCollaborationTexts,
  projectCollaborationDocument,
  seedCollaborationProject,
} from "../collaboration/projectDocument";
import {
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "../storage/workspaceAssetStore";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { collaborationParticipantKey } from "../collaboration/participantKey";
import { WorkspaceActionsContext } from "./WorkspaceContext";
import type { WorkspaceActions } from "../stores/workspaceActions";
import type { WorkspaceFile } from "../types/workspace";

/**
 * Waits until this member's own presence publications have settled (one once
 * the room is live, one from the debounced surface publish), so none of them
 * re-renders a probe in the middle of a test.
 */
async function ownPresenceSettled(provider: (typeof controls.providers)[number]) {
  await waitFor(() =>
    expect(provider.awarenessPublications.filter(({ kind }) => kind === "state")).toHaveLength(2),
  );
}

/** Both of the provider's contexts, read as one value by the probes below. */
function useRoom() {
  return { ...useCollaboration(), ...useRoomPresence() };
}

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
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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

    act(() =>
      collaboration!.followParticipant({
        actorId: controls.auth.user.id,
        sessionId: provider.awarenessSessionId,
      }),
    );
    expect(collaboration!.followedParticipantKey).toBeNull();
    for (const remote of remotes) {
      act(() => collaboration!.followParticipant(remote));
      expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(remote));
    }
    view.unmount();
  });

  it("consumes first Escape, retains follow through reconnect, and stops on leave or playback", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => collaboration!.followParticipant(target));

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
    expect(collaboration!.followedParticipantKey).toBeNull();
    window.removeEventListener("keydown", downstreamEscape);

    act(() => collaboration!.followParticipant(target));
    act(() => provider.setConnectionState("reconnecting"));
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(target));
    act(() => provider.setConnectionState("live"));
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(target));

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
    await waitFor(() => expect(collaboration!.followedParticipantKey).toBeNull());

    act(() => provider.emitAwareness({ ...target, revision: 3 }));
    act(() => collaboration!.followParticipant(target));
    usesPlaybackModel = true;
    view.rerender(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(collaboration!.followedParticipantKey).toBeNull());
    view.unmount();
  });

  it("leaves Escape inside a modal dialog to the dialog, and ends the follow elsewhere", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => collaboration!.followParticipant(target));

    // Outside any dialog, as from Monaco's textarea, Escape still ends the follow.
    const outside = document.createElement("textarea");
    document.body.append(outside);
    const outsideEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => outside.dispatchEvent(outsideEscape));
    expect(outsideEscape.defaultPrevented).toBe(true);
    expect(collaboration!.followedParticipantKey).toBeNull();
    outside.remove();
    act(() => collaboration!.followParticipant(target));

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const field = document.createElement("input");
    modal.append(field);
    document.body.append(modal);
    const dialogEscape = vi.fn();
    modal.addEventListener("keydown", dialogEscape);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => field.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(false);
    expect(dialogEscape).toHaveBeenCalledTimes(1);
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(target));
    modal.remove();
    view.unmount();
  });

  it("keeps the exact expired target visible while reconnecting and stops if it is absent live", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => collaboration!.followParticipant(target));

    const now = vi.spyOn(Date, "now").mockReturnValue(target.expiresAt + 1);
    try {
      act(() => provider.setConnectionState("reconnecting"));
      expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(target));
      expect(collaboration!.followedParticipant?.sessionId).toBe(target.sessionId);

      act(() => provider.setConnectionState("live"));
      await waitFor(() => expect(collaboration!.followedParticipantKey).toBeNull());
    } finally {
      now.mockRestore();
      view.unmount();
    }
  });

  // A session ID is chosen by the client and visible to every member, so
  // another member can publish awareness under the same one.
  it("follows the member chosen, not another member reusing their session ID", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    const sessionId = "60000000-0000-4000-8000-000000000001";
    // Participants are listed by name, so the reusing member comes first.
    const target = {
      ...participant({ actorId: "50000000-0000-4000-8000-000000000001", sessionId }),
      name: "Zed",
    };
    const reusing = {
      ...participant({ actorId: "50000000-0000-4000-8000-000000000002", sessionId }),
      name: "Aaron",
    };
    act(() => {
      provider.emitAwareness(target);
      provider.emitAwareness(reusing);
    });

    act(() => collaboration!.followParticipant(target));
    expect(collaboration!.followedParticipant?.actorId).toBe(target.actorId);

    act(() =>
      provider.emitAwareness({
        kind: "leave",
        roomId: target.roomId,
        actorId: target.actorId,
        sessionId,
        revision: 2,
        occurredAt: 2,
      }),
    );
    await waitFor(() => expect(collaboration!.followedParticipantKey).toBeNull());
    expect(collaboration!.followedParticipant).toBeNull();
    view.unmount();
  });

  it("refuses to follow this member's own session but follows another member reusing its ID", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    const own = { actorId: controls.auth.user.id, sessionId: provider.awarenessSessionId };
    expect(collaboration!.ownParticipantKey).toBe(`${own.actorId}:${own.sessionId}`);
    await waitFor(() =>
      expect(collaboration!.participants.map(collaborationParticipantKey)).toContain(
        collaboration!.ownParticipantKey,
      ),
    );
    const reusing = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: own.sessionId,
    });
    act(() => provider.emitAwareness(reusing));

    act(() => collaboration!.followParticipant(own));
    expect(collaboration!.followedParticipantKey).toBeNull();
    act(() => collaboration!.followParticipant(reusing));
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(reusing));
    view.unmount();
  });

  it("isolates room switches from late providers and restores the exact standalone stores", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    let slidesStore: SlidesStoreInstance | null = null;
    let whiteboardStore: WhiteboardStoreInstance | null = null;
    function Probe() {
      collaboration = useRoom();
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
      deckBorrowed: false,
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

describe("CollaborationContext retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  it("resumes a failed room, but rebuilds it once the room has refused local edits", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    const first = controls.providers[0]!;
    act(() => first.setConnectionState("failed"));

    await act(async () => {
      await collaboration!.retry();
    });
    expect(first.retries).toBe(1);
    expect(controls.providers).toHaveLength(1);

    // The refused edits are still in this document; resuming it would keep
    // showing text the room never accepted.
    first.hasDivergedDocument = true;
    act(() => {
      void collaboration!.retry();
    });
    await waitFor(() => expect(controls.providers).toHaveLength(2));
    expect(first.retries).toBe(1);
    expect(first.stopped).toBe(true);
    expect(collaboration!.provider).toBe(controls.providers[1]);
    view.unmount();
  });
});

describe("CollaborationContext leaving a failed room", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  // In `failed` the provider no longer drains its outbox (e.g. the host ended
  // the room while an update waited for its ack), so waiting for it would trap
  // the participant in the room.
  for (const action of ["leaveRoom", "closeRoom"] as const) {
    it(`lets ${action} finish with edits the room can no longer accept`, async () => {
      let collaboration: ReturnType<typeof useRoom> | null = null;
      function Probe() {
        collaboration = useRoom();
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
      provider.hasPendingUpdates = true;
      act(() => provider.setConnectionState("failed"));

      await act(async () => {
        await collaboration![action]();
      });

      expect(provider.stopped).toBe(true);
      await waitFor(() => expect(collaboration!.provider).toBeNull());
      view.unmount();
    });
  }
});

function rectangle(id: string, index: string): WhiteboardElementJSON {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 1,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 10,
    index,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  } as WhiteboardElementJSON;
}

describe("CollaborationContext teaching projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  // A delta writes one transaction per element so every update stays under the
  // room limit; the teaching tree must not be re-projected (and every element
  // re-validated) after each of them.
  it("projects a multi-element whiteboard delta once", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => {
      seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
      seedCollaborationTeachingDocument(provider.doc, { slides: [], whiteboardElements: [] });
    });
    await waitFor(() => expect(collaboration!.teaching.initialized).toBe(true));
    vi.mocked(projectCollaborationTeachingDocument).mockClear();

    const upserts = Array.from({ length: 20 }, (_, index) => rectangle(`e${index}`, `a${index}`));
    act(() => {
      collaboration!.publishWhiteboardDelta({ upserts });
    });

    await waitFor(() => expect(collaboration!.teaching.whiteboardElements).toHaveLength(20));
    expect(projectCollaborationTeachingDocument).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // Validation re-emits an element's keys in schema order; Excalidraw's order
  // differs, so the acceptance check must not compare raw serializations.
  it("changes the shared slide without extra teaching projections", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    const slide = (id: string, order: number) => ({
      slide: { id, order, content: id, contentType: "html" as const },
      asset: {
        id: String(order).repeat(64),
        mimeType: "application/vnd.next-editor.slide+json",
        size: 32,
      },
    });
    act(() => {
      seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
      seedCollaborationTeachingDocument(provider.doc, {
        slides: [slide("one", 0), slide("two", 1)],
        whiteboardElements: [],
      });
    });
    await waitFor(() => expect(collaboration!.teaching.currentSlideId).toBe("one"));
    vi.mocked(projectCollaborationTeachingDocument).mockClear();

    let accepted = false;
    act(() => {
      accepted = collaboration!.publishCurrentSlide("two");
    });

    expect(accepted).toBe(true);
    await waitFor(() => expect(collaboration!.teaching.currentSlideId).toBe("two"));
    // Only the room projection that every teaching change gets.
    expect(projectCollaborationTeachingDocument).toHaveBeenCalledTimes(1);
  });

  it("reports an applied whiteboard delta as accepted", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => {
      seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
      seedCollaborationTeachingDocument(provider.doc, { slides: [], whiteboardElements: [] });
    });
    await waitFor(() => expect(collaboration!.teaching.initialized).toBe(true));

    let accepted: boolean | null = null;
    act(() => {
      accepted = collaboration!.publishWhiteboardDelta({ upserts: [rectangle("e0", "a0")] });
    });

    expect(accepted).toBe(true);
    view.unmount();
  });

  // A teaching transaction that changes nothing shown (here, a peer's candidate
  // that loses to the current winner) must not hand every collaboration
  // consumer a new projection.
  it("keeps the teaching projection when a teaching transaction changes nothing shown", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
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
    act(() => {
      seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
      seedCollaborationTeachingDocument(provider.doc, {
        slides: [],
        whiteboardElements: [{ ...rectangle("e0", "a0"), version: 2, versionNonce: 20 }],
      });
    });
    await waitFor(() => expect(collaboration!.teaching.whiteboardElements).toHaveLength(1));
    const teaching = collaboration!.teaching;
    vi.mocked(projectCollaborationTeachingDocument).mockClear();

    act(() => {
      const root = provider.doc.getMap("project").get("teaching") as import("yjs").Map<unknown>;
      const record = (root.get("whiteboardElements") as import("yjs").Map<unknown>).get(
        "e0",
      ) as import("yjs").Array<string>;
      record.push([
        JSON.stringify({
          kind: "element",
          version: 1,
          versionNonce: 10,
          element: rectangle("e0", "a0"),
        }),
      ]);
    });
    await waitFor(() => expect(projectCollaborationTeachingDocument).toHaveBeenCalledTimes(1));
    expect(collaboration!.teaching).toBe(teaching);

    act(() => {
      collaboration!.publishWhiteboardDelta({ upserts: [rectangle("e1", "a1")] });
    });
    await waitFor(() => expect(collaboration!.teaching).not.toBe(teaching));
    expect(collaboration!.teaching.whiteboardElements.map(({ id }) => id)).toEqual(["e0", "e1"]);
    view.unmount();
  });

  // A projection that changes neither the presentation nor its current slide
  // (here, a whiteboard change) keeps the build step the viewer is on; moving
  // away and back between two projections starts the slide over.
  it("shows the room's hydrated deck in the slides store and keeps the build step until the presentation changes", async () => {
    const slides = [
      { id: "one", order: 0, content: "one", contentType: "html" as const },
      { id: "two", order: 1, content: "two", contentType: "html" as const },
    ];
    const payloads = new Map<string, Uint8Array>();
    const seedSlides = await Promise.all(
      slides.map(async (slide) => {
        const bytes = encodeCollaborationSlidePayload(slide);
        const id = await collaborationSlidePayloadAssetId(bytes);
        payloads.set(id, bytes);
        return {
          slide,
          asset: { id, mimeType: COLLABORATION_SLIDE_ASSET_MIME_TYPE, size: bytes.byteLength },
        };
      }),
    );
    vi.mocked(downloadCollaborationAsset).mockImplementation(async (_roomId, assetId) =>
      payloads.get(assetId)!,
    );
    let collaboration: ReturnType<typeof useRoom> | null = null;
    let slidesStore: SlidesStoreInstance | null = null;
    function Probe() {
      collaboration = useRoom();
      slidesStore = useSlidesStore().store;
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    try {
      await waitFor(() => expect(controls.providers).toHaveLength(1));
      const provider = controls.providers[0]!;
      act(() => {
        seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
        seedCollaborationTeachingDocument(provider.doc, {
          slides: seedSlides,
          whiteboardElements: [],
        });
      });
      const store = () => slidesStore!.getSnapshot().context;
      await waitFor(() => expect(store().slides.map((slide) => slide.id)).toEqual(["one", "two"]));
      expect(store().slides.map((slide) => slide.content)).toEqual(["one", "two"]);
      expect(store().previewState).toMatchObject({ currentSlideId: "one", indexv: 0 });

      act(() => {
        slidesStore!.trigger.setPreviewState({
          previewState: { ...store().previewState, indexv: 2 },
        });
      });
      act(() => {
        collaboration!.publishWhiteboardDelta({ upserts: [rectangle("e0", "a0")] });
      });
      await waitFor(() => expect(collaboration!.teaching.whiteboardElements).toHaveLength(1));
      expect(store().previewState).toMatchObject({ currentSlideId: "one", indexv: 2 });

      const revision = collaboration!.teaching.presentationRevision;
      act(() => {
        collaboration!.publishCurrentSlide("two");
        collaboration!.publishCurrentSlide("one");
      });
      await waitFor(() => expect(collaboration!.teaching.presentationRevision).toBe(revision + 2));
      expect(store().previewState).toMatchObject({ currentSlideId: "one", indexv: 0 });

      act(() => {
        slidesStore!.trigger.setPreviewState({
          previewState: { ...store().previewState, indexv: 2 },
        });
      });
      act(() => {
        collaboration!.publishCurrentSlide("two");
      });
      await waitFor(() => expect(store().previewState.currentSlideId).toBe("two"));
      expect(store().previewState.indexv).toBe(0);
    } finally {
      vi.mocked(downloadCollaborationAsset).mockReset();
      view.unmount();
    }
  });

  // WhiteboardPanel pushes only "external" scenes into the canvas. The projection of a local
  // delta the room kept is the canvas's own echo; one where another client's version won is
  // not, and the canvas must receive it.
  describe("the whiteboard scene a published delta projects", () => {
    async function renderRoom(whiteboardElements: WhiteboardElementJSON[]) {
      let collaboration: ReturnType<typeof useRoom> | null = null;
      let whiteboardStore: WhiteboardStoreInstance | null = null;
      function Probe() {
        collaboration = useRoom();
        whiteboardStore = useWhiteboardStore().store;
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
      act(() => {
        seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
        seedCollaborationTeachingDocument(provider.doc, { slides: [], whiteboardElements });
      });
      await waitFor(() => expect(collaboration!.teaching.initialized).toBe(true));
      return {
        view,
        publish: (upserts: WhiteboardElementJSON[]) => {
          let accepted: boolean | null = null;
          act(() => {
            accepted = collaboration!.publishWhiteboardDelta({ upserts });
          });
          return accepted;
        },
        scene: () => whiteboardStore!.getSnapshot().context,
      };
    }

    it("is the canvas's own echo when the room kept the delta", async () => {
      const room = await renderRoom([]);

      expect(room.publish([rectangle("e0", "a0")])).toBe(true);

      await waitFor(() => expect(room.scene().scene.elements).toHaveLength(1));
      expect(room.scene().sceneUpdateSource).toBe("canvas");
      room.view.unmount();
    });

    it("reaches the canvas when another client's newer version won", async () => {
      const newer = { ...rectangle("e0", "a0"), version: 5, versionNonce: 50 };
      const room = await renderRoom([newer]);

      expect(room.publish([rectangle("e0", "a0"), rectangle("e1", "a1")])).toBe(false);

      await waitFor(() => expect(room.scene().scene.elements).toHaveLength(2));
      expect(room.scene().scene.elements.find((element) => element.id === "e0")?.version).toBe(5);
      expect(room.scene().sceneUpdateSource).toBe("external");
      room.view.unmount();
    });
  });

  // The room's teaching state is canonical, so the host's recording takes its
  // changes from the projection; the first projection is the room's starting
  // state, not a change.
  describe("recording the room's teaching changes", () => {
    beforeEach(() => {
      isRecording = true;
    });
    afterEach(() => {
      isRecording = false;
    });

    async function renderRecordingRoom(hostUserId: string) {
      let collaboration: ReturnType<typeof useRoom> | null = null;
      function Probe() {
        collaboration = useRoom();
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
      provider.session = { ...provider.session, room: { ...provider.session.room, hostUserId } };
      const slide = (id: string, order: number) => ({
        slide: { id, order, content: id, contentType: "html" as const },
        asset: {
          id: String(order).repeat(64),
          mimeType: "application/vnd.next-editor.slide+json",
          size: 32,
        },
      });
      act(() => {
        seedCollaborationProject(provider.doc, createStarterHtmlCssWorkspace());
        seedCollaborationTeachingDocument(provider.doc, {
          slides: [slide("one", 0), slide("two", 1)],
          whiteboardElements: [],
        });
      });
      await waitFor(() => expect(collaboration!.teaching.currentSlideId).toBe("one"));
      return { view, collaboration: () => collaboration! };
    }

    it("records the host's slide and whiteboard changes after the first projection", async () => {
      const room = await renderRecordingRoom(controls.auth.user.id);
      expect(controls.handleSlideEvent).not.toHaveBeenCalled();
      expect(controls.handleWhiteboardEvent).not.toHaveBeenCalled();

      act(() => {
        room.collaboration().publishCurrentSlide("two");
      });
      await waitFor(() => expect(controls.handleSlideEvent).toHaveBeenCalledTimes(1));
      expect(controls.handleSlideEvent).toHaveBeenCalledWith({
        type: "slide_change",
        timestamp: expect.any(Number),
        slideId: "two",
        indexv: 0,
      });
      expect(controls.handleWhiteboardEvent).not.toHaveBeenCalled();

      act(() => {
        room.collaboration().publishWhiteboardDelta({ upserts: [rectangle("e0", "a0")] });
      });
      await waitFor(() => expect(controls.handleWhiteboardEvent).toHaveBeenCalledTimes(1));
      expect(controls.handleWhiteboardEvent).toHaveBeenCalledWith({
        timestamp: expect.any(Number),
        upserts: [expect.objectContaining({ id: "e0" })],
      });
      expect(controls.handleSlideEvent).toHaveBeenCalledTimes(1);
      room.view.unmount();
    });

    it("records nothing for a member who is not the host", async () => {
      const room = await renderRecordingRoom("50000000-0000-4000-8000-000000000001");

      act(() => {
        room.collaboration().publishCurrentSlide("two");
      });
      act(() => {
        room.collaboration().publishWhiteboardDelta({ upserts: [rectangle("e0", "a0")] });
      });
      await waitFor(() => expect(room.collaboration().teaching.whiteboardElements).toHaveLength(1));

      expect(room.collaboration().teaching.currentSlideId).toBe("two");
      expect(controls.handleSlideEvent).not.toHaveBeenCalled();
      expect(controls.handleWhiteboardEvent).not.toHaveBeenCalled();
      room.view.unmount();
    });
  });
});

describe("CollaborationContext presence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  it("re-renders presence readers, not room-only readers, on a remote awareness event", async () => {
    const renders = { room: 0, presence: 0 };
    function RoomProbe() {
      useCollaboration();
      renders.room += 1;
      return null;
    }
    function PresenceProbe() {
      useRoomPresence();
      renders.presence += 1;
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <RoomProbe />
          <PresenceProbe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    await ownPresenceSettled(provider);
    const before = { ...renders };

    act(() =>
      provider.emitAwareness(
        participant({
          actorId: "50000000-0000-4000-8000-000000000001",
          sessionId: "60000000-0000-4000-8000-000000000001",
        }),
      ),
    );

    expect(renders.room).toBe(before.room);
    expect(renders.presence).toBe(before.presence + 1);
    view.unmount();
  });

  it("follows a participant who joined after followParticipant was read", async () => {
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    let presence: ReturnType<typeof useRoomPresence> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      presence = useRoomPresence();
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
    await ownPresenceSettled(provider);
    const followParticipant = collaboration!.followParticipant;
    const late = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: "60000000-0000-4000-8000-000000000001",
    });

    act(() => provider.emitAwareness(late));
    expect(collaboration!.followParticipant).toBe(followParticipant);
    act(() => followParticipant(late));

    expect(presence!.followedParticipantKey).toBe(collaborationParticipantKey(late));
    view.unmount();
  });

  // The room broadcasts a membership change to every socket (an invitation
  // claimed, a role changed, a member removed) and each provider then stores a
  // fresh session object. A leave here reaches every peer, which drops this
  // participant and stops anyone following it.
  it("stays present when a membership change refreshes the room session", async () => {
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <div />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    await waitFor(() =>
      expect(provider.awarenessPublications).toContainEqual(
        expect.objectContaining({ kind: "state" }),
      ),
    );
    provider.awarenessPublications.length = 0;

    act(() => {
      provider.session = {
        ...provider.session,
        room: { ...provider.session.room, roleVersion: 2 },
      };
      provider.setConnectionState("live");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.awarenessPublications).not.toContainEqual(
      expect.objectContaining({ kind: "leave" }),
    );
  });
});

describe("CollaborationContext follow application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  async function renderRoom() {
    const probe = {
      collaboration: null as ReturnType<typeof useRoom> | null,
      renders: 0,
    };
    function Probe() {
      probe.collaboration = useRoom();
      probe.renders += 1;
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
    await ownPresenceSettled(provider);
    const target = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: "60000000-0000-4000-8000-000000000001",
    });
    act(() => provider.emitAwareness(target));
    return { probe, target, view };
  }

  // The application's release timer is a 0 ms timeout.
  const releaseFollowApplication = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("applies a followed view without re-rendering collaboration consumers", async () => {
    const { probe, view } = await renderRoom();
    const renders = probe.renders;

    act(() => probe.collaboration!.runFollowApplication(() => {}));
    await releaseFollowApplication();

    expect(probe.renders).toBe(renders);
    view.unmount();
  });

  it("asks for no republish when the follow outlives the application", async () => {
    const { probe, target, view } = await renderRoom();
    act(() => probe.collaboration!.followParticipant(target));

    act(() => probe.collaboration!.runFollowApplication(() => {}));
    await releaseFollowApplication();

    expect(probe.collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(target));
    expect(probe.collaboration!.surfaceRepublishVersion).toBe(0);
    view.unmount();
  });

  it("asks once for a republish when the follow ends while publication is still suppressed", async () => {
    const { probe, target, view } = await renderRoom();
    act(() => probe.collaboration!.followParticipant(target));

    act(() => {
      probe.collaboration!.runFollowApplication(() => {});
      probe.collaboration!.stopFollowing("user");
    });
    expect(probe.collaboration!.surfaceRepublishVersion).toBe(0);
    await releaseFollowApplication();
    expect(probe.collaboration!.surfaceRepublishVersion).toBe(1);

    // A stop outside an application's release window publishes directly.
    act(() => probe.collaboration!.followParticipant(target));
    act(() => probe.collaboration!.stopFollowing("user"));
    await releaseFollowApplication();
    expect(probe.collaboration!.surfaceRepublishVersion).toBe(1);
    view.unmount();
  });
});

describe("CollaborationContext asset hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceAssetStoreForTests();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  // notifyAssetAvailable bumps the workspace sync and preview versions, which
  // makes the runtime diff the whole project; text edits cannot change assets.
  it("hydrates room assets when the tree changes, not on every text edit", async () => {
    const asset = await registerWorkspaceAsset(new Uint8Array([1, 2, 3, 4]), {
      mimeType: "image/png",
    });
    const project = createStarterHtmlCssWorkspace();
    project.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "plaintext",
      encoding: "asset",
      content: asset,
    };
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <div />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    act(() => seedCollaborationProject(provider.doc, project));
    await waitFor(() => expect(workspaceActions.notifyAssetAvailable).toHaveBeenCalledTimes(1));

    const entryId = projectCollaborationDocument(provider.doc).nodeIdByPath.get(
      project.entryFilePath,
    )!;
    for (let edit = 0; edit < 3; edit += 1) {
      act(() => {
        provider.doc.transact(
          () => getCollaborationTexts(provider.doc).get(entryId)!.insert(0, "x"),
          "remote-provider",
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(workspaceActions.notifyAssetAvailable).toHaveBeenCalledTimes(1);
  });
});

describe("CollaborationContext write access while reconnecting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  it("keeps a synced room writable through every reconnect state", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    expect(collaboration!.canWrite).toBe(true);

    // Offline edits are queued in every one of these states; turning the editor
    // read-only for each retry's handshake only rejects keystrokes.
    for (const state of ["reconnecting", "connecting", "syncing"]) {
      act(() => provider.setConnectionState(state));
      expect(collaboration!.canWrite).toBe(true);
    }
    act(() => provider.setConnectionState("failed"));
    expect(collaboration!.canWrite).toBe(false);

    // Before the first sync the workspace still shows the pre-room project.
    provider.hasSynced = false;
    act(() => provider.setConnectionState("reconnecting"));
    expect(collaboration!.canWrite).toBe(false);
  });
});

describe("CollaborationContext participant expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  // expiresAt is stamped with the room's clock; this browser's clock may differ.
  it("lists and follows a participant whose server expiry looks past on a fast local clock", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const serverNow = Date.now() - 90_000;
    const remote = {
      ...participant({
        actorId: "50000000-0000-4000-8000-000000000001",
        sessionId: "60000000-0000-4000-8000-000000000001",
      }),
      occurredAt: serverNow,
      expiresAt: serverNow + 30_000,
    };

    act(() => controls.providers[0]!.emitAwareness(remote));
    act(() => collaboration!.followParticipant(remote));

    expect(collaboration!.participants.map((entry) => entry.sessionId)).toContain(remote.sessionId);
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(remote));
  });
});

describe("CollaborationContext connection lifetime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  // The room effect owns the WebSocket; a new recorder callback is no reason to
  // stop the provider and resync the room.
  it("keeps the provider when the recorder's callbacks change identity", async () => {
    const tree = () => (
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <div />
        </Providers>
      </MemoryRouter>
    );
    const view = render(tree());
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const original = controls.handleSlideEvent;
    try {
      controls.handleSlideEvent = vi.fn();
      view.rerender(tree());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controls.providers).toHaveLength(1);
      expect(controls.providers[0]!.stopped).toBe(false);
    } finally {
      controls.handleSlideEvent = original;
      view.unmount();
    }
  });
});

describe("CollaborationContext room switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  it("starts the next room without the previous room's presence or follow target", async () => {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/code?room=40000000-0000-4000-8000-000000000001"]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const remote = participant({
      actorId: "50000000-0000-4000-8000-000000000001",
      sessionId: "60000000-0000-4000-8000-000000000001",
    });
    act(() => controls.providers[0]!.emitAwareness(remote));
    act(() => collaboration!.followParticipant(remote));
    expect(collaboration!.followedParticipantKey).toBe(collaborationParticipantKey(remote));

    act(() => collaboration!.joinRoom("40000000-0000-4000-8000-000000000002"));
    await waitFor(() => expect(controls.providers).toHaveLength(2));

    expect(controls.providers[0]!.stopped).toBe(true);
    expect(collaboration!.provider).toBe(controls.providers[1]);
    expect(collaboration!.followedParticipantKey).toBeNull();
    expect(collaboration!.participants.map((entry) => entry.sessionId)).not.toContain(
      remote.sessionId,
    );
  });
});

describe("CollaborationContext room roster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  const ROOM_ID = "40000000-0000-4000-8000-000000000001";

  function member(userId: string, role: "owner" | "editor" | "viewer") {
    return {
      userId,
      role,
      username: userId,
      name: null,
      avatarUrl: null,
      joinedAt: 1,
      updatedAt: 1,
    };
  }

  function invitation(id: string) {
    return {
      id,
      roomId: ROOM_ID,
      role: "editor" as const,
      maxUses: 1,
      useCount: 0,
      expiresAt: Date.now() + 60_000,
      revokedAt: null,
      createdAt: 1,
    };
  }

  type MemberList = { members: ReturnType<typeof member>[]; roleVersion: number };

  async function renderRoom() {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    function Probe() {
      collaboration = useRoom();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={[`/code?room=${ROOM_ID}`]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    return {
      view,
      provider: controls.providers[0]!,
      collaboration: () => collaboration!,
      memberIds: () => collaboration!.members.map((entry) => entry.userId),
      invitationIds: () => collaboration!.invitations.map((entry) => entry.id),
    };
  }

  it("loads the members once the room is live, and invitations only for the owner", async () => {
    vi.mocked(listCollaborationMembers).mockResolvedValueOnce({
      members: [member("a", "owner"), member("b", "editor")],
      roleVersion: 1,
    });
    const room = await renderRoom();

    await waitFor(() => expect(room.memberIds()).toEqual(["a", "b"]));
    expect(listCollaborationMembers).toHaveBeenCalledWith(ROOM_ID);
    expect(listCollaborationInvitations).not.toHaveBeenCalled();
    expect(room.invitationIds()).toEqual([]);

    room.provider.session.membership.role = "owner";
    vi.mocked(listCollaborationInvitations).mockResolvedValueOnce([invitation("i1")]);
    await act(async () => {
      await room.collaboration().refreshRoomData();
    });
    expect(listCollaborationInvitations).toHaveBeenCalledWith(ROOM_ID);
    expect(room.invitationIds()).toEqual(["i1"]);
    room.view.unmount();
  });

  it("keeps the latest of two overlapping refreshes", async () => {
    const room = await renderRoom();
    await waitFor(() => expect(listCollaborationMembers).toHaveBeenCalledTimes(1));
    let resolveStale!: (value: MemberList) => void;
    vi.mocked(listCollaborationMembers)
      .mockImplementationOnce(
        () =>
          new Promise<MemberList>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce({ members: [member("latest", "editor")], roleVersion: 2 });

    let stale!: Promise<void>;
    act(() => {
      stale = room.collaboration().refreshRoomData();
    });
    await act(async () => {
      await room.collaboration().refreshRoomData();
    });
    expect(room.memberIds()).toEqual(["latest"]);

    await act(async () => {
      resolveStale({ members: [member("stale", "editor")], roleVersion: 1 });
      await stale;
    });
    expect(room.memberIds()).toEqual(["latest"]);
    room.view.unmount();
  });

  it("applies invitation and member changes to the lists", async () => {
    const members = { members: [member("a", "owner"), member("b", "editor")], roleVersion: 1 };
    vi.mocked(listCollaborationMembers)
      .mockResolvedValueOnce(members)
      .mockResolvedValueOnce(members);
    const room = await renderRoom();
    await waitFor(() => expect(room.memberIds()).toEqual(["a", "b"]));

    await act(async () => {
      await expect(room.collaboration().createInvitation("editor")).rejects.toThrow(
        "Only the room owner can create invitations.",
      );
    });
    expect(createCollaborationInvitation).not.toHaveBeenCalled();

    room.provider.session.membership.role = "owner";
    vi.mocked(listCollaborationInvitations).mockResolvedValueOnce([invitation("i1")]);
    await act(async () => {
      await room.collaboration().refreshRoomData();
    });
    vi.mocked(createCollaborationInvitation).mockResolvedValueOnce({
      ...invitation("i2"),
      token: "secret",
    });
    await act(async () => {
      await room.collaboration().createInvitation("viewer");
    });
    expect(createCollaborationInvitation).toHaveBeenCalledWith(ROOM_ID, { role: "viewer" });
    expect(room.invitationIds()).toEqual(["i2", "i1"]);

    vi.mocked(revokeCollaborationInvitation).mockResolvedValueOnce(undefined);
    await act(async () => {
      await room.collaboration().revokeInvitation("i1");
    });
    expect(revokeCollaborationInvitation).toHaveBeenCalledWith(ROOM_ID, "i1");
    expect(room.invitationIds()).toEqual(["i2"]);

    vi.mocked(updateCollaborationMemberRole).mockResolvedValueOnce(member("b", "viewer"));
    await act(async () => {
      await room.collaboration().updateMemberRole("b", "viewer");
    });
    expect(updateCollaborationMemberRole).toHaveBeenCalledWith(ROOM_ID, "b", "viewer");
    expect(room.collaboration().members.map((entry) => entry.role)).toEqual(["owner", "viewer"]);

    vi.mocked(removeCollaborationMember).mockResolvedValueOnce(undefined);
    await act(async () => {
      await room.collaboration().removeMember("b");
    });
    expect(removeCollaborationMember).toHaveBeenCalledWith(ROOM_ID, "b");
    expect(room.memberIds()).toEqual(["a"]);
    room.view.unmount();
  });

  it("drops the roster on leaving, including a list that arrives afterwards", async () => {
    vi.mocked(listCollaborationMembers).mockResolvedValueOnce({
      members: [member("a", "owner")],
      roleVersion: 1,
    });
    const room = await renderRoom();
    await waitFor(() => expect(room.memberIds()).toEqual(["a"]));
    let resolveLate!: (value: MemberList) => void;
    vi.mocked(listCollaborationMembers).mockImplementationOnce(
      () =>
        new Promise<MemberList>((resolve) => {
          resolveLate = resolve;
        }),
    );
    let late!: Promise<void>;
    act(() => {
      late = room.collaboration().refreshRoomData();
    });

    await act(async () => {
      await room.collaboration().leaveRoom();
    });
    await waitFor(() => expect(room.collaboration().provider).toBeNull());
    expect(room.memberIds()).toEqual([]);

    await act(async () => {
      resolveLate({ members: [member("late", "editor")], roleVersion: 2 });
      await late;
    });
    expect(room.memberIds()).toEqual([]);
    room.view.unmount();
  });
});

// Inside a room the provider replaces the workspace actions below it with ones
// that write to the room's document, which the projection then brings back
// into the workspace.
describe("CollaborationContext workspace actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceAssetStoreForTests();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  function renderEditor(url: string) {
    let collaboration: ReturnType<typeof useRoom> | null = null;
    let actions: WorkspaceActions | null = null;
    function Probe() {
      collaboration = useRoom();
      actions = useContext(WorkspaceActionsContext);
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={[url]}>
        <Providers>
          <Probe />
        </Providers>
      </MemoryRouter>,
    );
    return { view, collaboration: () => collaboration!, actions: () => actions! };
  }

  it("passes the workspace's own actions through outside a room", () => {
    const editor = renderEditor("/code");
    expect(editor.actions()).toBe(workspaceActions);
    editor.view.unmount();
  });

  it("writes changes to the room's document and reports the ones it refuses", async () => {
    const editor = renderEditor("/code?room=40000000-0000-4000-8000-000000000001");
    await waitFor(() => expect(controls.providers).toHaveLength(1));
    const provider = controls.providers[0]!;
    const project = createStarterHtmlCssWorkspace();
    act(() => seedCollaborationProject(provider.doc, project));
    const roomFiles = () => projectCollaborationDocument(provider.doc).project.files;
    const error = () => editor.collaboration().error;

    const entry = project.files["index.html"]!;
    const entryContent = entry.content as string;
    const getFile = vi
      .spyOn(workspaceActions, "getFile")
      .mockImplementation((path) => project.files[path] ?? null);
    let edited: string | null = null;
    try {
      act(() => {
        edited = editor.actions().applyFileTextEdits({
          fileId: "index",
          path: "index.html",
          beforeVersion: 1,
          afterVersion: 2,
          beforeLength: entryContent.length,
          afterLength: entryContent.length + 1,
          changes: [{ offset: 0, deleteLength: 0, text: "x" }],
        });
      });
    } finally {
      getFile.mockRestore();
    }
    expect(edited).toBe(`x${entryContent}`);
    expect(roomFiles()["index.html"]?.content).toBe(`x${entryContent}`);

    act(() => editor.actions().loadProject(project));
    expect(error()).toBe("Leave the room before loading another project.");
    act(() => editor.actions().updateFileContent("index.html", "<p>changed</p>"));
    expect(roomFiles()["index.html"]?.content).toBe("<p>changed</p>");
    expect(error()).toBeNull();

    act(() => editor.actions().createFolder("docs"));
    expect(projectCollaborationDocument(provider.doc).nodeIdByPath.has("docs")).toBe(true);

    const reconciles = vi.mocked(workspaceActions.reconcileExternalProject).mock.calls.length;
    act(() => editor.actions().reconcileExternalProject(project));
    expect(workspaceActions.reconcileExternalProject).toHaveBeenCalledTimes(reconciles);
    expect(error()).toBe("Bulk project replacement is disabled in a live room.");

    const descriptor = await registerWorkspaceAsset(new Uint8Array([1, 2, 3, 4]), {
      mimeType: "image/png",
    });
    act(() => editor.actions().createFile("logo.png", descriptor));
    expect(error()).toBe("Text collaboration files require string content.");
    act(() => editor.actions().createFile("logo.png", "text", "asset"));
    expect(error()).toBe("Binary collaboration files require an asset descriptor.");

    vi.mocked(uploadCollaborationAsset).mockResolvedValueOnce({
      id: descriptor.assetId,
      mimeType: descriptor.mimeType,
      size: descriptor.size,
    });
    act(() => editor.actions().createFile("logo.png", descriptor, "asset"));
    await waitFor(() =>
      expect(roomFiles()["logo.png"]).toMatchObject({ encoding: "asset", content: descriptor }),
    );
    expect(uploadCollaborationAsset).toHaveBeenCalledWith(
      "40000000-0000-4000-8000-000000000001",
      expect.any(Uint8Array),
      "image/png",
    );
    expect(error()).toBeNull();

    act(() => provider.setConnectionState("failed"));
    act(() => editor.actions().createFolder("later"));
    expect(error()).toBe("This collaboration room is read-only");
    act(() => editor.actions().createFile("later.png", descriptor, "asset"));
    expect(error()).toBe("The collaboration room is not ready for asset uploads.");
    expect(projectCollaborationDocument(provider.doc).nodeIdByPath.has("later")).toBe(false);
    editor.view.unmount();
  });
});

// "Retry" is offered while the error shown is a failed asset or presentation
// download; the room's own reset (the URL leaving the room) drops the offer but
// leaves the message on screen.
describe("CollaborationContext asset retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceAssetStoreForTests();
    controls.providers.length = 0;
    usesPlaybackModel = false;
  });

  const unavailable = { response: { data: { error: "The asset is unavailable." } } };

  async function renderRoomWithMissingAsset() {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const descriptor = await registerWorkspaceAsset(bytes, { mimeType: "image/png" });
    // Only the room has it now, so hydrating the project downloads it.
    resetWorkspaceAssetStoreForTests();
    const project = createStarterHtmlCssWorkspace();
    project.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "plaintext",
      encoding: "asset",
      content: descriptor,
    };
    let collaboration: ReturnType<typeof useRoom> | null = null;
    let setSearchParams: SetURLSearchParams | null = null;
    function Probe() {
      collaboration = useRoom();
      setSearchParams = useSearchParams()[1];
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
    vi.mocked(downloadCollaborationAsset).mockRejectedValueOnce(unavailable);
    act(() => seedCollaborationProject(controls.providers[0]!.doc, project));
    await waitFor(() => expect(collaboration!.error).toBe("The asset is unavailable."));
    return {
      view,
      bytes,
      descriptor,
      collaboration: () => collaboration!,
      setSearchParams: () => setSearchParams!,
    };
  }

  it("offers the retry only while the failed download is the error shown", async () => {
    const room = await renderRoomWithMissingAsset();
    expect(room.collaboration().canRetryAssets).toBe(true);

    act(() => {
      room.collaboration().publishCurrentSlide("slide-that-is-not-there");
    });
    expect(room.collaboration().error).not.toBeNull();
    expect(room.collaboration().error).not.toBe("The asset is unavailable.");
    expect(room.collaboration().canRetryAssets).toBe(false);

    act(() => room.collaboration().clearError());
    expect(room.collaboration().error).toBeNull();
    expect(room.collaboration().canRetryAssets).toBe(false);

    vi.mocked(downloadCollaborationAsset).mockRejectedValueOnce(unavailable);
    act(() => room.collaboration().retryAssets());
    await waitFor(() => expect(room.collaboration().canRetryAssets).toBe(true));
    expect(room.collaboration().error).toBe("The asset is unavailable.");

    vi.mocked(downloadCollaborationAsset).mockResolvedValueOnce(room.bytes);
    act(() => room.collaboration().retryAssets());
    expect(room.collaboration().error).toBeNull();
    expect(room.collaboration().canRetryAssets).toBe(false);
    await waitFor(() =>
      expect(workspaceActions.notifyAssetAvailable).toHaveBeenCalledWith(room.descriptor.assetId),
    );
    expect(room.collaboration().error).toBeNull();
    room.view.unmount();
  });

  it("keeps the message but drops the retry when the URL leaves the room", async () => {
    const room = await renderRoomWithMissingAsset();
    expect(room.collaboration().canRetryAssets).toBe(true);

    act(() =>
      room.setSearchParams()((current) => {
        const next = new URLSearchParams(current);
        next.delete("room");
        return next;
      }),
    );
    await waitFor(() => expect(room.collaboration().provider).toBeNull());

    expect(room.collaboration().error).toBe("The asset is unavailable.");
    expect(room.collaboration().canRetryAssets).toBe(false);
    room.view.unmount();
  });
});
