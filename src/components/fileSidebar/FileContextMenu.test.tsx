import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SidebarContextMenuState, SidebarEntryKind } from "./sidebarModel";
import FileContextMenu from "./FileContextMenu";

const clipboard = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn<(text: string) => void>(),
}));
vi.mock("../../utils/clipboard", () => clipboard);

afterEach(() => {
  vi.clearAllMocks();
});

const fileMenu: SidebarContextMenuState = {
  x: 120,
  y: 80,
  kind: "file",
  path: "src/index.html",
  parentPath: "src",
};

function renderMenu(
  menu: SidebarContextMenuState | null,
  flags: { canOpenInPreview?: boolean; isInPreview?: boolean; isDeleteRefused?: boolean } = {},
) {
  const handlers = {
    onDismiss: vi.fn<() => void>(),
    onCreate: vi.fn<(kind: SidebarEntryKind, parentPath: string) => void>(),
    onUpload: vi.fn<(parentPath: string) => void>(),
    onOpenInPreview: vi.fn<(path: string) => void>(),
    onRename: vi.fn<(kind: SidebarEntryKind, path: string) => void>(),
    onDelete: vi.fn<(kind: SidebarEntryKind, path: string) => void>(),
  };
  const view = render(
    <>
      <button type="button">Outside</button>
      <FileContextMenu
        menu={menu}
        canOpenInPreview={flags.canOpenInPreview ?? false}
        isInPreview={flags.isInPreview ?? false}
        isDeleteRefused={flags.isDeleteRefused ?? false}
        {...handlers}
      />
    </>,
  );
  return { ...view, ...handlers };
}

const item = (name: string) => screen.getByRole("button", { name });

describe("FileContextMenu", () => {
  it("renders nothing while closed", () => {
    renderMenu(null);

    expect(screen.queryByRole("button", { name: "New File" })).not.toBeInTheDocument();
  });

  it("opens at the pointer, inside the viewport", () => {
    renderMenu(fileMenu);

    // jsdom lays nothing out, so the menu keeps its fallback size (224 × 320).
    const menu = item("New File").parentElement!;
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("80px");
    expect(menu.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
  });

  it("creates and uploads next to a file, and inside a folder", () => {
    const onFile = renderMenu(fileMenu);
    fireEvent.click(item("New File"));
    fireEvent.click(item("New Folder"));
    fireEvent.click(item("Upload Files Here"));
    expect(onFile.onCreate.mock.calls).toEqual([
      ["file", "src"],
      ["folder", "src"],
    ]);
    expect(onFile.onUpload).toHaveBeenCalledWith("src");
    onFile.unmount();

    const onFolder = renderMenu({ ...fileMenu, kind: "folder", path: "src/lib" });
    fireEvent.click(item("New File"));
    expect(onFolder.onCreate).toHaveBeenCalledWith("file", "src/lib");
  });

  it("copies the path and dismisses itself", () => {
    const { onDismiss } = renderMenu(fileMenu);

    fireEvent.click(item("Copy Path"));
    fireEvent.click(item("Copy Relative Path"));

    expect(clipboard.copyTextToClipboard.mock.calls).toEqual([
      ["/src/index.html"],
      ["src/index.html"],
    ]);
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("renames and deletes the entry it was opened on", () => {
    const { onRename, onDelete } = renderMenu({ ...fileMenu, kind: "folder", path: "src" });

    fireEvent.click(item("Rename"));
    fireEvent.click(item("Delete Folder"));

    expect(onRename).toHaveBeenCalledWith("folder", "src");
    expect(onDelete).toHaveBeenCalledWith("folder", "src");
  });

  it("refuses a delete that would leave no file, and says why", () => {
    const { onDelete } = renderMenu(fileMenu, { isDeleteRefused: true });

    const deleteFile = item("Delete File");
    expect(deleteFile).toBeDisabled();
    expect(deleteFile).toHaveAttribute("title", "A project needs at least one file");
    expect(screen.getByText("A project needs at least one file")).toBeVisible();
    fireEvent.click(deleteFile);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("shows the reason only when the delete is refused", () => {
    renderMenu(fileMenu);

    expect(screen.queryByText("A project needs at least one file")).not.toBeInTheDocument();
  });

  it("offers Open in Preview only when it can, and marks the file already shown", () => {
    const hidden = renderMenu(fileMenu);
    expect(screen.queryByRole("button", { name: "Open in Preview" })).not.toBeInTheDocument();
    hidden.unmount();

    const notShown = renderMenu(fileMenu, { canOpenInPreview: true });
    expect(item("Open in Preview")).not.toHaveAttribute("aria-current");
    expect(item("Open in Preview").querySelector("svg")).toBeNull();
    notShown.unmount();

    const { onOpenInPreview } = renderMenu(fileMenu, { canOpenInPreview: true, isInPreview: true });
    const openInPreview = item("Open in Preview");
    expect(openInPreview).toHaveClass("text-sky-200");
    // Not by hue alone: the state is exposed, and a check (hidden from the
    // accessibility tree, so the name stays the same) shows it.
    expect(openInPreview).toHaveAttribute("aria-current", "true");
    expect(openInPreview.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(openInPreview);
    expect(onOpenInPreview).toHaveBeenCalledWith("src/index.html");
  });

  it("names its group of actions after the entry kind", () => {
    const onFile = renderMenu(fileMenu);
    expect(screen.getByRole("group", { name: "File actions" })).toContainElement(item("Rename"));
    onFile.unmount();

    renderMenu({ ...fileMenu, kind: "folder", path: "src" });
    expect(screen.getByRole("group", { name: "Folder actions" })).toBeInTheDocument();
  });

  it("moves focus to its first item when it opens", () => {
    renderMenu(fileMenu);

    expect(item("New File")).toHaveFocus();
  });

  it("dismisses when focus moves out of it, but not between its items", () => {
    const { onDismiss } = renderMenu(fileMenu);

    fireEvent.blur(item("New File"), { relatedTarget: item("Rename") });
    expect(onDismiss).not.toHaveBeenCalled();

    // Safari blurs to nothing on a mousedown over an item; the click must still land.
    fireEvent.blur(item("Rename"), { relatedTarget: null });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(item("Rename"), { relatedTarget: item("Outside") });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the browser's own menu from opening over it", () => {
    renderMenu(fileMenu);

    // fireEvent returns false when the event's default action was prevented.
    expect(fireEvent.contextMenu(item("New File"))).toBe(false);
  });

  it("dismisses on a pointer-down outside it or on Escape", () => {
    const { onDismiss } = renderMenu(fileMenu);

    fireEvent.pointerDown(item("Rename"));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(item("Outside"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
