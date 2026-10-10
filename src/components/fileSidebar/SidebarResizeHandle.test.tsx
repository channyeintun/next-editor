import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { getEditorOptions } from "../../monaco/theme";
import {
  DEFAULT_FILE_SIDEBAR_WIDTH,
  FILE_SIDEBAR_KEYBOARD_LARGE_STEP,
  FILE_SIDEBAR_KEYBOARD_STEP,
  getClampedFileSidebarWidth,
  getFileSidebarMaxWidth,
  MIN_FILE_SIDEBAR_WIDTH,
} from "../../utils/sidebarLayout";
import SidebarResizeHandle from "./SidebarResizeHandle";

beforeAll(() => {
  // jsdom has no pointer capture.
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
});

afterEach(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

function renderHandle(width = 280) {
  const onWidthChange = vi.fn<(width: number) => void>();
  const view = render(<SidebarResizeHandle width={width} onWidthChange={onWidthChange} />);
  return {
    ...view,
    onWidthChange,
    handle: () => screen.getByRole("separator", { name: "Resize file sidebar" }),
  };
}

const clamp = (width: number) => getClampedFileSidebarWidth(width, window.innerWidth);
/** The preset a click steps to from the 280px test width: 360px, if it fits. */
const nextPresetFrom280 = () => clamp(Math.min(360, getFileSidebarMaxWidth(window.innerWidth)));

/** Presses and releases the primary button on the handle, `drift` px apart. */
function click(handle: HTMLElement, drift = 0) {
  fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
  if (drift) {
    fireEvent.pointerMove(window, { clientX: 300 + drift });
  }
  fireEvent.pointerUp(window, { clientX: 300 + drift });
}

describe("SidebarResizeHandle", () => {
  it("describes the width as a focusable vertical separator", () => {
    const { handle } = renderHandle(280.4);

    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuemin", String(MIN_FILE_SIDEBAR_WIDTH));
    expect(handle()).toHaveAttribute(
      "aria-valuemax",
      String(getFileSidebarMaxWidth(window.innerWidth)),
    );
    expect(handle()).toHaveAttribute("aria-valuenow", "280");
    expect(handle()).toHaveAttribute("tabindex", "0");
    expect(handle()).toHaveAccessibleDescription("Drag, click, or use the arrow keys to resize");
  });

  it("offers a 24px hit area centred on the edge, with the line on the edge", () => {
    const { handle } = renderHandle();

    // w-6 is 24px and -right-3 moves it 12px past the edge: centred on it.
    expect(handle()).toHaveClass("w-6", "-right-3");
    expect(handle()).toHaveClass("before:left-1/2", "before:-translate-x-1/2", "before:w-px");
  });

  it("reaches no further into the editor than its line-number column", () => {
    // How far the hit area extends past the sidebar's edge (-right-3).
    const reachIntoEditor = 12;
    const editor = getEditorOptions(false);

    // Monaco starts right at the edge. With no glyph margin, its leftmost
    // column is the right-aligned line numbers, at least lineNumbersMinChars
    // digits wide. Even at a narrow 0.5em digit that column is wider than the
    // reach, so the handle never covers editor text or a gutter glyph.
    expect(editor.glyphMargin).toBe(false);
    expect(reachIntoEditor).toBeLessThan(editor.lineNumbersMinChars * editor.fontSize * 0.5);
  });

  it("steps the width with the arrow keys, Home and End", () => {
    const { handle, onWidthChange } = renderHandle(280);

    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle(), { key: "Home" });
    fireEvent.keyDown(handle(), { key: "End" });

    expect(onWidthChange.mock.calls).toEqual([
      [clamp(280 - FILE_SIDEBAR_KEYBOARD_STEP)],
      [clamp(280 + FILE_SIDEBAR_KEYBOARD_LARGE_STEP)],
      [clamp(MIN_FILE_SIDEBAR_WIDTH)],
      [clamp(getFileSidebarMaxWidth(window.innerWidth))],
    ]);
  });

  it("leaves other keys alone", () => {
    const { handle, onWidthChange } = renderHandle();

    const event = fireEvent.keyDown(handle(), { key: "Enter" });

    expect(event).toBe(true); // not default-prevented
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("follows a primary-button drag from where it started, until the pointer is released", () => {
    const { handle, onWidthChange, container } = renderHandle(280);

    fireEvent.pointerDown(handle(), { button: 2, clientX: 300 });
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();

    fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 1 });
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.style.cursor).toBe("col-resize");
    expect(handle()).toHaveClass("before:bg-sky-400");

    fireEvent.pointerMove(window, { clientX: 340 });
    expect(onWidthChange).toHaveBeenLastCalledWith(clamp(320));

    fireEvent.pointerUp(window, { clientX: 340 });
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.cursor).toBe("");

    fireEvent.pointerMove(window, { clientX: 400 });
    expect(onWidthChange).toHaveBeenCalledTimes(1);
  });

  it("steps to the next preset width on a click, so resizing never needs a drag", () => {
    const { handle, onWidthChange, container } = renderHandle(280);

    click(handle());

    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(nextPresetFrom280());
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("steps up from the narrowest width and wraps back to it from the widest", () => {
    const narrowest = renderHandle(MIN_FILE_SIDEBAR_WIDTH);
    click(narrowest.handle());
    expect(narrowest.onWidthChange).toHaveBeenCalledExactlyOnceWith(
      clamp(DEFAULT_FILE_SIDEBAR_WIDTH),
    );
    narrowest.unmount();

    const widest = renderHandle(getFileSidebarMaxWidth(window.innerWidth));
    click(widest.handle());
    expect(widest.onWidthChange).toHaveBeenCalledExactlyOnceWith(clamp(MIN_FILE_SIDEBAR_WIDTH));
  });

  it("treats a press that wanders less than 4px as a click, and a longer one as a drag", () => {
    const jitter = renderHandle(280);
    click(jitter.handle(), 3);
    // The 3px follow, then the step that replaces it.
    expect(jitter.onWidthChange.mock.calls).toEqual([[clamp(283)], [nextPresetFrom280()]]);
    jitter.unmount();

    const drag = renderHandle(280);
    click(drag.handle(), 4);
    expect(drag.onWidthChange.mock.calls).toEqual([[clamp(284)]]);
  });

  it("does not step when the press is cancelled", () => {
    const { handle, onWidthChange } = renderHandle(280);

    fireEvent.pointerDown(handle(), { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerCancel(window, { clientX: 300 });

    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("keeps the width in bounds when the window resizes", () => {
    const { onWidthChange } = renderHandle(280);

    fireEvent(window, new Event("resize"));

    expect(onWidthChange).toHaveBeenCalledWith(clamp(280));
  });

  it("listens for window resizes once across width changes, and clamps the latest width", () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const { rerender, onWidthChange } = renderHandle(280);

    for (const width of [300, 320, 340]) {
      rerender(<SidebarResizeHandle width={width} onWidthChange={onWidthChange} />);
    }
    const resizeSubscriptions = addEventListener.mock.calls.filter(([type]) => type === "resize");
    addEventListener.mockRestore();

    expect(resizeSubscriptions).toHaveLength(1);
    fireEvent(window, new Event("resize"));
    expect(onWidthChange).toHaveBeenLastCalledWith(clamp(340));
  });
});
