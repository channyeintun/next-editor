import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  type RefObject,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { usePreviewAdapterHandle } from "../../contexts/PreviewAdapterHandleContext";
import { useRuntimePanelStore } from "../../contexts/RuntimePanelStoreContext";
import { usePreviewPanel } from "../../contexts/PreviewPanelContext";
import {
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceSaveVersion,
} from "../../hooks/useWorkspace";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../../hooks/useWebContainerRuntime";
import { IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE } from "../../utils/iframeInteractionCapture";
import { requestPreviewScreenshot } from "../../utils/iframeScreenshotBridge";
import { isRuntimeBusy, type WebContainerRuntimeStatus } from "../../runtime/webcontainer/types";
import type {
  ApiClientRecordedRequest,
  ApiClientRecordedResult,
  ApiClientReplayState,
  ApiClientRequestTab,
  IframeInteractionEvent,
  PreviewActiveMode,
  PreviewDomPatchBatch,
  PreviewEvent,
  PreviewInitialDocument,
  PreviewPanelMode,
  PreviewSize,
} from "../../types/slides";
import { lessonRunsInWebContainer } from "../../types/lessonTypes";
import type { PreviewScrollPosition } from "./previewIframeUtils";
import { useApiClientStoreInstance } from "../../contexts/ApiClientStoreContext";
import type { ApiClientHistoryEntry } from "../../stores/apiClientStore";
import {
  recordedApiStateToReplayPayload,
  storeResultToRecorded,
  toRecordedApiRequest,
} from "../../stores/apiClientRecordingAdapter";
import { hasRrwebPreviewSeed } from "../../core/src/preview";
import { RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE } from "./rrwebPreview";
import { useApiClient } from "./useApiClient";
import { usePreviewInteractionCapture } from "./usePreviewInteractionCapture";
import { usePreviewMessageBridge } from "./usePreviewMessageBridge";
import { requestStudioPreviewCommand } from "../../utils/iframeStudioCommandBridge";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";
import { usePreviewResize } from "./usePreviewResize";
import { useRuntimeSnapshotRequests } from "./useRuntimeSnapshotRequests";
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
  /** See RuntimePreviewRenderer — false once recorded HTML can reach the frame. */
  allowSameOriginPreview: boolean;
  size: PreviewSize;
  isOpen: boolean;
  panelMode: PreviewPanelMode;
  dockWidth: number;
  isRefreshing: boolean;
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
  handleReload: () => void;
  handleOpenConsole: () => void;
  handleResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  handleDockResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Click/keyboard alternative to dragging a resize handle: one step bigger or smaller. */
  handleResizeStep: (direction: 1 | -1) => void;
  handleTransitionStart: () => void;
  handleTransitionComplete: () => void;
  setActiveMode: (mode: PreviewActiveMode) => void;
  sendApiClientRequest: () => void;
  recordApiClientTab: (tab: ApiClientRequestTab) => void;
  recordApiClientInspect: (entry: ApiClientHistoryEntry) => void;
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
 * Writes preview HTML into the iframe as its srcdoc. Returns whether the content
 * landed, so the caller only records it as applied on success. Module-level (not
 * inside the hook) because its try/catch would otherwise force a React Compiler
 * bailout of the whole controller hook.
 */
function writeIframeContent(iframe: HTMLIFrameElement, content: string): boolean {
  try {
    iframe.removeAttribute("src");
    iframe.srcdoc = content;
    return true;
  } catch (error) {
    console.error("Error updating iframe srcdoc:", error);
    return false;
  }
}

/**
 * Shows the runtime placeholder in the frame, and records it as the frame's
 * content. Asks the element, not `lastContentRef`, whether the placeholder is
 * already there: closing the panel, a playback, or a sandbox change mounts a new,
 * empty frame while the ref still holds what the old one showed. Module-level so
 * the uncompiled controller hook does not grow.
 */
function showRuntimePlaceholder(
  iframe: HTMLIFrameElement,
  lastContentRef: RefObject<string>,
  placeholder: string,
): void {
  if (iframe.getAttribute("srcdoc") !== placeholder) {
    iframe.removeAttribute("src");
    iframe.srcdoc = placeholder;
  }
  lastContentRef.current = placeholder;
}

/**
 * A cross-origin runtime iframe (e.g. the :PORT runtime preview) can paint
 * blank inside the floating panel's clipped/composited container — it is
 * `position: fixed` with `rounded-xl`, `overflow-hidden`, a box-shadow and a
 * transform/opacity transition, none of which the docked panel has. Chromium
 * leaves the frame unpainted until something forces a repaint, which is why a
 * manual scroll "revives" it. Toggling a compositor-only transform nudges that
 * repaint without reloading the frame (changing src/srcdoc/display would
 * reload a cross-origin frame and lose its state instead). Module-level so the
 * uncompiled controller's repaint effects key off the panel state alone, not a
 * function recreated (and so re-run, toggling the layer) on every render.
 */
