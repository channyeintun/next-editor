import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, type Transition } from "motion/react";
import {
  useNextEditorActions,
  useNextEditorMetadata,
} from "../hooks/useNextEditorContext";
import {
  useWorkspaceLessonType,
  useWorkspacePreviewVersion,
  useWorkspaceSaveVersion,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeMetadata } from "../hooks/useWebContainerRuntime";
import type { WebContainerRuntimeStatus } from "../contexts/WebContainerRuntimeContext";
import type {
  PreviewSize,
  PreviewState,
  PreviewEvent,
  IframeInteractionEvent,
} from "../types/slides";
import { arePreviewSizesEqual } from "../utils/equality";
import { useCompiledStaticWorkspacePreview } from "./preview/useCompiledStaticWorkspacePreview";

const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";

// ============================================================================
// XPath Utility
// ============================================================================

/**
 * Find element by XPath
 */
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

const Preview = memo(function Preview() {
  const [size, setSize] = useState<PreviewSize>("small");
  const [isTransitioning, setIsTransitioning] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lastContentRef = useRef<string>("");
  const lastRuntimeSnapshotRef = useRef<string>("");
  const scrollPositionRef = useRef<{ scrollTop: number; scrollLeft: number }>({
    scrollTop: 0,
    scrollLeft: 0,
  });
  const pendingInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const setupInteractionListenersRef = useRef<
    (() => (() => void) | undefined) | null
  >(null);
  const cleanupListenersRef = useRef<(() => void) | undefined>(undefined);

  // Refs for scroll throttling
  const targetScrollRef = useRef<{
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const isUserScrollingRef = useRef<boolean>(false);
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Refs to store latest recording state and handler (to bypass closure issues)
  const isRecordingRef = useRef<boolean>(false);
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
  const staticWorkspacePreview = useCompiledStaticWorkspacePreview();

  // Keep refs updated synchronously
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

  // Emit preview event
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

  // Emit interaction event

  // Handle messages from the iframe (postMessage approach)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Ensure the message is from our iframe
      if (event.source !== iframeRef.current?.contentWindow) return;

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

      if (type === "IFRAME_INTERACTION") {
        // Update scroll position if it's a scroll event on the main document
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
            // Mark as user scrolling to disable LERP temporarily (avoids fighting)
            isUserScrollingRef.current = true;
            if (userScrollTimeoutRef.current)
              clearTimeout(userScrollTimeoutRef.current);
            userScrollTimeoutRef.current = setTimeout(() => {
              isUserScrollingRef.current = false;
            }, 100);

            // Sync target rewf
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
        } else if (isRecordingRef.current && handlePreviewEventRef.current) {
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
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [effectiveRuntimePreviewUrl]); // size is used via sizeRef

  // Register preview state getter
  useEffect(() => {
    if (
      registerPreviewStateGetter &&
      typeof registerPreviewStateGetter === "function"
    ) {
      registerPreviewStateGetter((): PreviewState => {
        const interaction = pendingInteractionRef.current;
        pendingInteractionRef.current = null; // Consume the interaction
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
    }
  }, [
    captureRuntimePreviewSnapshot,
    isRuntimePreviewActive,
    registerPreviewStateGetter,
  ]); // size is used via sizeRef

  const updateIframeContent = useCallback(
    (content: string, options?: { force?: boolean }) => {
      if (!iframeRef.current || (isRuntimePreviewActive && !options?.force)) {
        return;
      }

      // Skip update if content hasn't changed
      if (lastContentRef.current === content) return;
      lastContentRef.current = content;

      const iframe = iframeRef.current;

      try {
        // Use srcdoc with the content directly (single HTML entry support)
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

          // Always try to include content for replay.
          // Fall back to static workspace preview if DOM snapshot is unavailable.
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

  // Register preview state applier (handles playback)
  useEffect(() => {
    if (
      registerPreviewStateApplier &&
      typeof registerPreviewStateApplier === "function"
    ) {
      registerPreviewStateApplier((previewState: PreviewState) => {
        let sizeToApply = previewState.size;

        // Clamp custom sizes to viewport to prevent overflow on mobile/small screens
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
            // If no static fallback available (e.g. React/JSX app), skip manual reload.
            // The workspace snapshot application will trigger WebContainer file sync
            // which will naturally cause the dev server to HMR/reload.
          }
        } else if (
          previewState.content !== undefined &&
          previewState.content !== lastContentRef.current
        ) {
          updateIframeContent(previewState.content, { force: true });
        }

        const iframe = iframeRef.current;
        if (!iframe || isRuntimePreviewActive) return;

        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        const iframeWindow = iframe.contentWindow;
        if (!iframeDoc || !iframeWindow) return;

        // Apply scroll position with LERP
        if (
          previewState.scrollTop !== undefined ||
          previewState.scrollLeft !== undefined
        ) {
          const targetTop = previewState.scrollTop ?? 0;
          const targetLeft = previewState.scrollLeft ?? 0;

          // If we are recording, don't fight the user's scroll
          if (isRecordingRef.current && isUserScrollingRef.current) {
            return;
          }

          // Update target
          targetScrollRef.current = {
            scrollTop: targetTop,
            scrollLeft: targetLeft,
          };

          // Apply in RAF to allow coalescing of rapid updates and match display refresh rate
          if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;

              const target = targetScrollRef.current;
              if (!target || !iframeRef.current) return;

              const iframe = iframeRef.current;
              const iframeDoc =
                iframe.contentDocument || iframe.contentWindow?.document;
              const iframeWindow = iframe.contentWindow;

              if (!iframeDoc || !iframeWindow) return;

              // Determine scroll target (window vs element)
              let scrollTarget: Element | Window = iframeWindow;

              if (
                previewState.currentInteraction?.type === "scroll" &&
                previewState.currentInteraction.data &&
                !previewState.currentInteraction.data.isDocument
              ) {
                const el = getElementByXPath(
                  iframeDoc,
                  previewState.currentInteraction.target.xpath,
                );
                if (el instanceof Element) scrollTarget = el;
              }

              // Get current scroll to check threshold
              let currentTop = 0;
              let currentLeft = 0;
              try {
                if (scrollTarget === iframeWindow) {
                  currentTop =
                    iframeWindow.scrollY || iframeDoc.documentElement.scrollTop;
                  currentLeft =
                    iframeWindow.scrollX ||
                    iframeDoc.documentElement.scrollLeft;
                } else if (scrollTarget instanceof Element) {
                  currentTop = scrollTarget.scrollTop;
                  currentLeft = scrollTarget.scrollLeft;
                }
              } catch (error: unknown) {
                console.warn("Failed to read scroll position:", error);
              }

              // Threshold check (0.1px) for efficiency
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

        // Apply interaction replay
        if (previewState.currentInteraction) {
          const interaction = previewState.currentInteraction;

          const element = getElementByXPath(
            iframeDoc,
            interaction.target.xpath,
          ) as HTMLElement | null;

          if (!element) return;

          // In an iframe, standard instanceof checks can fail because constructors belong to the iframe's window.
          // Since we've cast to HTMLElement, we can check for style presence.
          const elementWithStyle = element as HTMLElement & { value?: string };
          const isElementWithStyle = !!elementWithStyle.style;
          const tagName = element.tagName.toLowerCase();

          if (isElementWithStyle) {
            // Apply visual feedback based on interaction type
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
          }
        }
      });
    }
  }, [
    effectiveRuntimePreviewUrl,
    forceRefreshPreview,
    isRuntimePreviewActive,
    registerPreviewStateApplier,
    staticWorkspacePreview,
    updateIframeContent,
  ]);

  // Track all interaction events in iframe during recording
  useEffect(() => {
    if (!isRecording || isRuntimePreviewActive) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

    const setupInteractionListeners = () => {
      try {
        const iframeDoc =
          iframe.contentDocument || iframe.contentWindow?.document;
        if (!iframeDoc) return;

        // Self-contained capture script to be injected into the iframe
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

        const scriptEl = iframeDoc.createElement("script");
        scriptEl.textContent = captureScript;
        if (iframeDoc.head) {
          iframeDoc.head.appendChild(scriptEl);
        } else {
          iframeDoc.documentElement.appendChild(scriptEl);
        }

        return () => {
          // No clean cleanup needed as the script lives in the iframe document which gets destroyed
        };
      } catch (error) {
        console.warn(
          "Cannot track interactions in iframe (likely cross-origin):",
          error,
        );
        return undefined;
      }
    };

    // Store the setup function in ref so updateIframeContent can call it
    setupInteractionListenersRef.current = setupInteractionListeners;

    let cleanup: (() => void) | undefined;

    const handleIframeLoad = () => {
      cleanup?.();
      cleanup = setupInteractionListeners();
      cleanupListenersRef.current = cleanup;
    };

    iframe.addEventListener("load", handleIframeLoad);
    cleanup = setupInteractionListeners();
    cleanupListenersRef.current = cleanup;

    return () => {
      iframe.removeEventListener("load", handleIframeLoad);
      cleanup?.();
      setupInteractionListenersRef.current = null;
      cleanupListenersRef.current = undefined;
    };
  }, [isRecording, emitPreviewEvent, isRuntimePreviewActive, size]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) return;

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
    if (editor) {
      if (!lastContentRef.current) {
        updateIframeContent(editor.getValue());
      }
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

      // Initial update if not already set
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

  // Also ensure iframe loads properly
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
    if (!iframe) return;

    const handleIframeLoad = () => {
      const editor = editorRef.current;
      if (editor) {
        const content = editor.getValue();
        updateIframeContent(content);
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

  const isLarge = size === "large";
  const isMedium = size === "medium";
  const isSmall = size === "small";

  const getSizeClasses = () => {
    if (isLarge)
      return "shadow-2xl border border-black/10 transition-shadow z-[100]";
    if (isMedium)
      return "shadow-lg border border-gray-300 transition-shadow z-32";
    return "shadow-md border border-gray-300 cursor-pointer transition-shadow z-31";
  };

  const handleClick = () => {
    if (size === "small") {
      setSize("medium");
      emitPreviewEvent("preview_open", { newSize: "medium" });
    }
  };

  const handleMinimize = () => {
    setSize("small");
    emitPreviewEvent("preview_minimize", { newSize: "small" });
  };

  const handleMaximize = () => {
    const newSize = size === "large" ? "medium" : "large";
    setSize(newSize);
    emitPreviewEvent("preview_maximize", { newSize });
  };

  const [isRefreshing, setIsRefreshing] = useState(false);

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

  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = (e: React.MouseEvent | React.TouchEvent) => {
    // Only handle primary touch/click
    if ("button" in e && e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const getCoords = (
      ev: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent,
    ) => {
      if ("touches" in ev) {
        return { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
      }
      return { x: ev.clientX, y: ev.clientY };
    };

    const { x: startX, y: startY } = getCoords(e);

    const iframe = iframeRef.current;
    if (!iframe) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const startWidth = rect.width;
    const startHeight = rect.height;

    // Immediately set to custom size to prevent jump when switching from preset
    setSize({ width: startWidth, height: startHeight });

    let resizeRaf: number | null = null;
    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const { x: currentX, y: currentY } = getCoords(moveEvent);

      // Anchored at top-right, so dragging left increases width
      const deltaX = startX - currentX;
      const deltaY = currentY - startY;

      const maxWidth = window.innerWidth - 32; // 1rem padding right + 1rem padding left
      const maxHeight = window.innerHeight - 96; // 5rem top offset + small bottom padding

      const newWidth = Math.min(maxWidth, Math.max(160, startWidth + deltaX));
      const newHeight = Math.min(
        maxHeight,
        Math.max(120, startHeight + deltaY),
      );

      const newSize = { width: newWidth, height: newHeight };
      setSize(newSize);

      // Record resizing event during the drag for granular replay
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        emitPreviewEvent("preview_resize", { newSize });
      });
    };

    const onEnd = () => {
      setIsResizing(false);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      // One final emit to ensure accuracy
      emitPreviewEvent("preview_resize");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
  };

  const springTransition: Transition = {
    type: "spring",
    stiffness: 260,
    damping: 26,
    mass: 1,
  };

  const getPreviewVariants = () => {
    const base = {
      small: {
        top: "4rem",
        right: "1rem",
        width: "12rem",
        height: "8rem",
        left: "auto",
        bottom: "auto",
      },
      medium: {
        top: "5rem",
        right: "1rem",
        width: "20rem",
        height: "28rem",
        left: "auto",
        bottom: "auto",
      },
      large: {
        top: "10%",
        right: "10%",
        bottom: "10%",
        left: "10%",
        width: "80%",
        height: "80%",
      },
    };

    if (typeof size === "object") {
      return {
        ...base,
        custom: {
          top: "5rem",
          right: "1rem",
          width: `${size.width}px`,
          height: `${size.height}px`,
          left: "auto",
          bottom: "auto",
        },
      };
    }
    return base;
  };

  const variants = getPreviewVariants();
  const animateState = typeof size === "object" ? "custom" : size;

  const previewContent = (
    <>
      {/* Overlay for click-outside-to-minimize - only for large size */}
      <AnimatePresence>
        {isLarge && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-90 bg-black/10"
            onClick={handleMinimize}
          />
        )}
      </AnimatePresence>

      <motion.div
        variants={variants}
        initial={false}
        animate={animateState}
        transition={springTransition}
        ref={containerRef}
        onAnimationStart={() => setIsTransitioning(true)}
        onAnimationComplete={() => setIsTransitioning(false)}
        className={`fixed bg-white rounded-xl overflow-hidden flex flex-col ${getSizeClasses()} ${isSmall ? "hover:shadow-xl active:scale-95" : ""}`}
        onClick={(e) => {
          if (isSmall) {
            e.stopPropagation();
            handleClick();
          }
        }}
      >
        {/* Browser-style header */}
        <div className="flex items-center bg-gray-50 px-3 py-2 border-b border-gray-200">
          {/* Window controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMinimize();
              }}
              className="w-3 h-3 rounded-full bg-rose-400 hover:bg-rose-500 transition-colors flex items-center justify-center group"
              title="Minimize"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-rose-900/20 opacity-0 group-hover:opacity-100" />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMaximize();
              }}
              className="w-3 h-3 rounded-full bg-amber-400 hover:bg-amber-500 transition-colors flex items-center justify-center group"
              title={isLarge ? "Medium Size" : "Maximize"}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-amber-900/20 opacity-0 group-hover:opacity-100" />
            </button>
          </div>

          <div className="flex-1" />

          {/* Refresh button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefresh();
            }}
            className="p-1 rounded-md text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600 active:scale-95"
            title="Refresh Preview"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={isRefreshing ? "animate-spin" : ""}
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
        </div>

        <div className="relative flex-1">
          <iframe
            ref={iframeRef}
            className={`absolute inset-0 w-full h-full block border-0 bg-transparent align-middle ${isTransitioning || isResizing ? "pointer-events-none" : ""}`}
            title="Code Preview"
            sandbox="allow-scripts allow-same-origin"
          />

          {/* Resize handle */}
          <div
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            onDoubleClick={(e) => e.stopPropagation()}
            className="absolute bottom-0 left-0 w-10 h-10 cursor-sw-resize flex items-end justify-start z-50 group transition-colors touch-none"
            title="Drag to resize"
          >
            <div className="mb-2 ml-2 flex flex-col items-start gap-0.5">
              <div className="w-5 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-3.5 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-2 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
            </div>

            {/* Visual background triangle */}
            <svg
              className="absolute bottom-0 left-0 w-10 h-10 text-gray-200/50 group-hover:text-blue-500/20 transition-colors -z-10"
              viewBox="0 0 40 40"
            >
              <path d="M0 40 L40 40 L0 0 Z" fill="currentColor" />
            </svg>
          </div>
        </div>
      </motion.div>
    </>
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(previewContent, document.body);
});

export default Preview;
