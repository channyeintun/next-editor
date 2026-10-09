import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  incrementPerformanceCounter,
  recordPerformanceMetric,
  startPerformanceSpan,
} from "../../utils/performanceMetrics";
import {
  createReplayableRuntimePreview,
  RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
} from "./previewIframeUtils";

// The runtime preview's snapshot protocol: the replayable HTML of the live
// runtime page, serialized directly when the frame is same-origin and otherwise
// requested from the page's recorder by postMessage, one request at a time, with
// a timeout that falls back to the last snapshot. The answers arrive through
// usePreviewMessageBridge, which the controller wires to the returned callbacks.

export type RuntimeSnapshotRequestReason =
  | "edit"
  | "inspection"
  | "load"
  | "recording-finalize"
  | "refresh"
  | "route-change"
  | "runtime-ready";

interface PendingRuntimeSnapshotRequest {
  requestId: string;
  promise: Promise<string | null>;
  resolve: (snapshot: string | null) => void;
  timeoutId: number;
}

const RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS = 1_200;

/**
 * Asks the runtime page's recorder for a snapshot. False when the frame cannot
 * be messaged (postMessage threw), so the caller settles the request at once.
 */
function postSnapshotRequest(
  target: Window,
  reason: RuntimeSnapshotRequestReason,
  requestId: string,
): boolean {
  try {
    target.postMessage(
      {
        type: RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
        payload: { reason, requestId },
      },
      "*",
    );
    return true;
  } catch {
    return false;
  }
}

interface UseRuntimeSnapshotRequestsOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  effectiveRuntimePreviewUrl: string | null;
  isRuntimePreviewActive: boolean;
  /** The frame's last written content; a same-origin snapshot updates it too. */
  lastContentRef: RefObject<string>;
}

export interface RuntimeSnapshotRequests {
  /** Resolves with the page's snapshot, or the last one (or null) on timeout or failure. */
  requestRuntimePreviewSnapshot: (reason: RuntimeSnapshotRequestReason) => Promise<string | null>;
  /** Settles the pending request with a snapshot the recorder posted back. */
  completeRuntimeSnapshotRequest: (snapshot: string, requestId: string | null) => void;
  /** Whether a posted snapshot answers the pending request. */
  shouldAcceptRuntimeSnapshot: (requestId: string | null) => boolean;
  /** The last snapshot of the current runtime page; "" once its URL changes or it stops. */
  lastRuntimeSnapshotRef: RefObject<string>;
  lastRuntimeSnapshotCapturedAtRef: RefObject<number>;
}

