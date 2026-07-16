import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import type { WorkspaceActions } from "./WorkspaceContext";

const mocks = vi.hoisted(() => ({
  closeRoom: vi.fn(),
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  publishUpdate: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock("@next-editor/infra", () => ({
  claimCollaborationInvitation: vi.fn(),
  closeCollaborationRoom: mocks.closeRoom,
  createCollaborationInvitation: vi.fn(),
  createCollaborationRoom: mocks.createRoom,
  downloadCollaborationAsset: vi.fn(),
  exportCollaborationRoom: vi.fn(),
  getCollaborationBootstrap: vi.fn(),
  getCollaborationRoom: mocks.getRoom,
  listCollaborationAwareness: vi.fn(async () => []),
  listCollaborationInvitations: vi.fn(async () => []),
  listCollaborationMembers: vi.fn(async () => ({ members: [], roleVersion: 1 })),
  publishCollaborationAwareness: vi.fn(),
  publishCollaborationUpdate: mocks.publishUpdate,
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
  updateActiveFileContent: vi.fn(),
  hydrateAssetContents: vi.fn(),
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
};

vi.mock("../hooks/useWorkspace", () => ({
  useWorkspaceActions: () => baseActions,
  useWorkspaceActiveFilePath: () => project.entryFilePath,
}));
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ usesPlaybackModel: false, isRecording: false }),
}));

import { CollaborationProvider, useCollaboration } from "./CollaborationContext";
import type { CollaborationRoomSession } from "../collaboration/protocol";
import { applyEncodedYjsSnapshot, applyEncodedYjsUpdate } from "../collaboration/yjsUpdates";
import { projectCollaborationDocument } from "../collaboration/projectDocument";

const roomSession: CollaborationRoomSession = {
  room: {
    id: "20000000-0000-4000-8000-000000000001",
    ownerId: "10000000-0000-4000-8000-000000000001",
    hostUserId: "10000000-0000-4000-8000-000000000001",
    status: "active",
    protocolVersion: 1,
    documentSchemaVersion: 1,
    roleVersion: 1,
    maxMembers: 10,
    createdAt: 1,
    updatedAt: 1,
  },
  membership: { role: "owner" },
  channel: "collab:room:20000000-0000-4000-8000-000000000001",
};

describe("CollaborationProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentProject = project;
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
        <CollaborationProvider>
          <Probe />
        </CollaborationProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.createRoom).toHaveBeenCalledTimes(1);
    expect(mocks.createRoom.mock.calls[0][0]).toMatchObject({
      protocolVersion: 1,
      documentSchemaVersion: 1,
    });
    await waitFor(() => expect(search).toContain(`room=${roomSession.room.id}`));
    view.unmount();
  });

  it("uploads binary files before publishing descriptor-only room updates", async () => {
    currentProject = structuredClone(project);
    currentProject.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "plaintext",
      content: "aGVsbG8=",
      encoding: "base64",
    };
    const asset = {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mimeType: "image/png",
      size: 5,
    };
    mocks.createRoom.mockResolvedValue(roomSession);
    mocks.uploadAsset.mockResolvedValue(asset);
    mocks.publishUpdate.mockResolvedValue({ accepted: true });
    mocks.getRoom.mockRejectedValue({ response: { status: 404 } });
    let collaboration: ReturnType<typeof useCollaboration> | null = null;
    function Probe() {
      collaboration = useCollaboration();
      return null;
    }

    const view = render(
      <MemoryRouter initialEntries={["/code"]}>
        <CollaborationProvider>
          <Probe />
        </CollaborationProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await collaboration!.createRoom();
    });

    expect(mocks.uploadAsset).toHaveBeenCalledWith(roomSession.room.id, "aGVsbG8=", "image/png");
    expect(mocks.publishUpdate).toHaveBeenCalledTimes(1);
    const doc = new Y.Doc();
    applyEncodedYjsSnapshot(doc, mocks.createRoom.mock.calls[0][0].snapshot);
    expect(projectCollaborationDocument(doc).project.files["logo.png"]).toBeUndefined();
    applyEncodedYjsUpdate(doc, mocks.publishUpdate.mock.calls[0][1].update);
    const projection = projectCollaborationDocument(doc);
    expect(projection.project.files["logo.png"]).toMatchObject({
      encoding: "base64",
      content: "",
    });
    expect(Array.from(projection.assetsByNodeId.values())).toContainEqual(asset);
    doc.destroy();
    view.unmount();
  });
});
