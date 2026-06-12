import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { PreviewDomainAdapter } from "../../contexts/NextEditorDomainAdaptersContext";
import type {
  IframeInteractionEvent,
  PreviewPanelMode,
  PreviewSize,
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import { getElementByXPath, type PreviewScrollPosition } from "./previewIframeUtils";
import { clampCustomPreviewSize, isCustomPreviewSize } from "./previewSizeUtils";

interface PreviewRefreshOptions {
  content?: string;
  emitEvent?: boolean;
  showSpinner?: boolean;
}

interface UsePreviewPlaybackRegistrationOptions {
  previewAdapter: PreviewDomainAdapter;
  captureRuntimePreviewSnapshot: () => string | null;
  isRuntimePreviewActive: boolean;
  isLiveRuntimePreviewActive: boolean;
  pendingInteractionRef: RefObject<IframeInteractionEvent | null>;
  lastRuntimeSnapshotRef: RefObject<string>;
  lastContentRef: RefObject<string>;
  scrollPositionRef: RefObject<PreviewScrollPosition>;
  sizeRef: RefObject<PreviewSize>;
  isOpenRef: RefObject<boolean>;
  modeRef: RefObject<PreviewPanelMode>;
  effectiveRuntimePreviewUrl: string | null;
  staticWorkspacePreview: string;
  forceRefreshPreview: (options?: PreviewRefreshOptions) => void;
  updateIframeContent: (
    content: string,
    options?: { force?: boolean; preserveDocument?: boolean },
  ) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  setSize: Dispatch<SetStateAction<PreviewSize>>;
  applyPreviewPanelState: (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => void;
  lastRefreshKeyRef: RefObject<number | undefined>;
  isRecordingRef: RefObject<boolean>;
  isUserScrollingRef: RefObject<boolean>;
  targetScrollRef: RefObject<PreviewScrollPosition | null>;
  rafRef: RefObject<number | null>;
}

function getIframeDocumentAndWindow(iframe: HTMLIFrameElement): {
  iframeDoc: Document;
  iframeWindow: NonNullable<HTMLIFrameElement["contentWindow"]>;
} | null {
  try {
    const iframeWindow = iframe.contentWindow;
    const iframeDoc = iframe.contentDocument || iframeWindow?.document;

    if (!iframeDoc || !iframeWindow) {
      return null;
    }

    return {
      iframeDoc,
      iframeWindow,
    };
  } catch {
    return null;
  }
}

export function usePreviewPlaybackRegistration({
  previewAdapter,
  captureRuntimePreviewSnapshot,
  isRuntimePreviewActive,
  isLiveRuntimePreviewActive,
  pendingInteractionRef,
  lastRuntimeSnapshotRef,
  lastContentRef,
  scrollPositionRef,
  sizeRef,
  isOpenRef,
  modeRef,
  effectiveRuntimePreviewUrl,
  staticWorkspacePreview,
  forceRefreshPreview,
  updateIframeContent,
  iframeRef,
  setSize,
  applyPreviewPanelState,
  lastRefreshKeyRef,
  isRecordingRef,
  isUserScrollingRef,
  targetScrollRef,
  rafRef,
}: UsePreviewPlaybackRegistrationOptions) {
  const targetScrollInteractionRef = useRef<IframeInteractionEvent | null>(null);

  useEffect(() => {
    previewAdapter.setSnapshotGetter((): PreviewState | null => {
      if (!isOpenRef.current) {
        return null;
      }

      const interaction = pendingInteractionRef.current;
      pendingInteractionRef.current = null;
      const content = isRuntimePreviewActive
        ? captureRuntimePreviewSnapshot() || lastRuntimeSnapshotRef.current || undefined
        : lastContentRef.current;

      return {
        size: sizeRef.current,
        isOpen: isOpenRef.current,
        mode: modeRef.current,
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
    isOpenRef,
    lastContentRef,
    lastRuntimeSnapshotRef,
    modeRef,
    pendingInteractionRef,
    previewAdapter,
    scrollPositionRef,
    sizeRef,
  ]);

  useEffect(() => {
    previewAdapter.setSnapshotApplier((previewState: PreviewState) => {
      let sizeToApply = previewState.size;

      if (isCustomPreviewSize(sizeToApply)) {
        sizeToApply = clampCustomPreviewSize(sizeToApply, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
      }

      if (!arePreviewSizesEqual(sizeToApply, sizeRef.current)) {
        setSize(sizeToApply);
      }

      applyPreviewPanelState({
        isOpen: previewState.isOpen,
        mode: previewState.mode,
      });

      const didRefreshKeyChange =
        previewState.refreshKey !== undefined &&
        previewState.refreshKey !== lastRefreshKeyRef.current;

      lastRefreshKeyRef.current = previewState.refreshKey;

      if (didRefreshKeyChange) {
        if (previewState.content !== undefined) {
          if (isRuntimePreviewActive) {
            updateIframeContent(previewState.content, {
              force: true,
              preserveDocument: true,
            });
          } else {
            forceRefreshPreview({
              content: previewState.content,
              emitEvent: false,
            });
          }
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
        updateIframeContent(previewState.content, {
          force: true,
          preserveDocument: isRuntimePreviewActive,
        });
      }

      const iframe = iframeRef.current;
      if (!iframe || isLiveRuntimePreviewActive) {
        return;
      }

      const iframeState = getIframeDocumentAndWindow(iframe);
      if (!iframeState) {
        return;
      }

      const { iframeDoc } = iframeState;

      if (previewState.scrollTop !== undefined || previewState.scrollLeft !== undefined) {
        const targetTop = previewState.scrollTop ?? 0;
        const targetLeft = previewState.scrollLeft ?? 0;

        if (isRecordingRef.current && isUserScrollingRef.current) {
          return;
        }

        targetScrollRef.current = {
          scrollTop: targetTop,
          scrollLeft: targetLeft,
        };
        targetScrollInteractionRef.current =
          previewState.currentInteraction?.type === "scroll"
            ? previewState.currentInteraction
            : null;

        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;

            const target = targetScrollRef.current;
            if (!target || !iframeRef.current) {
              return;
            }

            const iframe = iframeRef.current;
            const iframeState = getIframeDocumentAndWindow(iframe);

            if (!iframeState) {
              return;
            }

            const { iframeDoc, iframeWindow } = iframeState;

            let scrollTarget: Element | Window = iframeWindow;
            const targetInteraction = targetScrollInteractionRef.current;

            if (
              targetInteraction?.type === "scroll" &&
              targetInteraction.data &&
              !targetInteraction.data.isDocument
            ) {
              const element = getElementByXPath(iframeDoc, targetInteraction.target.xpath);
              if (element instanceof Element) {
                scrollTarget = element;
              }
            }

            let currentTop = 0;
            let currentLeft = 0;
            try {
              if (scrollTarget === iframeWindow) {
                currentTop = iframeWindow.scrollY || iframeDoc.documentElement.scrollTop;
                currentLeft = iframeWindow.scrollX || iframeDoc.documentElement.scrollLeft;
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
      const element = getElementByXPath(iframeDoc, interaction.target.xpath) as HTMLElement | null;

      if (!element) {
        return;
      }

      const elementWithStyle = element as HTMLElement & { value?: string };
      const tagName = element.tagName.toLowerCase();

      switch (interaction.type) {
        case "click":
          elementWithStyle.style.setProperty("--ring-color", "rgba(59, 130, 246, 0.5)");
          elementWithStyle.style.boxShadow = "0 0 0 4px rgba(59, 130, 246, 0.5)";
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
            tagName === "input" || tagName === "textarea" || elementWithStyle.isContentEditable;
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
    applyPreviewPanelState,
    effectiveRuntimePreviewUrl,
    forceRefreshPreview,
    iframeRef,
    isLiveRuntimePreviewActive,
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
