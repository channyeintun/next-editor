import { memo } from "react";
import { PreviewChrome } from "./preview/PreviewChrome";
import { RuntimePreviewRenderer } from "./preview/RuntimePreviewRenderer";
import { usePreviewController } from "./preview/usePreviewController";

const Preview = memo(function Preview() {
  const controller = usePreviewController();

  if (!controller.isOpen) {
    return null;
  }

  const previewRenderer = (
    <RuntimePreviewRenderer
      iframeRef={controller.iframeRef}
      replayContainerRef={controller.replayContainerRef}
      isRrwebReplayActive={controller.isRrwebReplayActive}
      disablePointerEvents={controller.disablePointerEvents}
    />
  );

  const previewChrome = (
    <PreviewChrome
      containerRef={controller.containerRef}
      size={controller.size}
      mode={controller.panelMode}
      dockWidth={controller.dockWidth}
      onClose={controller.handleClose}
      onFloat={controller.handleFloat}
      onDock={controller.handleDock}
      onBack={controller.handleBack}
      onForward={controller.handleForward}
      onOpenConsole={controller.handleOpenConsole}
      onResizeStart={controller.handleResizeStart}
      onDockResizeStart={controller.handleDockResizeStart}
      onTransitionStart={controller.handleTransitionStart}
      onTransitionComplete={controller.handleTransitionComplete}
      previewAddressLabel={controller.previewAddressLabel}
      previewAddressTitle={controller.previewAddressTitle}
    >
      {previewRenderer}
    </PreviewChrome>
  );

  return previewChrome;
});

export default Preview;
