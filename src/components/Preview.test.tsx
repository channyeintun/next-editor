import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import Preview from "./Preview";

const previewState = vi.hoisted(() => ({
  isOpen: false,
  activeMode: "browser" as "browser" | "api",
  showModeToggle: false,
}));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ isPlaying: false }),
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
});

describe("Preview", () => {
  it("uses the full dock width on the first open render", () => {
    const view = render(<Preview />);
    expect(screen.queryByRole("complementary", { name: "Preview" })).not.toBeInTheDocument();

    previewState.isOpen = true;
    view.rerender(<Preview />);

    expect(screen.getByRole("complementary", { name: "Preview" })).toHaveStyle({ width: "432px" });
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
