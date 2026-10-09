import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NextEditorActionsContext, type NextEditorActions } from "../../contexts/NextEditorContext";
import { WorkspaceActionsContext } from "../../contexts/WorkspaceContext";
import type { WorkspaceActions } from "../../stores/workspaceActions";
import type { WorkspaceProject } from "../../types/workspace";
import { MAX_WORKSPACE_ASSET_BYTES } from "../../utils/workspaceFileUpload";
import { useWorkspaceFileImport } from "./useWorkspaceFileImport";

const reader = vi.hoisted(() => ({
  readUploadedWorkspaceFile: vi.fn<(file: File) => Promise<{ content: string }>>(),
}));
vi.mock("../../utils/workspaceFileUpload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/workspaceFileUpload")>()),
  ...reader,
}));

afterEach(() => {
  vi.restoreAllMocks();
  reader.readUploadedWorkspaceFile.mockReset();
});

function Harness() {
  const {
    uploadInputRef,
    handleUploadInputChange,
    openFilePicker,
    isFileDragOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useWorkspaceFileImport();
  return (
    <div
      data-testid="drop-target"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        data-testid="picker"
        ref={uploadInputRef}
        type="file"
        multiple
        onChange={handleUploadInputChange}
      />
      <button type="button" onClick={() => openFilePicker("src")}>
        Upload to src
      </button>
      <span data-testid="inside" />
      {isFileDragOver ? <p>Dragging files</p> : null}
    </div>
  );
}

function renderHarness(existingPaths: string[] = []) {
  const actions = {
    createFile: vi.fn<WorkspaceActions["createFile"]>(),
    getProject: vi.fn<WorkspaceActions["getProject"]>(
      () =>
        ({
          files: Object.fromEntries(existingPaths.map((path) => [path, {}])),
          folders: ["src"],
        }) as unknown as WorkspaceProject,
    ),
    saveProject: vi.fn<WorkspaceActions["saveProject"]>(() => Promise.resolve()),
  };
  const editorActions = { handleWorkspaceEvent: vi.fn<() => void>() };
  render(
    <WorkspaceActionsContext value={actions as unknown as WorkspaceActions}>
      <NextEditorActionsContext value={editorActions as unknown as NextEditorActions}>
        <Harness />
      </NextEditorActionsContext>
    </WorkspaceActionsContext>,
  );
  return { ...actions, ...editorActions };
}

function textFile(name: string) {
  reader.readUploadedWorkspaceFile.mockImplementation(async (file) => ({
    content: `contents of ${file.name}`,
  }));
  return new File(["x"], name, { type: "text/plain" });
}

// jsdom has no DragEvent; a bubbling Event carrying a dataTransfer is all the handlers read.
function dragEvent(
  type: string,
  { files = [] as File[], types = ["Files"], relatedTarget = null as Node | null } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, dropEffect: "none" },
  });
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  return event;
}

describe("useWorkspaceFileImport", () => {
  it("opens the picker and adds what it picks under that folder, under unused names", async () => {
    const { createFile, saveProject, handleWorkspaceEvent } = renderHarness(["src/notes.txt"]);
    const picker = screen.getByTestId<HTMLInputElement>("picker");
    const click = vi.spyOn(picker, "click");

    fireEvent.click(screen.getByRole("button", { name: "Upload to src" }));
    expect(click).toHaveBeenCalledTimes(1);

    fireEvent.change(picker, { target: { files: [textFile("notes.txt"), textFile("todo.txt")] } });

    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(1));
    expect(createFile.mock.calls).toEqual([
      ["src/notes-1.txt", "contents of notes.txt", undefined],
      ["src/todo.txt", "contents of todo.txt", undefined],
    ]);
    expect(handleWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(picker.value).toBe("");
  });

  it("skips files that are too large or unreadable, and names them in one alert", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createFile, saveProject, handleWorkspaceEvent } = renderHarness();
    const huge = new File(["x"], "huge.mov");
    Object.defineProperty(huge, "size", { value: MAX_WORKSPACE_ASSET_BYTES + 1 });
    reader.readUploadedWorkspaceFile.mockRejectedValue(new Error("unreadable"));

    fireEvent.change(screen.getByTestId("picker"), {
      target: { files: [huge, new File(["x"], "broken.bin")] },
    });

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert).toHaveBeenCalledWith(
      `Skipped (must be under ${Math.round(MAX_WORKSPACE_ASSET_BYTES / (1024 * 1024))} MB or unreadable):\nhuge.mov\nbroken.bin`,
    );
    expect(createFile).not.toHaveBeenCalled();
    expect(saveProject).not.toHaveBeenCalled();
    expect(handleWorkspaceEvent).not.toHaveBeenCalled();
  });

  it("claims file drags, shows them until they leave, and adds dropped files at the root", async () => {
    const { createFile } = renderHarness();
    const target = screen.getByTestId("drop-target");

    const over = dragEvent("dragover");
    fireEvent(target, over);
    expect(over.defaultPrevented).toBe(true);
    expect((over as unknown as { dataTransfer: DataTransfer }).dataTransfer.dropEffect).toBe(
      "copy",
    );
    expect(screen.getByText("Dragging files")).toBeInTheDocument();

    fireEvent(target, dragEvent("dragleave", { relatedTarget: screen.getByTestId("inside") }));
    expect(screen.getByText("Dragging files")).toBeInTheDocument();

    fireEvent(target, dragEvent("dragleave", { relatedTarget: document.body }));
    expect(screen.queryByText("Dragging files")).not.toBeInTheDocument();

    fireEvent(target, dragEvent("dragover"));
    const drop = dragEvent("drop", { files: [textFile("logo.svg")] });
    fireEvent(target, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.queryByText("Dragging files")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(createFile).toHaveBeenCalledWith("logo.svg", "contents of logo.svg", undefined),
    );
  });

  it("leaves drags that carry no files alone", () => {
    renderHarness();
    const target = screen.getByTestId("drop-target");

    const over = dragEvent("dragover", { types: ["text/uri-list"] });
    fireEvent(target, over);

    expect(over.defaultPrevented).toBe(false);
    expect(screen.queryByText("Dragging files")).not.toBeInTheDocument();
  });
});
