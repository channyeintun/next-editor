import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDragAndDropUrl } from "./useDragAndDropUrl";
import type { UrlLoader } from "./useUrlLoader";

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
    expect(loader.importNextEditorFile).toHaveBeenCalledWith(lesson, undefined, undefined);
  });
});
