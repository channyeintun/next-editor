import { memo } from "react";
import { createPortal } from "react-dom";
import { PreviewChrome } from "./preview/PreviewChrome";
import { RuntimePreviewRenderer } from "./preview/RuntimePreviewRenderer";
import { StaticPreviewRenderer } from "./preview/StaticPreviewRenderer";
import { usePreviewController } from "./preview/usePreviewController";

const Preview = memo(function Preview() {
  const controller = usePreviewController();

  if (typeof document === "undefined") {
    return null;
  }

  const previewRenderer =
    controller.rendererKind === "runtime" ? (
      <RuntimePreviewRenderer
        iframeRef={controller.iframeRef}
        disablePointerEvents={controller.disablePointerEvents}
      />
    ) : (
      <StaticPreviewRenderer
        iframeRef={controller.iframeRef}
        disablePointerEvents={controller.disablePointerEvents}
      />
    );

  return createPortal(
    <PreviewChrome
      containerRef={controller.containerRef}
      size={controller.size}
      isRefreshing={controller.isRefreshing}
      onClick={controller.handleClick}
      onMinimize={controller.handleMinimize}
      onMaximize={controller.handleMaximize}
      onRefresh={controller.handleRefresh}
      onResizeStart={controller.handleResizeStart}
      onTransitionStart={controller.handleTransitionStart}
      onTransitionComplete={controller.handleTransitionComplete}
    >
      {previewRenderer}
    </PreviewChrome>,
    document.body,
  );
});

export default Preview;
