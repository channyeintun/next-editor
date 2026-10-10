import { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceTreeFile } from "../../types/workspace";
import QuickOpenDialog from "./QuickOpenDialog";

const workspace = vi.hoisted(() => ({
  files: [] as WorkspaceTreeFile[],
  activeFilePath: "",
}));

vi.mock("../../hooks/useWorkspace", () => ({
  useWorkspaceTreeFiles: () => workspace.files,
  useWorkspaceActiveFilePath: () => workspace.activeFilePath,
}));

function treeFile(path: string): WorkspaceTreeFile {
  return { path, name: path.split("/").at(-1) ?? path, language: "typescript" };
}

const FILES = ["index.html", "src/App.tsx", "src/components/FileSidebar.tsx", "src/main.ts"];

function renderDialog({ isApple = false, files = FILES, activeFilePath = "src/main.ts" } = {}) {
  workspace.files = files.map(treeFile);
  workspace.activeFilePath = activeFilePath;
  const onChoose = vi.fn<(file: WorkspaceTreeFile) => void>();
  const onDismiss = vi.fn<() => void>();
  render(
    <QuickOpenDialog
      isApple={isApple}
      onChoose={onChoose}
      onDismiss={onDismiss}
      returnFocusTo={createRef<HTMLElement>()}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Search files by name" });
  const type = (value: string) => fireEvent.change(input, { target: { value } });
  const press = (init: KeyboardEventInit) => fireEvent.keyDown(input, init);
  const activeOption = () => {
    const id = input.getAttribute("aria-activedescendant");
    return id ? document.getElementById(id) : null;
  };
  return { input, type, press, activeOption, onChoose, onDismiss };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuickOpenDialog", () => {
  it("is a modal dialog named Go to file, with focus in its combobox", () => {
    const { input, activeOption } = renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Go to file" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(activeOption()).toHaveAttribute("aria-selected", "true");
    expect(activeOption()).toHaveTextContent("index.html");
  });

  it("lists every file in path order before anything is typed", () => {
    renderDialog();

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "index.html",
      "App.tsx, in src",
      "FileSidebar.tsx, in src/components",
      "main.ts, in src, open",
    ]);
  });

  it("ranks matches as the query changes and announces the count in one status region", () => {
    const { input, type, activeOption } = renderDialog();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");
    const firstActiveId = input.getAttribute("aria-activedescendant");

    type("fs");
    expect(activeOption()).toHaveTextContent("FileSidebar.tsx");
    // Option ids follow the file, not the row, so a new top file is announced.
    expect(input.getAttribute("aria-activedescendant")).not.toBe(firstActiveId);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("1 file matches");

    type("s");
    expect(status).toHaveTextContent("3 files match");
  });

  it("highlights the matched letters", () => {
    const { type, activeOption } = renderDialog();

    type("fsb");

    const highlighted = activeOption()!.querySelectorAll(".text-sky-300");
    expect(Array.from(highlighted, (node) => node.textContent)).toEqual(["F", "S", "b"]);
  });

  it("says when nothing matches and collapses the list", () => {
    const { input, type } = renderDialog();

    type("zzz");

    expect(screen.getByRole("status")).toHaveTextContent("No files match zzz");
    expect(screen.getByText("No files match “zzz”.")).toBeInTheDocument();
    expect(screen.getByRole("listbox", { hidden: true })).not.toBeVisible();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("moves with the arrows, wrapping, and with Page Up and Down, clamped", () => {
    const { press, activeOption } = renderDialog();

    press({ key: "ArrowUp" });
    expect(activeOption()).toHaveTextContent("main.ts");
    press({ key: "ArrowDown" });
    expect(activeOption()).toHaveTextContent("index.html");
    press({ key: "PageDown" });
    expect(activeOption()).toHaveTextContent("main.ts");
    press({ key: "PageUp" });
    expect(activeOption()).toHaveTextContent("index.html");
  });

  it("moves down when the shortcut is pressed again", () => {
    const { press, activeOption } = renderDialog();
    press({ key: "p", code: "KeyP", ctrlKey: true });
    expect(activeOption()).toHaveTextContent("App.tsx");
  });

  it("takes Ctrl+N and Ctrl+P as next and previous on a Mac", () => {
    const { press, activeOption } = renderDialog({ isApple: true });

    press({ key: "n", ctrlKey: true });
    press({ key: "n", ctrlKey: true });
    expect(activeOption()).toHaveTextContent("FileSidebar.tsx");
    press({ key: "p", ctrlKey: true });
    expect(activeOption()).toHaveTextContent("App.tsx");
    press({ key: "p", code: "KeyP", metaKey: true });
    expect(activeOption()).toHaveTextContent("FileSidebar.tsx");
  });

  it("chooses the active file on Enter, but not while an input method composes", () => {
    const { type, press, onChoose } = renderDialog();
    type("app");

    press({ key: "Enter", isComposing: true });
    // Safari's Enter that commits a composition comes after compositionend.
    press({ key: "Enter", keyCode: 229 });
    expect(onChoose).not.toHaveBeenCalled();

    press({ key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ path: "src/App.tsx" }));
  });

  it("keeps focus in the field on a press, and chooses on a click", () => {
    const { input, onChoose } = renderDialog();
    const option = screen.getByRole("option", { name: /FileSidebar\.tsx/ });

    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);

    expect(input).toHaveFocus();
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/components/FileSidebar.tsx" }),
    );
  });

  it("keeps focus in the field on a press anywhere in the card but the field and Close", () => {
    const { input } = renderDialog();

    expect(fireEvent.mouseDown(screen.getByRole("listbox"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText(/to move/))).toBe(false);
    expect(fireEvent.mouseDown(input)).toBe(true);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Close" }))).toBe(true);
    expect(input).toHaveFocus();
  });

  it("outlines only the active option, for forced colors", () => {
    const { activeOption } = renderDialog();

    expect(activeOption()).toHaveClass("outline-2");
    for (const option of screen.getAllByRole("option").filter((row) => row !== activeOption())) {
      expect(option).not.toHaveClass("outline-2");
    }
  });

  it("marks the open file and carries no studio targets", () => {
    renderDialog();

    expect(screen.getByRole("option", { name: /main\.ts/ })).toHaveTextContent("open");
    expect(document.querySelector("[data-studio-target]")).toBeNull();
  });

  it("closes on Escape and on Close", () => {
    const { input, onDismiss } = renderDialog();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("says when it shows only the first results", () => {
    const files = Array.from({ length: 120 }, (_, index) => `file${index}.ts`);
    renderDialog({ files, activeFilePath: "file0.ts" });

    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getByText("Showing the first 100 of 120")).toBeInTheDocument();
  });
});
