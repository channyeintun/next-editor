import { act, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../core/src";
import { NextEditorActionsContext, type NextEditorActions } from "../contexts/NextEditorContext";
import { encodeRecordingToStream } from "../storage/streamingRecordingCodec";
import { useDragAndDropUrl } from "./useDragAndDropUrl";
import { useUrlLoader, type UrlLoader } from "./useUrlLoader";

// jsdom has no DragEvent; a bubbling Event carrying a dataTransfer is all the hook reads.
function dragEvent(type: string, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, getData: () => "" },
  });
  return event;
}

function fakeLoader() {
  return {
    fetchNextEditorFile: vi.fn<UrlLoader["fetchNextEditorFile"]>(async () => {}),
    importNextEditorFile: vi.fn<UrlLoader["importNextEditorFile"]>(async () => {}),
    isNextEditorUrl: vi.fn<UrlLoader["isNextEditorUrl"]>(() => false),
  } as unknown as UrlLoader;
}

/** An editor surface next to a file sidebar that, like FileSidebar, keeps its drops to itself. */
function renderPage(loader: UrlLoader) {
  const state = { isDragging: false };
  function Page() {
    // Like useUrlLoader (which the compiler skips), hand the hook new functions on every render.
    state.isDragging = useDragAndDropUrl({
      ...loader,
      fetchNextEditorFile: (url) => loader.fetchNextEditorFile(url),
      importNextEditorFile: (...files) => loader.importNextEditorFile(...files),
    }).isDragging;
    return createElement(
      "div",
      null,
      createElement("main", { "data-testid": "surface" }, createElement("p", null, "code")),
      createElement("aside", {
        "data-testid": "sidebar",
        onDragOver: (event: DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
        },
      }),
    );
  }
  const view = render(createElement(Page));
  return { state, ...view };
}

describe("useDragAndDropUrl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hides the drop overlay after a drop another handler keeps to itself", () => {
    const { state, getByTestId } = renderPage(fakeLoader());
    const surface = getByTestId("surface");
    const sidebar = getByTestId("sidebar");

    act(() => {
      surface.dispatchEvent(dragEvent("dragenter"));
      surface.dispatchEvent(dragEvent("dragover"));
    });
    expect(state.isDragging).toBe(true);

    act(() => {
      sidebar.dispatchEvent(dragEvent("dragenter"));
      surface.dispatchEvent(dragEvent("dragleave"));
      sidebar.dispatchEvent(dragEvent("dragover"));
      sidebar.dispatchEvent(dragEvent("drop"));
    });
    expect(state.isDragging).toBe(false);
  });

  it("hides the drop overlay when the drag leaves the page from an inner element", () => {
    const { state, getByTestId, getByText } = renderPage(fakeLoader());
    const surface = getByTestId("surface");
    const paragraph = getByText("code");

    // One act per event, so the page re-renders in between, as it does while dragging.
    act(() => surface.dispatchEvent(dragEvent("dragenter")));
    act(() => surface.dispatchEvent(dragEvent("dragover")));
    act(() => paragraph.dispatchEvent(dragEvent("dragenter")));
    act(() => surface.dispatchEvent(dragEvent("dragleave")));
    // Moving onto a child is not leaving.
    expect(state.isDragging).toBe(true);

    // Leaving the window (or Esc) fires dragleave at the element under the pointer.
    act(() => {
      paragraph.dispatchEvent(dragEvent("dragleave"));
    });
    expect(state.isDragging).toBe(false);
  });

  it("still imports a .ne dropped on the page", () => {
    const loader = fakeLoader();
    const { state, getByTestId } = renderPage(loader);
    const lesson = new File(["ne"], "lesson.ne");

    act(() => {
      getByTestId("surface").dispatchEvent(dragEvent("dragenter", [lesson]));
      getByTestId("surface").dispatchEvent(dragEvent("drop", [lesson]));
    });

    expect(state.isDragging).toBe(false);
    expect(loader.importNextEditorFile).toHaveBeenCalledWith([lesson]);
  });
});

describe("dropping a lesson with other files", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    document.body.innerHTML = "";
  });

  async function lessonFile(name: string, overrides: Partial<Recording> = {}): Promise<File> {
    const recording: Recording = {
      version: 4,
      id: "lesson",
      name: "Lesson",
      createdAt: 1,
      duration: 1_000,
      keyframeInterval: 120,
      frames: [],
      ...overrides,
    };
    return new File([(await encodeRecordingToStream(recording)) as BlobPart], name);
  }

  /** The editor's real loader behind the drop hook; returns what reached loadRecording. */
  function renderEditorDropTarget() {
    const loadRecording = vi.fn<NextEditorActions["loadRecording"]>();
    const actions = {
      loadRecording,
      extendRecording: vi.fn<NextEditorActions["extendRecording"]>(),
      appendRecordingDelta: vi.fn<NextEditorActions["appendRecordingDelta"]>(),
      addCaptionTrack: vi.fn<NextEditorActions["addCaptionTrack"]>(),
    } as unknown as NextEditorActions;
    function DropTarget() {
      useDragAndDropUrl(useUrlLoader());
      return createElement("main", { "data-testid": "surface" });
    }
    const view = render(
      createElement(
        NextEditorActionsContext.Provider,
        { value: actions },
        createElement(DropTarget),
      ),
    );
    const drop = (files: File[]) =>
      act(() => {
        view.getByTestId("surface").dispatchEvent(dragEvent("drop", files));
      });
    return { drop, loadRecording };
  }

  it("loads the .ne even when an image is dropped first, in any letter case", async () => {
    const { drop, loadRecording } = renderEditorDropTarget();

    drop([new File(["png"], "cover.png", { type: "image/png" }), await lessonFile("LESSON.NE")]);

    await waitFor(() => expect(loadRecording).toHaveBeenCalledTimes(1));
    expect(loadRecording.mock.calls[0][0].id).toBe("lesson");
  });

  it("pairs the camera video named like the lesson, not the first video dropped", async () => {
    URL.createObjectURL = vi.fn<(blob: Blob) => string>((blob) => `blob:${(blob as File).name}`);
    URL.revokeObjectURL = vi.fn<(url: string) => void>();
    const { drop, loadRecording } = renderEditorDropTarget();

    drop([
      await lessonFile("intro.ne", { cameraFile: "take.webm" }),
      new File(["other"], "other-lesson.webm", { type: "video/webm" }),
      new File(["intro"], "intro.webm", { type: "video/webm" }),
    ]);

    await waitFor(() => expect(loadRecording).toHaveBeenCalledTimes(1));
    expect(loadRecording.mock.calls[0][0].cameraUrl).toBe("blob:intro.webm");
  });
});
