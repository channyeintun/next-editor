/* oxlint-disable vitest/require-mock-type-parameters */
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import type { WorkspaceActions } from "./WorkspaceContext";

const mocks = vi.hoisted(() => ({
  closeRoom: vi.fn(),
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  initializeTeaching: vi.fn(),
  handleSlideEvent: vi.fn(),
  handleWhiteboardEvent: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock("@next-editor/infra", () => ({
  claimCollaborationInvitation: vi.fn(),
  closeCollaborationRoom: mocks.closeRoom,
  createCollaborationInvitation: vi.fn(),
  createCollaborationRoom: mocks.createRoom,
  downloadCollaborationAsset: vi.fn(),
  exportCollaborationRoom: vi.fn(),
  getCollaborationRoom: mocks.getRoom,
  initializeCollaborationTeachingSurfaces: mocks.initializeTeaching,
  listCollaborationInvitations: vi.fn(async () => []),
  listCollaborationMembers: vi.fn(async () => ({ members: [], roleVersion: 1 })),
  removeCollaborationMember: vi.fn(),
  revokeCollaborationInvitation: vi.fn(),
  updateCollaborationMemberRole: vi.fn(),
  uploadCollaborationAsset: mocks.uploadAsset,
  useAuth: () => ({
    user: { id: "10000000-0000-4000-8000-000000000001" },
    isSignedIn: true,
    isLoading: false,
  }),
}));

const project = createStarterHtmlCssWorkspace();
let currentProject = project;
const baseActions: WorkspaceActions = {
  setActiveFilePath: vi.fn(),
  setPreviewFilePath: vi.fn(),
  setCollapsedFolders: vi.fn(),
  setSidebarScrollTop: vi.fn(),
  setSidebarWidth: vi.fn(),
  setSidebarCollapsed: vi.fn(),
  createNewEditor: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  renameFile: vi.fn(),
  renameFolder: vi.fn(),
  deleteFile: vi.fn(),
  deleteFolder: vi.fn(),
  updateFileContent: vi.fn(),
  applyFileTextEdits: vi.fn(() => "updated"),
  updateActiveFileContent: vi.fn(),
  hydrateAssetDescriptors: vi.fn(),
  notifyAssetAvailable: vi.fn(),
  saveProject: vi.fn(async () => {}),
  loadProject: vi.fn(),
  reconcileExternalProject: vi.fn(),
  updateLessonType: vi.fn(),
  getProject: () => currentProject,
  getWorkspaceRevision: () => 0,
  getActiveFilePath: () => project.entryFilePath,
  getCollapsedFolders: () => [],
  getSidebarScrollTop: () => 0,
  getSidebarWidth: () => 260,
  getFile: (path) => project.files[path] ?? null,
  listFiles: () => Object.values(project.files),
  subscribeWorkspaceSync: vi.fn(() => () => {}),
};

vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => baseActions,
  useWorkspaceActiveFilePath: () => project.entryFilePath,
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ usesPlaybackModel: false, isRecording: false }),
  useNextEditorActions: () => ({
    handleSlideEvent: mocks.handleSlideEvent,
    handleWhiteboardEvent: mocks.handleWhiteboardEvent,
  }),
}));

import { CollaborationProvider, useCollaboration } from "./CollaborationContext";
import type { CollaborationRoomSession } from "../collaboration/protocol";
import { applyEncodedYjsSnapshot } from "../collaboration/yjsUpdates";
import { projectCollaborationDocument } from "../collaboration/projectDocument";
import {
  COLLABORATION_SLIDE_ASSET_MIME_TYPE,
  collaborationSlidePayloadAssetId,
  validateCollaborationTeachingDocument,
} from "../collaboration/teachingDocument";
import {
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "../storage/workspaceAssetStore";
import { SlidesStoreProvider, useSlidesStore } from "./SlidesStoreContext";
import { WhiteboardStoreProvider } from "./WhiteboardStoreContext";
import { WhiteboardProvider, useWhiteboardContext } from "./WhiteboardContext";
import type { SlidesStoreInstance } from "../stores/slidesStore";

let testSlidesStore: SlidesStoreInstance | null = null;
let testWhiteboardController: ReturnType<typeof useWhiteboardContext> | null = null;

function TeachingStoreProbe() {
  testSlidesStore = useSlidesStore().store;
  testWhiteboardController = useWhiteboardContext();
  return null;
}

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <SlidesStoreProvider>
      <WhiteboardStoreProvider>
        <CollaborationProvider>
          <WhiteboardProvider>{children}</WhiteboardProvider>
        </CollaborationProvider>
      </WhiteboardStoreProvider>
    </SlidesStoreProvider>
  );
}

