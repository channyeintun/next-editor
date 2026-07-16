import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Preview from "./Preview";

const previewState = vi.hoisted(() => ({ isOpen: false }));

vi.mock("../hooks/useNextEditorContext", () => ({
  useNextEditorMetadata: () => ({ isPlaying: false }),
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
      isResizing: false,
      isTransitioning: false,
      disablePointerEvents: false,
      previewAddressLabel: "localhost",
      previewAddressTitle: "localhost",
      activeMode: "browser",
      showModeToggle: false,
      isRuntimeReady: false,
      handleClose: noop,
      handleFloat: noop,
      handleDock: noop,
      handleBack: noop,
      handleForward: noop,
      handleRefresh: noop,
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
});

describe("Preview", () => {
  it("uses the full dock width on the first open render", () => {
    const view = render(<Preview />);
    expect(screen.queryByRole("complementary", { name: "Preview" })).not.toBeInTheDocument();

    previewState.isOpen = true;
    view.rerender(<Preview />);

    expect(screen.getByRole("complementary", { name: "Preview" })).toHaveStyle({ width: "432px" });
  });
});
