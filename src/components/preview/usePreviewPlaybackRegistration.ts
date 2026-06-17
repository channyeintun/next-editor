import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  PreviewDomainAdapter,
  PreviewPatchReplayInput,
} from "../../contexts/NextEditorDomainAdaptersContext";
import type {
  IframeInteractionEvent,
  PreviewInitialDocument,
  PreviewPanelMode,
  PreviewSize,
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import {
  applyPreviewDomPatchBatchToIframe,
  applyPreviewInitialDocumentToIframe,
  getElementByXPath,
  type PreviewScrollPosition,
} from "./previewIframeUtils";
import { clampCustomPreviewSize, isCustomPreviewSize } from "./previewSizeUtils";

interface PreviewPatchReplayCursor {
  recordingId: string | null;
  documentId: string | null;
  revision: number;
  lastAppliedBatchIndex: number;
}

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

function getLatestInitialDocument(
  initialDocuments: PreviewInitialDocument[],
  currentTime: number,
  documentId?: string,
): PreviewInitialDocument | null {
  let latestDocument: PreviewInitialDocument | null = null;

  for (const initialDocument of initialDocuments) {
    if (initialDocument.time > currentTime) {
      continue;
    }

    if (documentId && initialDocument.documentId !== documentId) {
      continue;
    }

    if (!latestDocument || initialDocument.time >= latestDocument.time) {
      latestDocument = initialDocument;
    }
  }

  return latestDocument;
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
}: UsePreviewPlaybackRegistrationOptions) {
  const targetScrollInteractionRef = useRef<IframeInteractionEvent | null>(null);
  const patchReplayCursorRef = useRef<PreviewPatchReplayCursor>({
    recordingId: null,
    documentId: null,
    revision: 0,
    lastAppliedBatchIndex: -1,
  });
  const patchReplayFailedRef = useRef(false);
  // Deduplicates desync logging: a persistent desync should warn once, not once
  // per timeline tick. Cleared whenever patch replay reaches a healthy state so
  // a later, distinct desync warns again.
  const patchReplayDesyncLoggedRef = useRef(false);
  // O(1) marker-id -> element cache for the active replay document, passed into
  // the apply engine so ref lookups don't re-scan the DOM each op. Cleared on
  // every (re)seed because it replaces the document.
  const patchReplayNodeIndexRef = useRef<Map<string, Element>>(new Map());
  // One-shot drift recovery: when best-effort apply skips ops, re-seed and
  // fast-forward once to restore the canonical DOM for the current time.
  // `resyncAttempted` bounds it so a deterministic skip can't reseed every tick.
  const patchReplayDriftRef = useRef(false);
  const patchReplayResyncAttemptedRef = useRef(false);

  useEffect(() => {
    if (hasPreviewPatchReplay) {
      return;
    }

    patchReplayFailedRef.current = false;
    patchReplayDesyncLoggedRef.current = false;
    patchReplayDriftRef.current = false;
    patchReplayResyncAttemptedRef.current = false;
    patchReplayNodeIndexRef.current.clear();
    patchReplayCursorRef.current = {
      recordingId: null,
      documentId: null,
      revision: 0,
      lastAppliedBatchIndex: -1,
    };
  }, [hasPreviewPatchReplay]);

  useEffect(() => {
    const applyInitialDocument = (
      iframe: HTMLIFrameElement,
      input: PreviewPatchReplayInput,
      initialDocument: PreviewInitialDocument,
    ) => {
      if (!applyPreviewInitialDocumentToIframe(iframe, initialDocument)) {
        patchReplayFailedRef.current = true;
        return false;
      }

      lastContentRef.current = initialDocument.html;
      patchReplayFailedRef.current = false;
      // A fresh seed is a clean slate: re-enable one-shot desync logging and
      // drop the stale node-id cache (the document was just replaced).
      patchReplayDesyncLoggedRef.current = false;
      patchReplayNodeIndexRef.current.clear();
      patchReplayCursorRef.current = {
        recordingId: input.recordingId,
        documentId: initialDocument.documentId,
        revision: 0,
        lastAppliedBatchIndex: -1,
      };
      return true;
    };

    const ensureReplaySeed = (iframe: HTMLIFrameElement, input: PreviewPatchReplayInput) => {
      // A seek starts a fresh drift episode: allow a recovery attempt again.
      if (input.isSeeking) {
        patchReplayResyncAttemptedRef.current = false;
      }

      const driftResync = patchReplayDriftRef.current;
      const cursor = patchReplayCursorRef.current;
      const needsSeed =
        input.isSeeking ||
        // After a desync, re-seed from the nearest initial document and replay
        // forward instead of looping on the same failing batch forever.
        patchReplayFailedRef.current ||
        // Best-effort apply skipped ops last pass: re-seed + fast-forward once to
        // restore the canonical DOM (bounded by `resyncAttempted`).
        driftResync ||
        cursor.recordingId !== input.recordingId ||
        cursor.documentId === null ||
        input.lastAppliedPatchBatchIndex < cursor.lastAppliedBatchIndex;

      if (!needsSeed) {
        return true;
      }

      if (driftResync) {
        // Consume the one-shot so a still-failing fast-forward can't reseed every
        // tick; it re-arms only after a fully clean pass (or a seek).
        patchReplayDriftRef.current = false;
        patchReplayResyncAttemptedRef.current = true;
      }

      const initialDocument = getLatestInitialDocument(input.initialDocuments, input.currentTime);

      if (!initialDocument) {
        patchReplayFailedRef.current = true;
        return false;
      }

      return applyInitialDocument(iframe, input, initialDocument);
    };

    previewAdapter.setPatchReplayApplier((input) => {
      if (!hasPreviewPatchReplay || isLiveRuntimePreviewActive) {
        return input.lastAppliedPatchBatchIndex;
      }

      const iframe = iframeRef.current;
      if (!iframe || !ensureReplaySeed(iframe, input)) {
        return -1;
      }

      let cursor = patchReplayCursorRef.current;
      let passSkippedOps = false;

      for (
        let index = cursor.lastAppliedBatchIndex + 1;
        index < input.patchBatches.length;
        index++
      ) {
        const patchBatch = input.patchBatches[index];

        if (patchBatch.time > input.currentTime) {
          break;
        }

        if (patchBatch.documentId !== cursor.documentId) {
          const initialDocument = getLatestInitialDocument(
            input.initialDocuments,
            input.currentTime,
            patchBatch.documentId,
          );

          if (!initialDocument || !applyInitialDocument(iframe, input, initialDocument)) {
            patchReplayFailedRef.current = true;
            return cursor.lastAppliedBatchIndex;
          }

          cursor = patchReplayCursorRef.current;
        }

        if (patchBatch.baseRevision !== cursor.revision) {
          if (!patchReplayDesyncLoggedRef.current) {
            console.warn("Preview patch replay revision mismatch", {
              documentId: patchBatch.documentId,
              expected: cursor.revision,
              received: patchBatch.baseRevision,
            });
            patchReplayDesyncLoggedRef.current = true;
          }
          patchReplayFailedRef.current = true;
          return cursor.lastAppliedBatchIndex;
        }

        const result = applyPreviewDomPatchBatchToIframe(
          iframe,
          patchBatch,
          patchReplayNodeIndexRef.current,
        );

        if (!result.ok) {
          // Only a fatal condition (iframe document missing / cross-origin)
          // halts replay. Re-seed next tick and let snapshot content take over.
          if (!patchReplayDesyncLoggedRef.current) {
            console.warn(
              `Preview patch replay halted: ${result.error ?? "unknown"} ` +
                `(batch=${index}, documentId=${patchBatch.documentId})`,
            );
            patchReplayDesyncLoggedRef.current = true;
          }
          patchReplayFailedRef.current = true;
          return cursor.lastAppliedBatchIndex;
        }

        if (result.failedOps > 0) {
          passSkippedOps = true;

          if (!patchReplayDesyncLoggedRef.current) {
            const failedOp = patchBatch.ops[result.firstFailedOpIndex ?? -1]?.op ?? "?";
            console.warn(
              `Preview patch replay skipped ${result.failedOps} op(s): ${result.error ?? "unknown"} ` +
                `(op=${failedOp}, batch=${index}, opIndex=${result.firstFailedOpIndex}, ` +
                `documentId=${patchBatch.documentId})`,
            );
            patchReplayDesyncLoggedRef.current = true;
          }
        }

        // Advance even when some ops were skipped: a single unresolved node must
        // not freeze the whole preview.
        cursor = {
          recordingId: input.recordingId,
          documentId: patchBatch.documentId,
          revision: patchBatch.revision,
          lastAppliedBatchIndex: index,
        };
        patchReplayCursorRef.current = cursor;
      }

      if (passSkippedOps) {
        // Arm a single re-seed + fast-forward next tick to restore the canonical
        // DOM. Skipped only if we already tried this episode (avoids a per-tick
        // reseed loop on a deterministic skip).
        if (!patchReplayResyncAttemptedRef.current) {
          patchReplayDriftRef.current = true;
        }
      } else {
        // Clean pass: healthy again, so re-arm drift recovery for the future.
        patchReplayDriftRef.current = false;
        patchReplayResyncAttemptedRef.current = false;
      }

      patchReplayFailedRef.current = false;
      return patchReplayCursorRef.current.lastAppliedBatchIndex;
    });

    return () => {
      previewAdapter.setPatchReplayApplier((input) => input.lastAppliedPatchBatchIndex);
    };
  }, [
    hasPreviewPatchReplay,
    iframeRef,
    isLiveRuntimePreviewActive,
    lastContentRef,
    previewAdapter,
  ]);

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
      const shouldApplySnapshotContent = !hasPreviewPatchReplay || patchReplayFailedRef.current;

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
