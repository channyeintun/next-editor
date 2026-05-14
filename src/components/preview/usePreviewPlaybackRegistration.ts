import {
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { PreviewDomainAdapter } from "../../contexts/NextEditorDomainAdaptersContext";
import type {
  IframeInteractionEvent,
  PreviewSize,
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import {
  getElementByXPath,
  type PreviewScrollPosition,
} from "./previewIframeUtils";

interface PreviewRefreshOptions {
  content?: string;
  emitEvent?: boolean;
  showSpinner?: boolean;
}

interface UsePreviewPlaybackRegistrationOptions {
  previewAdapter: PreviewDomainAdapter;
  captureRuntimePreviewSnapshot: () => string | null;
  isRuntimePreviewActive: boolean;
  pendingInteractionRef: RefObject<IframeInteractionEvent | null>;
  lastRuntimeSnapshotRef: RefObject<string>;
  lastContentRef: RefObject<string>;
  scrollPositionRef: RefObject<PreviewScrollPosition>;
  sizeRef: RefObject<PreviewSize>;
  effectiveRuntimePreviewUrl: string | null;
  staticWorkspacePreview: string;
  forceRefreshPreview: (options?: PreviewRefreshOptions) => void;
  updateIframeContent: (content: string, options?: { force?: boolean }) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  setSize: Dispatch<SetStateAction<PreviewSize>>;
  lastRefreshKeyRef: RefObject<number | undefined>;
  isRecordingRef: RefObject<boolean>;
  isUserScrollingRef: RefObject<boolean>;
  targetScrollRef: RefObject<PreviewScrollPosition | null>;
  rafRef: RefObject<number | null>;
}

export function usePreviewPlaybackRegistration({
  previewAdapter,
  captureRuntimePreviewSnapshot,
  isRuntimePreviewActive,
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
}: UsePreviewPlaybackRegistrationOptions) {
  useEffect(() => {
    previewAdapter.setSnapshotGetter((): PreviewState => {
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

    return () => {
      previewAdapter.setSnapshotGetter(() => null);
    };
  }, [
    captureRuntimePreviewSnapshot,
    isRuntimePreviewActive,
    lastContentRef,
    lastRuntimeSnapshotRef,
    pendingInteractionRef,
    previewAdapter,
    scrollPositionRef,
    sizeRef,
  ]);

  useEffect(() => {
    previewAdapter.setSnapshotApplier((previewState: PreviewState) => {
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
        } else if (effectiveRuntimePreviewUrl && staticWorkspacePreview) {
          forceRefreshPreview({
            content: staticWorkspacePreview,
            emitEvent: false,
          });
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
      const tagName = element.tagName.toLowerCase();

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

    return () => {
      previewAdapter.setSnapshotApplier((_previewState) => undefined);
    };
  }, [
    effectiveRuntimePreviewUrl,
    forceRefreshPreview,
    iframeRef,
    isRecordingRef,
    isRuntimePreviewActive,
    isUserScrollingRef,
    lastContentRef,
    lastRefreshKeyRef,
    rafRef,
    previewAdapter,
    setSize,
    sizeRef,
    staticWorkspacePreview,
    targetScrollRef,
    updateIframeContent,
  ]);
}
