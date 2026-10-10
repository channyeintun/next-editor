import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  registerWorkspaceAsset,
  resetWorkspaceAssetStoreForTests,
} from "../storage/workspaceAssetStore";
import type { WorkspaceProject } from "../types/workspace";
import { downloadWorkspaceProjectAsZip } from "./workspaceZip";

const { downloadBlob } = vi.hoisted(() => ({
  downloadBlob: vi.fn<(blob: Blob, filename: string) => void>(),
}));

vi.mock("./downloadBlob", () => ({ downloadBlob }));

afterEach(() => {
  downloadBlob.mockReset();
  resetWorkspaceAssetStoreForTests();
});

const ASSET_BYTES = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256);

async function createProject(): Promise<WorkspaceProject> {
  const asset = await registerWorkspaceAsset(ASSET_BYTES, { mimeType: "image/png" });
  return {
    id: "project-1",
    name: "  My Lesson: Part 1 ",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: ["assets/empty"],
    files: {
      "index.html": {
        path: "index.html",
        name: "index.html",
        language: "html",
        content: "<h1>Hello</h1>",
      },
      "src/app.js": {
        path: "src/app.js",
        name: "app.js",
        language: "javascript",
        content: "console.log('hi');\n".repeat(64),
      },
      "assets/logo.png": {
        path: "assets/logo.png",
        name: "logo.png",
        language: "plaintext",
        content: asset,
        encoding: "asset",
      },
      "legacy.bin": {
        path: "legacy.bin",
        name: "legacy.bin",
        language: "plaintext",
        content: btoa(String.fromCharCode(0, 1, 2, 255)),
        encoding: "base64",
      },
    },
  };
}

describe("downloadWorkspaceProjectAsZip", () => {
  it("downloads a zip named after the project with its folders, text and binary files", async () => {
    await downloadWorkspaceProjectAsZip(await createProject());

    expect(downloadBlob).toHaveBeenCalledOnce();
    const [archive, filename] = downloadBlob.mock.calls[0];
    expect(filename).toBe("my-lesson-part-1.zip");
    expect(archive.type).toBe("application/zip");

    const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      "assets/empty/",
      "assets/logo.png",
      "index.html",
      "legacy.bin",
      "src/app.js",
    ]);
    expect(entries["assets/empty/"].byteLength).toBe(0);
    expect(strFromU8(entries["index.html"])).toBe("<h1>Hello</h1>");
    expect(strFromU8(entries["src/app.js"])).toBe("console.log('hi');\n".repeat(64));
    expect(entries["assets/logo.png"]).toEqual(ASSET_BYTES);
    expect(entries["legacy.bin"]).toEqual(new Uint8Array([0, 1, 2, 255]));
  });
});
