import { useRef, useEffect } from "react";
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
  const { slides, preview, runtimePanel } = useNextEditorDomainAdapters();
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
    getSlideState: () => slides.getSnapshot(),
    applySlideState: (slideState, currentSlideIndex) =>
      slides.applySnapshot(slideState, currentSlideIndex),

    getPreviewState: () => preview.getSnapshot(),
    applyPreviewState: (previewState) => preview.applySnapshot(previewState),
    applyPreviewPatchReplay: (input) => preview.applyPatchReplay(input),

    getSlides: () => slides.getSlides(),
    applySlides: (nextSlides) => slides.applySlides(nextSlides),
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
        preview.applyDockWidthDelta(snapshot.previewDockWidthDelta);
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
        ...runtimePanel.getSnapshot(),
      };
    },
    applyRuntimeSnapshot: (snapshot) => {
      runtimePanel.applySnapshot(snapshot);
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
