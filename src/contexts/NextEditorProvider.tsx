import { useRef, useEffect } from "react";
import type * as monaco from "monaco-editor";
import type { Recording, UseNextEditorConfig } from "../core/src";
import {
  useNextEditorActorActions,
  useNextEditorInteractionEffects,
} from "../core/src/useNextEditor";
import { NextEditorActionsContext } from "./NextEditorContext";
import { NextEditorActorContext } from "./NextEditorActorContext";
import { usePreviewAdapterHandle } from "./PreviewAdapterHandleContext";
import { useSlidesStore } from "./SlidesStoreContext";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import { useRuntimePanelStore } from "./RuntimePanelStoreContext";
import { selectRecordingState } from "../stores/runtimePanelStore";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { useRecordingStreamSink } from "../hooks/useRecordingStreamSink";
import { createRecordingStorage } from "../storage/RecordingStorage";
import { saveScreenRecordingLocally } from "../storage/screenRecordingSave";
import type { RuntimeRecordingSnapshot } from "../types/runtime";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";
import { getAgentStore } from "../agent/agentStore";

interface NextEditorProviderProps {
  children: React.ReactNode;
}

interface NextEditorProviderContentProps {
  children: React.ReactNode;
  config: UseNextEditorConfig;
  recordingStorage: { current: ReturnType<typeof createRecordingStorage> };
  suppressWorkspaceEventsRef: { current: boolean };
}

const NextEditorProviderContent: React.FC<NextEditorProviderContentProps> = ({
  children,
  config,
  recordingStorage,
  suppressWorkspaceEventsRef,
}) => {
  const actorRef = NextEditorActorContext.useActorRef();
  // Subscription-free senders + side effects only: the provider dispatches events but
  // never reads machine state, so it must not re-render on state transitions.
  const {
    clearRecording,
    startRecording,
    stopRecording: stopRecordingImmediately,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    extendRecording,
    appendRecordingDelta,
    addCaptionTrack,
    removeCaptionTrack,
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent: handleWorkspaceEventBase,
    handleRuntimeEvent,
    handleWhiteboardEvent,
    handleChatEvent,
  } = useNextEditorActorActions(actorRef);
  useNextEditorInteractionEffects(actorRef, config);
  const previewHandle = usePreviewAdapterHandle();
  const stopRecordingPromiseRef = useRef<Promise<void> | null>(null);

  const stopRecording = () => {
    if (stopRecordingPromiseRef.current) {
      return stopRecordingPromiseRef.current;
    }

    const request = (async () => {
      try {
        await previewHandle.recordingStopPreparer.current?.();
      } finally {
        try {
          stopRecordingImmediately();
        } finally {
          stopRecordingPromiseRef.current = null;
        }
      }
    })();
    stopRecordingPromiseRef.current = request;
    return request;
  };

  // Opt-in: forward the live SCR3 recording stream to a configured sink (inert if absent).
  useRecordingStreamSink(actorRef, config.recordingStreamSink);

  // Stabilize storage and registration methods
  const exportAsFile = (recording: Recording, filename?: string) =>
    recordingStorage.current.exportAsFile(recording, filename);
  const importFromFile = () => recordingStorage.current.importFromFile();
  const clearStorage = () => recordingStorage.current.clear();
  const getStorageStats = () => recordingStorage.current.getStats();
  const deleteFromStorage = (id: string) => recordingStorage.current.delete(id);

  // Library UIs should render from this metadata list — cheap, no stream/media decode — and
  // call `loadStoredRecordingById` only for the entry the user actually opens.
  const listStoredRecordings = () => recordingStorage.current.list();
  const loadStoredRecordingById = async (id: string) => {
    const recording = await recordingStorage.current.loadById(id);
    if (!recording) {
      console.warn(`Failed to load stored recording ${id}: entry missing or undecodable`);
    }
    return recording;
  };

  const handleWorkspaceEvent = (event?: {
    sidebarWidthDelta?: number;
    previewDockWidthDelta?: number;
  }) => {
    if (suppressWorkspaceEventsRef.current) {
      return;
    }

    handleWorkspaceEventBase(event);
  };

  const actionsValue = {
    editorRef: config.editorRef,
    syncEditorRef,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    extendRecording,
    appendRecordingDelta,
    addCaptionTrack,
    removeCaptionTrack,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent,
    handleRuntimeEvent,
    handleWhiteboardEvent,
    handleChatEvent,
    clearRecording,
    exportAsFile,
    importFromFile,
    clearStorage,
    getStorageStats,
    listStoredRecordings,
    loadStoredRecordingById,
    deleteFromStorage,
  };

  return <NextEditorActionsContext value={actionsValue}>{children}</NextEditorActionsContext>;
};

