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
      className={`absolute inset-0 w-full h-full block border-0 bg-transparent align-middle ${disablePointerEvents ? "pointer-events-none" : ""}`}
      title="Runtime Preview"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
