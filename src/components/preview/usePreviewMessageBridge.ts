import { useEffect, type RefObject } from "react";
import {
  type IframeInteractionEvent,
  type PreviewDomPatchBatch,
  type PreviewEvent,
  type PreviewInitialDocument,
  type PreviewRecordedEvent,
  type PreviewSize,
} from "../../types/slides";
import {
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
} from "../../utils/apiClientBridge";
import {
  IFRAME_CONSOLE_MESSAGE_TYPE,
  isIframeConsoleMethod,
  type IframeConsoleMessagePayload,
} from "../../utils/iframeConsoleBridge";
import {
  createReplayableRuntimePreviewFromHtml,
  type PreviewScrollPosition,
  RUNTIME_SNAPSHOT_MESSAGE_TYPE,
} from "./previewIframeUtils";
import {
  PREVIEW_RRWEB_FORMAT_VERSION,
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
} from "./rrwebPreview";

interface UsePreviewMessageBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  apiIframeRef?: RefObject<HTMLIFrameElement | null>;
  effectiveRuntimePreviewUrl: string | null;
  isRecordingRef: RefObject<boolean>;
  handlePreviewEventRef: RefObject<((event: PreviewEvent) => void) | null>;
  handlePreviewInitialDocumentRef: RefObject<((document: PreviewInitialDocument) => void) | null>;
  handlePreviewPatchBatchRef: RefObject<((batch: PreviewDomPatchBatch) => void) | null>;
  lastPreviewInitialDocumentRef: RefObject<PreviewInitialDocument | null>;
  recordedPreviewInitialDocumentIdRef: RefObject<string | null>;
  lastRuntimeSnapshotRef: RefObject<string>;
  scrollPositionRef: RefObject<PreviewScrollPosition>;
  userScrollTimeoutRef: RefObject<NodeJS.Timeout | null>;
  isUserScrollingRef: RefObject<boolean>;
  targetScrollRef: RefObject<PreviewScrollPosition | null>;
  pendingInteractionRef: RefObject<IframeInteractionEvent | null>;
  sizeRef: RefObject<PreviewSize>;
  onConsoleMessage: (message: string) => void;
  onRouteChange: (route: string) => void;
}

function formatPreviewConsoleMessage(payload: unknown): string | null {
  const consolePayload = payload as Partial<IframeConsoleMessagePayload> | null;

  if (!consolePayload || !isIframeConsoleMethod(consolePayload.method)) {
    return null;
  }

  const args = Array.isArray(consolePayload.args)
    ? consolePayload.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const message = args.join(" ");
  const location =
    typeof consolePayload.pathname === "string" && consolePayload.pathname
      ? ` ${consolePayload.pathname}`
      : "";

  return `[preview:${consolePayload.method}]${location} ${message}`.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPreviewRecordedEvent(value: unknown): value is PreviewRecordedEvent {
  return (
    isRecord(value) &&
    typeof value.type === "number" &&
    isFiniteNumber(value.timestamp) &&
    "data" in value
  );
}

function isPreviewRecordedEventArray(value: unknown): value is PreviewRecordedEvent[] {
  return Array.isArray(value) && value.every(isPreviewRecordedEvent);
}

function createValidatedInitialDocument(
  payload: unknown,
  effectiveRuntimePreviewUrl: string | null,
): PreviewInitialDocument | null {
  if (!isRecord(payload) || !effectiveRuntimePreviewUrl) {
    return null;
  }

  if (
    payload.version !== PREVIEW_RRWEB_FORMAT_VERSION ||
    !isFiniteNumber(payload.time) ||
    typeof payload.documentId !== "string" ||
    !isOptionalString(payload.route) ||
    !isPreviewRecordedEventArray(payload.events)
  ) {
    return null;
  }

  return {
    version: PREVIEW_RRWEB_FORMAT_VERSION,
    time: payload.time,
    documentId: payload.documentId,
    route: payload.route,
    events: payload.events,
  };
}

function createValidatedPatchBatch(payload: unknown): PreviewDomPatchBatch | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    payload.version !== PREVIEW_RRWEB_FORMAT_VERSION ||
    !isFiniteNumber(payload.time) ||
    (payload.source !== "runtime-preview" && payload.source !== "static-preview") ||
    typeof payload.documentId !== "string" ||
    !isOptionalString(payload.route) ||
    !isPreviewRecordedEventArray(payload.events)
  ) {
    return null;
  }

  return {
    version: PREVIEW_RRWEB_FORMAT_VERSION,
    time: payload.time,
    source: payload.source,
    documentId: payload.documentId,
    route: payload.route,
    events: payload.events,
  };
}

