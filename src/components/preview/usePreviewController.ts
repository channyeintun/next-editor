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
import {
  useNextEditorActions,
  useNextEditorMetadata,
} from "../../hooks/useNextEditorContext";
import { useNextEditorDomainAdapters } from "../../contexts/NextEditorDomainAdaptersContext";
import {
  useWorkspaceLessonType,
  useWorkspacePreviewVersion,
  useWorkspaceSaveVersion,
} from "../../hooks/useWorkspace";
import { useWebContainerRuntimeMetadata } from "../../hooks/useWebContainerRuntime";
import type { WebContainerRuntimeStatus } from "../../contexts/WebContainerRuntimeContext";
import type {
  IframeInteractionEvent,
  PreviewEvent,
  PreviewSize,
} from "../../types/slides";
import { useCompiledStaticWorkspacePreview } from "./useCompiledStaticWorkspacePreview";
import {
  createReplayableRuntimePreview,
  patchIframeContentFromHtml,
  type PreviewScrollPosition,
} from "./previewIframeUtils";
import { usePreviewInteractionCapture } from "./usePreviewInteractionCapture";
import { usePreviewMessageBridge } from "./usePreviewMessageBridge";
import { usePreviewPlaybackRegistration } from "./usePreviewPlaybackRegistration";

function escapePreviewHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
      description:
        "WebContainers need cross-origin isolation before the app preview can run.",
      placeholderKind: "message",
    };
  }

  if (status === "error") {
    return {
      label: "Runtime preview error",
      title: "Runtime preview failed",
      description:
        errorMessage ??
        "Check the runner output, fix the error, and rerun the preview.",
      placeholderKind: "message",
    };
  }

  if (status === "installing") {
    return {
      label: "Installing runtime",
      title: "Installing dependencies",
      description:
        "The project is preparing packages before the live preview can start.",
      placeholderKind: "spinner",
    };
  }

  if (status === "starting") {
    return {
      label: "Starting runtime",
      title: "Starting live preview",
      description:
        "The dev server is booting and will replace this placeholder when it is ready.",
      placeholderKind: "spinner",
    };
  }

  if (status === "mounting" || status === "booting") {
    return {
      label: "Preparing runtime",
      title: "Preparing runtime preview",
      description:
        "The workspace is mounting into the WebContainer before the preview starts.",
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
  size: PreviewSize;
  isRefreshing: boolean;
  isResizing: boolean;
  isTransitioning: boolean;
  disablePointerEvents: boolean;
  rendererKind: "runtime" | "static";
  handleClick: () => void;
  handleMinimize: () => void;
  handleMaximize: () => void;
  handleRefresh: () => void;
  handleResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  handleTransitionStart: () => void;
  handleTransitionComplete: () => void;
}

export function usePreviewController(): PreviewController {
  const [size, setSize] = useState<PreviewSize>("small");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lastContentRef = useRef("");
  const lastRuntimeSnapshotRef = useRef("");
  const scrollPositionRef = useRef<PreviewScrollPosition>({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);

  const targetScrollRef = useRef<PreviewScrollPosition | null>(null);
  const rafRef = useRef<number | null>(null);
  const editorBootstrapPollTimeoutRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isRecordingRef = useRef(false);
  const handlePreviewEventRef = useRef<((event: PreviewEvent) => void) | null>(
    null,
  );

  const { editorRef, handlePreviewEvent } = useNextEditorActions();
  const { preview } = useNextEditorDomainAdapters();
  const lessonType = useWorkspaceLessonType();
  const previewVersion = useWorkspacePreviewVersion();
  const saveVersion = useWorkspaceSaveVersion();
  const {
    previewUrl: runtimePreviewUrl,
    status: runtimeStatus,
    errorMessage: runtimeErrorMessage,
    isSupported: isRuntimeSupported,
    runnerConfig,
  } = useWebContainerRuntimeMetadata();

  const { currentRecording, isPlaying, isRecording, usesPlaybackModel } =
    useNextEditorMetadata();
  const staticWorkspacePreview = useCompiledStaticWorkspacePreview();
  const isRuntimePlaybackPreviewActive =
    lessonType === "node.js" &&
    Boolean(currentRecording) &&
    usesPlaybackModel &&
    !isRecording;
  const isPlaybackPreviewActive =
    lessonType === "node.js"
      ? isRuntimePlaybackPreviewActive
      : usesPlaybackModel && !isRecording;
  const recordedRuntimeSnapshot = isRuntimePlaybackPreviewActive
    ? (currentRecording?.runtimeSnapshot ?? null)
    : null;
  const recordedRuntimeStatus = recordedRuntimeSnapshot?.status as
    | WebContainerRuntimeStatus
    | undefined;
  const effectiveRuntimeStatus =
    runtimeStatus === "idle"
      ? (recordedRuntimeStatus ?? runtimeStatus)
      : runtimeStatus;
  const effectiveRuntimePreviewUrl =
    runtimePreviewUrl || recordedRuntimeSnapshot?.previewUrl || null;
  const effectiveRuntimeErrorMessage =
    runtimeErrorMessage || recordedRuntimeSnapshot?.errorMessage || null;
  const isStaticWorkspacePreview = lessonType === "html-css";
  const isLiveRuntimePreviewActive =
    lessonType === "node.js" &&
    !isRuntimePlaybackPreviewActive &&
    runtimeStatus === "ready" &&
    Boolean(runtimePreviewUrl);
  const isRuntimePreviewActive =
    lessonType === "node.js" &&
    effectiveRuntimeStatus === "ready" &&
    Boolean(effectiveRuntimePreviewUrl);
  const isRuntimeManagedPreview =
    lessonType === "node.js" && runnerConfig.enabled;
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

  const sizeRef = useRef<PreviewSize>(size);
  sizeRef.current = size;
  const previousSaveVersionRef = useRef<number | null>(null);
  const previousIsRecordingRef = useRef(isRecording);
  const lastRefreshKeyRef = useRef<number | undefined>(undefined);

  const captureRuntimePreviewSnapshot = useCallback(() => {
    if (!effectiveRuntimePreviewUrl) {
      return null;
    }

    const iframe = iframeRef.current;

    if (!iframe) {
      return null;
    }

    const snapshot = createReplayableRuntimePreview(
      iframe,
      effectiveRuntimePreviewUrl,
    );

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
        content?: string;
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
          content: options?.content,
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
    lastRuntimeSnapshotRef,
    scrollPositionRef,
    userScrollTimeoutRef,
    isUserScrollingRef,
    targetScrollRef,
    pendingInteractionRef,
    sizeRef,
  });

  const updateIframeContent = useCallback(
    (
      content: string,
      options?: { force?: boolean; preserveDocument?: boolean },
    ) => {
      if (
        !iframeRef.current ||
        (isLiveRuntimePreviewActive && !options?.force)
      ) {
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
        const shouldReloadRuntime =
          options?.reloadRuntime ?? !options?.emitEvent;

        if (!options?.emitEvent && shouldReloadRuntime) {
          void refreshRuntimePreview(
            iframe,
            effectiveRuntimePreviewUrl,
          ).finally(finishRefresh);
          return;
        }

        let didFinalize = false;
        let runtimeSnapshotPollTimeout: number | null = null;
        const initialRuntimeSnapshot =
          captureRuntimePreviewSnapshot() ||
          lastRuntimeSnapshotRef.current ||
          "";

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

          const resolvedContent =
            content || staticWorkspacePreview || undefined;

          emitPreviewEvent(
            "preview_refresh",
            resolvedContent ? { content: resolvedContent } : undefined,
          );
          finishRefresh();
        };

        const pollRuntimeSnapshot = () => {
          const content =
            captureRuntimePreviewSnapshot() ||
            lastRuntimeSnapshotRef.current ||
            undefined;

          if (content !== undefined && content !== initialRuntimeSnapshot) {
            finalizeRuntimeRefresh(content);
            return;
          }

          const hasTimedOut = performance.now() - refreshStartedAt >= 1500;

          if (hasTimedOut) {
            finalizeRuntimeRefresh(content);
            return;
          }

          runtimeSnapshotPollTimeout = window.setTimeout(
            pollRuntimeSnapshot,
            100,
          );
        };

        const handleRuntimeRefreshLoad = () => {
          runtimeSnapshotPollTimeout = window.setTimeout(
            pollRuntimeSnapshot,
            0,
          );
        };

        const refreshStartedAt = performance.now();

        if (!shouldReloadRuntime) {
          pollRuntimeSnapshot();
          return;
        }

        iframe.addEventListener("load", handleRuntimeRefreshLoad, {
          once: true,
        });

        void refreshRuntimePreview(iframe, effectiveRuntimePreviewUrl).catch(
          () => finalizeRuntimeRefresh(initialRuntimeSnapshot || undefined),
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

      if (isStaticWorkspacePreview) {
        lastContentRef.current = "";
        updateIframeContent(staticWorkspacePreview, { force: true });

        if (options?.emitEvent) {
          emitPreviewEvent("preview_refresh", {
            content: staticWorkspacePreview,
          });
        }

        finishRefresh();
        return;
      }

      const editor = editorRef.current;

      if (!editor) {
        finishRefresh();
        return;
      }

      const content = editor.getValue();
      lastContentRef.current = "";
      updateIframeContent(content, { force: true });

      if (options?.emitEvent) {
        emitPreviewEvent("preview_refresh", { content });
      }

      finishRefresh();
    },
    [
      editorRef,
      captureRuntimePreviewSnapshot,
      emitPreviewEvent,
      isRuntimeManagedPreview,
      isRuntimePreviewActive,
      isStaticWorkspacePreview,
      effectiveRuntimePreviewUrl,
      runtimePreviewPlaceholder,
      staticWorkspacePreview,
      updateIframeContent,
    ],
  );

  usePreviewPlaybackRegistration({
    previewAdapter: preview,
    captureRuntimePreviewSnapshot,
    isRuntimePreviewActive,
    isLiveRuntimePreviewActive,
    pendingInteractionRef,
    lastRuntimeSnapshotRef,
    lastContentRef,
    scrollPositionRef,
    sizeRef,
    effectiveRuntimePreviewUrl,
    staticWorkspacePreview,
    forceRefreshPreview,
    updateIframeContent,
    iframeRef,
    setSize,
    lastRefreshKeyRef,
    isRecordingRef,
    isUserScrollingRef,
    targetScrollRef,
    rafRef,
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
  }, [
    captureRuntimePreviewSnapshot,
    isPlaybackPreviewActive,
    isRuntimePreviewActive,
  ]);

  useEffect(() => {
    if (isPlaybackPreviewActive) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    if (lessonType === "node.js" && runtimePreviewUrl) {
      captureRuntimePreviewSnapshot();
      if (
        iframe.getAttribute("srcdoc") !== null ||
        iframe.src !== runtimePreviewUrl
      ) {
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

      return;
    }

    if (isStaticWorkspacePreview) {
      updateIframeContent(staticWorkspacePreview);

      return;
    }

    const editor = editorRef.current;
    if (editor && !lastContentRef.current) {
      updateIframeContent(editor.getValue());
    }
  }, [
    editorRef,
    isPlaybackPreviewActive,
    isStaticWorkspacePreview,
    isRuntimeManagedPreview,
    lessonType,
    previewVersion,
    runtimePreviewPlaceholder,
    runtimePreviewUrl,
    staticWorkspacePreview,
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
    if (
      isPlaybackPreviewActive ||
      runtimePreviewUrl ||
      isRuntimeManagedPreview ||
      isStaticWorkspacePreview
    ) {
      return;
    }

    let isCancelled = false;

    const checkForEditor = () => {
      if (isCancelled) {
        return;
      }

      const editor = editorRef.current;
      if (!editor) {
        editorBootstrapPollTimeoutRef.current = window.setTimeout(
          checkForEditor,
          100,
        );
        return;
      }

      editorBootstrapPollTimeoutRef.current = null;

      if (!lastContentRef.current) {
        updateIframeContent(editor.getValue());
      }
    };

    checkForEditor();

    return () => {
      isCancelled = true;

      if (editorBootstrapPollTimeoutRef.current !== null) {
        window.clearTimeout(editorBootstrapPollTimeoutRef.current);
        editorBootstrapPollTimeoutRef.current = null;
      }
    };
  }, [
    editorRef,
    isPlaybackPreviewActive,
    isRuntimeManagedPreview,
    isStaticWorkspacePreview,
    runtimePreviewUrl,
    updateIframeContent,
  ]);

  useEffect(() => {
    if (
      isPlaybackPreviewActive ||
      runtimePreviewUrl ||
      isRuntimeManagedPreview ||
      isStaticWorkspacePreview
    ) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    const handleIframeLoad = () => {
      const editor = editorRef.current;
      if (editor) {
        updateIframeContent(editor.getValue());
      }
    };

    iframe.addEventListener("load", handleIframeLoad);

    return () => {
      iframe.removeEventListener("load", handleIframeLoad);
    };
  }, [
    editorRef,
    isPlaybackPreviewActive,
    isStaticWorkspacePreview,
    isRuntimeManagedPreview,
    runtimePreviewUrl,
    updateIframeContent,
  ]);

  const handleClick = useCallback(() => {
    if (size !== "small") {
      return;
    }

    setSize("medium");
    emitPreviewEvent("preview_open", { newSize: "medium" });
  }, [emitPreviewEvent, size]);

  const handleMinimize = useCallback(() => {
    setSize("small");
    emitPreviewEvent("preview_minimize", { newSize: "small" });
  }, [emitPreviewEvent]);

  const handleMaximize = useCallback(() => {
    const newSize = size === "large" ? "medium" : "large";
    setSize(newSize);
    emitPreviewEvent("preview_maximize", { newSize });
  }, [emitPreviewEvent, size]);

  const handleRefresh = useCallback(() => {
    forceRefreshPreview({ emitEvent: true, showSpinner: true });
  }, [forceRefreshPreview]);

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
        currentEvent:
          | MouseEvent
          | TouchEvent
          | ReactMouseEvent
          | ReactTouchEvent,
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

      setSize({ width: startWidth, height: startHeight });

      let resizeRaf: number | null = null;
      const onMove = (moveEvent: MouseEvent | TouchEvent) => {
        if (moveEvent.cancelable) {
          moveEvent.preventDefault();
        }
        const { x: currentX, y: currentY } = getCoords(moveEvent);

        const deltaX = startX - currentX;
        const deltaY = currentY - startY;

        const maxWidth = window.innerWidth - 32;
        const maxHeight = window.innerHeight - 96;

        const newWidth = Math.min(maxWidth, Math.max(160, startWidth + deltaX));
        const newHeight = Math.min(
          maxHeight,
          Math.max(120, startHeight + deltaY),
        );

        const newSize = { width: newWidth, height: newHeight };
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

  const handleTransitionStart = useCallback(() => {
    setIsTransitioning(true);
  }, []);

  const handleTransitionComplete = useCallback(() => {
    setIsTransitioning(false);
  }, []);

  return {
    containerRef,
    iframeRef,
    size,
    isRefreshing,
    isResizing,
    isTransitioning,
    disablePointerEvents: isTransitioning || isResizing,
    rendererKind: lessonType === "node.js" ? "runtime" : "static",
    handleClick,
    handleMinimize,
    handleMaximize,
    handleRefresh,
    handleResizeStart,
    handleTransitionStart,
    handleTransitionComplete,
  };
}
