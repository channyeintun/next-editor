import type { RefObject } from "react";

interface StaticPreviewRendererProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  disablePointerEvents: boolean;
}

export function StaticPreviewRenderer({
  iframeRef,
  disablePointerEvents,
}: StaticPreviewRendererProps) {
  return (
    <iframe
      ref={iframeRef}
      className={`absolute inset-0 block border-0 bg-transparent align-middle size-full ${disablePointerEvents ? "pointer-events-none" : ""}`}
      title="Code Preview"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
