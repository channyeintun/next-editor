import type { RefObject } from "react";

interface RuntimePreviewRendererProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  disablePointerEvents: boolean;
}

export function RuntimePreviewRenderer({
  iframeRef,
  disablePointerEvents,
}: RuntimePreviewRendererProps) {
  return (
    <iframe
      ref={iframeRef}
      className={`absolute inset-0 block border-0 bg-transparent align-middle size-full ${disablePointerEvents ? "pointer-events-none" : ""}`}
      title="Runtime Preview"
      sandbox="allow-scripts allow-same-origin"
      data-cursor-replay-target="preview-frame"
    />
  );
}
