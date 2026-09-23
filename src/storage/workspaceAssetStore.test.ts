// @vitest-environment node
// (fake-indexeddb stores Blobs with the global structuredClone, which under jsdom
// cannot clone jsdom's Blob; see src/test/fakeIndexedDB.ts.)
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import type { WorkspaceAssetDescriptor, WorkspaceProject } from "../types/workspace";
import {
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

  it("writes an asset back from memory when its stored copy has gone", async () => {
    const fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
    const descriptor = await registerWorkspaceAsset(new Uint8Array([65, 66, 67]), {
      mimeType: "image/png",
    });
    // Site data cleared under the running page.
    await fake.clear(DATABASE, "assets");

    await persistWorkspaceAssets(projectWithAsset(descriptor));

    const stored = (await fake.read(DATABASE, "assets")) as Blob[];
    expect(stored).toHaveLength(1);
    expect(new Uint8Array(await stored[0].arrayBuffer())).toEqual(new Uint8Array([65, 66, 67]));
  });
});