export const NextEditorProvider: React.FC<NextEditorProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const recordingStorage = useRef(createRecordingStorage());
  const previewHandle = usePreviewAdapterHandle();
  const { store: slidesStore } = useSlidesStore();
  const { store: whiteboardStore } = useWhiteboardStore();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const {
    getProject,
    getActiveFilePath,
    getCollapsedFolders,
    getSidebarScrollTop,
    getSidebarWidth,
    getSidebarCollapsed,
    loadProject,
    setSidebarWidth,
    startSidebarCollapsed,
  } = useWorkspaceActions();
  const saveRuntimeWorkspace = useWebContainerRuntimeSaveWorkspace();
  const getRuntimeRecordingSnapshot = useWebContainerRuntimeSnapshotGetter();
  const workspaceSnapshotRef = useRef<WorkspaceRecordingSnapshot | null>(null);
  const suppressWorkspaceEventsRef = useRef(false);
  const clearWorkspaceEventSuppressionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
        window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
      }
    };
  }, []);

  const suppressWorkspaceEvents = () => {
    suppressWorkspaceEventsRef.current = true;

    if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
      window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
    }

    clearWorkspaceEventSuppressionTimeoutRef.current = window.setTimeout(() => {
      suppressWorkspaceEventsRef.current = false;
      clearWorkspaceEventSuppressionTimeoutRef.current = null;
    }, 0);
  };

  const config: UseNextEditorConfig = {
    editorRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    pauseOnUserInteraction: true,
    getSlideState: () => {
      const { slides, previewState } = slidesStore.getSnapshot().context;
      const currentSlideIndex = Math.max(
        0,
        slides.findIndex((s) => s.id === previewState.currentSlideId),
      );
      return { previewState, currentSlideIndex };
    },
    applySlideState: (slideState) => {
      const { previewState: prev } = slidesStore.getSnapshot().context;

      const nextIsOpen = slideState.isOpen;
      const nextIsMaximized = slideState.isMaximized ?? prev.isMaximized ?? false;
      const nextSlideId = slideState.currentSlideId ?? prev.currentSlideId ?? null;
      const nextIndexv = slideState.indexv ?? prev.indexv ?? 0;
      const nextInteraction = slideState.currentInteraction;

      if (
        nextIsOpen !== prev.isOpen ||
        nextIsMaximized !== prev.isMaximized ||
        nextSlideId !== prev.currentSlideId ||
        nextIndexv !== prev.indexv ||
        nextInteraction !== prev.currentInteraction
      ) {
        slidesStore.trigger.setPreviewState({
          previewState: {
            isOpen: nextIsOpen,
            isMaximized: nextIsMaximized,
            currentSlideId: nextSlideId,
            indexv: nextIndexv,
            currentInteraction: nextInteraction,
          },
        });
      }
    },

    getPreviewState: () => previewHandle.snapshotGetter.current?.() ?? null,
    applyPreviewState: (previewState) => previewHandle.snapshotApplier.current?.(previewState),
    applyPreviewPatchReplay: (input) =>
      previewHandle.patchReplayApplier.current?.(input) ?? input.lastAppliedPatchBatchIndex,

    getSlides: () => slidesStore.getSnapshot().context.slides,
    applySlides: (nextSlides) => slidesStore.trigger.setSlides({ slides: nextSlides }),
    getWorkspaceSnapshot: () => {
      const project = getProject();
      const activeFilePath = getActiveFilePath();
      const collapsedFolders = getCollapsedFolders();
      const sidebarScrollTop = getSidebarScrollTop();
      const sidebarCollapsed = getSidebarCollapsed();
      const cachedSnapshot = workspaceSnapshotRef.current;

      if (
        cachedSnapshot &&
        cachedSnapshot.project === project &&
        cachedSnapshot.activeFilePath === activeFilePath &&
        cachedSnapshot.collapsedFolders === collapsedFolders &&
        (cachedSnapshot.sidebarScrollTop ?? 0) === sidebarScrollTop &&
        (cachedSnapshot.sidebarCollapsed ?? false) === sidebarCollapsed
      ) {
        return cachedSnapshot;
      }

      const nextSnapshot = {
        project,
        activeFilePath,
        collapsedFolders,
        sidebarScrollTop,
        sidebarCollapsed,
      } satisfies WorkspaceRecordingSnapshot;

      workspaceSnapshotRef.current = nextSnapshot;
      return nextSnapshot;
    },
    applyWorkspaceSnapshot: (snapshot) => {
      suppressWorkspaceEvents();
      loadProject(
        snapshot.project,
        snapshot.activeFilePath,
        snapshot.collapsedFolders ?? [],
        snapshot.sidebarScrollTop ?? 0,
      );
      // Only when the recording says so. Absent — every recording made before
      // this, and every lesson that does not ask — the viewer's own preference
      // stands, and even when it is present this is the opening frame rather
      // than a lock: the toggle keeps working mid-replay, and nothing is
      // written back to their storage.
      if (typeof snapshot.sidebarCollapsed === "boolean") {
        startSidebarCollapsed(snapshot.sidebarCollapsed);
      }
      if (
        typeof snapshot.sidebarWidthDelta === "number" &&
        Number.isFinite(snapshot.sidebarWidthDelta) &&
        snapshot.sidebarWidthDelta !== 0
      ) {
        setSidebarWidth(getSidebarWidth() + snapshot.sidebarWidthDelta);
      }
      if (
        typeof snapshot.previewDockWidthDelta === "number" &&
        Number.isFinite(snapshot.previewDockWidthDelta) &&
        snapshot.previewDockWidthDelta !== 0
      ) {
        previewHandle.dockWidthDeltaApplier.current?.(snapshot.previewDockWidthDelta);
      }
      void saveRuntimeWorkspace();
    },
    getRuntimeSnapshot: (): RuntimeRecordingSnapshot => {
      const snapshot = getRuntimeRecordingSnapshot();

      return {
        mode: snapshot.previewUrl ? "webcontainer" : "single-file",
        status: snapshot.status,
        previewUrl: snapshot.previewUrl,
        previewPort: snapshot.previewPort,
        lastOutput: snapshot.lastOutput,
        activeCommand: snapshot.activeCommand,
        errorMessage: snapshot.errorMessage,
        terminalSessions: snapshot.terminalSessions,
        activeTerminalSessionId: snapshot.activeTerminalSessionId,
        latestPreviewMessage: snapshot.latestPreviewMessage,
        latestLifecycleEvent: snapshot.latestLifecycleEvent,
        ...selectRecordingState(runtimePanelStore.getSnapshot().context),
      };
    },
    applyRuntimeSnapshot: (snapshot) => {
      runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot });
    },
    applyChatSnapshot: (snapshot) => {
      getAgentStore().trigger.applyReplaySnapshot({ snapshot });
    },
    getWhiteboardState: () => whiteboardStore.getSnapshot().context.scene,
    applyWhiteboardState: (scene) => {
      whiteboardStore.trigger.setScene({ scene });
    },
    // Local-only: the screen-capture video is handed straight to a disk download and never touches
    // the Recording, the .ne codec, IndexedDB, or any upload path. `saveScreenRecordingLocally` is
    // the blob's sole exit.
    onScreenRecordingReady: (payload) => saveScreenRecordingLocally(payload),
  };

  return (
    <NextEditorActorContext.Provider options={{ input: config }}>
      <NextEditorProviderContent
        config={config}
        recordingStorage={recordingStorage}
        suppressWorkspaceEventsRef={suppressWorkspaceEventsRef}
      >
        {children}
      </NextEditorProviderContent>
    </NextEditorActorContext.Provider>
  );
};
