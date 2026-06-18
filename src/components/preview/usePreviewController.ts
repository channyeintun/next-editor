import {
  useCallback,
  useEffect,
  useMemo,
  type RefObject,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useNextEditorDomainAdapters } from "../../contexts/NextEditorDomainAdaptersContext";
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
import type { WebContainerRuntimeStatus } from "../../contexts/WebContainerRuntimeContext";
import type {
  IframeInteractionEvent,
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
} from "./previewIframeUtils";
import { hasRrwebPreviewEvents } from "./rrwebPreview";
import { usePreviewInteractionCapture } from "./usePreviewInteractionCapture";
import { usePreviewMessageBridge } from "./usePreviewMessageBridge";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";
import {
  clampCustomPreviewSize,
  getCustomPreviewSizeFromResize,
  isCustomPreviewSize,
} from "./previewSizeUtils";

function escapePreviewHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

interface RuntimePreviewLocation {
  href: string;
  port: number | null;
  route: string;
}

function getUrlPort(url: URL): number | null {
  const port = Number(url.port);

  return Number.isFinite(port) && port > 0 ? port : null;
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function formatPreviewRoute(pathname: string, search: string, hash: string): string {
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname || ""}`;
  const route = `${normalizedPathname || "/"}${search}${hash}`;

  return route || "/";
}

function normalizePreviewRoute(route: string): string {
  const trimmedRoute = route.trim();

  if (!trimmedRoute) {
    return "/";
  }

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedRoute)) {
      const parsedUrl = new URL(trimmedRoute);
      return formatPreviewRoute(parsedUrl.pathname || "/", parsedUrl.search, parsedUrl.hash);
    }
  } catch {
    // Treat malformed values as relative routes.
  }

  if (trimmedRoute.startsWith("/")) {
    return trimmedRoute;
  }

  if (trimmedRoute.startsWith("?") || trimmedRoute.startsWith("#")) {
    return `/${trimmedRoute}`;
  }

  return `/${trimmedRoute}`;
}

function createRuntimePreviewLocationFromUrl(
  url: string | null,
  fallbackPort: number | null,
): RuntimePreviewLocation | null {
  if (!url) {
    return null;
  }

  try {
    const parsedUrl = new URL(url);

    if (!isHttpUrl(parsedUrl)) {
      return null;
    }

    return {
      href: parsedUrl.href,
      port: fallbackPort ?? getUrlPort(parsedUrl),
      route: formatPreviewRoute(parsedUrl.pathname || "/", parsedUrl.search, parsedUrl.hash),
    };
  } catch {
    return {
      href: url,
      port: fallbackPort,
      route: "/",
    };
  }
}

function formatPreviewAddressLabel(location: RuntimePreviewLocation | null): string {
  if (!location) {
    return "Preview";
  }

  return location.port === null ? location.route : `:${location.port} ${location.route}`;
}

function applyRouteToRuntimePreviewLocation(
  location: RuntimePreviewLocation | null,
  route: string,
): RuntimePreviewLocation | null {
  if (!location) {
    return null;
  }

  const normalizedRoute = normalizePreviewRoute(route);

  try {
    const routeUrl = new URL(normalizedRoute, location.href);

    return {
      ...location,
      href: routeUrl.href,
      route: normalizedRoute,
    };
  } catch {
    return {
      ...location,
      route: normalizedRoute,
    };
  }
}

async function refreshRuntimePreview(
  iframe: HTMLIFrameElement,
  fallbackUrl: string,
): Promise<void> {
  try {
    const { reloadPreview } = await import("@webcontainer/api");
    reloadPreview(iframe);
  } catch {
    iframe.removeAttribute("srcdoc");
    iframe.src = fallbackUrl;
  }
}

function getRuntimePreviewState(
  status: WebContainerRuntimeStatus,
  errorMessage: string | null,
  isSupported: boolean,
): {
  label: string;
  title: string;
  description: string;
  placeholderKind: "spinner" | "message";
} {
  if (!isSupported) {
    return {
      label: "Runtime preview unavailable",
      title: "Runtime preview unavailable",
      description: "WebContainers need cross-origin isolation before the app preview can run.",
      placeholderKind: "message",
    };
  }

  if (status === "error") {
    return {
      label: "Runtime preview error",
      title: "Runtime preview failed",
      description: errorMessage ?? "Check the runner output, fix the error, and rerun the preview.",
      placeholderKind: "message",
    };
  }

  if (status === "installing") {
    return {
      label: "Installing runtime",
      title: "Installing dependencies",
      description: "The project is preparing packages before the live preview can start.",
      placeholderKind: "spinner",
    };
  }

  if (status === "starting") {
    return {
      label: "Starting runtime",
      title: "Starting live preview",
      description: "The dev server is booting and will replace this placeholder when it is ready.",
      placeholderKind: "spinner",
    };
  }

  if (status === "mounting" || status === "booting") {
    return {
      label: "Preparing runtime",
      title: "Preparing runtime preview",
      description: "The workspace is mounting into the WebContainer before the preview starts.",
      placeholderKind: "spinner",
    };
  }

  return {
    label: "Runtime preview",
    title: "Runtime preview is waiting",
    description: "Run or rerun the project to open the live app preview here.",
    placeholderKind: "spinner",
  };
}

function createRuntimePreviewPlaceholder(
  placeholderKind: "spinner" | "message",
  title: string,
  description: string,
): string {
  if (placeholderKind === "spinner") {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f8fafc;
      }

      .spinner {
        width: 32px;
        height: 32px;
        border-radius: 999px;
        border: 3px solid rgba(148, 163, 184, 0.28);
        border-top-color: #0f766e;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <div class="spinner" role="status" aria-label="${escapePreviewHtml(title)}"></div>
  </body>
</html>`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
        background: #f6f7fb;
        color: #0f172a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(125, 211, 252, 0.18), transparent 35%),
          linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
      }

      main {
        width: min(420px, calc(100vw - 32px));
        padding: 28px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      }

      .eyebrow {
        margin: 0 0 14px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #0f766e;
      }

      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
      }

      p {
        margin: 14px 0 0;
        font-size: 15px;
        line-height: 1.6;
        color: #334155;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Runtime Preview</p>
      <h1>${escapePreviewHtml(title)}</h1>
      <p>${escapePreviewHtml(description)}</p>
    </main>
  </body>
</html>`;
}

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
  handleClose: () => void;
  handleFloat: () => void;
  handleDock: () => void;
  handleBack: () => void;
  handleForward: () => void;
  handleRefresh: () => void;
  handleOpenConsole: () => void;
  handleResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  handleDockResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  handleTransitionStart: () => void;
  handleTransitionComplete: () => void;
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

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const replayContainerRef = useRef<HTMLDivElement>(null);

  const lastContentRef = useRef("");
  const lastRuntimeSnapshotRef = useRef("");
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
  const lastPreviewInitialDocumentRef = useRef<PreviewInitialDocument | null>(null);
  const recordedPreviewInitialDocumentIdRef = useRef<string | null>(null);

  const { handlePreviewEvent, handlePreviewInitialDocument, handlePreviewPatchBatch } =
    useNextEditorActions();
  const { preview, runtimePanel } = useNextEditorDomainAdapters();
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
  const runtimePreviewState = useMemo(
    () =>
      getRuntimePreviewState(
        effectiveRuntimeStatus,
        effectiveRuntimeErrorMessage,
        isRuntimeSupported,
      ),
    [effectiveRuntimeErrorMessage, effectiveRuntimeStatus, isRuntimeSupported],
  );
  const runtimePreviewPlaceholder = useMemo(
    () =>
      createRuntimePreviewPlaceholder(
        runtimePreviewState.placeholderKind,
        runtimePreviewState.title,
        runtimePreviewState.description,
      ),
    [
      runtimePreviewState.description,
      runtimePreviewState.placeholderKind,
      runtimePreviewState.title,
    ],
  );

  isRecordingRef.current = isRecording;
  handlePreviewEventRef.current = handlePreviewEvent;
  handlePreviewInitialDocumentRef.current = handlePreviewInitialDocument;
  handlePreviewPatchBatchRef.current = handlePreviewPatchBatch;

  useEffect(() => {
    if (!isRecording) {
      recordedPreviewInitialDocumentIdRef.current = null;
      return;
    }

    const initialDocument = lastPreviewInitialDocumentRef.current;
    if (
      initialDocument &&
      initialDocument.documentId !== recordedPreviewInitialDocumentIdRef.current
    ) {
      handlePreviewInitialDocument(initialDocument);
      recordedPreviewInitialDocumentIdRef.current = initialDocument.documentId;
    }
  }, [handlePreviewInitialDocument, isRecording]);

  const sizeRef = useRef<PreviewSize>(size);
  sizeRef.current = size;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const panelModeRef = useRef<PreviewPanelMode>(panelMode);
  panelModeRef.current = panelMode;
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

    const snapshot = createReplayableRuntimePreview(iframe, effectiveRuntimePreviewUrl);

    if (snapshot) {
      lastRuntimeSnapshotRef.current = snapshot;
      lastContentRef.current = snapshot;
    }

    return snapshot;
  }, [effectiveRuntimePreviewUrl]);

  useEffect(() => {
    if (isRuntimePreviewActive) {
      return;
    }

    lastRuntimeSnapshotRef.current = "";
  }, [effectiveRuntimePreviewUrl, isRuntimePreviewActive]);

  const emitPreviewEvent = useCallback(
    (
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
        };
        handlePreviewEventRef.current(event);
      }
    },
    [],
  );

  usePreviewMessageBridge({
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
    onConsoleMessage: runtimePanel.appendConsoleLine,
    onRouteChange: applyPreviewRoute,
  });

  const updateIframeContent = useCallback(
    (content: string, options?: { force?: boolean; preserveDocument?: boolean }) => {
      if (!iframeRef.current || (isLiveRuntimePreviewActive && !options?.force)) {
        return;
      }

      if (!options?.force && lastContentRef.current === content) {
        return;
      }

      const iframe = iframeRef.current;

      try {
        if (
          options?.preserveDocument &&
          iframe.getAttribute("src") === null &&
          patchIframeContentFromHtml(iframe, content)
        ) {
          lastContentRef.current = content;
          return;
        }

        iframe.removeAttribute("src");
        iframe.srcdoc = content;
        lastContentRef.current = content;
      } catch (error) {
        console.error("Error updating iframe srcdoc:", error);
      }
    },
    [isLiveRuntimePreviewActive],
  );

  const forceRefreshPreview = useCallback(
    (options?: {
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
        let runtimeSnapshotPollTimeout: number | null = null;
        const initialRuntimeSnapshot =
          captureRuntimePreviewSnapshot() || lastRuntimeSnapshotRef.current || "";

        const cleanupRuntimeRefresh = () => {
          iframe.removeEventListener("load", handleRuntimeRefreshLoad);
          if (runtimeSnapshotPollTimeout !== null) {
            window.clearTimeout(runtimeSnapshotPollTimeout);
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

        const pollRuntimeSnapshot = () => {
          const content =
            captureRuntimePreviewSnapshot() || lastRuntimeSnapshotRef.current || undefined;

          if (content !== undefined && content !== initialRuntimeSnapshot) {
            finalizeRuntimeRefresh(content);
            return;
          }

          const hasTimedOut = performance.now() - refreshStartedAt >= 1500;

          if (hasTimedOut) {
            finalizeRuntimeRefresh(content);
            return;
          }

          runtimeSnapshotPollTimeout = window.setTimeout(pollRuntimeSnapshot, 100);
        };

        const handleRuntimeRefreshLoad = () => {
          runtimeSnapshotPollTimeout = window.setTimeout(pollRuntimeSnapshot, 0);
        };

        const refreshStartedAt = performance.now();

        if (!shouldReloadRuntime) {
          pollRuntimeSnapshot();
          return;
        }

        iframe.addEventListener("load", handleRuntimeRefreshLoad, {
          once: true,
        });

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
    },
    [
      captureRuntimePreviewSnapshot,
      emitPreviewEvent,
      isRuntimeManagedPreview,
      isRuntimePreviewActive,
      effectiveRuntimePreviewUrl,
      runtimePreviewPlaceholder,
      updateIframeContent,
    ],
  );

  usePreviewPlaybackRegistration({
    previewAdapter: preview,
    captureRuntimePreviewSnapshot,
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
      captureRuntimePreviewSnapshot();
    };

    iframe.addEventListener("load", syncSnapshot);
    syncSnapshot();

    return () => {
      iframe.removeEventListener("load", syncSnapshot);
    };
  }, [captureRuntimePreviewSnapshot, isPlaybackPreviewActive, isRuntimePreviewActive]);

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
      captureRuntimePreviewSnapshot();
      if (iframe.getAttribute("srcdoc") !== null || iframe.src !== runtimePreviewUrl) {
        iframe.removeAttribute("srcdoc");
        iframe.src = runtimePreviewUrl;
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
    captureRuntimePreviewSnapshot,
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
    isPlaybackPreviewActive,
    isRuntimeSupported,
    lessonType,
    runnerConfig.enabled,
    runtimePreviewUrl,
    runtimeStatus,
    startRuntime,
  ]);

  const handleClose = useCallback(() => {
    closePreview();
  }, [closePreview]);

  const handleFloat = useCallback(() => {
    setSize((currentSize) =>
      currentSize === "small" || currentSize === "large" ? "medium" : currentSize,
    );
    floatPreview();
  }, [floatPreview]);

  const handleDock = useCallback(() => {
    dockPreview();
  }, [dockPreview]);

  const handleRefresh = useCallback(() => {
    forceRefreshPreview({ emitEvent: true, showSpinner: true });
  }, [forceRefreshPreview]);

  const handleBack = useCallback(() => {
    const iframeWindow = iframeRef.current?.contentWindow;

    if (!iframeWindow) {
      return;
    }

    try {
      iframeWindow.history.back();
      return;
    } catch {
      iframeWindow.postMessage(
        {
          type: IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE,
          payload: {
            action: "back",
          },
        },
        "*",
      );
    }
  }, []);

  const handleForward = useCallback(() => {
    const iframeWindow = iframeRef.current?.contentWindow;

    if (!iframeWindow) {
      return;
    }

    try {
      iframeWindow.history.forward();
      return;
    } catch {
      iframeWindow.postMessage(
        {
          type: IFRAME_NAVIGATION_COMMAND_MESSAGE_TYPE,
          payload: {
            action: "forward",
          },
        },
        "*",
      );
    }
  }, []);

  const handleOpenConsole = useCallback(() => {
    runtimePanel.openConsole();
  }, [runtimePanel]);

  const previewAddress = useMemo(() => {
    const location = applyRouteToRuntimePreviewLocation(
      createRuntimePreviewLocationFromUrl(effectiveRuntimePreviewUrl, effectiveRuntimePreviewPort),
      previewRoute,
    );

    return {
      label: formatPreviewAddressLabel(location),
      title: location?.href ?? effectiveRuntimePreviewUrl ?? "Preview",
    };
  }, [effectiveRuntimePreviewPort, effectiveRuntimePreviewUrl, previewRoute]);

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

    handleRefresh();
  }, [handleRefresh, isPlaying, isRecording]);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent | ReactTouchEvent) => {
      if ("button" in event && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);

      const getCoords = (
        currentEvent: MouseEvent | TouchEvent | ReactMouseEvent | ReactTouchEvent,
      ) => {
        if ("touches" in currentEvent) {
          return {
            x: currentEvent.touches[0].clientX,
            y: currentEvent.touches[0].clientY,
          };
        }

        return { x: currentEvent.clientX, y: currentEvent.clientY };
      };

      const { x: startX, y: startY } = getCoords(event);
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
        const { x: currentX, y: currentY } = getCoords(moveEvent);

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
    },
    [emitPreviewEvent],
  );

  const handleDockResizeStart = useCallback(
    (event: ReactMouseEvent | ReactTouchEvent) => {
      if ("button" in event && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsResizing(true);

      const getCoords = (
        currentEvent: MouseEvent | TouchEvent | ReactMouseEvent | ReactTouchEvent,
      ) => {
        if ("touches" in currentEvent) {
          return {
            x: currentEvent.touches[0].clientX,
            y: currentEvent.touches[0].clientY,
          };
        }

        return { x: currentEvent.clientX, y: currentEvent.clientY };
      };

      const { x: startX } = getCoords(event);
      const rect = containerRef.current?.getBoundingClientRect();

      if (!rect) {
        setIsResizing(false);
        return;
      }

      const startWidth = rect.width;

      const onMove = (moveEvent: MouseEvent | TouchEvent) => {
        if (moveEvent.cancelable) {
          moveEvent.preventDefault();
        }

        const { x: currentX } = getCoords(moveEvent);
        setDockWidth(clampPreviewDockWidth(startWidth + startX - currentX, window.innerWidth));
      };

      const onEnd = () => {
        setIsResizing(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
    },
    [setDockWidth],
  );

  const forceIframeRepaint = useCallback(() => {
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
  }, []);

  const handleTransitionStart = useCallback(() => {
    setIsTransitioning(true);
  }, []);

  const handleTransitionComplete = useCallback(() => {
    setIsTransitioning(false);
    forceIframeRepaint();
  }, [forceIframeRepaint]);

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
    handleClose,
    handleFloat,
    handleDock,
    handleBack,
    handleForward,
    handleRefresh,
    handleOpenConsole,
    handleResizeStart,
    handleDockResizeStart,
    handleTransitionStart,
    handleTransitionComplete,
  };
}
