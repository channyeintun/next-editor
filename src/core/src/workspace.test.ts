import { describe, expect, it } from "vite-plus/test";
import {
  areWorkspaceAssetDescriptorsEqual,
  areWorkspaceFilesEqual,
  areWorkspaceProjectsEqual,
  areWorkspaceSnapshotsEqual,
  isNonZeroWidthDelta,
  type WorkspaceAssetDescriptor,
  type WorkspaceFile,
  type WorkspaceProject,
  type WorkspaceRecordingSnapshot,
  type WorkspaceTextFile,
} from "./workspace";

describe("isNonZeroWidthDelta", () => {
  it("accepts only a finite, non-zero number", () => {
    expect(isNonZeroWidthDelta(3)).toBe(true);
    expect(isNonZeroWidthDelta(-3)).toBe(true);
    expect(isNonZeroWidthDelta(0.5)).toBe(true);

    expect(isNonZeroWidthDelta(0)).toBe(false);
    expect(isNonZeroWidthDelta(-0)).toBe(false);
    expect(isNonZeroWidthDelta(Number.NaN)).toBe(false);
    expect(isNonZeroWidthDelta(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNonZeroWidthDelta(undefined)).toBe(false);
    expect(isNonZeroWidthDelta(null)).toBe(false);
    expect(isNonZeroWidthDelta("3")).toBe(false);
  });
});

const descriptor: WorkspaceAssetDescriptor = {
  kind: "asset",
  assetId: "a".repeat(64),
  mimeType: "image/png",
  size: 3,
};

function textFile(path: string, content: string): WorkspaceTextFile {
  return { path, name: path.split("/").pop() ?? path, language: "plaintext", content };
}

function project(files: Record<string, WorkspaceFile>): WorkspaceProject {
  return {
    id: "p",
    name: "Project",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: ["src"],
    files,
  };
}

describe("areWorkspaceProjectsEqual", () => {
  it("ignores the order the file paths were inserted in", () => {
    const left = project({
      "index.html": textFile("index.html", "<p>"),
      "src/a.ts": textFile("src/a.ts", "a"),
    });
    const right = project({
      "src/a.ts": textFile("src/a.ts", "a"),
      "index.html": textFile("index.html", "<p>"),
    });

    expect(areWorkspaceProjectsEqual(left, right)).toBe(true);
  });

  it("tells projects apart when one has an extra path", () => {
    const left = project({ "index.html": textFile("index.html", "") });
    const right = project({
      "index.html": textFile("index.html", ""),
      "a.ts": textFile("a.ts", ""),
    });

    expect(areWorkspaceProjectsEqual(left, right)).toBe(false);
    expect(areWorkspaceProjectsEqual(right, left)).toBe(false);
  });

  it("tells projects apart when the counts match but a path differs", () => {
    const left = project({ "a.ts": textFile("a.ts", "") });
    const right = project({ "b.ts": textFile("a.ts", "") });

    expect(areWorkspaceProjectsEqual(left, right)).toBe(false);
  });

  it("does not take an inherited key for a file", () => {
    const left = project({ toString: textFile("toString", "") });
    const right = project({ valueOf: textFile("toString", "") });

    expect(areWorkspaceProjectsEqual(left, right)).toBe(false);
  });

  it("compares each file's content", () => {
    expect(
      areWorkspaceProjectsEqual(
        project({ "a.ts": textFile("a.ts", "one") }),
        project({ "a.ts": textFile("a.ts", "two") }),
      ),
    ).toBe(false);
  });
});

describe("areWorkspaceFilesEqual", () => {
  it("treats a missing encoding as utf-8", () => {
    const implicit = textFile("a.ts", "a");
    const explicit: WorkspaceFile = { ...implicit, encoding: "utf-8" };

    expect(areWorkspaceFilesEqual(implicit, explicit)).toBe(true);
  });

  it("compares asset files by descriptor id, MIME type and size", () => {
    const asset: WorkspaceFile = {
      path: "logo.png",
      name: "logo.png",
      language: "binary",
      content: descriptor,
      encoding: "asset",
    };

    expect(areWorkspaceFilesEqual(asset, { ...asset, content: { ...descriptor } })).toBe(true);
    expect(areWorkspaceFilesEqual(asset, { ...asset, content: { ...descriptor, size: 4 } })).toBe(
      false,
    );
    expect(
      areWorkspaceFilesEqual(asset, {
        ...asset,
        content: { ...descriptor, mimeType: "image/gif" },
      }),
    ).toBe(false);
    expect(
      areWorkspaceFilesEqual(asset, {
        ...asset,
        content: { ...descriptor, assetId: "b".repeat(64) },
      }),
    ).toBe(false);
  });

  it("tells a legacy base64 file from a text file with the same content", () => {
    const legacy: WorkspaceFile = {
      path: "logo.png",
      name: "logo.png",
      language: "binary",
      content: "QUJD",
      encoding: "base64",
    };

    expect(areWorkspaceFilesEqual(legacy, { ...legacy })).toBe(true);
    expect(areWorkspaceFilesEqual(legacy, { ...legacy, encoding: undefined })).toBe(false);
  });
});

describe("areWorkspaceAssetDescriptorsEqual", () => {
  it("ignores object identity", () => {
    expect(areWorkspaceAssetDescriptorsEqual(descriptor, { ...descriptor })).toBe(true);
    expect(areWorkspaceAssetDescriptorsEqual(descriptor, { ...descriptor, size: 0 })).toBe(false);
  });
});

describe("areWorkspaceSnapshotsEqual", () => {
  it("ignores sidebarCollapsed", () => {
    const snapshot: WorkspaceRecordingSnapshot = {
      project: project({ "index.html": textFile("index.html", "") }),
      activeFilePath: "index.html",
    };

    expect(areWorkspaceSnapshotsEqual(snapshot, { ...snapshot, sidebarCollapsed: true })).toBe(
      true,
    );
    expect(areWorkspaceSnapshotsEqual(snapshot, { ...snapshot, activeFilePath: "a.ts" })).toBe(
      false,
    );
  });
});