const roomSession: CollaborationRoomSession = {
  room: {
    id: "20000000-0000-4000-8000-000000000001",
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
  membership: { role: "owner" },
};

describe("CollaborationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorkspaceAssetStoreForTests();
    localStorage.clear();
    currentProject = project;
    testSlidesStore = null;
    testWhiteboardController = null;
    mocks.closeRoom.mockResolvedValue(undefined);
    mocks.initializeTeaching.mockResolvedValue(undefined);
  });

  it("seeds the current workspace and moves the editor into the created room URL", async () => {
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.getRoom.mockRejectedValue({ response: { status: 404 } });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    let search = "";
    function Probe() {
      collaboration = useCollaboration();
      search = useLocation().search;
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );
    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.createRoom).toHaveBeenCalledTimes(1);
    expect(mocks.initializeTeaching).toHaveBeenCalledTimes(1);
    expect(mocks.createRoom.mock.calls[0][0]).toMatchObject({
      protocolVersion: 2,
      documentSchemaVersion: 1,
    });
    await waitFor(() => expect(search).toContain(`room=${roomSession.room.id}`));
    await waitFor(() => expect(collaboration!.isCreatingRoom).toBe(false));
    view.unmount();
  });

  it("enters the room-start authoring boundary immediately and clears it on failure", async () => {
    let rejectCreation: ((reason: unknown) => void) | null = null;
    mocks.createRoom.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCreation = reject;
        }),
    );
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );

    let creation!: Promise<CollaborationRoomSession>;
    act(() => {
      creation = collaboration!.createRoom();
    });
    expect(collaboration!.isCreatingRoom).toBe(true);
    await waitFor(() => expect(rejectCreation).not.toBeNull());

    await act(async () => {
      rejectCreation!(new Error("creation failed"));
      await expect(creation).rejects.toThrow("creation failed");
    });
    expect(collaboration!.isCreatingRoom).toBe(false);
    view.unmount();
  });

  it("does not project or mutate an empty collaboration document before socket sync", async () => {
    mocks.getRoom.mockImplementation(() => new Promise(() => {}));
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={[`/code?room=${roomSession.room.id}`]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );

    await waitFor(() => expect(collaboration!.provider).not.toBeNull());
    expect(collaboration!.error).toBeNull();
    expect(collaboration!.doc?.getMap("project").get("texts")).toBeUndefined();
    view.unmount();
  });

  it("includes uploaded binary descriptors in the initial room snapshot", async () => {
    const bytes = new TextEncoder().encode("hello");
    const descriptor = await registerWorkspaceAsset(bytes, { mimeType: "image/png" });
    currentProject = structuredClone(project);
    currentProject.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "plaintext",
      content: descriptor,
      encoding: "asset",
    };
    currentProject.files["logo-copy.png"] = {
      path: "logo-copy.png",
      name: "logo-copy.png",
      language: "plaintext",
      content: descriptor,
      encoding: "asset",
    };
    const asset = {
      id: descriptor.assetId,
      mimeType: descriptor.mimeType,
      size: descriptor.size,
    };
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.uploadAsset.mockResolvedValue(asset);
    mocks.getRoom.mockRejectedValue({ response: { status: 404 } });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );
    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1);
    const [uploadedRoomId, uploadedBytes, uploadedMimeType] = mocks.uploadAsset.mock.calls[0];
    expect(uploadedRoomId).toBe(roomSession.room.id);
    expect(Array.from(uploadedBytes)).toEqual(Array.from(bytes));
    expect(uploadedMimeType).toBe(descriptor.mimeType);
    const doc = new Y.Doc();
    applyEncodedYjsSnapshot(doc, mocks.createRoom.mock.calls[0][0].snapshot);
    expect(projectCollaborationDocument(doc).project.files["logo.png"]).toMatchObject({
      encoding: "asset",
      content: descriptor,
    });
    expect(projectCollaborationDocument(doc).project.files["logo-copy.png"]).toMatchObject({
      encoding: "asset",
      content: descriptor,
    });
    doc.destroy();
    view.unmount();
  });

  it("rejects the room asset-count quota before creating or uploading anything", async () => {
    currentProject = structuredClone(project);
    for (let index = 1; index <= 101; index += 1) {
      const path = `asset-${index}.bin`;
      currentProject.files[path] = {
        path,
        name: path,
        language: "plaintext",
        encoding: "asset",
        content: {
          kind: "asset",
          assetId: index.toString(16).padStart(64, "0"),
          mimeType: "application/octet-stream",
          size: 1,
        },
      };
    }
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );

    await act(async () => {
      await expect(collaboration!.createRoom()).rejects.toThrow(/at most 100 assets/i);
    });
    expect(mocks.createRoom).not.toHaveBeenCalled();
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
    view.unmount();
  });

  it("rejects the room asset-byte quota from descriptors without reading payloads", async () => {
    currentProject = structuredClone(project);
    for (let index = 1; index <= 6; index += 1) {
      const path = `large-asset-${index}.bin`;
      currentProject.files[path] = {
        path,
        name: path,
        language: "plaintext",
        encoding: "asset",
        content: {
          kind: "asset",
          assetId: index.toString(16).padStart(64, "0"),
          mimeType: "application/octet-stream",
          size: 5 * 1024 * 1024,
        },
      };
    }
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );

    await act(async () => {
      await expect(collaboration!.createRoom()).rejects.toThrow(/exceed.*asset quota/i);
    });
    expect(mocks.createRoom).not.toHaveBeenCalled();
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retries the exact teaching initialization once before exposing the room", async () => {
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.initializeTeaching
      .mockRejectedValueOnce({
        response: { status: 503, data: { error: "asset verification unavailable" } },
      })
      .mockResolvedValueOnce(undefined);
    mocks.getRoom.mockRejectedValue({ response: { status: 404 } });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    let search = "";
    function Probe() {
      collaboration = useCollaboration();
      search = useLocation().search;
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );
    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.initializeTeaching).toHaveBeenCalledTimes(2);
    expect(mocks.initializeTeaching.mock.calls[1]).toEqual(mocks.initializeTeaching.mock.calls[0]);
    expect(mocks.closeRoom).not.toHaveBeenCalled();
    await waitFor(() => expect(search).toContain(`room=${roomSession.room.id}`));
    view.unmount();
  });

  it("does not retry a deterministic teaching initialization rejection", async () => {
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.initializeTeaching.mockRejectedValue({
      response: { status: 409, data: { error: "already initialized" } },
    });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );

    await act(async () => {
      await expect(collaboration!.createRoom()).rejects.toMatchObject({
        response: { status: 409 },
      });
    });

    expect(mocks.initializeTeaching).toHaveBeenCalledTimes(1);
    expect(mocks.closeRoom).toHaveBeenCalledWith(roomSession.room.id);
    view.unmount();
  });

  it("uploads prepared slides before publishing a teaching-only manifest and whiteboard seed", async () => {
    const secretSlideContent = "<main>private slide payload</main>";
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.uploadAsset.mockImplementation(
      async (_roomId: string, bytes: Uint8Array, mimeType: string) => ({
        id: await collaborationSlidePayloadAssetId(bytes),
        mimeType,
        size: bytes.byteLength,
      }),
    );
    mocks.getRoom.mockRejectedValue({ response: { status: 404 } });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <TeachingStoreProbe />
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );
    act(() => {
      testSlidesStore!.trigger.setSlides({
        slides: [
          {
            id: "prepared-slide",
            order: 0,
            contentType: "html",
            content: secretSlideContent,
          },
          {
            id: "prepared-slide-copy",
            order: 1,
            contentType: "html",
            content: secretSlideContent,
          },
        ],
      });
      testWhiteboardController!.handleExcalidrawChange(
        [
          {
            id: "prepared-shape",
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
            isDeleted: false,
            index: "a0",
            groupIds: [],
            frameId: null,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
          },
        ],
        { scrollX: 12, scrollY: -3, zoom: 2 },
        false,
      );
    });

    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.uploadAsset).toHaveBeenCalledTimes(1);
    expect(mocks.uploadAsset.mock.calls[0]?.[2]).toBe(COLLABORATION_SLIDE_ASSET_MIME_TYPE);
    expect(mocks.uploadAsset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.initializeTeaching.mock.invocationCallOrder[0]!,
    );
    const roomDoc = new Y.Doc();
    applyEncodedYjsSnapshot(roomDoc, mocks.createRoom.mock.calls[0]![0].snapshot);
    expect(JSON.stringify(roomDoc.toJSON())).not.toContain(secretSlideContent);
    applyEncodedYjsSnapshot(roomDoc, mocks.initializeTeaching.mock.calls[0]![1].update);
    const teaching = validateCollaborationTeachingDocument(roomDoc).projection;
    expect(teaching).toMatchObject({
      initialized: true,
      slideOrder: ["prepared-slide", "prepared-slide-copy"],
      currentSlideId: "prepared-slide",
      whiteboardElements: [expect.objectContaining({ id: "prepared-shape" })],
    });
    expect(teaching.slides.get("prepared-slide")?.asset.id).toBe(
      teaching.slides.get("prepared-slide-copy")?.asset.id,
    );
    roomDoc.destroy();
    view.unmount();
  });

  it("closes a newly created room when a teaching asset fails before publication", async () => {
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.uploadAsset.mockRejectedValue(new Error("asset unavailable"));
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }
    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <TestProviders>
          <TeachingStoreProbe />
          <Probe />
        </TestProviders>
      </MemoryRouter>,
    );
    act(() => {
      testSlidesStore!.trigger.setSlides({
        slides: [{ id: "prepared-slide", order: 0, contentType: "html", content: "payload" }],
      });
    });

    await act(async () => {
      await expect(collaboration!.createRoom()).rejects.toThrow("asset unavailable");
    });

    expect(mocks.initializeTeaching).not.toHaveBeenCalled();
    expect(mocks.closeRoom).toHaveBeenCalledWith(roomSession.room.id);
    expect(collaboration!.isCreatingRoom).toBe(false);
    view.unmount();
  });
});
