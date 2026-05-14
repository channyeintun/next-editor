import { useRef, useMemo, useCallback, useEffect } from "react";
import type * as monaco from "monaco-editor";
import type { Recording, UseNextEditorConfig } from "../core/src";
import { useNextEditorActorBindings } from "../core/src/useNextEditor";
import { NextEditorActionsContext } from "./NextEditorContext";
import { NextEditorActorContext } from "./NextEditorActorContext";
import { useNextEditorDomainAdapters } from "./NextEditorDomainAdaptersContext";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { createJsonStorage } from "../storage/JsonStorage";
import type { SlidePreviewState, PreviewState, Slide } from "../types/slides";
import type {
  RuntimePanelRecordingState,
  RuntimeRecordingSnapshot,
} from "../types/runtime";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";

interface NextEditorProviderProps {
  children: React.ReactNode;
}

interface NextEditorProviderContentProps {
  children: React.ReactNode;
  config: UseNextEditorConfig;
  jsonStorage: { current: ReturnType<typeof createJsonStorage> };
  resetProject: () => void;
  suppressWorkspaceEventsRef: { current: boolean };
}

const NextEditorProviderContent: React.FC<NextEditorProviderContentProps> = ({
  children,
  config,
  jsonStorage,
  resetProject,
  suppressWorkspaceEventsRef,
}) => {
  const actorRef = NextEditorActorContext.useActorRef();
  const { slides, preview, runtimePanel } = useNextEditorDomainAdapters();
  const originalHook = useNextEditorActorBindings(actorRef, config);

  const {
    clearRecording: clearRecordingBase,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    loadRecording,
    syncEditorRef,
    handleEditorChange,
    handleSlideEvent,
    handlePreviewEvent,
    handleWorkspaceEvent: handleWorkspaceEventBase,
    handleRuntimeEvent,
  } = originalHook;

  // Stabilize storage and registration methods
  const exportAsFile = useCallback(
    (recording: Recording, filename?: string) =>
      jsonStorage.current.exportAsFile(recording, filename),
    [jsonStorage],
  );
  const exportAllAsFile = useCallback(
    (filename?: string) => jsonStorage.current.exportAllAsFile(filename),
    [jsonStorage],
  );
  const importFromFile = useCallback(
    () => jsonStorage.current.importFromFile(),
    [jsonStorage],
  );
  const clearStorage = useCallback(
    () => jsonStorage.current.clear(),
    [jsonStorage],
  );
  const getStorageStats = useCallback(
    () => jsonStorage.current.getStats(),
    [jsonStorage],
  );
  const deleteFromStorage = useCallback(
    (id: string) => jsonStorage.current.delete(id),
    [jsonStorage],
  );

  const loadRecordingsFromStorage = useCallback(async () => {
    try {
      return await jsonStorage.current.load();
    } catch (error) {
      console.warn("Failed to load recordings from storage:", error);
      return [];
    }
  }, [jsonStorage]);

  const clearRecording = useCallback(() => {
    clearRecordingBase();
    resetProject();
  }, [clearRecordingBase, resetProject]);

  const handleWorkspaceEvent = useCallback(() => {
    if (suppressWorkspaceEventsRef.current) {
      return;
    }

    handleWorkspaceEventBase();
  }, [handleWorkspaceEventBase, suppressWorkspaceEventsRef]);

  const registerSlideStateGetter = useCallback(
    (
      getter: () => {
        previewState: SlidePreviewState;
        currentSlideIndex: number;
      } | null,
    ) => {
      slides.setSnapshotGetter(getter);
    },
    [slides],
  );

  const registerSlideStateApplier = useCallback(
    (
      applier: (
        slideState: SlidePreviewState,
        currentSlideIndex: number,
      ) => void,
    ) => {
      slides.setSnapshotApplier(applier);
    },
    [slides],
  );

  const registerSlidesGetter = useCallback(
    (getter: () => Slide[]) => {
      slides.setSlidesGetter(getter);
    },
    [slides],
  );

  const registerSlidesApplier = useCallback(
    (applier: (slides: Slide[]) => void) => {
      slides.setSlidesApplier(applier);
    },
    [slides],
  );

  const registerPreviewStateGetter = useCallback(
    (getter: () => PreviewState | null) => {
      preview.setSnapshotGetter(getter);
    },
    [preview],
  );

  const registerPreviewStateApplier = useCallback(
    (applier: (previewState: PreviewState) => void) => {
      preview.setSnapshotApplier(applier);
    },
    [preview],
  );

  const registerRuntimeStateGetter = useCallback(
    (getter: () => RuntimePanelRecordingState | null) => {
      runtimePanel.setSnapshotGetter(getter);
    },
    [runtimePanel],
  );

  const registerRuntimeStateApplier = useCallback(
    (applier: (snapshot: RuntimeRecordingSnapshot) => void) => {
      runtimePanel.setSnapshotApplier(applier);
    },
    [runtimePanel],
  );

  const registerSlideNavigator = useCallback(
    (navigator: (indexh: number, indexv: number) => void) => {
      slides.setNavigator(navigator);
    },
    [slides],
  );

  const navigateSlidesDirect = useCallback(
    (indexh: number, indexv: number) => {
      slides.navigate(indexh, indexv);
    },
    [slides],
  );

  const actionsValue = useMemo(
    () => ({
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
      handleEditorChange,
      handleSlideEvent,
      handlePreviewEvent,
      handleWorkspaceEvent,
      handleRuntimeEvent,
      clearRecording,
      exportAsFile,
      exportAllAsFile,
      importFromFile,
      clearStorage,
      getStorageStats,
      loadRecordingsFromStorage,
      deleteFromStorage,
      registerSlideStateGetter,
      registerSlideStateApplier,
      registerSlidesGetter,
      registerSlidesApplier,
      registerPreviewStateGetter,
      registerPreviewStateApplier,
      registerRuntimeStateGetter,
      registerRuntimeStateApplier,
      registerSlideNavigator,
      navigateSlidesDirect,
    }),
    [
      config.editorRef,
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
      handleEditorChange,
      handleSlideEvent,
      handlePreviewEvent,
      handleWorkspaceEvent,
      handleRuntimeEvent,
      clearRecording,
      exportAsFile,
      exportAllAsFile,
      importFromFile,
      clearStorage,
      getStorageStats,
      loadRecordingsFromStorage,
      deleteFromStorage,
      registerSlideStateGetter,
      registerSlideStateApplier,
      registerSlidesGetter,
      registerSlidesApplier,
      registerPreviewStateGetter,
      registerPreviewStateApplier,
      registerRuntimeStateGetter,
      registerRuntimeStateApplier,
      registerSlideNavigator,
      navigateSlidesDirect,
    ],
  );

  return (
    <NextEditorActionsContext value={actionsValue}>
      {children}
    </NextEditorActionsContext>
  );
};

