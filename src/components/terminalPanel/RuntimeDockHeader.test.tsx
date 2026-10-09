import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeDockTab } from "../../types/runtime";
import RuntimeDockHeader from "./RuntimeDockHeader";

const TABS = [
  { id: "runner", label: "Runner", icon: null },
  { id: "agent", label: "Agent", icon: null },
] as const;

function renderHeader(props: Partial<ComponentProps<typeof RuntimeDockHeader>> = {}) {
  const layout = {
    displayIsFullHeight: false,
    displayIsCollapsed: false,
    toggleFullHeight: vi.fn<() => void>(),
    toggleCollapsed: vi.fn<() => void>(),
  };
  const onSelectTab = vi.fn<(tab: RuntimeDockTab) => void>();
  const view = render(
    <RuntimeDockHeader
      tabs={TABS}
      activeTab="runner"
      disabled={false}
      onSelectTab={onSelectTab}
      layout={layout}
      {...props}
    />,
  );
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
    expect(screen.getByRole("button", { name: "Collapse runtime dock" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Expand runtime dock to full height" }),
    ).toBeEnabled();
  });

  it("disables the full-height toggle while the dock is collapsed", () => {
    renderHeader({
      layout: {
        displayIsFullHeight: true,
        displayIsCollapsed: true,
        toggleFullHeight: () => {},
        toggleCollapsed: () => {},
      },
    });

    expect(screen.getByRole("button", { name: "Restore runtime dock height" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Expand runtime dock" })).toBeEnabled();
  });

  it("toggles the height and the collapse through the layout", () => {
    const { layout } = renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Expand runtime dock to full height" }));
    expect(layout.toggleFullHeight).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Collapse runtime dock" }));
    expect(layout.toggleCollapsed).toHaveBeenCalledOnce();
  });

  it("renders extra tabs inside the scrolling strip, ahead of the toggles outside it", () => {
    renderHeader({ children: <button type="button">New terminal</button> });

    const tabStrip = screen.getByRole("button", { name: "Runner" }).parentElement;
    expect(tabStrip).toHaveClass("min-w-0", "overflow-x-auto");
    expect(tabStrip).toContainElement(screen.getByRole("button", { name: "New terminal" }));
    for (const name of ["Expand runtime dock to full height", "Collapse runtime dock"]) {
      const control = screen.getByRole("button", { name });
      expect(tabStrip).not.toContainElement(control);
      expect(control).toHaveClass("shrink-0", "size-10");
    }
  });

  it("puts the dock's own attributes and the tour's hook on the collapse toggle", () => {
    renderHeader({ collapseToggleAttributes: { "data-tour": "runner" } });

    const collapse = screen.getByRole("button", { name: "Collapse runtime dock" });
    expect(collapse).toHaveAttribute("data-tour", "runner");
    expect(collapse).toHaveAttribute("data-runtime-dock-toggle");
    expect(
      screen.getByRole("button", { name: "Expand runtime dock to full height" }),
    ).not.toHaveAttribute("data-runtime-dock-toggle");
  });
});
