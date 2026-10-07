// @vitest-environment node
// (fake-indexeddb stores Blobs with the global structuredClone, which under jsdom
// cannot clone jsdom's Blob; see src/test/fakeIndexedDB.ts.)
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import type { WorkspaceAssetDescriptor, WorkspaceProject } from "../types/workspace";
import {
  getWorkspaceAssetBlob,
  persistWorkspaceAssets,
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "./workspaceAssetStore";

const DATABASE = "next-editor-workspace-assets-db";

function projectWithAsset(descriptor: WorkspaceAssetDescriptor): WorkspaceProject {
  return {
    id: "test",
    name: "Test",
    lessonType: "html-css",
    entryFilePath: "logo.png",
    folders: [],
    files: {
      "logo.png": {
        path: "logo.png",
        name: "logo.png",
        language: "binary",
        content: descriptor,
        encoding: "asset",
      },
    },
  };
}

describe("persistWorkspaceAssets", () => {
  afterEach(() => {
    resetWorkspaceAssetStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves assets that are already stored alone", async () => {
    const fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const descriptor = await registerWorkspaceAsset(new Uint8Array([65, 66, 67]), {
      mimeType: "image/png",
    });
    const put = vi.spyOn(IDBObjectStore.prototype, "put");

    await expect(persistWorkspaceAssets(projectWithAsset(descriptor))).resolves.toBeUndefined();

    expect(put).not.toHaveBeenCalled();
  });

  it("writes back from memory an asset whose registration could not store it", async () => {
    const fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const bytes = new Uint8Array([65, 66, 67]);
    fake.failNextCommit(new DOMException("quota exhausted", "QuotaExceededError"));
    await expect(registerWorkspaceAsset(bytes, { mimeType: "image/png" })).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const descriptor: WorkspaceAssetDescriptor = {
      kind: "asset",
      assetId: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      mimeType: "image/png",
      size: bytes.byteLength,
    };

    await persistWorkspaceAssets(projectWithAsset(descriptor));

    const stored = (await fake.read(DATABASE, "assets")) as Blob[];
    expect(stored).toHaveLength(1);
    expect(new Uint8Array(await stored[0].arrayBuffer())).toEqual(bytes);
  });
});

describe("getWorkspaceAssetBlob", () => {
  afterEach(() => {
    resetWorkspaceAssetStoreForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Holding each registered asset in memory as well kept every asset of every
  // lesson opened in the tab alive until it closed.
  it("reads a stored asset back from IndexedDB rather than holding it in memory", async () => {
    const fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const descriptor = await registerWorkspaceAsset(new Uint8Array([65, 66, 67]), {
      mimeType: "image/png",
    });
    const get = vi.spyOn(IDBObjectStore.prototype, "get");

    const blob = await getWorkspaceAssetBlob(descriptor);

    expect(get).toHaveBeenCalledTimes(1);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([65, 66, 67]));
  });

  // Until the write commits, IndexedDB does not have the asset yet, so a read
  // that lands meanwhile (a preview opening the file) must come from memory.
  it("serves a read that races the registration's write from memory", async () => {
    const fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const bytes = new Uint8Array([65, 66, 67]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const descriptor: WorkspaceAssetDescriptor = {
      kind: "asset",
      assetId: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      mimeType: "image/png",
      size: bytes.byteLength,
    };
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    const put = IDBObjectStore.prototype.put;
    const racing: { read: Promise<Blob> | null } = { read: null };
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ) {
      racing.read = getWorkspaceAssetBlob(descriptor);
      return put.apply(this, args);
    });

    await registerWorkspaceAsset(bytes, { mimeType: "image/png" });

    if (!racing.read) throw new Error("Expected the registration to store the asset");
    expect(new Uint8Array(await (await racing.read).arrayBuffer())).toEqual(bytes);
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the only copy in memory when there is no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const descriptor = await registerWorkspaceAsset(new Uint8Array([65, 66, 67]), {
      mimeType: "image/png",
    });

    const blob = await getWorkspaceAssetBlob(descriptor);

    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([65, 66, 67]));
  });
});
