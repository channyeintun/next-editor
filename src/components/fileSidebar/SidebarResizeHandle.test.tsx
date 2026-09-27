import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
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

  it("keeps the width in bounds when the window resizes", () => {
    const { onWidthChange } = renderHandle(280);

    fireEvent(window, new Event("resize"));

    expect(onWidthChange).toHaveBeenCalledWith(clamp(280));
  });
});
