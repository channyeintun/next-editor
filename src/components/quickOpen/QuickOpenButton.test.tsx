import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceTreeFile } from "../../types/workspace";
import QuickOpenButton from "./QuickOpenButton";

const mocks = vi.hoisted(() => ({
  isApple: false,
  isCovered: false,
  isPlaying: false,
  isTourActive: false,
  pause: vi.fn<() => void>(),
  openWorkspaceFile: vi.fn<(path: string) => void>(),
  editor: null as { getDomNode: () => HTMLElement | null; focus: () => void } | null,
  files: [] as WorkspaceTreeFile[],
}));

vi.mock("../../utils/keyboardPlatform", () => ({ isApplePlatform: () => mocks.isApple }));
vi.mock("../../hooks/useIsWorkspaceCovered", () => ({
  useIsWorkspaceCovered: () => mocks.isCovered,
}));
vi.mock("../../hooks/useOpenWorkspaceFile", () => ({
  useOpenWorkspaceFile: () => mocks.openWorkspaceFile,
}));
vi.mock("../tour/productTour", () => ({ isProductTourActive: () => mocks.isTourActive }));
vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: <T,>(select: (metadata: { isPlaying: boolean }) => T) =>
    select({ isPlaying: mocks.isPlaying }),
  useNextEditorActions: () => ({
    pause: mocks.pause,
    editorRef: {
      get current() {
        return mocks.editor;
      },
    },
  }),
}));
vi.mock("../../hooks/useWorkspace", () => ({
  useWorkspaceTreeFiles: () => mocks.files,
  useWorkspaceActiveFilePath: () => "src/a.ts",
}));

function treeFile(path: string): WorkspaceTreeFile {
  return { path, name: path.split("/").at(-1) ?? path, language: "typescript" };
}

let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  mocks.isApple = false;
  mocks.isCovered = false;
  mocks.isPlaying = false;
  mocks.isTourActive = false;
  mocks.editor = null;
  mocks.files = ["src/a.ts", "src/b.ts", "logo.png"].map(treeFile);
  rafCallbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.pause.mockReset();
  mocks.openWorkspaceFile.mockReset();
  document.body.innerHTML = "";
});

// A new element each time, so a rerender reads the changed mocks.
const ui = () => (
  <main id="editor-main" tabIndex={-1}>
    <QuickOpenButton />
  </main>
);

function renderButton() {
  return render(ui());
}

