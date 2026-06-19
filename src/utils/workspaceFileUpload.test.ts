import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../types/workspace";
import { readUploadedWorkspaceFile, shouldReadAsBinary } from "./workspaceFileUpload";

describe("shouldReadAsBinary", () => {
  it("reads known binary extensions as bytes", () => {
    expect(shouldReadAsBinary({ name: "logo.png", type: "image/png" })).toBe(true);
    expect(shouldReadAsBinary({ name: "clip.mp4", type: "" })).toBe(true);
  });

  it("reads source and SVG files as text", () => {
    expect(shouldReadAsBinary({ name: "value.ts", type: "text/plain" })).toBe(false);
    expect(shouldReadAsBinary({ name: "icon.svg", type: "image/svg+xml" })).toBe(false);
    expect(shouldReadAsBinary({ name: "data.json", type: "application/json" })).toBe(false);
  });

  it("defaults extensionless files to text", () => {
    expect(shouldReadAsBinary({ name: "LICENSE", type: "" })).toBe(false);
  });

  it("falls back to binary for unknown non-text mime types", () => {
    expect(shouldReadAsBinary({ name: "data.bin", type: "application/octet-stream" })).toBe(true);
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
  it("reads binary assets as base64", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await readUploadedWorkspaceFile(createFileStub("logo.png", "image/png", bytes));

    expect(result.encoding).toBe("base64");
    expect(base64ToBytes(result.content)).toEqual(bytes);
  });

  it("reads source files as text", async () => {
    const source = "export const value = 1;\n";
    const result = await readUploadedWorkspaceFile(
      createFileStub("value.ts", "text/plain", source),
    );

    expect(result.encoding).toBeUndefined();
    expect(result.content).toBe(source);
  });

  it("preserves byte content for a non-trivial buffer", async () => {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (index * 7) % 256;
    }

    const result = await readUploadedWorkspaceFile(
      createFileStub("blob.bin", "application/octet-stream", bytes),
    );

    expect(result.encoding).toBe("base64");
    expect(result.content).toBe(bytesToBase64(bytes));
  });
});
