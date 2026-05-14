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
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import { useCompiledStaticWorkspacePreview } from "./useCompiledStaticWorkspacePreview";

const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";

function getElementByXPath(doc: Document, xpath: string): Element | null {
  try {
    const result = doc.evaluate(
      xpath,
      doc,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue as Element | null;
  } catch {
    return null;
  }
}

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

function createReplayableRuntimePreview(
  iframe: HTMLIFrameElement,
  baseUrl: string,
): string | null {
  try {
    const iframeDocument =
      iframe.contentDocument || iframe.contentWindow?.document;

    if (!iframeDocument?.documentElement) {
      return null;
    }

    return createReplayableRuntimePreviewFromHtml(
      iframeDocument.documentElement.outerHTML,
      baseUrl,
    );
  } catch {
    return null;
  }
}

function createReplayableRuntimePreviewFromHtml(
  htmlContent: string,
  baseUrl: string,
): string | null {
  try {
    const parser = new DOMParser();
    const iframeDocument = parser.parseFromString(htmlContent, "text/html");

    if (!iframeDocument?.documentElement) {
      return null;
    }

    const html = iframeDocument.documentElement.cloneNode(true);

    if (!(html instanceof HTMLElement)) {
      return null;
    }

    html.querySelectorAll("script").forEach((script) => {
      script.remove();
    });

    const head = html.querySelector("head");

    if (head) {
      head.querySelector("base")?.remove();

      const base = head.ownerDocument.createElement("base");
      base.setAttribute("href", baseUrl);
      head.prepend(base);
    }

    return `<!doctype html>\n${html.outerHTML}`;
  } catch {
    return null;
  }
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
  const scrollPositionRef = useRef({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);

  const targetScrollRef = useRef<{
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef(false);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isRecordingRef = useRef(false);
  const handlePreviewEventRef = useRef<((event: PreviewEvent) => void) | null>(
    null,
  );

  const {
    editorRef,
    handlePreviewEvent,
    registerPreviewStateGetter,
    registerPreviewStateApplier,
  } = useNextEditorActions();
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

  const { currentRecording, isPlaying, isRecording } = useNextEditorMetadata();
  const staticWorkspacePreview = useCompiledStaticWorkspacePreview();
  const recordedRuntimeSnapshot =
    isPlaying && !isRecording
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
  }, [effectiveRuntimePreviewUrl]);

  useEffect(() => {
    if (
      !registerPreviewStateGetter ||
      typeof registerPreviewStateGetter !== "function"
    ) {
      return;
    }

    registerPreviewStateGetter((): PreviewState => {
      const interaction = pendingInteractionRef.current;
      pendingInteractionRef.current = null;
      const content = isRuntimePreviewActive
        ? captureRuntimePreviewSnapshot() ||
          lastRuntimeSnapshotRef.current ||
          undefined
        : lastContentRef.current;

      return {
        size: sizeRef.current,
        content,
        scrollTop: scrollPositionRef.current.scrollTop,
        scrollLeft: scrollPositionRef.current.scrollLeft,
        currentInteraction: interaction || undefined,
      };
    });
  }, [
    captureRuntimePreviewSnapshot,
    isRuntimePreviewActive,
    registerPreviewStateGetter,
  ]);

  const updateIframeContent = useCallback(
    (content: string, options?: { force?: boolean }) => {
      if (!iframeRef.current || (isRuntimePreviewActive && !options?.force)) {
        return;
      }

      if (lastContentRef.current === content) {
        return;
      }
      lastContentRef.current = content;

      const iframe = iframeRef.current;

      try {
        iframe.removeAttribute("src");
        iframe.srcdoc = content;
      } catch (error) {
        console.error("Error updating iframe srcdoc:", error);
      }
    },
    [isRuntimePreviewActive],
  );

  const forceRefreshPreview = useCallback(
    (options?: {
      content?: string;
      emitEvent?: boolean;
      showSpinner?: boolean;
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
        if (!options?.emitEvent) {
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

  useEffect(() => {
    if (isPlaying || !isRuntimePreviewActive) {
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
  }, [captureRuntimePreviewSnapshot, isPlaying, isRuntimePreviewActive]);

  useEffect(() => {
    if (
      !registerPreviewStateApplier ||
      typeof registerPreviewStateApplier !== "function"
    ) {
      return;
    }

    registerPreviewStateApplier((previewState: PreviewState) => {
      let sizeToApply = previewState.size;

      if (typeof sizeToApply === "object") {
        sizeToApply = {
          width: Math.min(sizeToApply.width, window.innerWidth - 32),
          height: Math.min(sizeToApply.height, window.innerHeight - 96),
        };
      }

      if (!arePreviewSizesEqual(sizeToApply, sizeRef.current)) {
        setSize(sizeToApply);
      }

      const didRefreshKeyChange =
        previewState.refreshKey !== undefined &&
        previewState.refreshKey !== lastRefreshKeyRef.current;

      lastRefreshKeyRef.current = previewState.refreshKey;

      if (didRefreshKeyChange) {
        if (previewState.content !== undefined) {
          forceRefreshPreview({
            content: previewState.content,
            emitEvent: false,
          });
        } else if (effectiveRuntimePreviewUrl) {
          const staticFallback = staticWorkspacePreview;

          if (staticFallback) {
            forceRefreshPreview({
              content: staticFallback,
              emitEvent: false,
            });
          }
        }
      } else if (
        previewState.content !== undefined &&
        previewState.content !== lastContentRef.current
      ) {
        updateIframeContent(previewState.content, { force: true });
      }

      const iframe = iframeRef.current;
      if (!iframe || isRuntimePreviewActive) {
        return;
      }

      const iframeDoc =
        iframe.contentDocument || iframe.contentWindow?.document;
      const iframeWindow = iframe.contentWindow;
      if (!iframeDoc || !iframeWindow) {
        return;
      }

      if (
        previewState.scrollTop !== undefined ||
        previewState.scrollLeft !== undefined
      ) {
        const targetTop = previewState.scrollTop ?? 0;
        const targetLeft = previewState.scrollLeft ?? 0;

        if (isRecordingRef.current && isUserScrollingRef.current) {
          return;
        }

        targetScrollRef.current = {
          scrollTop: targetTop,
          scrollLeft: targetLeft,
        };

        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;

            const target = targetScrollRef.current;
            if (!target || !iframeRef.current) {
              return;
            }

            const iframe = iframeRef.current;
            const iframeDoc =
              iframe.contentDocument || iframe.contentWindow?.document;
            const iframeWindow = iframe.contentWindow;

            if (!iframeDoc || !iframeWindow) {
              return;
            }

            let scrollTarget: Element | Window = iframeWindow;

            if (
              previewState.currentInteraction?.type === "scroll" &&
              previewState.currentInteraction.data &&
              !previewState.currentInteraction.data.isDocument
            ) {
              const element = getElementByXPath(
                iframeDoc,
                previewState.currentInteraction.target.xpath,
              );
              if (element instanceof Element) {
                scrollTarget = element;
              }
            }

            let currentTop = 0;
            let currentLeft = 0;
            try {
              if (scrollTarget === iframeWindow) {
                currentTop =
                  iframeWindow.scrollY || iframeDoc.documentElement.scrollTop;
                currentLeft =
                  iframeWindow.scrollX || iframeDoc.documentElement.scrollLeft;
              } else if (scrollTarget instanceof Element) {
                currentTop = scrollTarget.scrollTop;
                currentLeft = scrollTarget.scrollLeft;
              }
            } catch (error: unknown) {
              console.warn("Failed to read scroll position:", error);
            }

            if (
              Math.abs(currentTop - target.scrollTop) > 0.1 ||
              Math.abs(currentLeft - target.scrollLeft) > 0.1
            ) {
              try {
                if (scrollTarget === iframeWindow) {
                  iframeWindow.scrollTo({
                    top: target.scrollTop,
                    left: target.scrollLeft,
                    behavior: "instant",
                  });
                } else if (scrollTarget instanceof Element) {
                  scrollTarget.scrollTo({
                    top: target.scrollTop,
                    left: target.scrollLeft,
                    behavior: "instant",
                  });
                }
              } catch (error: unknown) {
                console.warn("Failed to update scroll position:", error);
              }
            }
          });
        }
      }

      if (!previewState.currentInteraction) {
        return;
      }

      const interaction = previewState.currentInteraction;
      const element = getElementByXPath(
        iframeDoc,
        interaction.target.xpath,
      ) as HTMLElement | null;

      if (!element) {
        return;
      }

      const elementWithStyle = element as HTMLElement & { value?: string };
      const isElementWithStyle = !!elementWithStyle.style;
      const tagName = element.tagName.toLowerCase();

      if (!isElementWithStyle) {
        return;
      }

      switch (interaction.type) {
        case "click":
          elementWithStyle.style.setProperty(
            "--ring-color",
            "rgba(59, 130, 246, 0.5)",
          );
          elementWithStyle.style.boxShadow =
            "0 0 0 4px rgba(59, 130, 246, 0.5)";
          setTimeout(() => {
            elementWithStyle.style.removeProperty("--ring-color");
            elementWithStyle.style.boxShadow = "";
          }, 300);
          break;
        case "focus":
          elementWithStyle.focus();
          break;
        case "scroll":
          if (interaction.data?.scrollTop !== undefined) {
            elementWithStyle.scrollTop = interaction.data.scrollTop;
          }
          if (interaction.data?.scrollLeft !== undefined) {
            elementWithStyle.scrollLeft = interaction.data.scrollLeft;
          }
          break;
        case "input": {
          const isInput =
            tagName === "input" ||
            tagName === "textarea" ||
            elementWithStyle.isContentEditable;
          if (isInput && interaction.data?.value !== undefined) {
            elementWithStyle.value = interaction.data.value;
          }
          break;
        }
      }
    });
  }, [
    effectiveRuntimePreviewUrl,
    forceRefreshPreview,
    isRuntimePreviewActive,
    registerPreviewStateApplier,
    staticWorkspacePreview,
    updateIframeContent,
  ]);

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
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) {
          return;
        }

        const captureScript = `
          (function() {
            if (window.__INTERACTION_CAPTURE_SETUP__) return;
            window.__INTERACTION_CAPTURE_SETUP__ = true;
            
            function getXPath(element) {
              if (element.id) return '//*[@id="' + element.id + '"]';
              if (element === document.body) return '/html/body';
              const parent = element.parentElement;
              if (!parent) return '/' + element.tagName.toLowerCase();
              const siblings = Array.from(parent.children).filter(s => s.tagName === element.tagName);
              const index = siblings.indexOf(element) + 1;
              return getXPath(parent) + '/' + element.tagName.toLowerCase() + (siblings.length > 1 ? '[' + index + ']' : '');
            }

            function getTargetInfo(element) {
              return {
                tagName: element.tagName.toLowerCase(),
                id: element.id || undefined,
                className: element.className || undefined,
                xpath: getXPath(element)
              };
            }

            function emit(type, target, data) {
              window.parent.postMessage({
                type: 'IFRAME_INTERACTION',
                payload: {
                  type: type,
                  target: getTargetInfo(target),
                  targetTag: target.tagName,
                  data: data
                }
              }, '*');
            }

            document.addEventListener('click', (e) => {
              emit('click', e.target, { clientX: e.clientX, clientY: e.clientY, button: e.button });
            }, true);

            document.addEventListener('mouseenter', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_start', e.target, { clientX: e.clientX, clientY: e.clientY });
              }
            }, true);

            document.addEventListener('mouseleave', (e) => {
              if (e.target !== document.body && e.target instanceof Element) {
                emit('hover_end', e.target);
              }
            }, true);

            document.addEventListener('focus', (e) => {
              if (e.target instanceof Element) emit('focus', e.target);
            }, true);

            document.addEventListener('blur', (e) => {
              if (e.target instanceof Element) emit('blur', e.target);
            }, true);

            document.addEventListener('keydown', (e) => {
              if (e.target instanceof Element) emit('keydown', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('keyup', (e) => {
              if (e.target instanceof Element) emit('keyup', e.target, { key: e.key, code: e.code });
            }, true);

            document.addEventListener('input', (e) => {
              const tag = e.target.tagName.toLowerCase();
              if (tag === 'input' || tag === 'textarea') {
                emit('input', e.target, { value: e.target.value });
              }
            }, true);

            let scrollTicking = false;
            document.addEventListener('scroll', (e) => {
              if (scrollTicking) return;
              
              const target = e.target;
              scrollTicking = true;
              
              requestAnimationFrame(() => {
                if (target === document || target === window || target === document.body || target === document.documentElement) {
                  const doc = document.scrollingElement || document.documentElement;
                  emit('scroll', document.body, { 
                    scrollTop: doc.scrollTop, 
                    scrollLeft: doc.scrollLeft,
                    isDocument: true
                  });
                } else if (target instanceof Element) {
                  emit('scroll', target, { 
                    scrollTop: target.scrollTop, 
                    scrollLeft: target.scrollLeft,
                    isDocument: false
                  });
                }
                scrollTicking = false;
              });
            }, true);
          })();
        `;

        const scriptElement = iframeDoc.createElement("script");
        scriptElement.textContent = captureScript;
        if (iframeDoc.head) {
          iframeDoc.head.appendChild(scriptElement);
        } else {
          iframeDoc.documentElement.appendChild(scriptElement);
        }

        return () => undefined;
      } catch (error) {
        console.warn(
          "Cannot track interactions in iframe (likely cross-origin):",
          error,
        );
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
  }, [isRecording, isRuntimePreviewActive, size]);

  useEffect(() => {
    if (isPlaying) {
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
    isPlaying,
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
    if (isPlaying) {
      return;
    }

    const previousSaveVersion = previousSaveVersionRef.current;
    previousSaveVersionRef.current = saveVersion;

    if (previousSaveVersion === null || previousSaveVersion === saveVersion) {
      return;
    }

    forceRefreshPreview({ emitEvent: true });
  }, [forceRefreshPreview, isPlaying, saveVersion]);

  useEffect(() => {
    if (
      isPlaying ||
      runtimePreviewUrl ||
      isRuntimeManagedPreview ||
      isStaticWorkspacePreview
    ) {
      return;
    }

    const checkForEditor = () => {
      const editor = editorRef.current;
      if (!editor) {
        setTimeout(checkForEditor, 100);
        return;
      }

      if (!lastContentRef.current) {
        updateIframeContent(editor.getValue());
      }
    };

    checkForEditor();
  }, [
    editorRef,
    isPlaying,
    isRuntimeManagedPreview,
    isStaticWorkspacePreview,
    runtimePreviewUrl,
    updateIframeContent,
  ]);

  useEffect(() => {
    if (
      isPlaying ||
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
    isPlaying,
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
