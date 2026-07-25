import type { RefObject } from "react";

interface RuntimePreviewRendererProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  replayContainerRef: RefObject<HTMLDivElement | null>;
  isRrwebReplayActive: boolean;
  disablePointerEvents: boolean;
  /**
   * False once a recording is loaded, because from then on the HTML this frame
   * may be handed came out of a `.ne` file rather than from the local user.
   * See the sandbox comment below for why that has to change the sandbox.
   */
  allowSameOrigin: boolean;
}

export function RuntimePreviewRenderer({
  iframeRef,
  replayContainerRef,
  isRrwebReplayActive,
  disablePointerEvents,
  allowSameOrigin,
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

  // `allow-same-origin` is safe for the live runtime, where this frame is
  // pointed at a cross-origin WebContainer URL via `src` — there the flag only
  // preserves that frame's own origin, which WebContainer needs, and the parent
  // still cannot reach into it.
  //
  // It is NOT safe for `srcdoc`. An about:srcdoc document inherits its
  // embedder's origin, so `allow-scripts allow-same-origin` on recorded HTML
  // means the recording executes as first-party script on the app's origin: it
  // can read localStorage, call /api/* with the viewer's session, and reach
  // parent.document. Preview HTML is replayed verbatim out of the `.ne` file
  // (usePreviewController's writeIframeContent), and any signed-in user can
  // publish a lesson, so that was stored XSS against every viewer.
  //
  // Once a recording is loaded the content is foreign, so the frame drops the
  // flag and the srcdoc document lands in an opaque origin. The `key` matters:
  // changing `sandbox` on a live element does not re-apply to the document
  // already in it, so React must mount a genuinely new element.
  const sandbox = allowSameOrigin
    ? "allow-scripts allow-same-origin allow-forms"
    : "allow-scripts allow-forms";

  return (
    <iframe
      key={allowSameOrigin ? "preview-frame-local" : "preview-frame-isolated"}
      ref={iframeRef}
      className={`absolute inset-0 block border-0 bg-transparent align-middle size-full ${disablePointerEvents ? "pointer-events-none" : ""}`}
      title="Runtime Preview"
      sandbox={sandbox}
      data-cursor-replay-target="preview-frame"
    />
  );
}
