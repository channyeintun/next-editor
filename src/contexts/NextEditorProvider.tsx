import { useRef, useMemo, useCallback, useEffect } from "react";
import type * as monaco from "monaco-editor";
import type { Recording, UseNextEditorConfig } from "../core/src";
import { useNextEditorActorBindings } from "../core/src/useNextEditor";
import { NextEditorActionsContext } from "./NextEditorContext";
import { NextEditorActorContext } from "./NextEditorActorContext";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import {
  useWorkspaceActions,
} from "../hooks/useWorkspace";
import { createJsonStorage } from "../storage/JsonStorage";
import type { SlidePreviewState, PreviewState, Slide } from "../types/slides";
import type {
  RuntimePanelRecordingState,
  RuntimeRecordingSnapshot,
} from "../types/runtime";

interface NextEditorProviderProps {
  children: React.ReactNode;
}

interface NextEditorProviderContentProps {
  children: React.ReactNode;
  config: UseNextEditorConfig;
  jsonStorage: { current: ReturnType<typeof createJsonStorage> };
  resetProject: () => void;
  skipRuntimeWorkspaceSyncRef: { current: boolean };
  suppressWorkspaceEventsRef: { current: boolean };
  getSlideStateRef: {
    current:
      | (() => {
          previewState: SlidePreviewState;
          currentSlideIndex: number;
        } | null)
      | null;
  };
  applySlideStateRef: {
    current:
      | ((slideState: SlidePreviewState, currentSlideIndex: number) => void)
      | null;
  };
  getPreviewStateRef: { current: (() => PreviewState | null) | null };
  applyPreviewStateRef: {
    current: ((previewState: PreviewState) => void) | null;
  };
  getRuntimeStateRef: {
    current: (() => RuntimePanelRecordingState | null) | null;
  };
  applyRuntimeStateRef: {
    current: ((snapshot: RuntimeRecordingSnapshot) => void) | null;
  };
  getSlidesRef: { current: (() => Slide[]) | null };
  applySlidesRef: { current: ((slides: Slide[]) => void) | null };
  navigateSlidesDirectRef: {
    current: ((indexh: number, indexv: number) => void) | null;
  };
}

