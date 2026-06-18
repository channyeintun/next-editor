import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  PreviewDomainAdapter,
  PreviewPatchReplayInput,
} from "../../contexts/NextEditorDomainAdaptersContext";
import type {
  IframeInteractionEvent,
  PreviewPanelMode,
  PreviewSize,
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import { getElementByXPath, type PreviewScrollPosition } from "./previewIframeUtils";
import { clampCustomPreviewSize, isCustomPreviewSize } from "./previewSizeUtils";
import { buildRrwebReplayEvents, hasRrwebPreviewEvents } from "./rrwebPreview";
import { RrwebPreviewReplayer } from "./rrwebPreviewReplayer";

interface UsePreviewPlaybackRegistrationOptions {
  previewAdapter: PreviewDomainAdapter;
  captureRuntimePreviewSnapshot: () => string | null;
  isPlaybackPreviewActive: boolean;
  isRuntimePreviewActive: boolean;
  isLiveRuntimePreviewActive: boolean;
  hasPreviewPatchReplay: boolean;
  pendingInteractionRef: RefObject<IframeInteractionEvent | null>;
  lastRuntimeSnapshotRef: RefObject<string>;
  lastContentRef: RefObject<string>;
  scrollPositionRef: RefObject<PreviewScrollPosition>;
  routeRef: RefObject<string>;
  sizeRef: RefObject<PreviewSize>;
  isOpenRef: RefObject<boolean>;
  modeRef: RefObject<PreviewPanelMode>;
  effectiveRuntimePreviewUrl: string | null;
  staticWorkspacePreview: string;
  updateIframeContent: (
    content: string,
    options?: { force?: boolean; preserveDocument?: boolean },
  ) => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  setSize: Dispatch<SetStateAction<PreviewSize>>;
  applyPreviewRoute: (route: string) => void;
  applyPreviewPanelState: (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => void;
  lastRefreshKeyRef: RefObject<number | undefined>;
  isRecordingRef: RefObject<boolean>;
  isUserScrollingRef: RefObject<boolean>;
  targetScrollRef: RefObject<PreviewScrollPosition | null>;
  rafRef: RefObject<number | null>;
  replayContainerRef: RefObject<HTMLDivElement | null>;
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
  isPlaybackPreviewActive,
  isRuntimePreviewActive,
  isLiveRuntimePreviewActive,
  hasPreviewPatchReplay,
  pendingInteractionRef,
  lastRuntimeSnapshotRef,
  lastContentRef,
  scrollPositionRef,
  routeRef,
  sizeRef,
  isOpenRef,
  modeRef,
  effectiveRuntimePreviewUrl,
  staticWorkspacePreview,
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
}: UsePreviewPlaybackRegistrationOptions) {
  const targetScrollInteractionRef = useRef<IframeInteractionEvent | null>(null);
  // rrweb replay: the Replayer owns the recorded DOM + scroll + input in one
  // ordered stream, driven by `currentTime`. Rebuilt when the recording changes.
  const rrwebReplayerRef = useRef<RrwebPreviewReplayer | null>(null);
  const rrwebReplayRecordingIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (hasPreviewPatchReplay) {
      return;
    }

    rrwebReplayerRef.current?.destroy();
    rrwebReplayerRef.current = null;
    rrwebReplayRecordingIdRef.current = null;
  }, [hasPreviewPatchReplay]);

  // Tear down the rrweb Replayer when the preview unmounts.
  useEffect(
    () => () => {
      rrwebReplayerRef.current?.destroy();
      rrwebReplayerRef.current = null;
      rrwebReplayRecordingIdRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const applyRrwebReplay = (input: PreviewPatchReplayInput): number => {
      const container = replayContainerRef.current;
      if (!container) {
        // Container not mounted yet; retry on the next tick.
        return -1;
      }

      if (!rrwebReplayerRef.current || rrwebReplayRecordingIdRef.current !== input.recordingId) {
        rrwebReplayerRef.current?.destroy();
        rrwebReplayerRef.current = null;
        rrwebReplayRecordingIdRef.current = input.recordingId;

        const events = buildRrwebReplayEvents(input.initialDocuments, input.patchBatches);
        const baseTime = input.initialDocuments[0]?.time ?? 0;

        // rrweb needs at least a Meta + FullSnapshot to build the document.
        if (events.length >= 2) {
          try {
            rrwebReplayerRef.current = new RrwebPreviewReplayer({
              root: container,
              events,
              baseTime,
            });
          } catch (error) {
            console.warn("Failed to initialize rrweb preview replayer", error);
            rrwebReplayerRef.current = null;
          }
        }
      }

      rrwebReplayerRef.current?.seekToRecordingTime(input.currentTime);

      // Report the last batch at/before currentTime so the machine's change
      // detection keeps advancing the cursor.
      let cursor = -1;
      for (let index = 0; index < input.patchBatches.length; index++) {
        if (input.patchBatches[index].time > input.currentTime) {
          break;
        }
        cursor = index;
      }
      return cursor;
    };

    previewAdapter.setPatchReplayApplier((input) => {
      if (!hasPreviewPatchReplay || isLiveRuntimePreviewActive) {
        return input.lastAppliedPatchBatchIndex;
      }

      if (hasRrwebPreviewEvents(input.initialDocuments, input.patchBatches)) {
        return applyRrwebReplay(input);
      }

      // Runtime previews always record in the rrweb format; there is no other
      // runtime replay path.
      return -1;
    });

    return () => {
      previewAdapter.setPatchReplayApplier((input) => input.lastAppliedPatchBatchIndex);
    };
  }, [hasPreviewPatchReplay, isLiveRuntimePreviewActive, previewAdapter, replayContainerRef]);

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
        route: routeRef.current,
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
    routeRef,
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

      if (!isPlaybackPreviewActive) {
        return;
      }

      if (previewState.route !== undefined) {
        applyPreviewRoute(previewState.route);
      }

      const didRefreshKeyChange =
        previewState.refreshKey !== undefined &&
        previewState.refreshKey !== lastRefreshKeyRef.current;

      lastRefreshKeyRef.current = previewState.refreshKey;
      // Static / snapshot previews swap full HTML content. rrweb runtime replay
      // rebuilds from recorded events, so it must never have content forced in.
      const shouldApplySnapshotContent = !hasPreviewPatchReplay;

      if (shouldApplySnapshotContent && didRefreshKeyChange) {
        if (previewState.content !== undefined) {
          updateIframeContent(previewState.content, {
            force: true,
            preserveDocument: true,
          });
        } else if (effectiveRuntimePreviewUrl && staticWorkspacePreview) {
          updateIframeContent(staticWorkspacePreview, {
            force: true,
            preserveDocument: true,
          });
        }
      } else if (
        shouldApplySnapshotContent &&
        previewState.content !== undefined &&
        previewState.content !== lastContentRef.current
      ) {
        updateIframeContent(previewState.content, {
          force: true,
          preserveDocument: true,
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
    applyPreviewRoute,
    effectiveRuntimePreviewUrl,
    hasPreviewPatchReplay,
    iframeRef,
    isPlaybackPreviewActive,
    isLiveRuntimePreviewActive,
    isRecordingRef,
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