export const NextEditorProvider: React.FC<NextEditorProviderProps> = ({
  children,
}) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const jsonStorage = useRef(createJsonStorage());
  const { slides, preview, runtimePanel } = useNextEditorDomainAdapters();
  const {
    getProject,
    getActiveFilePath,
    getCollapsedFolders,
    loadProject,
    resetProject,
  } = useWorkspaceActions();
  const saveRuntimeWorkspace = useWebContainerRuntimeSaveWorkspace();
  const getRuntimeRecordingSnapshot = useWebContainerRuntimeSnapshotGetter();
  const runtimeSnapshotRef = useRef(getRuntimeRecordingSnapshot());
  const workspaceSnapshotRef = useRef<WorkspaceRecordingSnapshot | null>(null);
  const suppressWorkspaceEventsRef = useRef(false);
  const clearWorkspaceEventSuppressionTimeoutRef = useRef<number | null>(null);

  runtimeSnapshotRef.current = getRuntimeRecordingSnapshot();

  useEffect(() => {
    return () => {
      if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
        window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
      }
    };
  }, []);

  const suppressWorkspaceEvents = useCallback(() => {
    suppressWorkspaceEventsRef.current = true;

    if (clearWorkspaceEventSuppressionTimeoutRef.current !== null) {
      window.clearTimeout(clearWorkspaceEventSuppressionTimeoutRef.current);
    }

    clearWorkspaceEventSuppressionTimeoutRef.current = window.setTimeout(() => {
      suppressWorkspaceEventsRef.current = false;
      clearWorkspaceEventSuppressionTimeoutRef.current = null;
    }, 0);
  }, []);

  const config = useMemo<UseNextEditorConfig>(
    () => ({
      editorRef,
      enableAudioRecording: true, // Enable built-in synchronized audio recording
      pauseOnUserInteraction: true,
      getSlideState: () => slides.getSnapshot(),
      applySlideState: (slideState, currentSlideIndex) =>
        slides.applySnapshot(slideState, currentSlideIndex),

      getPreviewState: () => preview.getSnapshot(),
      applyPreviewState: (previewState) => preview.applySnapshot(previewState),

      getSlides: () => slides.getSlides(),
      applySlides: (nextSlides) => slides.applySlides(nextSlides),
      getWorkspaceSnapshot: () => {
        const project = getProject();
        const activeFilePath = getActiveFilePath();
        const collapsedFolders = getCollapsedFolders();
        const cachedSnapshot = workspaceSnapshotRef.current;

        if (
          cachedSnapshot &&
          cachedSnapshot.project === project &&
          cachedSnapshot.activeFilePath === activeFilePath &&
          cachedSnapshot.collapsedFolders === collapsedFolders
        ) {
          return cachedSnapshot;
        }

        const nextSnapshot = {
          project,
          activeFilePath,
          collapsedFolders,
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
        );
        void saveRuntimeWorkspace();
      },
      getRuntimeSnapshot: (): RuntimeRecordingSnapshot => {
        const snapshot = runtimeSnapshotRef.current;

        return {
          mode: snapshot.previewUrl ? "webcontainer" : "single-file",
          status: snapshot.status,
          previewUrl: snapshot.previewUrl,
          terminalOutput: snapshot.terminalOutput || snapshot.lastOutput,
          activeCommand: snapshot.activeCommand,
          errorMessage: snapshot.errorMessage,
          ...runtimePanel.getSnapshot(),
        };
      },
      applyRuntimeSnapshot: (snapshot) => {
        runtimePanel.applySnapshot(snapshot);
      },
    }),
    [
      getActiveFilePath,
      getCollapsedFolders,
      getProject,
      loadProject,
      preview,
      runtimePanel,
      saveRuntimeWorkspace,
      slides,
      suppressWorkspaceEvents,
    ],
  );

  return (
    <NextEditorActorContext.Provider options={{ input: config }}>
      <NextEditorProviderContent
        config={config}
        jsonStorage={jsonStorage}
        resetProject={resetProject}
        suppressWorkspaceEventsRef={suppressWorkspaceEventsRef}
      >
        {children}
      </NextEditorProviderContent>
    </NextEditorActorContext.Provider>
  );
};