const NextEditorProviderContent: React.FC<NextEditorProviderContentProps> = ({
  children,
  config,
  jsonStorage,
  resetProject,
  skipRuntimeWorkspaceSyncRef,
  suppressWorkspaceEventsRef,
  getSlideStateRef,
  applySlideStateRef,
  getPreviewStateRef,
  applyPreviewStateRef,
  getRuntimeStateRef,
  applyRuntimeStateRef,
  getSlidesRef,
  applySlidesRef,
  navigateSlidesDirectRef,
}) => {
  const actorRef = NextEditorActorContext.useActorRef();
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
    isPlaying,
    isPaused,
    hasEnded,
  } = originalHook;

  useEffect(() => {
    skipRuntimeWorkspaceSyncRef.current = isPlaying || isPaused || hasEnded;
  }, [hasEnded, isPaused, isPlaying, skipRuntimeWorkspaceSyncRef]);

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
      getSlideStateRef.current = getter;
    },
    [getSlideStateRef],
  );

  const registerSlideStateApplier = useCallback(
    (
      applier: (
        slideState: SlidePreviewState,
        currentSlideIndex: number,
      ) => void,
    ) => {
      applySlideStateRef.current = applier;
    },
    [applySlideStateRef],
  );

  const registerSlidesGetter = useCallback(
    (getter: () => Slide[]) => {
      getSlidesRef.current = getter;
    },
    [getSlidesRef],
  );

  const registerSlidesApplier = useCallback(
    (applier: (slides: Slide[]) => void) => {
      applySlidesRef.current = applier;
    },
    [applySlidesRef],
  );

  const registerPreviewStateGetter = useCallback(
    (getter: () => PreviewState | null) => {
      getPreviewStateRef.current = getter;
    },
    [getPreviewStateRef],
  );

  const registerPreviewStateApplier = useCallback(
    (applier: (previewState: PreviewState) => void) => {
      applyPreviewStateRef.current = applier;
    },
    [applyPreviewStateRef],
  );

  const registerRuntimeStateGetter = useCallback(
    (getter: () => RuntimePanelRecordingState | null) => {
      getRuntimeStateRef.current = getter;
    },
    [getRuntimeStateRef],
  );

  const registerRuntimeStateApplier = useCallback(
    (applier: (snapshot: RuntimeRecordingSnapshot) => void) => {
      applyRuntimeStateRef.current = applier;
    },
    [applyRuntimeStateRef],
  );

  const registerSlideNavigator = useCallback(
    (navigator: (indexh: number, indexv: number) => void) => {
      navigateSlidesDirectRef.current = navigator;
    },
    [navigateSlidesDirectRef],
  );

  const navigateSlidesDirect = useCallback(
    (indexh: number, indexv: number) => {
      navigateSlidesDirectRef.current?.(indexh, indexv);
    },
    [navigateSlidesDirectRef],
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
  const { getProject, getActiveFilePath, loadProject, resetProject } =
    useWorkspaceActions();
  const saveRuntimeWorkspace = useWebContainerRuntimeSaveWorkspace();
  const getRuntimeRecordingSnapshot = useWebContainerRuntimeSnapshotGetter();
  const runtimeSnapshotRef = useRef(getRuntimeRecordingSnapshot());
  const skipRuntimeWorkspaceSyncRef = useRef(false);
  const suppressWorkspaceEventsRef = useRef(false);
  const clearWorkspaceEventSuppressionTimeoutRef = useRef<number | null>(null);
  const getSlideStateRef = useRef<
    | (() => {
        previewState: SlidePreviewState;
        currentSlideIndex: number;
      } | null)
    | null
  >(null);
  const applySlideStateRef = useRef<
    ((slideState: SlidePreviewState, currentSlideIndex: number) => void) | null
  >(null);

  const getPreviewStateRef = useRef<(() => PreviewState | null) | null>(null);
  const applyPreviewStateRef = useRef<
    ((previewState: PreviewState) => void) | null
  >(null);
  const getRuntimeStateRef = useRef<
    (() => RuntimePanelRecordingState | null) | null
  >(null);
  const applyRuntimeStateRef = useRef<
    ((snapshot: RuntimeRecordingSnapshot) => void) | null
  >(null);

  const getSlidesRef = useRef<(() => Slide[]) | null>(null);
  const applySlidesRef = useRef<((slides: Slide[]) => void) | null>(null);
  const navigateSlidesDirectRef = useRef<
    ((indexh: number, indexv: number) => void) | null
  >(null);

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
      getSlideState: () => getSlideStateRef.current?.() || null,
      applySlideState: (slideState, currentSlideIndex) =>
        applySlideStateRef.current?.(slideState, currentSlideIndex),

      getPreviewState: () => getPreviewStateRef.current?.() || null,
      applyPreviewState: (previewState) =>
        applyPreviewStateRef.current?.(previewState),

      getSlides: () => getSlidesRef.current?.() || [],
      applySlides: (slides) => applySlidesRef.current?.(slides),
      getWorkspaceSnapshot: () => ({
        project: structuredClone(getProject()),
        activeFilePath: getActiveFilePath(),
      }),
      applyWorkspaceSnapshot: (snapshot) => {
        suppressWorkspaceEvents();
        loadProject(snapshot.project, snapshot.activeFilePath);

        if (!skipRuntimeWorkspaceSyncRef.current) {
          void saveRuntimeWorkspace();
        }
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
          ...getRuntimeStateRef.current?.(),
        };
      },
      applyRuntimeSnapshot: (snapshot) => {
        applyRuntimeStateRef.current?.(snapshot);
      },
    }),
    [
      getActiveFilePath,
      getProject,
      loadProject,
      saveRuntimeWorkspace,
      suppressWorkspaceEvents,
    ],
  );

  return (
    <NextEditorActorContext.Provider options={{ input: config }}>
      <NextEditorProviderContent
        config={config}
        jsonStorage={jsonStorage}
        resetProject={resetProject}
        skipRuntimeWorkspaceSyncRef={skipRuntimeWorkspaceSyncRef}
        suppressWorkspaceEventsRef={suppressWorkspaceEventsRef}
        getSlideStateRef={getSlideStateRef}
        applySlideStateRef={applySlideStateRef}
        getPreviewStateRef={getPreviewStateRef}
        applyPreviewStateRef={applyPreviewStateRef}
        getRuntimeStateRef={getRuntimeStateRef}
        applyRuntimeStateRef={applyRuntimeStateRef}
        getSlidesRef={getSlidesRef}
        applySlidesRef={applySlidesRef}
        navigateSlidesDirectRef={navigateSlidesDirectRef}
      >
        {children}
      </NextEditorProviderContent>
    </NextEditorActorContext.Provider>
  );
};
