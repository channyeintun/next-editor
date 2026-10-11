import { afterEach, describe, expect, it } from "vite-plus/test";
import { isWorkspaceAssetDescriptor } from "../types/workspace";
import {
  getWorkspaceAssetBytes,
  resetWorkspaceAssetStoreForTests,
} from "../storage/workspaceAssetStore";
import { decodeWorkspaceText, readUploadedWorkspaceFile } from "./workspaceFileUpload";

describe("decodeWorkspaceText", () => {
  it("decodes UTF-8 text, dropping a leading BOM", () => {
    expect(decodeWorkspaceText(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(decodeWorkspaceText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("hi");
    expect(decodeWorkspaceText(new Uint8Array(0))).toBe("");
  });

  it("refuses bytes with a NUL in them, even when they decode", () => {
    expect(decodeWorkspaceText(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
  });

  it("refuses bytes that are not valid UTF-8", () => {
    expect(decodeWorkspaceText(new Uint8Array([0x61, 0xff, 0xfe, 0x80]))).toBeNull();
  });
});

// jsdom's File does not implement text()/arrayBuffer(), so use a minimal stub
// that mirrors the browser File surface the reader relies on.
function createFileStub(name: string, type: string, data: string | Uint8Array): File {
  return {
    name,
    type,
    text: async () => (typeof data === "string" ? data : new TextDecoder().decode(data)),
    arrayBuffer: async () =>
      typeof data === "string"
        ? new TextEncoder().encode(data).buffer
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  } as unknown as File;
}

describe("readUploadedWorkspaceFile", () => {
  afterEach(() => resetWorkspaceAssetStoreForTests());

  it("stores binary assets behind descriptors", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await readUploadedWorkspaceFile(createFileStub("logo.png", "image/png", bytes));

    expect(result.encoding).toBe("asset");
    expect(isWorkspaceAssetDescriptor(result.content)).toBe(true);
    if (!isWorkspaceAssetDescriptor(result.content)) throw new Error("Expected descriptor");
    expect(await getWorkspaceAssetBytes(result.content)).toEqual(bytes);
  });

  it("reads source files as text", async () => {
    const source = "export const value = 1;\n";
    const result = await readUploadedWorkspaceFile(
      createFileStub("value.ts", "text/plain", source),
    );

    expect(result.encoding).toBeUndefined();
    expect(result.content).toBe(source);
  });

  // Chrome on macOS reports a .ts file as an MPEG transport stream.
  it("reads a TypeScript file the browser calls video/mp2t as text", async () => {
    const source = "export const value: number = 1;\n";
    const result = await readUploadedWorkspaceFile(
      createFileStub("value.ts", "video/mp2t", source),
    );

    expect(result.encoding).toBeUndefined();
    expect(result.content).toBe(source);
  });

  it("reads SVG and JSON files as text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const json = '{"a":1}';

    expect(
      (await readUploadedWorkspaceFile(createFileStub("icon.svg", "image/svg+xml", svg))).content,
    ).toBe(svg);
    expect(
      (await readUploadedWorkspaceFile(createFileStub("data.json", "application/json", json)))
        .content,
    ).toBe(json);
  });

  // Chromium reports no type for many unknown extensions; such a file was read as text.
  it("keeps the bytes of an unknown binary the browser gives no type", async () => {
    const bytes = new Uint8Array([0x08, 0x01, 0xff, 0xfe, 0x80, 0x12]);
    const result = await readUploadedWorkspaceFile(createFileStub("model.onnx", "", bytes));

    expect(result.encoding).toBe("asset");
    if (!isWorkspaceAssetDescriptor(result.content)) throw new Error("Expected descriptor");
    expect(result.content.mimeType).toBe("application/octet-stream");
    expect(await getWorkspaceAssetBytes(result.content)).toEqual(bytes);
  });

  it("reads an extensionless text file as text", async () => {
    const result = await readUploadedWorkspaceFile(createFileStub("LICENSE", "", "MIT License\n"));

    expect(result.encoding).toBeUndefined();
    expect(result.content).toBe("MIT License\n");
  });

  it("preserves byte content for a non-trivial buffer", async () => {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 7) % 256;
    }

    const result = await readUploadedWorkspaceFile(
      createFileStub("blob.bin", "application/octet-stream", bytes),
    );

    expect(result.encoding).toBe("asset");
    if (!isWorkspaceAssetDescriptor(result.content)) throw new Error("Expected descriptor");
    expect(await getWorkspaceAssetBytes(result.content)).toEqual(bytes);
  });
});
