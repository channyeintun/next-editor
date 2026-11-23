import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import Preview from "./Preview";
import { selectMetadata, type MetadataSelector } from "../test/selectMetadata";
import type { PreviewTabTarget } from "./preview/runtimePreview";

const previewState = vi.hoisted(() => ({
  isOpen: false,
  activeMode: "browser" as "browser" | "api",
  showModeToggle: false,
  previewTab: { url: null, reason: "no-live-preview" } as PreviewTabTarget,
  handleResizeStep: vi.fn<(direction: 1 | -1) => void>(),
}));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: (select?: MetadataSelector) =>
    selectMetadata({ isPlaying: false }, select),
}));

vi.mock("./preview/ApiClientPanel", () => ({
  default: () => <div>API client</div>,
}));

vi.mock("./preview/usePreviewController", () => ({
  usePreviewController: () => {
    const noop = vi.fn<() => void>();

    return {
      containerRef: { current: null },
      iframeRef: { current: null },
      replayContainerRef: { current: null },
      isRrwebReplayActive: false,
      size: "medium",
      isOpen: previewState.isOpen,
      panelMode: "docked",
      dockWidth: 432,
      isRefreshing: false,
      isTransitioning: false,
      disablePointerEvents: false,
      previewAddressLabel: "localhost",
      previewAddressTitle: "localhost",
      previewTab: previewState.previewTab,
      activeMode: previewState.activeMode,
      showModeToggle: previewState.showModeToggle,
      isRuntimeReady: false,
      handleClose: noop,
      handleFloat: noop,
      handleDock: noop,
      handleBack: noop,
      handleForward: noop,
      handleReload: noop,
      handleOpenConsole: noop,
      handleResizeStart: noop,
      handleDockResizeStart: noop,
      handleResizeStep: previewState.handleResizeStep,
      handleTransitionStart: noop,
      handleTransitionComplete: noop,
      setActiveMode: noop,
      sendApiClientRequest: noop,
      recordApiClientTab: noop,
      recordApiClientInspect: noop,
    };
  },
}));

afterEach(() => {
  previewState.isOpen = false;
  previewState.activeMode = "browser";
  previewState.showModeToggle = false;
  previewState.previewTab = { url: null, reason: "no-live-preview" };
  previewState.handleResizeStep.mockClear();
});

describe("Preview", () => {
  it("uses the full dock width on the first open render", () => {
    const view = render(<Preview />);
    expect(screen.queryByRole("complementary", { name: "Preview" })).not.toBeInTheDocument();

    previewState.isOpen = true;
    view.rerender(<Preview />);

    expect(screen.getByRole("complementary", { name: "Preview" })).toHaveStyle({ width: "432px" });
  });

  it("offers Larger and Smaller as a non-drag way to resize", () => {
    previewState.isOpen = true;
    render(<Preview />);

    fireEvent.click(screen.getByRole("button", { name: "Preview options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Larger" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Smaller" }));

    expect(previewState.handleResizeStep.mock.calls).toEqual([[1], [-1]]);
    // The menu stays open so repeated presses keep resizing.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes the window menu on Escape and hands focus back to its button", () => {
    previewState.isOpen = true;
    render(<Preview />);
    const trigger = screen.getByRole("button", { name: "Preview options" });

    fireEvent.click(trigger);
    screen.getByRole("menuitem", { name: "Larger" }).focus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Larger" }), { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("moves between the window menu's items with the arrows, Home and End", () => {
    previewState.isOpen = true;
    render(<Preview />);

    fireEvent.click(screen.getByRole("button", { name: "Preview options" }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Float", "Larger", "Smaller", "Close"]);
    items[0]?.focus();

    // fireEvent returns false once a handler has called preventDefault.
    expect(fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })).toBe(false);
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(items[3]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(items[3]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(items[0]).toHaveFocus();
    // Moving between items leaves the menu open.
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("links the live preview to a browser tab of its own, with no handle on the editor", () => {
    previewState.isOpen = true;
    previewState.previewTab = { url: "https://k3j2h1x9ab-5173.editor.test/todos?done=1" };
    render(<Preview />);

    const link = screen.getByRole("link", { name: "Open preview in a new tab" });
    // A real link: the browser never takes it for a popup, and a middle click,
    // a modified click and "Copy link address" all work.
    expect(link).toHaveAttribute("href", "https://k3j2h1x9ab-5173.editor.test/todos?done=1");
    expect(link).toHaveAttribute("target", "_blank");
    // The page a lesson serves must not reach the editor's window or its address.
    expect(link.getAttribute("rel")?.split(" ")).toEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
    expect(link).not.toHaveAttribute("aria-disabled");
  });

  it("keeps the new-tab link in place, disabled, while there is no live preview", () => {
    previewState.isOpen = true;
    render(<Preview />);

    const link = screen.getByRole("link", { name: "Open preview in a new tab" });
    expect(link).toHaveAttribute("aria-disabled", "true");
    // No address: it takes no focus and opens nothing.
    expect(link).not.toHaveAttribute("href");
    expect(link).not.toHaveAttribute("target");
    expect(link.title).toContain("when the live preview is running");
  });

  it("says why the link is disabled where the browser would keep the tab apart", () => {
    previewState.isOpen = true;
    previewState.previewTab = { url: null, reason: "separate-site" };
    render(<Preview />);

    const link = screen.getByRole("link", { name: "Open preview in a new tab" });
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).not.toHaveAttribute("href");
    expect(link.title).toContain("keeps a preview tab apart from the editor");
  });

  it("makes the runtime frame inert while the opaque API client covers it", async () => {
    previewState.isOpen = true;
    previewState.showModeToggle = true;
    previewState.activeMode = "api";
    render(<Preview />);

    expect(await screen.findByText("API client")).toBeInTheDocument();
    expect(screen.getByTitle("Runtime Preview")).toHaveAttribute("inert");
  });

  it("keeps the runtime frame reachable in the browser frame", async () => {
    previewState.isOpen = true;
    previewState.showModeToggle = true;
    render(<Preview />);

    expect(await screen.findByText("API client")).toBeInTheDocument();
    expect(screen.getByTitle("Runtime Preview")).not.toHaveAttribute("inert");
  });

  it("keeps the runtime frame reachable when no API overlay is rendered", () => {
    // activeMode can stay "api" while the mode toggle is hidden; nothing covers
    // the frame then, so it must stay focusable.
    previewState.isOpen = true;
    previewState.activeMode = "api";
    render(<Preview />);

    expect(screen.getByTitle("Runtime Preview")).not.toHaveAttribute("inert");
  });
});
