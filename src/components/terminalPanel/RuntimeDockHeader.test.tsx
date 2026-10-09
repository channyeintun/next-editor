import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeDockTab } from "../../types/runtime";
import RuntimeDockHeader from "./RuntimeDockHeader";

const TABS = [
  { id: "runner", label: "Runner", icon: null },
  { id: "agent", label: "Agent", icon: null },
] as const;

const FULL_HEIGHT_TOGGLE = "Full-height runtime dock";
const DOCK_TOGGLE = "Runtime dock";

type HeaderProps = ComponentProps<typeof RuntimeDockHeader>;

function layoutState(state: Partial<HeaderProps["layout"]> = {}) {
  return {
    displayIsFullHeight: false,
    displayIsCollapsed: false,
    toggleFullHeight: vi.fn<() => void>(),
    toggleCollapsed: vi.fn<() => void>(),
    ...state,
  };
}

function header(props: Partial<HeaderProps> = {}) {
  return (
    <RuntimeDockHeader
      tabs={TABS}
      activeTab="runner"
      disabled={false}
      onSelectTab={() => {}}
      layout={layoutState()}
      {...props}
    />
  );
}

function renderHeader(props: Partial<HeaderProps> = {}) {
  const layout = layoutState();
  const onSelectTab = vi.fn<(tab: RuntimeDockTab) => void>();
  const view = render(header({ layout, onSelectTab, ...props }));
  return { ...view, layout, onSelectTab };
}

describe("RuntimeDockHeader", () => {
  afterEach(() => {
    cleanup();
  });

  it("marks the tab on screen as pressed and selects a tab on click", () => {
    const { onSelectTab } = renderHeader({ activeTab: "agent" });

    expect(screen.getByRole("button", { name: "Runner" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("data-tour", "agent");
    expect(screen.getByRole("button", { name: "Runner" })).not.toHaveAttribute("data-tour");

    fireEvent.click(screen.getByRole("button", { name: "Runner" }));
    expect(onSelectTab).toHaveBeenCalledWith("runner");
  });

  it("makes the tabs and the collapse toggle read-only during playback, but not the height", () => {
    renderHeader({ disabled: true });

    expect(screen.getByRole("button", { name: "Runner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: DOCK_TOGGLE })).toBeDisabled();
    expect(screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE })).toBeEnabled();
  });

  it("disables the full-height toggle while the dock is collapsed", () => {
    renderHeader({ layout: layoutState({ displayIsFullHeight: true, displayIsCollapsed: true }) });

    expect(screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE })).toBeDisabled();
    expect(screen.getByRole("button", { name: DOCK_TOGGLE })).toBeEnabled();
  });

  it("keeps each toggle's name and reports its state, with the action as the title", () => {
    const view = renderHeader();
    const fullHeight = screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE, pressed: false });
    const dock = screen.getByRole("button", { name: DOCK_TOGGLE, expanded: true });
    expect(fullHeight).toHaveAttribute("title", "Expand runtime dock to full height");
    expect(dock).toHaveAttribute("title", "Collapse runtime dock");
    expect(fullHeight).not.toHaveAttribute("aria-expanded");
    expect(dock).not.toHaveAttribute("aria-pressed");

    view.rerender(header({ layout: layoutState({ displayIsFullHeight: true }) }));
    expect(screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE, pressed: true })).toBe(
      fullHeight,
    );
    expect(fullHeight).toHaveAttribute("title", "Restore runtime dock height");

    view.rerender(header({ layout: layoutState({ displayIsCollapsed: true }) }));
    expect(screen.getByRole("button", { name: DOCK_TOGGLE, expanded: false })).toBe(dock);
    expect(dock).toHaveAttribute("title", "Expand runtime dock");
  });

  it("toggles the height and the collapse through the layout", () => {
    const { layout } = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE }));
    expect(layout.toggleFullHeight).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: DOCK_TOGGLE }));
    expect(layout.toggleCollapsed).toHaveBeenCalledOnce();
  });

  it("renders extra tabs inside the scrolling strip, ahead of the toggles outside it", () => {
    renderHeader({ children: <button type="button">New terminal</button> });

    const tabStrip = screen.getByRole("button", { name: "Runner" }).parentElement;
    expect(tabStrip).toHaveClass("min-w-0", "overflow-x-auto");
    expect(tabStrip).toContainElement(screen.getByRole("button", { name: "New terminal" }));
    for (const name of [FULL_HEIGHT_TOGGLE, DOCK_TOGGLE]) {
      const control = screen.getByRole("button", { name });
      expect(tabStrip).not.toContainElement(control);
      expect(control).toHaveClass("shrink-0", "size-10");
    }
  });

  it("puts the dock's own attributes and the tour's hook on the collapse toggle", () => {
    renderHeader({ collapseToggleAttributes: { "data-tour": "runner" } });

    const collapse = screen.getByRole("button", { name: DOCK_TOGGLE });
    expect(collapse).toHaveAttribute("data-tour", "runner");
    expect(collapse).toHaveAttribute("data-runtime-dock-toggle");
    expect(screen.getByRole("button", { name: FULL_HEIGHT_TOGGLE })).not.toHaveAttribute(
      "data-runtime-dock-toggle",
    );
  });
});
