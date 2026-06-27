import type { RefObject } from "react";

interface RuntimePreviewRendererProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  replayContainerRef: RefObject<HTMLDivElement | null>;
  isRrwebReplayActive: boolean;
  disablePointerEvents: boolean;
}

export function RuntimePreviewRenderer({
  iframeRef,
  replayContainerRef,
  isRrwebReplayActive,
  disablePointerEvents,
}: RuntimePreviewRendererProps) {
  // During runtime playback the recorded session is replayed by an rrweb Replayer
  // that mounts its own iframe into this container — the live runtime iframe is not
  // used. `data-cursor-replay-target` keeps the replayed cursor aligned over the
  // preview region (same bounds the live iframe would occupy).
  if (isRrwebReplayActive) {
    return (
      <div
        ref={replayContainerRef}
        className={`absolute inset-0 block size-full overflow-hidden bg-transparent ${disablePointerEvents ? "pointer-events-none" : ""}`}
        data-cursor-replay-target="preview-frame"
      />
    );
  }

  return (
    <iframe
      ref={iframeRef}
      className={`absolute inset-0 block border-0 bg-transparent align-middle size-full ${disablePointerEvents ? "pointer-events-none" : ""}`}
      title="Runtime Preview"
      sandbox="allow-scripts allow-same-origin allow-forms"
      data-cursor-replay-target="preview-frame"
    />
  );
}