/** Dispatches the key on `target` and returns the event. */
function pressKey(init: KeyboardEventInit, target: EventTarget = document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const ctrlP = { key: "p", code: "KeyP", ctrlKey: true };
const dialog = () => screen.queryByRole("dialog", { name: "Go to file" });

function flushFrames() {
  act(() => {
    for (const callback of rafCallbacks.splice(0)) callback(0);
  });
}

describe("QuickOpenButton", () => {
  it("opens on Ctrl+P, pausing a playing lesson, and never lets the browser print", () => {
    renderButton();
    const bubbleListener = vi.fn<(event: KeyboardEvent) => void>();
    document.addEventListener("keydown", bubbleListener);

    const event = pressKey(ctrlP);

    expect(event.defaultPrevented).toBe(true);
    expect(dialog()).toBeInTheDocument();
    expect(mocks.pause).toHaveBeenCalledTimes(1);
    expect(bubbleListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubbleListener);
  });

  it("opens on Cmd+P on a Mac and leaves Ctrl+P to Monaco there", () => {
    mocks.isApple = true;
    renderButton();

    expect(pressKey(ctrlP).defaultPrevented).toBe(false);
    expect(dialog()).not.toBeInTheDocument();

    pressKey({ key: "p", code: "KeyP", metaKey: true });
    expect(dialog()).toBeInTheDocument();
  });

  it("ignores Meta+P off a Mac", () => {
    renderButton();

    expect(pressKey({ key: "p", code: "KeyP", metaKey: true }).defaultPrevented).toBe(false);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("prevents a held key's repeats without opening", () => {
    renderButton();

    expect(pressKey({ ...ctrlP, repeat: true }).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("opens nothing while the workspace is covered, and closes when a cover begins", () => {
    mocks.isCovered = true;
    const { rerender } = renderButton();
    expect(pressKey(ctrlP).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeInTheDocument();
    expect(mocks.pause).not.toHaveBeenCalled();

    mocks.isCovered = false;
    rerender(ui());
    pressKey(ctrlP);
    expect(dialog()).toBeInTheDocument();

    mocks.isCovered = true;
    rerender(ui());
    expect(dialog()).not.toBeInTheDocument();

    // Closed for good: the picker does not come back when the cover goes.
    mocks.isCovered = false;
    rerender(ui());
    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to file" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("leaves the key to a running product tour", () => {
    mocks.isTourActive = true;
    renderButton();

    expect(pressKey(ctrlP).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeInTheDocument();
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("moves down on the shortcut pressed again in the picker, and never prints", () => {
    renderButton();
    pressKey(ctrlP);
    const input = screen.getByRole("combobox");
    const activeText = () =>
      document.getElementById(input.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(activeText()).toMatch(/^a\.ts/);

    const again = pressKey(ctrlP, input);
    expect(again.defaultPrevented).toBe(true);
    expect(activeText()).toMatch(/^b\.ts/);
    expect(mocks.pause).toHaveBeenCalledTimes(1);

    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    expect(pressKey(ctrlP, close).defaultPrevented).toBe(true);
    expect(dialog()).toBeInTheDocument();
  });

  it("keeps the lesson paused if playback starts while the picker is open", () => {
    const { rerender } = renderButton();
    pressKey(ctrlP);
    expect(mocks.pause).toHaveBeenCalledTimes(1);

    mocks.isPlaying = true;
    rerender(ui());
    expect(mocks.pause).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    mocks.isPlaying = false;
    rerender(ui());
    mocks.isPlaying = true;
    rerender(ui());
    expect(mocks.pause).toHaveBeenCalledTimes(2);
  });

  it("draws the picker in a layer above the header's z-50 popovers", () => {
    renderButton();
    pressKey(ctrlP);

    expect(dialog()?.closest(".z-60")).toHaveClass("absolute");
  });

  it("leaves the key to another open dialog or menu", () => {
    renderButton();
    const other = document.createElement("div");
    other.setAttribute("aria-modal", "true");
    document.body.append(other);
    expect(pressKey(ctrlP).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeInTheDocument();
    other.remove();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(menu);
    pressKey(ctrlP, item);
    expect(dialog()).not.toBeInTheDocument();
  });

  it("opens the picked file and moves focus into the editor", () => {
    const editorNode = document.createElement("div");
    editorNode.tabIndex = -1;
    mocks.editor = { getDomNode: () => editorNode, focus: () => editorNode.focus() };
    renderButton();
    document.body.append(editorNode);
    pressKey(ctrlP);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(mocks.openWorkspaceFile).toHaveBeenCalledWith("src/b.ts");
    expect(dialog()).not.toBeInTheDocument();
    expect(document.getElementById("editor-main")).toHaveFocus();
    flushFrames();
    expect(editorNode).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces the switch when no editor can take focus", () => {
    renderButton();
    pressKey(ctrlP);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "logo" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    flushFrames();

    expect(mocks.openWorkspaceFile).toHaveBeenCalledWith("logo.png");
    expect(document.getElementById("editor-main")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Opened logo.png");
  });

  it("gives focus back to the button when cancelled", () => {
    renderButton();
    const button = screen.getByRole("button", { name: "Go to file" });
    button.focus();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(dialog()).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(mocks.openWorkspaceFile).not.toHaveBeenCalled();
  });

  it("gives focus to the button when what opened the picker is gone", () => {
    renderButton();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    pressKey(ctrlP, opener);
    opener.remove();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to file" })).toHaveFocus();
  });

  it("names its shortcut", () => {
    renderButton();
    const button = screen.getByRole("button", { name: "Go to file" });

    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+P");
    expect(button).toHaveAttribute("title", "Go to file (Ctrl+P)");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
  });
});
