import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceAssetDescriptor } from "./workspace";
import { createWorkspaceFile } from "./workspaceFiles";

const descriptor: WorkspaceAssetDescriptor = {
  kind: "asset",
  assetId: "a".repeat(64),
  mimeType: "image/png",
  size: 3,
};

describe("createWorkspaceFile", () => {
  it("derives the canonical path, name and language of a text file", () => {
    expect(createWorkspaceFile("/src\\App.tsx", "export {};")).toEqual({
      path: "src/App.tsx",
      name: "App.tsx",
      language: "typescript",
      content: "export {};",
    });
  });

  it("keeps an asset descriptor with encoding asset", () => {
    expect(createWorkspaceFile("public/logo.png", descriptor, "asset")).toEqual({
      path: "public/logo.png",
      name: "logo.png",
      language: "plaintext",
      content: descriptor,
      encoding: "asset",
    });
  });

  it("keeps a legacy base64 string with encoding base64", () => {
    expect(createWorkspaceFile("logo.png", "QUJD", "base64")).toMatchObject({
      content: "QUJD",
      encoding: "base64",
    });
  });

  it("makes a descriptor without encoding asset an empty text file", () => {
    const file = createWorkspaceFile("logo.png", descriptor);

    expect(file.content).toBe("");
    expect(file).not.toHaveProperty("encoding");
  });
});
