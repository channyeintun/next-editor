import { useEffect, type RefObject } from "react";
import {
  PREVIEW_DOM_PATCH_FORMAT_VERSION,
  type IframeInteractionEvent,
  type PreviewDomPatchBatch,
  type PreviewDomPatchOp,
  type PreviewEvent,
  type PreviewInitialDocument,
  type PreviewNodeRef,
  type PreviewSize,
  type SerializedPreviewNode,
} from "../../types/slides";
import {
  IFRAME_CONSOLE_MESSAGE_TYPE,
  isIframeConsoleMethod,
  type IframeConsoleMessagePayload,
} from "../../utils/iframeConsoleBridge";
import {
  createReplayableRuntimePreviewFromHtml,
  type PreviewScrollPosition,
  RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE,
  RUNTIME_PATCH_BATCH_MESSAGE_TYPE,
  RUNTIME_SNAPSHOT_MESSAGE_TYPE,
} from "./previewIframeUtils";

interface UsePreviewMessageBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
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

function isOptionalNamespace(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function isPreviewNodeRef(value: unknown): value is PreviewNodeRef {
  if (!isRecord(value) || !Array.isArray(value.path)) {
    return false;
  }

  return (
    (value.id === undefined || typeof value.id === "string") &&
    value.path.every((part) => typeof part === "number" && Number.isInteger(part) && part >= 0)
  );
}

function isSerializedPreviewNode(value: unknown): value is SerializedPreviewNode {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.kind !== "element" &&
    value.kind !== "text" &&
    value.kind !== "comment" &&
    value.kind !== "doctype"
  ) {
    return false;
  }

  if (value.tagName !== undefined && typeof value.tagName !== "string") {
    return false;
  }

  if (!isOptionalNamespace(value.namespaceURI)) {
    return false;
  }

  if (value.text !== undefined && typeof value.text !== "string") {
    return false;
  }

  if (
    value.attributes !== undefined &&
    (!Array.isArray(value.attributes) ||
      !value.attributes.every(
        (attribute) =>
          Array.isArray(attribute) &&
          attribute.length === 2 &&
          typeof attribute[0] === "string" &&
          typeof attribute[1] === "string",
      ))
  ) {
    return false;
  }

  return (
    value.children === undefined ||
    (Array.isArray(value.children) && value.children.every(isSerializedPreviewNode))
  );
}

function isPreviewDomPatchOp(value: unknown): value is PreviewDomPatchOp {
  if (!isRecord(value) || typeof value.op !== "string") {
    return false;
  }

  switch (value.op) {
    case "set_text":
      return isPreviewNodeRef(value.target) && typeof value.text === "string";
    case "set_attribute":
      return (
        isPreviewNodeRef(value.target) &&
        typeof value.name === "string" &&
        typeof value.value === "string" &&
        isOptionalNamespace(value.namespaceURI)
      );
    case "remove_attribute":
      return (
        isPreviewNodeRef(value.target) &&
        typeof value.name === "string" &&
        isOptionalNamespace(value.namespaceURI)
      );
    case "insert_node":
      return (
        isPreviewNodeRef(value.parent) &&
        isFiniteNumber(value.index) &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        isSerializedPreviewNode(value.node)
      );
    case "remove_node":
      return isPreviewNodeRef(value.target);
    case "move_node":
      return (
        isPreviewNodeRef(value.target) &&
        isPreviewNodeRef(value.parent) &&
        isFiniteNumber(value.index) &&
        Number.isInteger(value.index) &&
        value.index >= 0
      );
    case "replace_subtree":
      return (
        isPreviewNodeRef(value.target) &&
        typeof value.html === "string" &&
        (value.mode === "children" || value.mode === "node")
      );
    case "set_property":
      return (
        isPreviewNodeRef(value.target) &&
        (value.name === "value" || value.name === "checked" || value.name === "selected") &&
        (typeof value.value === "string" || typeof value.value === "boolean")
      );
    default:
      return false;
  }
}

function createValidatedInitialDocument(
  payload: unknown,
  effectiveRuntimePreviewUrl: string | null,
): PreviewInitialDocument | null {
  if (!isRecord(payload) || !effectiveRuntimePreviewUrl) {
    return null;
  }

  if (
    payload.version !== PREVIEW_DOM_PATCH_FORMAT_VERSION ||
    !isFiniteNumber(payload.time) ||
    typeof payload.documentId !== "string" ||
    !isOptionalString(payload.route) ||
    typeof payload.html !== "string"
  ) {
    return null;
  }

  const html = createReplayableRuntimePreviewFromHtml(payload.html, effectiveRuntimePreviewUrl);
  if (!html) {
    return null;
  }

  return {
    version: PREVIEW_DOM_PATCH_FORMAT_VERSION,
    time: payload.time,
    documentId: payload.documentId,
    route: payload.route,
    html,
  };
}

function createValidatedPatchBatch(payload: unknown): PreviewDomPatchBatch | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (
    payload.version !== PREVIEW_DOM_PATCH_FORMAT_VERSION ||
    !isFiniteNumber(payload.time) ||
    (payload.source !== "runtime-preview" && payload.source !== "static-preview") ||
    typeof payload.documentId !== "string" ||
    !isFiniteNumber(payload.baseRevision) ||
    !isFiniteNumber(payload.revision) ||
    !isOptionalString(payload.route) ||
    !Array.isArray(payload.ops) ||
    !payload.ops.every(isPreviewDomPatchOp)
  ) {
    return null;
  }

  return {
    version: PREVIEW_DOM_PATCH_FORMAT_VERSION,
    time: payload.time,
    source: payload.source,
    documentId: payload.documentId,
    baseRevision: payload.baseRevision,
    revision: payload.revision,
    route: payload.route,
    ops: payload.ops,
  };
}

export function usePreviewMessageBridge({
  iframeRef,
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
