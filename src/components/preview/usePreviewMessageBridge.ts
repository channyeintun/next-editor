import { useEffect, type RefObject } from "react";
import type {
  IframeInteractionEvent,
  PreviewEvent,
  PreviewSize,
} from "../../types/slides";
import {
  createReplayableRuntimePreviewFromHtml,
  type PreviewScrollPosition,
  RUNTIME_SNAPSHOT_MESSAGE_TYPE,
} from "./previewIframeUtils";

interface UsePreviewMessageBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  effectiveRuntimePreviewUrl: string | null;
  isRecordingRef: RefObject<boolean>;
  handlePreviewEventRef: RefObject<((event: PreviewEvent) => void) | null>;
  lastRuntimeSnapshotRef: RefObject<string>;
  scrollPositionRef: RefObject<PreviewScrollPosition>;
  userScrollTimeoutRef: RefObject<NodeJS.Timeout | null>;
  isUserScrollingRef: RefObject<boolean>;
  targetScrollRef: RefObject<PreviewScrollPosition | null>;
  pendingInteractionRef: RefObject<IframeInteractionEvent | null>;
  sizeRef: RefObject<PreviewSize>;
}

export function usePreviewMessageBridge({
  iframeRef,
  effectiveRuntimePreviewUrl,
  isRecordingRef,
  handlePreviewEventRef,
  lastRuntimeSnapshotRef,
  scrollPositionRef,
  userScrollTimeoutRef,
  isUserScrollingRef,
  targetScrollRef,
  pendingInteractionRef,
  sizeRef,
}: UsePreviewMessageBridgeOptions) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const { type, payload } = event.data || {};
      if (type === RUNTIME_SNAPSHOT_MESSAGE_TYPE) {
        if (typeof payload?.html !== "string" || !effectiveRuntimePreviewUrl) {
          return;
        }

        const previousSnapshot = lastRuntimeSnapshotRef.current;
        const snapshot = createReplayableRuntimePreviewFromHtml(
          payload.html,
          effectiveRuntimePreviewUrl,
        );

        if (snapshot) {
          lastRuntimeSnapshotRef.current = snapshot;

          if (
            snapshot !== previousSnapshot &&
            isRecordingRef.current &&
            handlePreviewEventRef.current
          ) {
            handlePreviewEventRef.current({
              type: "preview_refresh",
              timestamp: Date.now(),
              size: sizeRef.current,
              content: snapshot,
              scrollTop: scrollPositionRef.current.scrollTop,
              scrollLeft: scrollPositionRef.current.scrollLeft,
            });
          }
        }

        return;
      }

      if (type !== "IFRAME_INTERACTION") {
        return;
      }

      if (payload.type === "mousemove") {
        return;
      }

      const isMainDocumentScroll =
        payload.type === "scroll" &&
        payload.data &&
        (payload.data.isDocument ||
          payload.targetTag === "BODY" ||
          payload.targetTag === "HTML");

      if (isMainDocumentScroll) {
        scrollPositionRef.current = {
          scrollTop: payload.data.scrollTop,
          scrollLeft: payload.data.scrollLeft,
        };

        if (isRecordingRef.current && handlePreviewEventRef.current) {
          isUserScrollingRef.current = true;
          if (userScrollTimeoutRef.current) {
            clearTimeout(userScrollTimeoutRef.current);
          }
          userScrollTimeoutRef.current = setTimeout(() => {
            isUserScrollingRef.current = false;
          }, 100);

          targetScrollRef.current = {
            scrollTop: payload.data.scrollTop,
            scrollLeft: payload.data.scrollLeft,
          };

          handlePreviewEventRef.current({
            type: "preview_scroll",
            timestamp: Date.now(),
            size: sizeRef.current,
            scrollTop: payload.data.scrollTop,
            scrollLeft: payload.data.scrollLeft,
          });
        }

        return;
      }

      if (!isRecordingRef.current || !handlePreviewEventRef.current) {
        return;
      }

      const interaction: IframeInteractionEvent = {
        type: payload.type,
        timestamp: performance.now(),
        target: payload.target,
        data: payload.data,
      };

      pendingInteractionRef.current = interaction;
      handlePreviewEventRef.current({
        type: "preview_interaction",
        timestamp: Date.now(),
        size: sizeRef.current,
        scrollTop: scrollPositionRef.current.scrollTop,
        scrollLeft: scrollPositionRef.current.scrollLeft,
        interaction,
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    effectiveRuntimePreviewUrl,
    handlePreviewEventRef,
    iframeRef,
    isRecordingRef,
    isUserScrollingRef,
    lastRuntimeSnapshotRef,
    pendingInteractionRef,
    scrollPositionRef,
    sizeRef,
    targetScrollRef,
    userScrollTimeoutRef,
  ]);
}