export function useRuntimeSnapshotRequests({
  iframeRef,
  effectiveRuntimePreviewUrl,
  isRuntimePreviewActive,
  lastContentRef,
}: UseRuntimeSnapshotRequestsOptions): RuntimeSnapshotRequests {
  const lastRuntimeSnapshotRef = useRef("");
  const lastRuntimeSnapshotCapturedAtRef = useRef(0);
  const lastRuntimeSnapshotUrlRef = useRef<string | null>(null);
  const runtimeSnapshotRequestSequenceRef = useRef(0);
  const pendingRuntimeSnapshotRequestRef = useRef<PendingRuntimeSnapshotRequest | null>(null);

  const captureRuntimePreviewSnapshot = useCallback(() => {
    if (!effectiveRuntimePreviewUrl) {
      return null;
    }

    const iframe = iframeRef.current;

    if (!iframe) {
      return null;
    }

    const finishSpan = startPerformanceSpan("preview.snapshot_serialize", {
      source: "same_origin",
    });
    const snapshot = createReplayableRuntimePreview(iframe, effectiveRuntimePreviewUrl);
    finishSpan({ outcome: snapshot ? "success" : "unavailable" });

    if (snapshot) {
      lastRuntimeSnapshotRef.current = snapshot;
      lastRuntimeSnapshotCapturedAtRef.current = Date.now();
      lastContentRef.current = snapshot;
      recordPerformanceMetric(
        "preview.snapshot_bytes",
        new TextEncoder().encode(snapshot).byteLength,
        "bytes",
        { source: "same_origin" },
      );
    }

    return snapshot;
  }, [effectiveRuntimePreviewUrl, iframeRef, lastContentRef]);

  const completeRuntimeSnapshotRequest = useCallback(
    (snapshot: string, requestId: string | null) => {
      lastRuntimeSnapshotCapturedAtRef.current = Date.now();
      const pendingRequest = pendingRuntimeSnapshotRequestRef.current;
      if (!pendingRequest || requestId !== pendingRequest.requestId) {
        return;
      }

      window.clearTimeout(pendingRequest.timeoutId);
      pendingRuntimeSnapshotRequestRef.current = null;
      pendingRequest.resolve(snapshot);
    },
    [],
  );

  const shouldAcceptRuntimeSnapshot = useCallback((requestId: string | null) => {
    const pendingRequest = pendingRuntimeSnapshotRequestRef.current;
    return Boolean(pendingRequest && requestId === pendingRequest.requestId);
  }, []);

  const requestRuntimePreviewSnapshot = useCallback(
    (reason: RuntimeSnapshotRequestReason): Promise<string | null> => {
      if (!effectiveRuntimePreviewUrl) {
        return Promise.resolve(null);
      }

      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow) {
        return Promise.resolve(null);
      }

      const pendingRequest = pendingRuntimeSnapshotRequestRef.current;
      if (pendingRequest) {
        incrementPerformanceCounter("preview.snapshot_request_coalesced", 1, { reason });
        return pendingRequest.promise;
      }

      incrementPerformanceCounter("preview.snapshot_request", 1, { reason });

      const sameOriginSnapshot = captureRuntimePreviewSnapshot();
      if (sameOriginSnapshot) {
        return Promise.resolve(sameOriginSnapshot);
      }

      const requestId = `runtime-snapshot-${++runtimeSnapshotRequestSequenceRef.current}`;
      let resolveRequest: (snapshot: string | null) => void = () => undefined;
      const promise = new Promise<string | null>((resolve) => {
        resolveRequest = resolve;
      });
      const timeoutId = window.setTimeout(() => {
        const activeRequest = pendingRuntimeSnapshotRequestRef.current;
        if (!activeRequest || activeRequest.requestId !== requestId) {
          return;
        }

        pendingRuntimeSnapshotRequestRef.current = null;
        incrementPerformanceCounter("preview.snapshot_request_timeout", 1, { reason });
        activeRequest.resolve(lastRuntimeSnapshotRef.current || null);
      }, RUNTIME_SNAPSHOT_REQUEST_TIMEOUT_MS);

      pendingRuntimeSnapshotRequestRef.current = {
        requestId,
        promise,
        resolve: resolveRequest,
        timeoutId,
      };

      if (!postSnapshotRequest(iframeWindow, reason, requestId)) {
        window.clearTimeout(timeoutId);
        pendingRuntimeSnapshotRequestRef.current = null;
        resolveRequest(lastRuntimeSnapshotRef.current || null);
      }

      return promise;
    },
    [captureRuntimePreviewSnapshot, effectiveRuntimePreviewUrl, iframeRef],
  );

  useEffect(() => {
    return () => {
      const pendingRequest = pendingRuntimeSnapshotRequestRef.current;
      if (!pendingRequest) {
        return;
      }

      window.clearTimeout(pendingRequest.timeoutId);
      pendingRuntimeSnapshotRequestRef.current = null;
      pendingRequest.resolve(null);
    };
  }, [effectiveRuntimePreviewUrl]);

  useEffect(() => {
    const didUrlChange = lastRuntimeSnapshotUrlRef.current !== effectiveRuntimePreviewUrl;
    lastRuntimeSnapshotUrlRef.current = effectiveRuntimePreviewUrl;

    if (didUrlChange || !isRuntimePreviewActive) {
      lastRuntimeSnapshotRef.current = "";
      lastRuntimeSnapshotCapturedAtRef.current = 0;
    }
  }, [effectiveRuntimePreviewUrl, isRuntimePreviewActive]);

  return {
    requestRuntimePreviewSnapshot,
    completeRuntimeSnapshotRequest,
    shouldAcceptRuntimeSnapshot,
    lastRuntimeSnapshotRef,
    lastRuntimeSnapshotCapturedAtRef,
  };
}