export function usePreviewMessageBridge({
  iframeRef,
  apiIframeRef,
  effectiveRuntimePreviewUrl,
  isRecordingRef,
  handlePreviewEventRef,
  handlePreviewInitialDocumentRef,
  handlePreviewPatchBatchRef,
  lastPreviewInitialDocumentRef,
  recordedPreviewInitialDocumentIdRef,
  lastRuntimeSnapshotRef,
  scrollPositionRef,
  userScrollTimeoutRef,
  isUserScrollingRef,
  targetScrollRef,
  pendingInteractionRef,
  sizeRef,
  onConsoleMessage,
  onRouteChange,
}: UsePreviewMessageBridgeOptions) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const previewWindow = iframeRef.current?.contentWindow;
      const apiWindow = apiIframeRef?.current?.contentWindow;
      const fromApiClient = Boolean(apiWindow) && event.source === apiWindow;

      if (event.source !== previewWindow && !fromApiClient) {
        return;
      }

      const { type, payload } = event.data || {};

      // rrweb document/patch streams are recorded from BOTH frames (the runtime
      // preview and the API client), so replay can switch between them on the
      // single merged event stream — handle these before the source split.
      if (type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE) {
        const initialDocument = createValidatedInitialDocument(payload, effectiveRuntimePreviewUrl);
        if (!initialDocument) {
          return;
        }

        lastPreviewInitialDocumentRef.current = initialDocument;

        if (
          isRecordingRef.current &&
          handlePreviewInitialDocumentRef.current &&
          initialDocument.documentId !== recordedPreviewInitialDocumentIdRef.current
        ) {
          handlePreviewInitialDocumentRef.current(initialDocument);
          recordedPreviewInitialDocumentIdRef.current = initialDocument.documentId;
        }

        return;
      }

      if (type === RUNTIME_PATCH_BATCH_MESSAGE_TYPE) {
        const patchBatch = createValidatedPatchBatch(payload);

        if (patchBatch && isRecordingRef.current && handlePreviewPatchBatchRef.current) {
          handlePreviewPatchBatchRef.current(patchBatch);
        }

        return;
      }

      // The API client frame's only non-rrweb message is an outbound request,
      // relayed into the runtime preview iframe's same-origin fetch proxy (which
      // sidesteps CORS). Nothing else from that frame concerns the host.
      if (fromApiClient) {
        if (type === API_CLIENT_REQUEST_MESSAGE_TYPE) {
          previewWindow?.postMessage(event.data, "*");
        }

        return;
      }

      // --- Everything below is from the runtime preview iframe only. ---

      if (type === IFRAME_CONSOLE_MESSAGE_TYPE) {
        const message = formatPreviewConsoleMessage(payload);

        if (message) {
          onConsoleMessage(message);
        }

        return;
      }

      // The fetch proxy's response is relayed back to the API client frame, which
      // renders it into its DOM (so rrweb records it for replay).
      if (type === API_CLIENT_RESPONSE_MESSAGE_TYPE) {
        if (payload && typeof payload.id === "string") {
          apiWindow?.postMessage(event.data, "*");
        }

        return;
      }

      if (type === RUNTIME_SNAPSHOT_MESSAGE_TYPE) {
        if (typeof payload?.html !== "string" || !effectiveRuntimePreviewUrl) {
          return;
        }

        const snapshot = createReplayableRuntimePreviewFromHtml(
          payload.html,
          effectiveRuntimePreviewUrl,
        );

        if (snapshot) {
          lastRuntimeSnapshotRef.current = snapshot;
        }

        return;
      }

      if (type !== "IFRAME_INTERACTION") {
        return;
      }

      if (payload.type === "mousemove") {
        return;
      }

      if (payload.type === "route_change") {
        const route = payload.data?.route;

        if (!effectiveRuntimePreviewUrl || typeof route !== "string") {
          return;
        }

        onRouteChange(route);

        if (isRecordingRef.current && handlePreviewEventRef.current) {
          handlePreviewEventRef.current({
            type: "preview_route_change",
            timestamp: Date.now(),
            size: sizeRef.current,
            route,
          });
        }

        return;
      }

      const isMainDocumentScroll =
        payload.type === "scroll" &&
        payload.data &&
        (payload.data.isDocument || payload.targetTag === "BODY" || payload.targetTag === "HTML");

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
    apiIframeRef,
    effectiveRuntimePreviewUrl,
    handlePreviewInitialDocumentRef,
    handlePreviewEventRef,
    handlePreviewPatchBatchRef,
    iframeRef,
    isRecordingRef,
    isUserScrollingRef,
    lastRuntimeSnapshotRef,
    lastPreviewInitialDocumentRef,
    onConsoleMessage,
    onRouteChange,
    pendingInteractionRef,
    recordedPreviewInitialDocumentIdRef,
    scrollPositionRef,
    sizeRef,
    targetScrollRef,
    userScrollTimeoutRef,
  ]);
}
