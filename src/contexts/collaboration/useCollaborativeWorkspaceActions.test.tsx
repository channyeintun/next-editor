import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import {
  CollaborationProjectController,
  type CollaborationProjectProjection,
} from "../../collaboration/projectDocument";
import type { CollaborationAssetDescriptor } from "../../collaboration/protocol";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import {
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "../../storage/workspaceAssetStore";
import type { TextEditEvent } from "../../types/textEdit";
import type { WorkspaceActions } from "../../stores/workspaceActions";
import { useCollaborativeWorkspaceActions } from "./useCollaborativeWorkspaceActions";

const mocks = vi.hoisted(() => ({
  uploadAsset:
    vi.fn<
      (roomId: string, bytes: Uint8Array, mimeType: string) => Promise<CollaborationAssetDescriptor>
    >(),
}));

vi.mock("@next-editor/infra", () => ({
  uploadCollaborationAsset: mocks.uploadAsset,
}));

const provider = {
  doc: new Y.Doc(),
  session: { room: { id: "20000000-0000-4000-8000-000000000001" } },
} as unknown as CollaborationRoomProvider;

function renderActions(canWrite: boolean) {
  const setError = vi.fn<(message: string | null) => void>();
  const providerRef: { current: CollaborationRoomProvider | null } = { current: provider };
  const getCurrentProjection = (): CollaborationProjectProjection | null => null;
  const queueLocalTextEdit = (_event: TextEditEvent) => {};
  const rendered = renderHook(
    ({ canWrite: currentCanWrite }: { canWrite: boolean }) =>
      useCollaborativeWorkspaceActions({
        baseActions: {} as WorkspaceActions,
        provider,
        providerRef,
        playbackRef: { current: false },
        canWrite: currentCanWrite,
        getCurrentProjection,
        queueLocalTextEdit,
        setError,
      }),
    { initialProps: { canWrite } },
  );
  return { ...rendered, providerRef, setError };
}

async function startUpload(canWrite: boolean) {
  const createAssetFile = vi
    .spyOn(CollaborationProjectController.prototype, "createAssetFile")
    .mockImplementation(() => {});
  const descriptor = await registerWorkspaceAsset(new TextEncoder().encode("hello"), {
    mimeType: "image/png",
  });
  let resolveUpload: (asset: CollaborationAssetDescriptor) => void = () => {};
  mocks.uploadAsset.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
  );
  const rendered = renderActions(canWrite);
  act(() =>
    rendered.result.current.collaborativeActions.createFile("logo.png", descriptor, "asset"),
  );
  await vi.waitFor(() => expect(mocks.uploadAsset).toHaveBeenCalledTimes(1));
  const finishUpload = () =>
    act(async () => {
      resolveUpload({ id: descriptor.assetId, mimeType: "image/png", size: descriptor.size });
      // Let the completion handler run before the test reads its effects.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { ...rendered, createAssetFile, finishUpload };
}

describe("useCollaborativeWorkspaceActions", () => {
  beforeEach(() => {
    resetWorkspaceAssetStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.uploadAsset.mockReset();
  });

  it("says why a finished upload was not added after edit access ended", async () => {
    const { rerender, setError, createAssetFile, finishUpload } = await startUpload(true);

    // The owner makes this member a viewer while the bytes are uploading.
    rerender({ canWrite: false });
    await finishUpload();

    await vi.waitFor(() =>
      expect(setError).toHaveBeenCalledWith(
        "The file finished uploading after your edit access ended, so it was not added.",
      ),
    );
    expect(createAssetFile).not.toHaveBeenCalled();
  });

  it("stays silent when the member left the room before the upload finished", async () => {
    const { providerRef, setError, createAssetFile, finishUpload } = await startUpload(true);

    providerRef.current = null;
    await finishUpload();

    expect(setError).not.toHaveBeenCalled();
    expect(createAssetFile).not.toHaveBeenCalled();
  });

  it("adds the file when the member can still edit", async () => {
    const { setError, createAssetFile, finishUpload } = await startUpload(true);

    await finishUpload();

    await vi.waitFor(() => expect(createAssetFile).toHaveBeenCalledTimes(1));
    expect(setError).toHaveBeenLastCalledWith(null);
  });
});
