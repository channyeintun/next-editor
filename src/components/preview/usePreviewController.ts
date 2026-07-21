import {
  useCallback,
  useEffect,
  useLayoutEffect,
  type RefObject,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { usePreviewAdapterHandle } from "../../contexts/PreviewAdapterHandleContext";
import { useRuntimePanelStore } from "../../contexts/RuntimePanelStoreContext";
import { clampPreviewDockWidth, usePreviewPanel } from "../../contexts/PreviewPanelContext";
import {
  useWorkspaceLessonType,
  useWorkspacePreviewVersion,
  useWorkspaceSaveVersion,
} from "../../hooks/useWorkspace";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../../hooks/useWebContainerRuntime";
import { IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE } from "../../utils/iframeInteractionCapture";
import { requestPreviewScreenshot } from "../../utils/iframeScreenshotBridge";
import type { WebContainerRuntimeStatus } from "../../contexts/WebContainerRuntimeContext";
import type {
  ApiClientRecordedRequest,
  ApiClientRecordedResult,
  ApiClientRequestTab,
  IframeInteractionEvent,
  PreviewActiveMode,
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  PreviewPanelMode,
  PreviewSize,
} from "../../types/slides";
import { lessonRunsInWebContainer } from "../../types/workspace";
import {
  createReplayableRuntimePreview,
  patchIframeContentFromHtml,
  type PreviewScrollPosition,
  RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
} from "./previewIframeUtils";
import {
  incrementPerformanceCounter,
  recordPerformanceMetric,
  startPerformanceSpan,
} from "../../utils/performanceMetrics";
import { useApiClientStoreInstance } from "../../contexts/ApiClientStoreContext";
import {
  buildHeaderRecord,
  recordedResultToStoreResult,
  recordToHeaders,
  storeResultToRecorded,
  type ApiClientHistoryEntry,
  type HttpMethod,
} from "../../stores/apiClientStore";
import { hasRrwebPreviewEvents, RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE } from "./rrwebPreview";
import { useApiClient } from "./useApiClient";
import { usePreviewInteractionCapture } from "./usePreviewInteractionCapture";
import { usePreviewMessageBridge } from "./usePreviewMessageBridge";
import { requestStudioPreviewCommand } from "../../utils/iframeStudioCommandBridge";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";
import {
  clampCustomPreviewSize,
  getCustomPreviewSizeFromResize,
  isCustomPreviewSize,
} from "./previewSizeUtils";
import {
  applyRouteToRuntimePreviewLocation,
  createRuntimePreviewLocationFromUrl,
  createRuntimePreviewPlaceholder,
  formatPreviewAddressLabel,
  getRuntimePreviewState,
  normalizePreviewRoute,
  refreshRuntimePreview,
  runtimePreviewSrcNeedsReset,
} from "./runtimePreview";

export interface PreviewController {
  containerRef: RefObject<HTMLDivElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  replayContainerRef: RefObject<HTMLDivElement | null>;
  isRrwebReplayActive: boolean;
  size: PreviewSize;
  isOpen: boolean;
  panelMode: PreviewPanelMode;
  dockWidth: number;
  isRefreshing: boolean;
  isResizing: boolean;
  isTransitioning: boolean;
  disablePointerEvents: boolean;
  previewAddressLabel: string;
  previewAddressTitle: string;
  activeMode: PreviewActiveMode;
  showModeToggle: boolean;
  isRuntimeReady: boolean;
  handleClose: () => void;
  handleFloat: () => void;
  handleDock: () => void;
  handleBack: () => void;
  handleForward: () => void;
  handleRefresh: () => void;
  handleReload: () => void;
  handleOpenConsole: () => void;
  handleResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  handleDockResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  handleTransitionStart: () => void;
  handleTransitionComplete: () => void;
  setActiveMode: (mode: PreviewActiveMode) => void;
  sendApiClientRequest: () => void;
  recordApiClientTab: (tab: ApiClientRequestTab) => void;
  recordApiClientInspect: (entry: ApiClientHistoryEntry) => void;
}

type RuntimeSnapshotRequestReason =
  | "inspection"
  | "load"
  | "recording-finalize"
  | "recording-start"
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

/** Pointer coordinates from a mouse or touch event (React or native). */
function getPointerCoords(event: MouseEvent | TouchEvent | ReactMouseEvent | ReactTouchEvent): {
  x: number;
  y: number;
} {
  if ("touches" in event) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  return { x: event.clientX, y: event.clientY };
}

/**
 * Navigates the preview iframe's history. Falls back to a postMessage command when the
 * iframe is cross-origin and `history` access throws.
 */
function navigateIframeHistory(
  iframeWindow: Window | null | undefined,
  action: "back" | "forward",
): void {
  if (!iframeWindow) {
    return;
  }

  try {
    if (action === "back") {
      iframeWindow.history.back();
    } else {
      iframeWindow.history.forward();
    }
  } catch {
    iframeWindow.postMessage(
      { type: IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE, payload: { action } },
      "*",
    );
  }
}

/**
 * Writes preview HTML into the iframe (patching the live document when asked and
 * possible, falling back to a srcdoc swap). Returns whether the content landed, so
 * the caller only records it as applied on success. Module-level (not inside the
 * hook) because its try/catch would otherwise force a React Compiler bailout of
 * the whole controller hook.
 */
function writeIframeContent(
  iframe: HTMLIFrameElement,
  content: string,
  preserveDocument: boolean,
): boolean {
  try {
    if (
      preserveDocument &&
      iframe.getAttribute("src") === null &&
      patchIframeContentFromHtml(iframe, content)
    ) {
      return true;
    }

    iframe.removeAttribute("src");
    iframe.srcdoc = content;
    return true;
  } catch (error) {
    console.error("Error updating iframe srcdoc:", error);
    return false;
  }
}

export function shouldUsePlaybackPreview({
  currentRecording,
  isPlaying,
  isRecording,
  usesPlaybackModel,
}: {
  currentRecording: unknown;
  isPlaying: boolean;
  isRecording: boolean;
  usesPlaybackModel: boolean;
}) {
  const isPlaybackModelActive = isPlaying && usesPlaybackModel && !isRecording;

  // Every lesson is replayed from its recorded runtime preview, so a loaded
  // recording is required to take over the iframe.
  return Boolean(currentRecording) && isPlaybackModelActive;
}

export function usePreviewController(): PreviewController {
  const [size, setSize] = useState<PreviewSize>("medium");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [previewRoute, setPreviewRoute] = useState("/");
  const [activeMode, setActiveMode] = useState<PreviewActiveMode>("browser");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayContainerRef = useRef<HTMLDivElement>(null);

  const lastContentRef = useRef("");
  const lastRuntimeSnapshotRef = useRef("");
  const lastRuntimeSnapshotCapturedAtRef = useRef(0);
  const lastRuntimeSnapshotUrlRef = useRef<string | null>(null);
  const runtimeSnapshotRequestSequenceRef = useRef(0);
  const pendingRuntimeSnapshotRequestRef = useRef<PendingRuntimeSnapshotRequest | null>(null);
  const scrollPositionRef = useRef<PreviewScrollPosition>({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const previewRouteRef = useRef("/");

  const targetScrollRef = useRef<PreviewScrollPosition | null>(null);
  const rafRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isRecordingRef = useRef(false);
  const handlePreviewEventRef = useRef<((event: PreviewEvent) => void) | null>(null);
  const handlePreviewInitialDocumentRef = useRef<
    ((document: PreviewInitialDocument) => void) | null
  >(null);
  const handlePreviewPatchBatchRef = useRef<((batch: PreviewDomPatchBatch) => void) | null>(null);
  const recordedPreviewInitialDocumentIdRef = useRef<string | null>(null);

  const {
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent,
  } = useNextEditorActions();
  const previewHandle = usePreviewAdapterHandle();
  const { consoleAppender, consoleOpener } = useRuntimePanelStore();
  const {
    isOpen,
    mode: panelMode,
    dockWidth,
    closePreview,
    floatPreview,
    dockPreview,
    setDockWidth,
    applyPreviewPanelState,
  } = usePreviewPanel();
  const { startRuntime } = useWebContainerRuntimeActions();
  const lessonType = useWorkspaceLessonType();
  const previewVersion = useWorkspacePreviewVersion();
  const saveVersion = useWorkspaceSaveVersion();
  const {
    previewUrl: runtimePreviewUrl,
    previewPort: runtimePreviewPort,
    status: runtimeStatus,
    errorMessage: runtimeErrorMessage,
    isSupported: isRuntimeSupported,
    runnerConfig,
    ambientStartEnabled,
  } = useWebContainerRuntimeMetadata();

  const { currentRecording, isPlaying, isRecording, usesPlaybackModel } = useNextEditorMetadata();
  const isPlaybackPreviewActive = shouldUsePlaybackPreview({
    currentRecording,
    isPlaying,
    isRecording,
    usesPlaybackModel,
  });
  const hasPreviewPatchReplay = Boolean(
    currentRecording?.previewInitialDocuments?.length &&
    currentRecording.previewPatchBatches?.length,
  );
  const isRuntimePlaybackPreviewActive =
    lessonRunsInWebContainer(lessonType) && isPlaybackPreviewActive;
  // The rrweb replay preview is shown ONLY while the recording is actively playing.
  // When paused/ended (or never started) — even with a recording loaded — the live
  // runtime preview is shown instead (see `isLiveRuntimePreviewActive`).
  const isRrwebReplayActive =
    isRuntimePlaybackPreviewActive &&
    hasRrwebPreviewEvents(
      currentRecording?.previewInitialDocuments,
      currentRecording?.previewPatchBatches,
    );
  const recordedRuntimeSnapshot = isRuntimePlaybackPreviewActive
    ? (currentRecording?.runtimeSnapshot ?? null)
    : null;
  const recordedRuntimeStatus = recordedRuntimeSnapshot?.status as
    | WebContainerRuntimeStatus
    | undefined;
  const effectiveRuntimeStatus =
    runtimeStatus === "idle" ? (recordedRuntimeStatus ?? runtimeStatus) : runtimeStatus;
  const effectiveRuntimePreviewUrl =
    runtimePreviewUrl || recordedRuntimeSnapshot?.previewUrl || null;
  const effectiveRuntimePreviewPort =
    runtimePreviewPort ?? recordedRuntimeSnapshot?.previewPort ?? null;
  const effectiveRuntimeErrorMessage =
    runtimeErrorMessage || recordedRuntimeSnapshot?.errorMessage || null;
  const isLiveRuntimePreviewActive =
    lessonRunsInWebContainer(lessonType) &&
    !isRuntimePlaybackPreviewActive &&
    runtimeStatus === "ready" &&
    Boolean(runtimePreviewUrl);
  const isRuntimePreviewActive =
    lessonRunsInWebContainer(lessonType) &&
    effectiveRuntimeStatus === "ready" &&
    Boolean(effectiveRuntimePreviewUrl);
  const isRuntimeManagedPreview = lessonRunsInWebContainer(lessonType) && runnerConfig.enabled;
  const runtimePreviewState = getRuntimePreviewState(
    effectiveRuntimeStatus,
    effectiveRuntimeErrorMessage,
    isRuntimeSupported,
  );
  const runtimePreviewPlaceholder = createRuntimePreviewPlaceholder(
    runtimePreviewState.placeholderKind,
    runtimePreviewState.title,
    runtimePreviewState.description,
  );

  // The frame selector is shown for every WebContainer lesson on a supported
  // environment — independent of boot progress — so it doesn't "pop in" mid-boot.
  // The API frame itself surfaces a "waiting for the server" state until the
  // runtime is ready (see `isRuntimeReady`).
  const showModeToggle = lessonRunsInWebContainer(lessonType) && isRuntimeSupported;
  const isRuntimeReady = effectiveRuntimeStatus === "ready";

  useEffect(() => {
    if (!showModeToggle && activeMode !== "browser") {
      setActiveMode("browser");
    }
  }, [activeMode, showModeToggle]);

  // The store instance is created once in its provider, so it is referentially
  // stable and safe to close over directly (no ref indirection needed).
  const apiClientStore = useApiClientStoreInstance();
  // Replay re-applies preview state at many timeline points and carries API state
  // forward across unrelated events, so dedupe by content to apply each distinct
  // recorded state exactly once.
  const lastAppliedApiSignatureRef = useRef<string | null>(null);

  const apiClient = useApiClient({
    iframeRef,
    runtimePreviewUrl: effectiveRuntimePreviewUrl,
    onRequestSent: (request) => {
      emitPreviewEvent("api_client_request", { apiClientRequest: request });
    },
    onResponseReceived: (result) => {
      emitPreviewEvent("api_client_response", { apiClientResult: result });
    },
  });

  const sizeRef = useRef<PreviewSize>(size);
  const isOpenRef = useRef(isOpen);
  const panelModeRef = useRef<PreviewPanelMode>(panelMode);

  // Mirror the latest render values into refs for consumers that live outside the
  // render cycle (the persistent message-bridge listeners and the machine's
  // snapshot getter). Synced in a layout effect — not during render — so the hook
  // stays memoizable by the React Compiler (render-time ref writes force a whole-
  // hook bailout, which made every re-render re-fire every effect in here). The
  // consumers all read `.current` asynchronously (postMessage handlers, machine
  // events), so commit-time freshness is sufficient.
  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
    handlePreviewEventRef.current = handlePreviewEvent;
    handlePreviewInitialDocumentRef.current = handlePreviewInitialDocument;
    handlePreviewPatchBatchRef.current = handlePreviewPatchBatch;
    sizeRef.current = size;
    isOpenRef.current = isOpen;
    panelModeRef.current = panelMode;
  });

  const previousSaveVersionRef = useRef<number | null>(null);
  const previousIsRecordingRef = useRef(isRecording);
  const lastRefreshKeyRef = useRef<number | undefined>(undefined);
  const previousPanelStateRef = useRef({ isOpen, panelMode });
  const hasRequestedRuntimeStartForOpenRef = useRef(false);

  const applyPreviewRoute = useCallback((route: string) => {
    const normalizedRoute = normalizePreviewRoute(route);

    previewRouteRef.current = normalizedRoute;
    setPreviewRoute((currentRoute) =>
      currentRoute === normalizedRoute ? currentRoute : normalizedRoute,
    );
  }, []);

  useEffect(() => {
    const location = createRuntimePreviewLocationFromUrl(
      effectiveRuntimePreviewUrl,
      effectiveRuntimePreviewPort,
    );

    applyPreviewRoute(location?.route ?? "/");
  }, [applyPreviewRoute, effectiveRuntimePreviewPort, effectiveRuntimePreviewUrl]);

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
  }, [effectiveRuntimePreviewUrl]);

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

      try {
        iframeWindow.postMessage(
          {
            type: RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
            payload: { reason, requestId },
          },
          "*",
        );
      } catch {
        window.clearTimeout(timeoutId);
        pendingRuntimeSnapshotRequestRef.current = null;
        resolveRequest(lastRuntimeSnapshotRef.current || null);
      }

      return promise;
    },
    [captureRuntimePreviewSnapshot, effectiveRuntimePreviewUrl],
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

  useEffect(() => {
    previewHandle.livePreviewInspectionGetter.current = async () => {
      const html =
        (await requestRuntimePreviewSnapshot("inspection")) || lastRuntimeSnapshotRef.current;
      if (!html) {
        return null;
      }

      const iframe = iframeRef.current;
      return {
        capturedAt: lastRuntimeSnapshotCapturedAtRef.current || Date.now(),
        height: iframe?.clientHeight ?? 0,
        html,
        route: previewRouteRef.current,
        url: effectiveRuntimePreviewUrl,
        width: iframe?.clientWidth ?? 0,
      };
    };
    previewHandle.previewScreenshotCapturer.current = () =>
      requestPreviewScreenshot(iframeRef.current);
    previewHandle.previewCommandExecutor.current = (command, options) =>
      requestStudioPreviewCommand(iframeRef.current, command, options);
    previewHandle.recordingStopPreparer.current = async () => {
      await requestRuntimePreviewSnapshot("recording-finalize");
    };

    return () => {
      previewHandle.livePreviewInspectionGetter.current = null;
      previewHandle.previewScreenshotCapturer.current = null;
      previewHandle.previewCommandExecutor.current = null;
      previewHandle.recordingStopPreparer.current = null;
    };
  }, [effectiveRuntimePreviewUrl, previewHandle, requestRuntimePreviewSnapshot]);

  useEffect(() => {
    if (!isRecording) {
      recordedPreviewInitialDocumentIdRef.current = null;
      return;
    }

    // Capture both replay formats at the explicit recording-start checkpoint.
    // rrweb provides ordered DOM mutations; the HTML snapshot remains the
    // bounded fallback used by recordings that cannot initialize rrweb replay.
    void requestRuntimePreviewSnapshot("recording-start");
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
        "*",
      );
    } catch {
      // Cross-origin/postMessage failures behave like an unanswered request.
    }
  }, [isRecording]);

  const handleRuntimeRouteChange = useCallback(
    (route: string) => {
      applyPreviewRoute(route);
      window.setTimeout(() => {
        void requestRuntimePreviewSnapshot("route-change");
      }, 0);
    },
    [applyPreviewRoute, requestRuntimePreviewSnapshot],
  );

  const emitPreviewEvent = (
    eventType: PreviewEvent["type"],
    options?: {
      newSize?: PreviewSize;
      isOpen?: boolean;
      mode?: PreviewPanelMode;
      content?: string;
      route?: string;
      scrollTop?: number;
      scrollLeft?: number;
      interaction?: IframeInteractionEvent;
      activeMode?: PreviewActiveMode;
      requestTab?: ApiClientRequestTab;
      apiClientRequest?: ApiClientRecordedRequest;
      apiClientResult?: ApiClientRecordedResult;
    },
  ) => {
    if (isRecordingRef.current && handlePreviewEventRef.current) {
      const event: PreviewEvent = {
        type: eventType,
        timestamp: performance.now(),
        size: options?.newSize ?? sizeRef.current,
        isOpen: options?.isOpen ?? isOpenRef.current,
        mode: options?.mode ?? panelModeRef.current,
        content: options?.content,
        route: options?.route,
        scrollTop: options?.scrollTop,
        scrollLeft: options?.scrollLeft,
        interaction: options?.interaction,
        activeMode: options?.activeMode,
        requestTab: options?.requestTab,
        apiClientRequest: options?.apiClientRequest,
        apiClientResult: options?.apiClientResult,
      };
      handlePreviewEventRef.current(event);
    }
  };

  usePreviewMessageBridge({
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
    onConsoleMessage: (msg: string) => consoleAppender.current?.(msg),
    onRouteChange: handleRuntimeRouteChange,
    shouldAcceptRuntimeSnapshot,
    onRuntimeSnapshot: completeRuntimeSnapshotRequest,
    onApiClientResponse: apiClient.handleResponse,
  });

  const updateIframeContent = (
    content: string,
    options?: { force?: boolean; preserveDocument?: boolean },
  ) => {
    if (!iframeRef.current || (isLiveRuntimePreviewActive && !options?.force)) {
      return;
    }

    if (!options?.force && lastContentRef.current === content) {
      return;
    }

    if (writeIframeContent(iframeRef.current, content, options?.preserveDocument === true)) {
      lastContentRef.current = content;
    }
  };

  const forceRefreshPreview = (options?: {
    content?: string;
    emitEvent?: boolean;
    showSpinner?: boolean;
    reloadRuntime?: boolean;
  }) => {
    const iframe = iframeRef.current;

    if (!iframe) {
      return;
    }

    if (options?.showSpinner) {
      setIsRefreshing(true);
    }

    const finishRefresh = () => {
      if (!options?.showSpinner) {
        return;
      }

      setTimeout(() => setIsRefreshing(false), 600);
    };

    if (options?.content !== undefined) {
      lastContentRef.current = "";
      updateIframeContent(options.content, { force: true });

      if (options.emitEvent) {
        emitPreviewEvent("preview_refresh", { content: options.content });
      }

      finishRefresh();
      return;
    }

    if (isRuntimePreviewActive && effectiveRuntimePreviewUrl) {
      const shouldReloadRuntime = options?.reloadRuntime ?? !options?.emitEvent;

      if (!options?.emitEvent && shouldReloadRuntime) {
        void refreshRuntimePreview(iframe, effectiveRuntimePreviewUrl).finally(finishRefresh);
        return;
      }

      let didFinalize = false;
      let runtimeSnapshotFallbackTimeout: number | null = null;
      const initialRuntimeSnapshot = lastRuntimeSnapshotRef.current || "";

      const cleanupRuntimeRefresh = () => {
        iframe.removeEventListener("load", handleRuntimeRefreshLoad);
        if (runtimeSnapshotFallbackTimeout !== null) {
          window.clearTimeout(runtimeSnapshotFallbackTimeout);
        }
      };

      const finalizeRuntimeRefresh = (content?: string) => {
        if (didFinalize) {
          return;
        }

        didFinalize = true;
        cleanupRuntimeRefresh();

        const resolvedContent = content || undefined;

        emitPreviewEvent(
          "preview_refresh",
          resolvedContent ? { content: resolvedContent } : undefined,
        );
        finishRefresh();
      };

      const captureRefreshSnapshot = () => {
        void requestRuntimePreviewSnapshot("refresh").then((content) => {
          finalizeRuntimeRefresh(content || initialRuntimeSnapshot || undefined);
        });
      };

      const handleRuntimeRefreshLoad = () => {
        if (runtimeSnapshotFallbackTimeout !== null) {
          window.clearTimeout(runtimeSnapshotFallbackTimeout);
          runtimeSnapshotFallbackTimeout = null;
        }
        captureRefreshSnapshot();
      };

      if (!shouldReloadRuntime) {
        captureRefreshSnapshot();
        return;
      }

      iframe.addEventListener("load", handleRuntimeRefreshLoad, {
        once: true,
      });
      runtimeSnapshotFallbackTimeout = window.setTimeout(
        () => finalizeRuntimeRefresh(lastRuntimeSnapshotRef.current || undefined),
        1_500,
      );

      void refreshRuntimePreview(iframe, effectiveRuntimePreviewUrl).catch(() =>
        finalizeRuntimeRefresh(initialRuntimeSnapshot || undefined),
      );
      return;
    }

    if (isRuntimeManagedPreview) {
      lastContentRef.current = "";
      iframe.removeAttribute("src");
      iframe.srcdoc = runtimePreviewPlaceholder;

      if (options?.emitEvent) {
        emitPreviewEvent("preview_refresh");
      }

      finishRefresh();
      return;
    }

    finishRefresh();
  };

  usePreviewPlaybackRegistration({
    previewHandle,
    isPlaybackPreviewActive,
    isRuntimePreviewActive,
    isLiveRuntimePreviewActive,
    hasPreviewPatchReplay,
    pendingInteractionRef,
    lastRuntimeSnapshotRef,
    lastContentRef,
    scrollPositionRef,
    routeRef: previewRouteRef,
    sizeRef,
    isOpenRef,
    modeRef: panelModeRef,
    updateIframeContent,
    iframeRef,
    setSize,
    applyPreviewRoute,
    applyPreviewPanelState,
    lastRefreshKeyRef,
    isRecordingRef,
    isUserScrollingRef,
    targetScrollRef,
    rafRef,
    replayContainerRef,
    onActiveModeChange: setActiveMode,
    onRequestTabChange: (tab) => apiClientStore.trigger.setRequestTab({ tab }),
    onApiClientStateChange: (apiState) => {
      const signature = JSON.stringify(apiState);
      if (signature === lastAppliedApiSignatureRef.current) {
        return;
      }
      lastAppliedApiSignatureRef.current = signature;

      const request = apiState.request;
      const history: ApiClientHistoryEntry[] = (apiState.history ?? []).map((entry) => ({
        id: entry.id,
        method: (entry.request?.method ?? "GET") as HttpMethod,
        path: entry.request?.path ?? "/",
        headers: recordToHeaders(entry.request?.headers ?? {}),
        body: entry.request?.body ?? "",
        result: recordedResultToStoreResult(entry.result),
        timestamp: 0,
      }));

      apiClientStore.trigger.applyReplayState({
        method: (request?.method ?? "GET") as HttpMethod,
        path: request?.path ?? "/",
        body: request?.body ?? "",
        headers: request ? recordToHeaders(request.headers) : [],
        sending: apiState.sending ?? false,
        result: apiState.result ? recordedResultToStoreResult(apiState.result) : null,
        history,
      });
    },
  });

  usePreviewInteractionCapture({
    iframeRef,
    isRecording,
    isRuntimePreviewActive: isLiveRuntimePreviewActive,
  });

  useEffect(() => {
    if (isPlaybackPreviewActive || !isRuntimePreviewActive) {
      return;
    }

    const iframe = iframeRef.current;

    if (!iframe) {
      return;
    }

    const syncSnapshot = () => {
      void requestRuntimePreviewSnapshot("load");
    };

    iframe.addEventListener("load", syncSnapshot);

    return () => {
      iframe.removeEventListener("load", syncSnapshot);
    };
  }, [isPlaybackPreviewActive, isRuntimePreviewActive, requestRuntimePreviewSnapshot]);

  useEffect(() => {
    if (isPlaybackPreviewActive) {
      return;
    }

    if (!isOpen) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    if (lessonRunsInWebContainer(lessonType) && runtimePreviewUrl) {
      // Guarded via the src *attribute* (see runtimePreviewSrcNeedsReset): any
      // `src` assignment navigates the frame, so re-assigning on every effect
      // run would reload the live preview and lose its state.
      if (runtimePreviewSrcNeedsReset(iframe, runtimePreviewUrl)) {
        iframe.removeAttribute("srcdoc");
        iframe.src = runtimePreviewUrl;
      } else {
        void requestRuntimePreviewSnapshot("runtime-ready");
      }

      return;
    }

    if (isRuntimeManagedPreview) {
      if (lastContentRef.current === runtimePreviewPlaceholder) {
        return;
      }

      lastContentRef.current = runtimePreviewPlaceholder;
      iframe.removeAttribute("src");
      iframe.srcdoc = runtimePreviewPlaceholder;
    }
  }, [
    isOpen,
    isPlaybackPreviewActive,
    isRuntimeManagedPreview,
    lessonType,
    panelMode,
    previewVersion,
    runtimePreviewPlaceholder,
    runtimePreviewUrl,
    updateIframeContent,
    requestRuntimePreviewSnapshot,
  ]);

  useEffect(() => {
    if (isPlaybackPreviewActive) {
      return;
    }

    const previousSaveVersion = previousSaveVersionRef.current;
    previousSaveVersionRef.current = saveVersion;

    if (previousSaveVersion === null || previousSaveVersion === saveVersion) {
      return;
    }

    if (isRuntimePreviewActive && !isRecording) {
      return;
    }

    forceRefreshPreview({
      emitEvent: true,
      reloadRuntime: false,
    });
  }, [
    forceRefreshPreview,
    isPlaybackPreviewActive,
    isRecording,
    isRuntimePreviewActive,
    saveVersion,
  ]);

  useEffect(() => {
    const previousPanelState = previousPanelStateRef.current;
    previousPanelStateRef.current = { isOpen, panelMode };

    if (previousPanelState.isOpen !== isOpen) {
      emitPreviewEvent(isOpen ? "preview_open" : "preview_close", {
        isOpen,
        mode: panelMode,
      });
      return;
    }

    if (isOpen && previousPanelState.panelMode !== panelMode) {
      emitPreviewEvent(panelMode === "floating" ? "preview_float" : "preview_unfloat", {
        isOpen,
        mode: panelMode,
      });
    }
  }, [emitPreviewEvent, isOpen, panelMode]);

  useEffect(() => {
    if (!isOpen) {
      hasRequestedRuntimeStartForOpenRef.current = false;
      return;
    }

    if (
      !lessonRunsInWebContainer(lessonType) ||
      !ambientStartEnabled ||
      isPlaybackPreviewActive ||
      !isRuntimeSupported ||
      !runnerConfig.enabled ||
      runtimePreviewUrl
    ) {
      return;
    }

    const isRuntimeBusy =
      runtimeStatus === "booting" ||
      runtimeStatus === "mounting" ||
      runtimeStatus === "installing" ||
      runtimeStatus === "starting";

    if (isRuntimeBusy || hasRequestedRuntimeStartForOpenRef.current) {
      return;
    }

    hasRequestedRuntimeStartForOpenRef.current = true;
    void startRuntime();
  }, [
    isOpen,
    ambientStartEnabled,
    isPlaybackPreviewActive,
    isRuntimeSupported,
    lessonType,
    runnerConfig.enabled,
    runtimePreviewUrl,
    runtimeStatus,
    startRuntime,
  ]);

  const handleClose = () => {
    closePreview();
  };

  const handleFloat = () => {
    setSize((currentSize) =>
      currentSize === "small" || currentSize === "large" ? "medium" : currentSize,
    );
    floatPreview();
  };

  const handleDock = () => {
    dockPreview();
  };

  const handleRefresh = () => {
    forceRefreshPreview({ emitEvent: true, showSpinner: true });
  };

  // User-initiated reload from the preview URL bar. Unlike `handleRefresh`
  // (which captures a baseline at recording start without touching the live
  // frame), this actually reloads the runtime preview iframe.
  const handleReload = () => {
    forceRefreshPreview({ emitEvent: true, showSpinner: true, reloadRuntime: true });
  };

  const handleBack = () => {
    navigateIframeHistory(iframeRef.current?.contentWindow, "back");
  };

  const handleForward = () => {
    navigateIframeHistory(iframeRef.current?.contentWindow, "forward");
  };

  const handleOpenConsole = () => {
    consoleOpener.current?.();
  };

  const previewAddressLocation = applyRouteToRuntimePreviewLocation(
    createRuntimePreviewLocationFromUrl(effectiveRuntimePreviewUrl, effectiveRuntimePreviewPort),
    previewRoute,
  );
  const previewAddress = {
    label: formatPreviewAddressLabel(previewAddressLocation),
    title: previewAddressLocation?.href ?? effectiveRuntimePreviewUrl ?? "Preview",
  };

  useEffect(() => {
    const clampCurrentCustomSize = () => {
      setSize((currentSize) => {
        if (!isCustomPreviewSize(currentSize)) {
          return currentSize;
        }

        const nextSize = clampCustomPreviewSize(currentSize, {
          width: window.innerWidth,
          height: window.innerHeight,
        });

        if (nextSize.width === currentSize.width && nextSize.height === currentSize.height) {
          return currentSize;
        }

        return nextSize;
      });
    };

    clampCurrentCustomSize();
    window.addEventListener("resize", clampCurrentCustomSize);

    return () => {
      window.removeEventListener("resize", clampCurrentCustomSize);
    };
  }, []);

  useEffect(() => {
    const wasRecording = previousIsRecordingRef.current;
    previousIsRecordingRef.current = isRecording;

    if (isPlaying || !isRecording || wasRecording) {
      return;
    }

    // Capture the active frame at recording start so replay opens in the right
    // mode even when the user was already in the API frame before pressing record.
    emitPreviewEvent("api_client_mode", { activeMode });
    handleRefresh();
  }, [activeMode, emitPreviewEvent, handleRefresh, isPlaying, isRecording]);

  const handleResizeStart = (event: ReactMouseEvent | ReactTouchEvent) => {
    if ("button" in event && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsResizing(true);

    const { x: startX, y: startY } = getPointerCoords(event);
    if (!iframeRef.current) {
      return;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const startWidth = rect.width;
    const startHeight = rect.height;

    setSize(
      clampCustomPreviewSize(
        { width: startWidth, height: startHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );

    let resizeRaf: number | null = null;
    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      const { x: currentX, y: currentY } = getPointerCoords(moveEvent);

      const newSize = getCustomPreviewSizeFromResize({
        startSize: { width: startWidth, height: startHeight },
        startPointer: { x: startX, y: startY },
        currentPointer: { x: currentX, y: currentY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setSize(newSize);

      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
      }
      resizeRaf = requestAnimationFrame(() => {
        emitPreviewEvent("preview_resize", { newSize });
      });
    };

    const onEnd = () => {
      setIsResizing(false);
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      emitPreviewEvent("preview_resize");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  };

  const handleDockResizeStart = (event: ReactMouseEvent | ReactTouchEvent) => {
    if ("button" in event && event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsResizing(true);

    const { x: startX } = getPointerCoords(event);
    const rect = containerRef.current?.getBoundingClientRect();

    if (!rect) {
      setIsResizing(false);
      return;
    }

    const startWidth = rect.width;
    let lastWidth = startWidth;

    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }

      const { x: currentX } = getPointerCoords(moveEvent);
      lastWidth = clampPreviewDockWidth(startWidth + startX - currentX, window.innerWidth);
      setDockWidth(lastWidth);
    };

    const onEnd = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);

      // Record the net resize as an offset (not an absolute width) so playback
      // applies the same delta to whatever dock width the viewer has.
      const previewDockWidthDelta = Math.round(lastWidth - startWidth);
      if (isRecordingRef.current && previewDockWidthDelta !== 0) {
        handleWorkspaceEvent({ previewDockWidthDelta });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  };

  const forceIframeRepaint = () => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    // A cross-origin runtime iframe (e.g. the :PORT runtime preview) can paint
    // blank inside the floating panel's clipped/composited container — it is
    // `position: fixed` with `rounded-xl`, `overflow-hidden`, a box-shadow and a
    // transform/opacity transition, none of which the docked panel has. Chromium
    // leaves the frame unpainted until something forces a repaint, which is why a
    // manual scroll "revives" it. Toggling a compositor-only transform nudges that
    // repaint without reloading the frame (changing src/srcdoc/display would
    // reload a cross-origin frame and lose its state instead).
    iframe.style.transform = "translateZ(0)";
    requestAnimationFrame(() => {
      const current = iframeRef.current;
      if (current) {
        current.style.transform = "";
      }
    });
  };

  const handleTransitionStart = () => {
    setIsTransitioning(true);
  };

  const handleTransitionComplete = () => {
    setIsTransitioning(false);
    forceIframeRepaint();
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // `transitionend` isn't guaranteed (reduced motion, an interrupted or absent
    // transition), so also force the repaint on the next frame and once more after
    // the 150ms panel transition would have finished. Safe to over-fire: the nudge
    // is idempotent and a no-op for same-origin previews.
    const raf = requestAnimationFrame(forceIframeRepaint);
    const timer = window.setTimeout(forceIframeRepaint, 220);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [panelMode, isOpen, forceIframeRepaint]);

  // Returning to browser mode uncovers the runtime iframe; if Chromium occlusion-
  // culled it while the API panel overlay was on top, nudge a repaint so it isn't
  // left blank. No-op for same-origin previews and idempotent.
  useEffect(() => {
    if (activeMode !== "browser" || !isOpen) {
      return;
    }

    const raf = requestAnimationFrame(forceIframeRepaint);

    return () => cancelAnimationFrame(raf);
  }, [activeMode, isOpen, forceIframeRepaint]);

  return {
    containerRef,
    iframeRef,
    replayContainerRef,
    isRrwebReplayActive,
    size,
    isOpen,
    panelMode,
    dockWidth,
    isRefreshing,
    isResizing,
    isTransitioning,
    disablePointerEvents: isTransitioning || isResizing,
    previewAddressLabel: previewAddress.label,
    previewAddressTitle: previewAddress.title,
    activeMode,
    showModeToggle,
    isRuntimeReady,
    handleClose,
    handleFloat,
    handleDock,
    handleBack,
    handleForward,
    handleRefresh,
    handleReload,
    handleOpenConsole,
    handleResizeStart,
    handleDockResizeStart,
    handleTransitionStart,
    handleTransitionComplete,
    setActiveMode: (mode: PreviewActiveMode) => {
      setActiveMode(mode);
      emitPreviewEvent("api_client_mode", { activeMode: mode });
    },
    sendApiClientRequest: apiClient.send,
    recordApiClientTab: (tab: ApiClientRequestTab) => {
      emitPreviewEvent("api_client_request_tab", { requestTab: tab });
    },
    recordApiClientInspect: (entry: ApiClientHistoryEntry) => {
      emitPreviewEvent("api_client_inspect_history", {
        apiClientRequest: {
          method: entry.method,
          path: entry.path,
          headers: buildHeaderRecord(entry.headers),
          body: entry.method === "GET" ? undefined : entry.body || undefined,
        },
        apiClientResult: storeResultToRecorded(entry.result),
      });
    },
  };
}
