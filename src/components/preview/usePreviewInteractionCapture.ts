import { useEffect, type RefObject } from "react";
import { createIframeInteractionCaptureScript } from "../../utils/iframeInteractionCapture";

const INTERACTION_CAPTURE_SETUP_MARKER = "__INTERACTION_CAPTURE_SETUP__";
const INTERACTION_CAPTURE_CLEANUP_MARKER = `${INTERACTION_CAPTURE_SETUP_MARKER}:cleanup`;

interface UsePreviewInteractionCaptureOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  isRecording: boolean;
  isRuntimePreviewActive: boolean;
}

export function usePreviewInteractionCapture({
  iframeRef,
  isRecording,
  isRuntimePreviewActive,
}: UsePreviewInteractionCaptureOptions) {
  useEffect(() => {
    if (!isRecording || isRuntimePreviewActive) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    const setupInteractionListeners = () => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        const iframeWindow = iframe.contentWindow as (Window & Record<string, unknown>) | null;

        if (!iframeDoc) {
          return;
        }

        const captureScript = createIframeInteractionCaptureScript(
          INTERACTION_CAPTURE_SETUP_MARKER,
          { includeMouseMove: false, includeRouteChange: true },
        );

        const scriptElement = iframeDoc.createElement("script");
        scriptElement.textContent = captureScript;
        if (iframeDoc.head) {
          iframeDoc.head.appendChild(scriptElement);
        } else {
          iframeDoc.documentElement.appendChild(scriptElement);
        }

        const cleanupInteractionCapture = iframeWindow?.[INTERACTION_CAPTURE_CLEANUP_MARKER];

        return () => {
          if (typeof cleanupInteractionCapture === "function") {
            cleanupInteractionCapture();
          }

          scriptElement.remove();
        };
      } catch (error) {
        console.warn("Cannot track interactions in iframe (likely cross-origin):", error);
        return undefined;
      }
    };

    let cleanup: (() => void) | undefined;

    const handleIframeLoad = () => {
      cleanup?.();
      cleanup = setupInteractionListeners();
    };

    iframe.addEventListener("load", handleIframeLoad);
    cleanup = setupInteractionListeners();

    return () => {
      iframe.removeEventListener("load", handleIframeLoad);
      cleanup?.();
    };
  }, [iframeRef, isRecording, isRuntimePreviewActive]);
}
