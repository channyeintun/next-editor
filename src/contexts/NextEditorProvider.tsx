import { useRef, useEffect } from "react";
import type * as monaco from "monaco-editor";
import type { Recording, UseNextEditorConfig } from "../core/src";
import { useNextEditorActorBindings } from "../core/src/useNextEditor";
import { NextEditorActionsContext } from "./NextEditorContext";
import { NextEditorActorContext } from "./NextEditorActorContext";
import { usePreviewAdapterHandle } from "./PreviewAdapterHandleContext";
import { useSlidesStore } from "./SlidesStoreContext";
import { useRuntimePanelStore } from "./RuntimePanelStoreContext";
import { selectRecordingState } from "../stores/runtimePanelStore";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { useRecordingStreamSink } from "../hooks/useRecordingStreamSink";
import { createRecordingStorage } from "../storage/RecordingStorage";
import type { RuntimeRecordingSnapshot } from "../types/runtime";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";

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
  const originalHook = useNextEditorActorBindings(actorRef, config);

  // Opt-in: forward the live SCR3 recording stream to a configured sink (inert if absent).
  useRecordingStreamSink(actorRef, config.recordingStreamSink);

  const {
    clearRecording,
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
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent: handleWorkspaceEventBase,
    handleRuntimeEvent,
  } = originalHook;

  // Stabilize storage and registration methods
  const exportAsFile = (recording: Recording, filename?: string) =>
    recordingStorage.current.exportAsFile(recording, filename);
  const importFromFile = () => recordingStorage.current.importFromFile();
  const clearStorage = () => recordingStorage.current.clear();
  const getStorageStats = () => recordingStorage.current.getStats();
  const deleteFromStorage = (id: string) => recordingStorage.current.delete(id);

  const loadRecordingsFromStorage = async () => {
    try {
      return await recordingStorage.current.load();
    } catch (error) {
      console.warn("Failed to load recordings from storage:", error);
      return [];
    }
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
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handlePreviewInitialDocument,
    handlePreviewPatchBatch,
    handleWorkspaceEvent,
    handleRuntimeEvent,
    clearRecording,
    exportAsFile,
    importFromFile,
    clearStorage,
    getStorageStats,
    loadRecordingsFromStorage,
    deleteFromStorage,
  };

  return <NextEditorActionsContext value={actionsValue}>{children}</NextEditorActionsContext>;
};

export const NextEditorProvider: React.FC<NextEditorProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const recordingStorage = useRef(createRecordingStorage());
  const previewHandle = usePreviewAdapterHandle();
  const { store: slidesStore, navigator: slideNavigator } = useSlidesStore();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const {
    getProject,
    getActiveFilePath,
    getCollapsedFolders,
    getSidebarScrollTop,
    getSidebarWidth,
    loadProject,
    setSidebarWidth,
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
    applySlideState: (slideState, currentSlideIndex) => {
      // Capture the pre-update state up front: the navigate decision below
      // compares the replay target against where the deck currently is.
      const { slides, previewState: prev } = slidesStore.getSnapshot().context;

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

      if (slideState.isOpen) {
        const prevIndexv = prev.indexv ?? 0;
        const prevSlideIndex = Math.max(
          0,
          slides.findIndex((s) => s.id === prev.currentSlideId),
        );

        if (
          currentSlideIndex !== prevSlideIndex ||
          (slideState.indexv !== undefined && nextIndexv !== prevIndexv)
        ) {
          slideNavigator.current?.(currentSlideIndex, nextIndexv);
        }
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
      const cachedSnapshot = workspaceSnapshotRef.current;

      if (
        cachedSnapshot &&
        cachedSnapshot.project === project &&
        cachedSnapshot.activeFilePath === activeFilePath &&
        cachedSnapshot.collapsedFolders === collapsedFolders &&
        (cachedSnapshot.sidebarScrollTop ?? 0) === sidebarScrollTop
      ) {
        return cachedSnapshot;
      }

      const nextSnapshot = {
        project,
        activeFilePath,
        collapsedFolders,
        sidebarScrollTop,
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
        ...selectRecordingState(runtimePanelStore.getSnapshot().context),
      };
    },
    applyRuntimeSnapshot: (snapshot) => {
      runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot });
    },
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
