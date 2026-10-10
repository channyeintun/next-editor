import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  FILE_SIDEBAR_COLLAPSED_STORAGE_KEY,
  getClampedFileSidebarWidth,
  MAX_FILE_SIDEBAR_WIDTH,
  MIN_FILE_SIDEBAR_WIDTH,
  readStoredFileSidebarCollapsed,
  writeStoredFileSidebarCollapsed,
} from "../utils/sidebarLayout";
import type { WorkspaceTreeFile } from "../types/workspace";
import { createWorkspaceFile } from "../types/workspaceFiles";
import { getViewportClampedContextMenuPlacement } from "./fileSidebar/contextMenuPlacement";
import { FolderIcon, getFileIcon } from "./fileSidebar/fileIcons";
import { deletesEveryFile, getInlineNameError } from "./fileSidebar/sidebarModel";

describe("FolderIcon", () => {
  const fills = (open: boolean) =>
    Array.from(
      render(createElement(FolderIcon, { open })).container.querySelectorAll("svg > path"),
      (path) => path.getAttribute("fill"),
    );

  it("draws an open folder in two blues and a closed one in grey", () => {
    expect(fills(true)).toEqual(["#5c99d6", "#3d7ab5"]);
    expect(fills(false)).toEqual(["#78909c"]);
  });
});

describe("getFileIcon", () => {
  const iconMarkup = (file: WorkspaceTreeFile) => render(getFileIcon(file)).container.innerHTML;

  it("draws tsconfig.json with the TypeScript icon", () => {
    expect(iconMarkup({ path: "tsconfig.json", name: "tsconfig.json", language: "json" })).toBe(
      iconMarkup({ path: "src/main.ts", name: "main.ts", language: "typescript" }),
    );
  });

  it("draws an unrecognized binary file with the generic file icon", () => {
    expect(
      iconMarkup({ path: "data.bin", name: "data.bin", language: "plaintext", encoding: "base64" }),
    ).toBe(iconMarkup({ path: "notes.txt", name: "notes.txt", language: "plaintext" }));
  });
});

describe("getViewportClampedContextMenuPlacement", () => {
  it("keeps a menu opened near the bottom fully inside the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 120,
      anchorY: 780,
      menuWidth: 224,
      menuHeight: 280,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.top).toBe(512);
    expect(placement.top + 280).toBeLessThanOrEqual(792);
    expect(placement.maxHeight).toBe(784);
  });

  it("keeps a menu opened near the right edge fully inside the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 980,
      anchorY: 120,
      menuWidth: 224,
      menuHeight: 280,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.left).toBe(792);
    expect(placement.left + 224).toBeLessThanOrEqual(1016);
  });

  it("uses max height when the menu is taller than the viewport", () => {
    const placement = getViewportClampedContextMenuPlacement({
      anchorX: 40,
      anchorY: 40,
      menuWidth: 224,
      menuHeight: 900,
      viewportWidth: 1024,
      viewportHeight: 800,
    });

    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(784);
  });
});

describe("deletesEveryFile", () => {
  function treeFile(path: string): WorkspaceTreeFile {
    return { path, name: path.split("/").at(-1) ?? path, language: "typescript" };
  }

  it("is true for the only file", () => {
    expect(deletesEveryFile([treeFile("main.ts")], "main.ts")).toBe(true);
  });

  it("is true for a folder that holds every file", () => {
    expect(deletesEveryFile([treeFile("src/a.ts"), treeFile("src/lib/b.ts")], "src")).toBe(true);
  });

  it("is false when another folder only shares the folder's name as a prefix", () => {
    expect(deletesEveryFile([treeFile("src/a.ts"), treeFile("src2/x.ts")], "src")).toBe(false);
  });

  it("is false for one of two files", () => {
    expect(deletesEveryFile([treeFile("a.ts"), treeFile("b.ts")], "a.ts")).toBe(false);
  });
});

describe("getInlineNameError", () => {
  const project = {
    files: Object.fromEntries(
      ["index.html", "src/app.ts", "src/lib/util.ts"].map((path) => [
        path,
        createWorkspaceFile(path, ""),
      ]),
    ),
    folders: ["src", "src/lib"],
  };
  const newFile = { kind: "file" } as const;
  const newFolder = { kind: "folder" } as const;
  const renamedFile = (currentPath: string) => ({ kind: "file" as const, currentPath });
  const renamedFolder = (currentPath: string) => ({ kind: "folder" as const, currentPath });

  it("refuses a name the workspace cannot hold", () => {
    expect(getInlineNameError(project, "", newFile)).toBe("That name can't be used here.");
  });

  it("refuses a file that already exists", () => {
    expect(getInlineNameError(project, "src/app.ts", newFile)).toBe(
      '"app.ts" already exists here.',
    );
    expect(getInlineNameError(project, "src/app.ts", renamedFile("src/main.ts"))).toBe(
      '"app.ts" already exists here.',
    );
  });

  it("refuses a file and a folder that would share a path", () => {
    // A new file named like a folder, a folder named like a file, and a path
    // that would put an entry inside a file.
    expect(getInlineNameError(project, "src/lib", newFile)).toBe('"lib" already exists here.');
    expect(getInlineNameError(project, "index.html", newFolder)).toBe(
      '"index.html" already exists here.',
    );
    expect(getInlineNameError(project, "index.html/page.html", newFile)).toBe(
      '"index.html" is a file, not a folder.',
    );
  });

  it("accepts renaming an entry to its own path, or a folder past its own contents", () => {
    expect(getInlineNameError(project, "src/app.ts", renamedFile("src/app.ts"))).toBeNull();
    expect(getInlineNameError(project, "src/lib", renamedFolder("src/lib"))).toBeNull();
    expect(getInlineNameError(project, "src/shared", renamedFolder("src/lib"))).toBeNull();
    expect(getInlineNameError(project, "src/main.ts", newFile)).toBeNull();
  });

  it("refuses a folder moved inside itself, but not a file made into a folder", () => {
    expect(getInlineNameError(project, "src/lib/inner", renamedFolder("src/lib"))).toBe(
      "A folder can't be moved inside itself.",
    );
    expect(getInlineNameError(project, "src/app.ts/main.ts", renamedFile("src/app.ts"))).toBeNull();
  });
});

describe("getClampedFileSidebarWidth", () => {
  it("keeps the sidebar width inside the configured bounds", () => {
    expect(getClampedFileSidebarWidth(120, 1200)).toBe(MIN_FILE_SIDEBAR_WIDTH);
    expect(getClampedFileSidebarWidth(320, 1200)).toBe(320);
    expect(getClampedFileSidebarWidth(900, 1200)).toBe(MAX_FILE_SIDEBAR_WIDTH);
  });

  it("reserves room for the main editor on narrow screens", () => {
    expect(getClampedFileSidebarWidth(320, 640)).toBe(280);
  });
});

describe("file sidebar collapsed preference", () => {
  afterEach(() => {
    window.localStorage.removeItem(FILE_SIDEBAR_COLLAPSED_STORAGE_KEY);
  });

  it("defaults to expanded when nothing is stored", () => {
    expect(readStoredFileSidebarCollapsed()).toBe(false);
  });

  it("round-trips the collapsed flag through storage", () => {
    writeStoredFileSidebarCollapsed(true);
    expect(readStoredFileSidebarCollapsed()).toBe(true);

    writeStoredFileSidebarCollapsed(false);
    expect(readStoredFileSidebarCollapsed()).toBe(false);
  });
});
