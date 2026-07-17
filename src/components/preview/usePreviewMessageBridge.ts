import { useEffect, type RefObject } from "react";
import {
  type IframeInteractionEvent,
  type IframeInteractionTarget,
  type IframeInteractionData,
  type PreviewDomPatchBatch,
  type PreviewEvent,
  type PreviewInitialDocument,
  type PreviewRecordedEvent,
  type PreviewSize,
} from "../../types/slides";
import {
  API_CLIENT_RESPONSE_MESSAGE_TYPE,
  type ApiClientResultPayload,
} from "../../utils/apiClientBridge";
import { recordPerformanceMetric } from "../../utils/performanceMetrics";
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
  effectiveRuntimePreviewUrl: string | null;
  isRecordingRef: RefObject<boolean>;
  handlePreviewEventRef: RefObject<((event: PreviewEvent) => void) | null>;
  handlePreviewInitialDocumentRef: RefObject<((document: PreviewInitialDocument) => void) | null>;
  handlePreviewPatchBatchRef: RefObject<((batch: PreviewDomPatchBatch) => void) | null>;
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
  shouldAcceptRuntimeSnapshot?: (requestId: string | null) => boolean;
  onRuntimeSnapshot?: (snapshot: string, requestId: string | null) => void;
  onApiClientResponse?: (payload: ApiClientResultPayload) => void;
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
    (payload.refresh !== undefined && payload.refresh !== true) ||
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
    refresh: payload.refresh,
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
  effectiveRuntimePreviewUrl,
  isRecordingRef,
  handlePreviewEventRef,
  handlePreviewInitialDocumentRef,
  handlePreviewPatchBatchRef,
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
  shouldAcceptRuntimeSnapshot,
  onRuntimeSnapshot,
  onApiClientResponse,
}: UsePreviewMessageBridgeOptions) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const { type, payload } = event.data || {};
      if (type === IFRAME_CONSOLE_MESSAGE_TYPE) {
        const message = formatPreviewConsoleMessage(payload);

        if (message) {
          onConsoleMessage(message);
        }

        return;
      }

      if (type === API_CLIENT_RESPONSE_MESSAGE_TYPE) {
        if (payload && typeof payload.id === "string" && onApiClientResponse) {
          onApiClientResponse(payload as ApiClientResultPayload);
        }

        return;
      }

      if (type === RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE) {
        const initialDocument = createValidatedInitialDocument(payload, effectiveRuntimePreviewUrl);
        if (!initialDocument) {
          return;
        }

        if (!isRecordingRef.current || !handlePreviewInitialDocumentRef.current) {
          return;
        }

        // A refresh document is the recorder's answer to the recording-start
        // snapshot request. It seeds the recording only while nothing has been
        // recorded yet, so a late answer can never displace a newer page's own
        // initial document. Regular (page-load) documents are recorded whenever
        // a new documentId appears — an iframe (re)load during the recording.
        const { refresh, ...recordedDocument } = initialDocument;
        const shouldRecord = refresh
          ? recordedPreviewInitialDocumentIdRef.current === null
          : recordedDocument.documentId !== recordedPreviewInitialDocumentIdRef.current;

        if (shouldRecord) {
          handlePreviewInitialDocumentRef.current(recordedDocument);
          recordedPreviewInitialDocumentIdRef.current = recordedDocument.documentId;
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

      if (type === RUNTIME_SNAPSHOT_MESSAGE_TYPE) {
        if (typeof payload?.html !== "string" || !effectiveRuntimePreviewUrl) {
          return;
        }
        const requestId =
          typeof payload.requestId === "string" ? payload.requestId.slice(0, 128) : null;
        if (shouldAcceptRuntimeSnapshot && !shouldAcceptRuntimeSnapshot(requestId)) {
          return;
        }

        if (isFiniteNumber(payload.durationMs)) {
          recordPerformanceMetric(
            "preview.snapshot_serialize",
            Math.min(payload.durationMs, 60_000),
            "ms",
            { source: "runtime_bridge" },
          );
        }
        if (isFiniteNumber(payload.byteLength)) {
          recordPerformanceMetric(
            "preview.snapshot_bytes",
            Math.min(payload.byteLength, 50 * 1024 * 1024),
            "bytes",
            { source: "runtime_bridge" },
          );
        }

        const snapshot = createReplayableRuntimePreviewFromHtml(
          payload.html,
          effectiveRuntimePreviewUrl,
        );

        if (snapshot) {
          lastRuntimeSnapshotRef.current = snapshot;
          onRuntimeSnapshot?.(snapshot, requestId);
        }

        return;
      }

      if (type !== "IFRAME_INTERACTION") {
        return;
      }

      if (!isRecord(payload)) {
        return;
      }

      const p = payload as Record<string, unknown>;

      if (p.type === "mousemove") {
        return;
      }

      if (p.type === "route_change") {
        const data = p.data as Record<string, unknown> | undefined;
        const route = data?.route;

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

      const data = p.data as Record<string, unknown> | undefined;
      const isMainDocumentScroll =
        p.type === "scroll" &&
        data &&
        (data.isDocument || p.targetTag === "BODY" || p.targetTag === "HTML");

      if (isMainDocumentScroll) {
        scrollPositionRef.current = {
          scrollTop: data.scrollTop as number,
          scrollLeft: data.scrollLeft as number,
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
            scrollTop: data.scrollTop as number,
            scrollLeft: data.scrollLeft as number,
          };

          handlePreviewEventRef.current({
            type: "preview_scroll",
            timestamp: Date.now(),
            size: sizeRef.current,
            scrollTop: data.scrollTop as number,
            scrollLeft: data.scrollLeft as number,
          });
        }

        return;
      }

      if (!isRecordingRef.current || !handlePreviewEventRef.current) {
        return;
      }

      const interaction: IframeInteractionEvent = {
        type: p.type as unknown as IframeInteractionEvent["type"],
        timestamp: performance.now(),
        target: p.target as unknown as IframeInteractionTarget,
        data: p.data as unknown as IframeInteractionData | undefined,
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
    handlePreviewInitialDocumentRef,
    handlePreviewEventRef,
    handlePreviewPatchBatchRef,
    iframeRef,
    isRecordingRef,
    isUserScrollingRef,
    lastRuntimeSnapshotRef,
    onApiClientResponse,
    onConsoleMessage,
    onRouteChange,
    onRuntimeSnapshot,
    pendingInteractionRef,
    recordedPreviewInitialDocumentIdRef,
    scrollPositionRef,
    shouldAcceptRuntimeSnapshot,
    sizeRef,
    targetScrollRef,
    userScrollTimeoutRef,
  ]);
}
