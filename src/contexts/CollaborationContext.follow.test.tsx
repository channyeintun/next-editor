/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
  handleSlideEvent: vi.fn(),
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
    session: { room: { roleVersion: number } };
    awarenessPublications: Array<{ kind: string }>;
    awarenessSessionId: string;
    emitDocumentChange: () => void;
    emitAwareness: (event: Record<string, unknown>) => void;
    setConnectionState: (state: string) => void;
    hasDivergedDocument: boolean;
    hasPendingUpdates: boolean;
    retries: number;
    stopped: boolean;
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
  getFile: () => null,
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
import {
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
} from "../collaboration/teachingDocument";
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
  it("reports an applied whiteboard delta as accepted", async () => {
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
});

describe("CollaborationContext presence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.providers.length = 0;
    usesPlaybackModel = false;
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
