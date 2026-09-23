import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type {
  PreviewAdapterHandle,
  PreviewPatchReplayInput,
} from "../../stores/previewAdapterHandle";
import type {
  ApiClientReplayState,
  ApiClientRequestTab,
  IframeInteractionEvent,
  PreviewActiveMode,
  PreviewPanelMode,
  PreviewSize,
  PreviewState,
} from "../../types/slides";
import { arePreviewSizesEqual } from "../../utils/equality";
import type { PreviewScrollPosition } from "./previewIframeUtils";
import { clampCustomPreviewSize, isCustomPreviewSize } from "./previewSizeUtils";
import { buildRrwebReplayEvents, hasRrwebPreviewSeed } from "./rrwebPreview";
import { createRrwebPreviewReplayer, type RrwebPreviewReplayer } from "./rrwebPreviewReplayer";

interface UsePreviewPlaybackRegistrationOptions {
  previewHandle: PreviewAdapterHandle;
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
  updateIframeContent: (content: string, options?: { force?: boolean }) => void;
  setSize: Dispatch<SetStateAction<PreviewSize>>;
  applyPreviewRoute: (route: string) => void;
  applyPreviewPanelState: (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => void;
  lastRefreshKeyRef: RefObject<number | undefined>;
  replayContainerRef: RefObject<HTMLDivElement | null>;
  onActiveModeChange?: (mode: PreviewActiveMode) => void;
  onRequestTabChange?: (tab: ApiClientRequestTab) => void;
  onApiClientStateChange?: (state: ApiClientReplayState) => void;
}

export function usePreviewPlaybackRegistration({
  previewHandle,
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
  updateIframeContent,
  setSize,
  applyPreviewRoute,
  applyPreviewPanelState,
  lastRefreshKeyRef,
  replayContainerRef,
  onActiveModeChange,
  onRequestTabChange,
  onApiClientStateChange,
}: UsePreviewPlaybackRegistrationOptions) {
  // rrweb replay: the Replayer owns the recorded DOM + scroll + input in one
  // ordered stream, driven by `currentTime`. Rebuilt when the recording changes.
  const rrwebReplayerRef = useRef<RrwebPreviewReplayer | null>(null);
  const rrwebReplayRecordingIdRef = useRef<string | null>(null);
  const rrwebReplayLoadGenerationRef = useRef(0);
  const rrwebReplayLoadStateRef = useRef<"idle" | "loading" | "ready" | "failed">("idle");
  const rrwebReplayPendingTimeRef = useRef(0);
  // The element the current Replayer is mounted in. If it changes (React remounted
  // the replay container), the old Replayer's iframe is orphaned and we must rebuild
  // into the new element.
  const rrwebReplayContainerElRef = useRef<HTMLElement | null>(null);
  // How much of the stream the current Replayer was built from. Recordings load
  // as a streaming prefix — `appendRecordingDelta` pushes new batches onto the
  // same array under the same recording id — so without these the Replayer built
  // from the first playable prefix was never rebuilt, and every batch decoded
  // afterwards was silently dropped while the cursor kept advancing.
  const rrwebReplayBuiltInitialDocCountRef = useRef(0);
  const rrwebReplayBuiltPatchBatchCountRef = useRef(0);

  useEffect(() => {
    if (hasPreviewPatchReplay && !isLiveRuntimePreviewActive) {
      return;
    }

    rrwebReplayLoadGenerationRef.current += 1;
    rrwebReplayLoadStateRef.current = "idle";
    rrwebReplayerRef.current?.destroy();
    rrwebReplayerRef.current = null;
    rrwebReplayRecordingIdRef.current = null;
    rrwebReplayContainerElRef.current = null;
  }, [hasPreviewPatchReplay, isLiveRuntimePreviewActive]);

  // Tear down the rrweb Replayer when the preview unmounts.
  useEffect(
    () => () => {
      rrwebReplayLoadGenerationRef.current += 1;
      rrwebReplayLoadStateRef.current = "idle";
      rrwebReplayerRef.current?.destroy();
      rrwebReplayerRef.current = null;
      rrwebReplayRecordingIdRef.current = null;
      rrwebReplayContainerElRef.current = null;
      rrwebReplayBuiltInitialDocCountRef.current = 0;
      rrwebReplayBuiltPatchBatchCountRef.current = 0;
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

      // Only rebuild for growth once the current Replayer is actually ready:
      // mid-load, the in-flight build is already picking up a longer prefix, and
      // restarting it on every delta would never finish.
      const streamGrew =
        rrwebReplayLoadStateRef.current === "ready" &&
        (input.initialDocuments.length > rrwebReplayBuiltInitialDocCountRef.current ||
          input.patchBatches.length > rrwebReplayBuiltPatchBatchCountRef.current);

      const needsRebuild =
        rrwebReplayRecordingIdRef.current !== input.recordingId ||
        rrwebReplayContainerElRef.current !== container ||
        streamGrew;

      if (needsRebuild) {
        rrwebReplayLoadGenerationRef.current += 1;
        rrwebReplayLoadStateRef.current = "idle";
        rrwebReplayerRef.current?.destroy();
        rrwebReplayerRef.current = null;
        rrwebReplayRecordingIdRef.current = input.recordingId;
        rrwebReplayContainerElRef.current = container;
        // Drop any orphaned wrapper (e.g. from a Replayer whose ref was lost) so a
        // rebuild can never leave two iframes stacked in the container.
        container.replaceChildren();
      }

      rrwebReplayPendingTimeRef.current = input.currentTime;

      if (!rrwebReplayerRef.current && rrwebReplayLoadStateRef.current === "idle") {
        const events = buildRrwebReplayEvents(input.initialDocuments, input.patchBatches);
        rrwebReplayBuiltInitialDocCountRef.current = input.initialDocuments.length;
        rrwebReplayBuiltPatchBatchCountRef.current = input.patchBatches.length;

        // rrweb needs at least a Meta + FullSnapshot to build the document.
        if (events.length >= 2) {
          const loadGeneration = ++rrwebReplayLoadGenerationRef.current;
          rrwebReplayLoadStateRef.current = "loading";
          void createRrwebPreviewReplayer({ root: container, events })
            .then((replayer) => {
              if (
                rrwebReplayLoadGenerationRef.current !== loadGeneration ||
                rrwebReplayRecordingIdRef.current !== input.recordingId ||
                rrwebReplayContainerElRef.current !== container
              ) {
                replayer.destroy();
                return;
              }

              rrwebReplayLoadStateRef.current = "ready";
              rrwebReplayerRef.current = replayer;
              replayer.seekToRecordingTime(rrwebReplayPendingTimeRef.current);
            })
            .catch((error: unknown) => {
              if (rrwebReplayLoadGenerationRef.current !== loadGeneration) {
                return;
              }
              rrwebReplayLoadStateRef.current = "failed";
              console.warn("Failed to initialize rrweb preview replayer", error);
            });
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

    previewHandle.patchReplayApplier.current = (input) => {
      if (!hasPreviewPatchReplay || isLiveRuntimePreviewActive) {
        return input.lastAppliedPatchBatchIndex;
      }

      if (hasRrwebPreviewSeed(input.initialDocuments)) {
        return applyRrwebReplay(input);
      }

      // Runtime previews always record in the rrweb format; there is no other
      // runtime replay path.
      return -1;
    };

    return () => {
      previewHandle.patchReplayApplier.current = null;
    };
  }, [hasPreviewPatchReplay, isLiveRuntimePreviewActive, previewHandle, replayContainerRef]);

  useEffect(() => {
    previewHandle.snapshotGetter.current = (): PreviewState | null => {
      if (!isOpenRef.current) {
        return null;
      }

      const interaction = pendingInteractionRef.current;
      pendingInteractionRef.current = null;
      const content = isRuntimePreviewActive
        ? lastRuntimeSnapshotRef.current || undefined
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
    };

    return () => {
      previewHandle.snapshotGetter.current = null;
    };
  }, [
    isRuntimePreviewActive,
    isOpenRef,
    lastContentRef,
    lastRuntimeSnapshotRef,
    modeRef,
    pendingInteractionRef,
    previewHandle,
    routeRef,
    scrollPositionRef,
    sizeRef,
  ]);

  useEffect(() => {
    previewHandle.snapshotApplier.current = (previewState: PreviewState) => {
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

      if (previewState.activeMode !== undefined) {
        onActiveModeChange?.(previewState.activeMode);
      }

      if (previewState.requestTab !== undefined) {
        onRequestTabChange?.(previewState.requestTab);
      }

      if (previewState.apiClientState !== undefined) {
        onApiClientStateChange?.(previewState.apiClientState);
      }

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
      // Snapshot-fallback playback swaps in the recorded HTML. rrweb replay rebuilds
      // from recorded events, so it must never have content forced in. The frame
      // is sandboxed without allow-same-origin during playback (recorded HTML is
      // foreign), so its document cannot be reached from here: content is the
      // only thing this can replay, by replacing the srcdoc.
      if (
        !hasPreviewPatchReplay &&
        previewState.content !== undefined &&
        (didRefreshKeyChange || previewState.content !== lastContentRef.current)
      ) {
        updateIframeContent(previewState.content, { force: true });
      }
    };

    return () => {
      previewHandle.snapshotApplier.current = null;
    };
  }, [
    applyPreviewPanelState,
    applyPreviewRoute,
    hasPreviewPatchReplay,
    isPlaybackPreviewActive,
    lastContentRef,
    lastRefreshKeyRef,
    previewHandle,
    setSize,
    sizeRef,
    updateIframeContent,
  ]);
}
