import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceActions, WorkspaceSidebarState } from "../contexts/WorkspaceContext";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { WorkspaceTreeFile } from "../types/workspace";
import FileSidebar from "./FileSidebar";

function treeFile(path: string): WorkspaceTreeFile {
  return { path, name: path.split("/").at(-1) ?? path, language: "typescript" };
}

const INITIAL_STATE: WorkspaceSidebarState = {
  activeFilePath: "index.html",
  files: [
    { path: "index.html", name: "index.html", language: "html" },
    treeFile("src/app.ts"),
    treeFile("src/lib/util.ts"),
  ],
  folders: ["src", "src/lib"],
  treeVersion: 0,
  collapsedFolders: [],
  sidebarScrollTop: 0,
  sidebarWidth: 260,
  lessonType: "html-css",
  previewFilePath: "",
};

// A small reactive stand-in for the workspace store: the sidebar re-renders on
// every update, as it does under the real provider.
const workspace = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const store = { version: 0, state: {} as WorkspaceSidebarState };
  return {
    store,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => store.version,
    update: (patch: Partial<WorkspaceSidebarState>) => {
      store.state = { ...store.state, ...patch };
      store.version += 1;
      for (const listener of listeners) {
        listener();
      }
    },
  };
});

const actions = vi.hoisted(() => ({
  createFile: vi.fn<WorkspaceActions["createFile"]>(),
  createFolder: vi.fn<WorkspaceActions["createFolder"]>(),
  deleteFile: vi.fn<WorkspaceActions["deleteFile"]>(),
  deleteFolder: vi.fn<WorkspaceActions["deleteFolder"]>(),
  renameFile: vi.fn<WorkspaceActions["renameFile"]>(),
  renameFolder: vi.fn<WorkspaceActions["renameFolder"]>(),
  saveProject: vi.fn<WorkspaceActions["saveProject"]>(),
  setActiveFilePath: vi.fn<WorkspaceActions["setActiveFilePath"]>(),
  setCollapsedFolders: vi.fn<WorkspaceActions["setCollapsedFolders"]>(),
  setSidebarScrollTop: vi.fn<WorkspaceActions["setSidebarScrollTop"]>(),
  setSidebarWidth: vi.fn<WorkspaceActions["setSidebarWidth"]>(),
  setPreviewFilePath: vi.fn<WorkspaceActions["setPreviewFilePath"]>(),
  getProject: vi.fn<WorkspaceActions["getProject"]>(),
}));

vi.mock("../hooks/useWorkspace", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useWorkspaceActions: () => actions as unknown as WorkspaceActions,
    useWorkspaceSidebarState: () => {
      useSyncExternalStore(workspace.subscribe, workspace.getVersion);
      return workspace.store.state;
    },
    useWorkspaceSidebarCollapsed: () => false,
    useWorkspaceSidebarWidth: () => 260,
  };
});
vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () =>
    ({ handleWorkspaceEvent: () => undefined }) as unknown as NextEditorActions,
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => null,
}));

beforeEach(() => {
  workspace.store.state = { ...INITIAL_STATE };
  actions.setCollapsedFolders.mockImplementation((paths) =>
    workspace.update({ collapsedFolders: paths }),
  );
  actions.setActiveFilePath.mockImplementation((path) =>
    workspace.update({ activeFilePath: path }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const action of Object.values(actions)) {
    action.mockReset();
  }
});

const row = (name: string) => screen.getByRole("button", { name });

describe("FileSidebar rows from the keyboard", () => {
  it("advertise their shortcuts", () => {
    render(<FileSidebar />);

    expect(row("app.ts")).toHaveAttribute("aria-keyshortcuts", "Shift+F10 F2 Delete");
    expect(row("lib")).toHaveAttribute("aria-keyshortcuts", "Shift+F10 F2 Delete");
  });

  it("open the name field on F2", () => {
    render(<FileSidebar />);

    fireEvent.keyDown(row("app.ts"), { key: "F2" });

    const field = screen.getByRole("textbox");
    expect(field).toHaveValue("app.ts");
    expect(field).toHaveFocus();
  });

  it("open the menu under the row on Shift+F10, with focus on its first item", () => {
    render(<FileSidebar />);
    const appRow = row("app.ts");
    appRow.focus();

    fireEvent.keyDown(appRow, { key: "F10", shiftKey: true });

    expect(screen.getByRole("group", { name: "File actions" })).toBeInTheDocument();
    expect(row("New File")).toHaveFocus();
    // The focused row is already the target; the keys do not open the file.
    expect(actions.setActiveFilePath).not.toHaveBeenCalled();
  });

  it("open a folder's menu on the Menu key", () => {
    render(<FileSidebar />);

    fireEvent.keyDown(row("lib"), { key: "ContextMenu" });

    expect(screen.getByRole("group", { name: "Folder actions" })).toBeInTheDocument();
  });

  it("get focus back when the menu closes on Escape", () => {
    render(<FileSidebar />);
    const appRow = row("app.ts");
    appRow.focus();
    fireEvent.keyDown(appRow, { key: "ContextMenu" });

    fireEvent.keyDown(row("New File"), { key: "Escape" });

    expect(screen.queryByRole("group", { name: "File actions" })).not.toBeInTheDocument();
    expect(appRow).toHaveFocus();
  });

  it("keep focus in the name field when Rename closes the menu", () => {
    render(<FileSidebar />);
    const appRow = row("app.ts");
    appRow.focus();
    fireEvent.keyDown(appRow, { key: "ContextMenu" });

    fireEvent.click(row("Rename"));

    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("delete after a confirm on Delete, or Cmd+Backspace", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FileSidebar />);

    fireEvent.keyDown(row("app.ts"), { key: "Delete" });
    expect(confirm).toHaveBeenLastCalledWith("Delete src/app.ts?");
    expect(actions.deleteFile).toHaveBeenCalledWith("src/app.ts");

    fireEvent.keyDown(row("lib"), { key: "Backspace", metaKey: true });
    expect(confirm).toHaveBeenLastCalledWith("Delete folder src/lib and its contents?");
    expect(actions.deleteFolder).toHaveBeenCalledWith("src/lib");

    // A plain Backspace is not a delete.
    fireEvent.keyDown(row("index.html"), { key: "Backspace" });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("refuse to delete the last file, as the menu does", () => {
    workspace.store.state = { ...INITIAL_STATE, files: [treeFile("main.ts")], folders: [] };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<FileSidebar />);

    fireEvent.keyDown(row("main.ts"), { key: "Delete" });

    expect(confirm).not.toHaveBeenCalled();
    expect(actions.deleteFile).not.toHaveBeenCalled();
  });
});
