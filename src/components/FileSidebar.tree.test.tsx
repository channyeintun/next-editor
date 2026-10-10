import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSidebarState } from "../stores/workspaceStore";
import type { WorkspaceActions } from "../stores/workspaceActions";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { WorkspaceProject, WorkspaceTreeFile } from "../types/workspace";
import { createWorkspaceFile } from "../types/workspaceFiles";
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
  // The name field checks a name against the project the store holds.
  actions.getProject.mockImplementation(() => {
    const { files, folders } = workspace.store.state;
    return {
      files: Object.fromEntries(
        files.map((file) => [file.path, createWorkspaceFile(file.path, "")]),
      ),
      folders,
    } as unknown as WorkspaceProject;
  });
  actions.setCollapsedFolders.mockImplementation((paths) =>
    workspace.update({ collapsedFolders: paths }),
  );
  actions.setActiveFilePath.mockImplementation((path) =>
    workspace.update({ activeFilePath: path }),
  );
  actions.createFile.mockImplementation((path) =>
    workspace.update({ files: [...workspace.store.state.files, treeFile(path)] }),
  );
  actions.renameFile.mockImplementation((currentPath, nextPath) =>
    workspace.update({
      files: workspace.store.state.files.map((file) =>
        file.path === currentPath ? treeFile(nextPath) : file,
      ),
    }),
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

describe("FileSidebar name field", () => {
  it("is named for the item it renames, and says how to save or cancel", () => {
    render(<FileSidebar />);

    fireEvent.keyDown(row("app.ts"), { key: "F2" });
    const fileField = screen.getByRole("textbox", { name: "File name for app.ts" });
    expect(fileField).toHaveAccessibleDescription("Press Enter to save or Escape to cancel");
    fireEvent.keyDown(fileField, { key: "Escape" });

    fireEvent.keyDown(row("lib"), { key: "F2" });
    expect(screen.getByRole("textbox", { name: "Folder name for lib" })).toHaveValue("lib");
  });

  it("is named for what it creates", () => {
    render(<FileSidebar />);

    fireEvent.click(row("Create file"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New file name" }), { key: "Escape" });

    fireEvent.click(row("Create folder"));
    expect(screen.getByRole("textbox", { name: "New folder name" })).toHaveAccessibleDescription(
      "Press Enter to save or Escape to cancel",
    );
  });

  it("stays open and says why when the name is taken, until the name changes", () => {
    render(<FileSidebar />);
    fireEvent.click(row("Create file"));
    const field = screen.getByRole("textbox", { name: "New file name" });

    fireEvent.change(field, { target: { value: "index.html" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(actions.createFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent('"index.html" already exists here.');
    expect(field).toHaveFocus();
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(
      '"index.html" already exists here. Press Enter to save or Escape to cancel',
    );

    fireEvent.change(field, { target: { value: "about.html" } });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(field).toBeValid();
    expect(field).toHaveAccessibleDescription("Press Enter to save or Escape to cancel");
  });

  it("stays open on blur after refusing a rename the workspace cannot hold", () => {
    render(<FileSidebar />);
    fireEvent.keyDown(row("app.ts"), { key: "F2" });
    const field = screen.getByRole("textbox", { name: "File name for app.ts" });

    fireEvent.change(field, { target: { value: ".." } });
    act(() => field.blur());

    expect(actions.renameFile).not.toHaveBeenCalled();
    expect(field).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("That name can't be used here.");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hands focus back to the row when Escape cancels a rename", () => {
    render(<FileSidebar />);
    fireEvent.keyDown(row("app.ts"), { key: "F2" });

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(row("app.ts")).toHaveFocus();
  });

  it("moves focus to the renamed row when Enter commits", () => {
    render(<FileSidebar />);
    fireEvent.keyDown(row("app.ts"), { key: "F2" });
    const field = screen.getByRole("textbox");

    fireEvent.change(field, { target: { value: "main.ts" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(actions.renameFile).toHaveBeenCalledWith("src/app.ts", "src/main.ts");
    expect(row("main.ts")).toHaveFocus();
  });

  it("moves focus to a new file's row, or back to Create file when cancelled", () => {
    render(<FileSidebar />);
    const createFile = row("Create file");
    createFile.focus();
    fireEvent.click(createFile);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(createFile).toHaveFocus();

    fireEvent.click(createFile);
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "notes.md" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(actions.createFile).toHaveBeenCalledWith("notes.md", expect.any(String));
    expect(row("notes.md")).toHaveFocus();
  });

  it("leaves focus alone when a blur closes the field", () => {
    render(<FileSidebar />);
    const createFile = row("Create file");
    createFile.focus();
    fireEvent.click(createFile);

    const field = screen.getByRole("textbox");
    act(() => field.blur());

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });
});

describe("FileSidebar landmark", () => {
  it("is a complementary region named by its Files heading", () => {
    render(<FileSidebar />);

    const sidebar = screen.getByRole("complementary", { name: "Files" });
    expect(within(sidebar).getByRole("heading", { level: 2, name: "Files" })).toBeInTheDocument();
  });
});

describe("FileSidebar active file", () => {
  it("marks only the open file's row as current, and follows a click", () => {
    render(<FileSidebar />);

    expect(row("index.html")).toHaveAttribute("aria-current", "true");
    expect(row("app.ts")).not.toHaveAttribute("aria-current");
    expect(row("src")).not.toHaveAttribute("aria-current");

    fireEvent.click(row("app.ts"));

    expect(row("app.ts")).toHaveAttribute("aria-current", "true");
    expect(row("index.html")).not.toHaveAttribute("aria-current");
  });
});

describe("FileSidebar tree structure", () => {
  const itemOf = (element: HTMLElement) => element.closest("li")!;

  it("nests each folder's entries in a list inside the folder's item", () => {
    render(<FileSidebar />);

    const files = screen.getByRole("list", { name: "Files" });
    expect(Array.from(files.children, (child) => child.tagName)).toEqual(["LI", "LI"]);
    expect(within(files).getAllByRole("listitem")).toHaveLength(5);

    const src = itemOf(row("src"));
    expect(within(src).getAllByRole("list")).toHaveLength(2);
    expect(src).toContainElement(row("app.ts"));
    expect(itemOf(row("lib"))).toContainElement(row("util.ts"));
    expect(itemOf(row("lib"))).not.toContainElement(row("app.ts"));
    expect(src).not.toContainElement(row("index.html"));
  });

  it("drops a collapsed folder's list, and lists a new entry inside its folder", () => {
    render(<FileSidebar />);

    fireEvent.click(row("lib"));
    expect(row("lib")).toHaveAttribute("aria-expanded", "false");
    expect(within(itemOf(row("lib"))).queryByRole("list")).not.toBeInTheDocument();

    fireEvent.keyDown(row("lib"), { key: "ContextMenu" });
    fireEvent.click(row("New File"));

    const field = screen.getByRole("textbox");
    expect(itemOf(row("lib"))).toContainElement(field);
    expect(field.closest("li")?.parentElement?.closest("li")).toBe(itemOf(row("lib")));
  });
});
