import { describe, expect, it } from "vitest";
import {
  approximateBase64ByteLength,
  base64ToBytes,
  bytesToBase64,
  getUniqueWorkspacePath,
  getWorkspaceFileMimeType,
  getWorkspaceMediaKind,
  isBinaryWorkspacePath,
} from "./workspace";

describe("isBinaryWorkspacePath", () => {
  it("flags binary asset extensions", () => {
    expect(isBinaryWorkspacePath("logo.png")).toBe(true);
    expect(isBinaryWorkspacePath("public/clip.MP4")).toBe(true);
    expect(isBinaryWorkspacePath("fonts/Inter.woff2")).toBe(true);
    expect(isBinaryWorkspacePath("sound.mp3")).toBe(true);
  });

  it("treats source and SVG files as text", () => {
    expect(isBinaryWorkspacePath("src/App.tsx")).toBe(false);
    expect(isBinaryWorkspacePath("styles.css")).toBe(false);
    expect(isBinaryWorkspacePath("public/favicon.svg")).toBe(false);
    expect(isBinaryWorkspacePath("README")).toBe(false);
  });
});

describe("base64 conversion", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 254, 255]);
    const encoded = bytesToBase64(bytes);

    expect(base64ToBytes(encoded)).toEqual(bytes);
  });

  it("round-trips a large buffer without overflowing", () => {
    const bytes = new Uint8Array(200_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 256;
    }

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("estimates the decoded byte length from base64", () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);

    expect(approximateBase64ByteLength(bytesToBase64(bytes))).toBe(bytes.length);
  });
});

describe("getWorkspaceMediaKind / mime", () => {
  it("classifies media by extension", () => {
    expect(getWorkspaceMediaKind("a/b/photo.jpeg")).toBe("image");
    expect(getWorkspaceMediaKind("intro.webm")).toBe("video");
    expect(getWorkspaceMediaKind("track.wav")).toBe("audio");
    expect(getWorkspaceMediaKind("doc.pdf")).toBe("other");
  });

  it("maps known extensions to mime types", () => {
    expect(getWorkspaceFileMimeType("logo.png")).toBe("image/png");
    expect(getWorkspaceFileMimeType("unknown.xyz")).toBe("application/octet-stream");
  });
});

describe("getUniqueWorkspacePath", () => {
  it("returns the desired path when it is free", () => {
    expect(getUniqueWorkspacePath("assets/logo.png", () => false)).toBe("assets/logo.png");
  });

  it("appends an increasing suffix before the extension on collisions", () => {
    const taken = new Set(["assets/logo.png", "assets/logo-1.png"]);

    expect(getUniqueWorkspacePath("assets/logo.png", (path) => taken.has(path))).toBe(
      "assets/logo-2.png",
    );
  });

  it("handles extensionless names", () => {
    const taken = new Set(["LICENSE"]);

    expect(getUniqueWorkspacePath("LICENSE", (path) => taken.has(path))).toBe("LICENSE-1");
  });
});