function forceIframeRepaint(iframeRef: RefObject<HTMLIFrameElement | null>): void {
  const iframe = iframeRef.current;
  if (!iframe) {
    return;
  }

  iframe.style.transform = "translateZ(0)";
  requestAnimationFrame(() => {
    const current = iframeRef.current;
    if (current) {
      current.style.transform = "";
    }
  });
}

/**
 * Whether the preview frame may keep `allow-same-origin`.
 *
 * The flag is only dangerous on the `srcdoc` path: an about:srcdoc document
 * inherits its embedder's origin, so recorded HTML from a `.ne` would run as
 * first-party script on the app's origin.
 *
 * On the live WebContainer URL the flag is REQUIRED, not merely harmless. That
 * document is cross-origin, so the flag only preserves *its own* origin — and
 * without it the preview lands in an opaque origin where its service worker
 * cannot register, and WebContainer replaces the app with its "enable storage
 * partitioning" placeholder.
 *
 * The condition mirrors the effect that actually assigns `iframe.src`, rather
 * than `isLiveRuntimePreviewActive` (which additionally requires
 * `runtimeStatus === "ready"`, and so would miss the window where the URL is
 * already assigned but the status has not caught up).
 */
export function shouldAllowSameOriginPreview({
  hasRecording,
  isPlaybackPreviewActive,
  runsInWebContainer,
  hasRuntimePreviewUrl,
}: {
  hasRecording: boolean;
  isPlaybackPreviewActive: boolean;
  runsInWebContainer: boolean;
  hasRuntimePreviewUrl: boolean;
}): boolean {
  // No recording open: ordinary authoring of the user's own content.
  if (!hasRecording) return true;
  // Showing the live runtime URL — cross-origin, and it needs the flag.
  return !isPlaybackPreviewActive && runsInWebContainer && hasRuntimePreviewUrl;
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
  const [previewRoute, setPreviewRoute] = useState("/");
  const [activeMode, setActiveMode] = useState<PreviewActiveMode>("browser");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayContainerRef = useRef<HTMLDivElement>(null);

  const lastContentRef = useRef("");
  const scrollPositionRef = useRef<PreviewScrollPosition>({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const previewRouteRef = useRef("/");

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
  const { subscribeWorkspaceSync } = useWorkspaceActions();
  const lessonType = useWorkspaceLessonType();
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
  // One predicate for both "render the replay surface" and "build a Replayer":
  // the recording has an rrweb seed. A seed alone (a preview that was opened and
  // never mutated) is a complete stream; patch batches without one cannot be
  // replayed, so such a recording keeps the iframe and its snapshot-HTML fallback.
  const hasPreviewPatchReplay = hasRrwebPreviewSeed(currentRecording?.previewInitialDocuments);
  const isRuntimePlaybackPreviewActive =
    lessonRunsInWebContainer(lessonType) && isPlaybackPreviewActive;
  // The rrweb replay preview is shown ONLY while the recording is actively playing.
  // When paused/ended (or never started) — even with a recording loaded — the live
  // runtime preview is shown instead (see `isLiveRuntimePreviewActive`).
  const isRrwebReplayActive = isRuntimePlaybackPreviewActive && hasPreviewPatchReplay;
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
  // True in exactly the states where the effect below points this frame at the
  // cross-origin WebContainer URL via `src` (see the `runtimePreviewSrcNeedsReset`
  // branch). Deliberately mirrors that condition rather than
  // `isLiveRuntimePreviewActive`, which also requires `runtimeStatus === "ready"`
  // and so would miss the window where the URL is already assigned.
  const allowSameOriginPreview = shouldAllowSameOriginPreview({
    hasRecording: Boolean(currentRecording),
    isPlaybackPreviewActive,
    runsInWebContainer: lessonRunsInWebContainer(lessonType),
    hasRuntimePreviewUrl: Boolean(runtimePreviewUrl),
  });
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
  // Replay hands every preview event's state to the applier, and after the first
  // API event each state carries the same recorded API object forward. Skip a
  // re-apply only when both that object and the store are exactly as the last
  // apply left them: the viewer can change the store while paused, and resuming
  // must show the recorded request again.
  const lastAppliedApiStateRef = useRef<{
    recorded: ApiClientReplayState;
    storeContext: unknown;
  } | null>(null);

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

  const {
    requestRuntimePreviewSnapshot,
    completeRuntimeSnapshotRequest,
    shouldAcceptRuntimeSnapshot,
    lastRuntimeSnapshotRef,
    lastRuntimeSnapshotCapturedAtRef,
  } = useRuntimeSnapshotRequests({
    iframeRef,
    effectiveRuntimePreviewUrl,
    isRuntimePreviewActive,
    lastContentRef,
  });

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
    // A retake discarded the stretch of the preview stream the live document's next
    // patches would build on. Its fresh full snapshot is accepted as the new seed, the
    // way the recording-start answer is.
    previewHandle.recordingCheckpointRequester.current = () => {
      recordedPreviewInitialDocumentIdRef.current = null;
      iframeRef.current?.contentWindow?.postMessage(
        { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
        "*",
      );
    };

    return () => {
      previewHandle.livePreviewInspectionGetter.current = null;
      previewHandle.previewScreenshotCapturer.current = null;
      previewHandle.previewCommandExecutor.current = null;
      previewHandle.recordingStopPreparer.current = null;
      previewHandle.recordingCheckpointRequester.current = null;
    };
  }, [effectiveRuntimePreviewUrl, previewHandle, requestRuntimePreviewSnapshot]);

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
    pendingInteractionRef,
    sizeRef,
    onConsoleMessage: (msg: string) => consoleAppender.current?.(msg),
    onRouteChange: handleRuntimeRouteChange,
    shouldAcceptRuntimeSnapshot,
    onRuntimeSnapshot: completeRuntimeSnapshotRequest,
    onApiClientResponse: apiClient.handleResponse,
  });

  const updateIframeContent = (content: string) => {
    const iframe = iframeRef.current;
    if (iframe && writeIframeContent(iframe, content)) {
      lastContentRef.current = content;
    }
  };

  // Refreshes the preview and records a preview_refresh, carrying the runtime
  // page's HTML when there is one. With `reloadRuntime` the live runtime frame is
  // reloaded first; otherwise its current page is only captured again.
  const forceRefreshPreview = ({
    showSpinner,
    reloadRuntime,
  }: {
    showSpinner: boolean;
    reloadRuntime: boolean;
  }) => {
    const iframe = iframeRef.current;

    if (!iframe) {
      return;
    }

    if (showSpinner) {
      setIsRefreshing(true);
    }

    const finishRefresh = () => {
      if (!showSpinner) {
        return;
      }

      setTimeout(() => setIsRefreshing(false), 600);
    };

    if (isRuntimePreviewActive && effectiveRuntimePreviewUrl) {
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

      if (!reloadRuntime) {
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

      // Never rejects (it falls back to assigning `src`); the timeout above
      // finalizes a reload whose `load` never comes.
      void refreshRuntimePreview(iframe, effectiveRuntimePreviewUrl);
      return;
    }

    if (isRuntimeManagedPreview) {
      showRuntimePlaceholder(iframe, lastContentRef, runtimePreviewPlaceholder);
      emitPreviewEvent("preview_refresh");
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
    isRrwebReplayActive,
    pendingInteractionRef,
    lastRuntimeSnapshotRef,
    lastContentRef,
    scrollPositionRef,
    routeRef: previewRouteRef,
    sizeRef,
    isOpenRef,
    modeRef: panelModeRef,
    updateIframeContent,
    setSize,
    applyPreviewRoute,
    applyPreviewPanelState,
    lastRefreshKeyRef,
    replayContainerRef,
    onActiveModeChange: setActiveMode,
    onRequestTabChange: (tab) => apiClientStore.trigger.setRequestTab({ tab }),
    onApiClientStateChange: (apiState) => {
      const lastApplied = lastAppliedApiStateRef.current;
      if (
        lastApplied?.recorded === apiState &&
        lastApplied.storeContext === apiClientStore.getSnapshot().context
      ) {
        return;
      }

      apiClientStore.trigger.applyReplayState(recordedApiStateToReplayPayload(apiState));
      lastAppliedApiStateRef.current = {
        recorded: apiState,
        storeContext: apiClientStore.getSnapshot().context,
      };
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
      showRuntimePlaceholder(iframe, lastContentRef, runtimePreviewPlaceholder);
    }
  }, [
    isOpen,
    isPlaybackPreviewActive,
    isRuntimeManagedPreview,
    lessonType,
    panelMode,
    runtimePreviewPlaceholder,
    runtimePreviewUrl,
    requestRuntimePreviewSnapshot,
    // Changing the sandbox mode remounts the frame (RuntimePreviewRenderer keys
    // on it, because a sandbox change does not apply to an already-loaded
    // document). The new element starts empty, so this effect has to re-run;
    // showRuntimePlaceholder's element check then repaints it.
    allowSameOriginPreview,
  ]);

  // Frames recorded from a live runtime carry its last HTML snapshot, the
  // fallback for recordings rrweb cannot replay. While recording, refresh it
  // after each workspace edit; outside a recording nothing reads it, and a
  // whole-page snapshot per keystroke would be pure cost. Neither does a take
  // whose rrweb seed has been recorded: its frames no longer store the fallback.
  const refreshRecordedRuntimeSnapshot = useEffectEvent(() => {
    if (
      !isRecordingRef.current ||
      !isLiveRuntimePreviewActive ||
      recordedPreviewInitialDocumentIdRef.current !== null
    ) {
      return;
    }

    void requestRuntimePreviewSnapshot("edit");
  });

  // Refresh on each workspace sync revision: an edit, a loaded project, or an
  // asset becoming available. Subscribing, instead of reading the revision in
  // render, keeps typing from re-rendering the preview.
  useEffect(() => {
    return subscribeWorkspaceSync(() => refreshRecordedRuntimeSnapshot());
  }, [subscribeWorkspaceSync]);

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

    forceRefreshPreview({ showSpinner: false, reloadRuntime: false });
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

    if (isRuntimeBusy(runtimeStatus) || hasRequestedRuntimeStartForOpenRef.current) {
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
    forceRefreshPreview({ showSpinner: true, reloadRuntime: false });
  };

  // User-initiated reload from the preview URL bar. Unlike `handleRefresh`
  // (which captures a baseline at recording start without touching the live
  // frame), this actually reloads the runtime preview iframe.
  const handleReload = () => {
    forceRefreshPreview({ showSpinner: true, reloadRuntime: true });
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

  const resize = usePreviewResize({
    containerRef,
    panelMode,
    dockWidth,
    setDockWidth,
    setSize,
    isRecordingRef,
    handleWorkspaceEvent,
    emitPreviewEvent,
  });

  // Recording start: capture the preview's starting point in both replay formats.
  useEffect(() => {
    const wasRecording = previousIsRecordingRef.current;
    previousIsRecordingRef.current = isRecording;

    if (!isRecording) {
      recordedPreviewInitialDocumentIdRef.current = null;
      return;
    }

    if (wasRecording) {
      return;
    }

    // rrweb: the recorder answers with a FullSnapshot of the live document, which
    // seeds the recording (see RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE).
    iframeRef.current?.contentWindow?.postMessage(
      { type: RUNTIME_TAKE_SNAPSHOT_MESSAGE_TYPE },
      "*",
    );
    // The active frame, so replay opens in the right mode even when the user was
    // already in the API frame before pressing record.
    emitPreviewEvent("api_client_mode", { activeMode });
    // The HTML fallback for recordings rrweb cannot replay: a preview_refresh
    // carrying the runtime page's snapshot.
    handleRefresh();
  }, [isRecording]);

  const handleTransitionStart = () => {
    setIsTransitioning(true);
  };

  const handleTransitionComplete = () => {
    setIsTransitioning(false);
    forceIframeRepaint(iframeRef);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // `transitionend` isn't guaranteed (reduced motion, an interrupted or absent
    // transition), so also force the repaint on the next frame and once more after
    // the 150ms panel transition would have finished. Safe to over-fire: the nudge
    // is idempotent and a no-op for same-origin previews.
    const raf = requestAnimationFrame(() => forceIframeRepaint(iframeRef));
    const timer = window.setTimeout(() => forceIframeRepaint(iframeRef), 220);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [panelMode, isOpen]);

  // Returning to browser mode uncovers the runtime iframe; if Chromium occlusion-
  // culled it while the API panel overlay was on top, nudge a repaint so it isn't
  // left blank. No-op for same-origin previews and idempotent.
  useEffect(() => {
    if (activeMode !== "browser" || !isOpen) {
      return;
    }

    const raf = requestAnimationFrame(() => forceIframeRepaint(iframeRef));

    return () => cancelAnimationFrame(raf);
  }, [activeMode, isOpen]);

  return {
    containerRef,
    iframeRef,
    replayContainerRef,
    isRrwebReplayActive,
    allowSameOriginPreview,
    size,
    isOpen,
    panelMode,
    dockWidth,
    isRefreshing,
    isTransitioning,
    disablePointerEvents: isTransitioning || resize.isResizing,
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
    handleReload,
    handleOpenConsole,
    handleResizeStart: resize.handleResizeStart,
    handleDockResizeStart: resize.handleDockResizeStart,
    handleResizeStep: resize.handleResizeStep,
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
        apiClientRequest: toRecordedApiRequest(entry),
        apiClientResult: storeResultToRecorded(entry.result),
      });
    },
  };
}
