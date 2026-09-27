import { useRef, useEffect } from "react";
import type * as monaco from "monaco-editor";
import type { EditorMachineInput, Recording } from "../core/src";
import {
  selectIsTakeInProgress,
  useNextEditorActorActions,
  useNextEditorInteractionEffects,
} from "../core/src/useNextEditor";
import { NextEditorActionsContext, type NextEditorActions } from "./NextEditorContext";
import { NextEditorActorContext } from "./NextEditorActorContext";
import { usePreviewAdapterHandle } from "./PreviewAdapterHandleContext";
import { useSlidesStore } from "./SlidesStoreContext";
import {
  applyRecordingSlides,
  applySlideRecordingState,
  readSlideRecordingState,
} from "../stores/slidesRecordingAdapter";
import { useWhiteboardStore } from "./WhiteboardStoreContext";
import { useRuntimePanelStore } from "./RuntimePanelStoreContext";
import { selectRecordingState } from "../stores/runtimePanelStore";
import {
  useWebContainerRuntimeSaveWorkspace,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { createRecordingStorage } from "../storage/RecordingStorage";
import { saveScreenRecordingLocally } from "../storage/screenRecordingSave";
import type { RuntimeRecordingSnapshot } from "../types/runtime";
import type { WorkspaceRecordingSnapshot, WorkspaceWidthDeltas } from "../types/workspace";
import { getAgentStore } from "../agent/agentStore";
import { createChatCheckpoint } from "../agent/chatRecording";
import { keepLearnerWorkspace } from "../stores/learnerVersionsStore";
import { useRecordingDraftJournal } from "../hooks/useRecordingDraftJournal";

interface NextEditorProviderProps {
  children: React.ReactNode;
  /**
   * Journal takes to IndexedDB as they record so a crash or closed tab can be recovered
   * (hooks/useRecordingDraftJournal). Off where takes are not the author's to lose.
   */
  recordingDrafts?: boolean;
}

interface NextEditorProviderContentProps {
  children: React.ReactNode;
  recordingDrafts: boolean;
  config: EditorMachineInput;
  recordingStorage: { current: ReturnType<typeof createRecordingStorage> };
  suppressWorkspaceEventsRef: { current: boolean };
}

/**
 * Lets the preview flush its last batch into the take, then stops the recording
 * even if that flush failed (the failure still reaches the caller). Module-level
 * because a try/finally with no catch inside a component makes the React Compiler
 * skip the whole component.
 */
async function prepareThenStopRecording(
  prepare: (() => Promise<void>) | null,
  stop: () => void,
): Promise<void> {
  try {
    await prepare?.();
  } finally {
    stop();
  }
}

const NextEditorProviderContent: React.FC<NextEditorProviderContentProps> = ({
  children,
  recordingDrafts,
  config,
  recordingStorage,
  suppressWorkspaceEventsRef,
}) => {
  const actorRef = NextEditorActorContext.useActorRef();
  // Subscription-free senders: the actions context must not change on state
  // transitions. (useNextEditorInteractionEffects below does subscribe to
  // isPlaying and the editor, so this component re-renders on those; the
  // compiler keeps actionsValue stable across them.)
  const senders = useNextEditorActorActions(actorRef);
  useNextEditorInteractionEffects(actorRef, config);
  useRecordingDraftJournal(actorRef, recordingDrafts);

  // Leaving the page (closing the tab, navigating, a phone backgrounding it) is the
  // one hand-back that sends the machine nothing, so ask it to keep the viewer's
  // edits while there is still time. `pagehide` covers bfcache navigations that never
  // fire `unload`; a hidden tab may be killed without either.
  useEffect(() => {
    const preserve = () => actorRef.send({ type: "PRESERVE_LEARNER_WORKSPACE" });
    const preserveWhenHidden = () => {
      if (document.visibilityState === "hidden") preserve();
    };
    window.addEventListener("pagehide", preserve);
    document.addEventListener("visibilitychange", preserveWhenHidden);
    return () => {
      window.removeEventListener("pagehide", preserve);
      document.removeEventListener("visibilitychange", preserveWhenHidden);
    };
  }, [actorRef]);
  // A take lives only in this tab until it is finalized: closing or reloading the tab
  // mid-take threw the whole recording away without a word. Ask the browser to confirm
  // while one is starting, running (or paused), or being finalized.
  const isTakeInProgress = NextEditorActorContext.useSelector(selectIsTakeInProgress);
  useEffect(() => {
    if (!isTakeInProgress) return;
    const confirmLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older engines show the prompt only when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", confirmLeaving);
    return () => window.removeEventListener("beforeunload", confirmLeaving);
  }, [isTakeInProgress]);

  const previewHandle = usePreviewAdapterHandle();
  const stopRecordingPromiseRef = useRef<Promise<void> | null>(null);

  // Every stop control can fire at once; they share the one in-flight stop.
  const stopRecording = () => {
    if (!stopRecordingPromiseRef.current) {
      stopRecordingPromiseRef.current = prepareThenStopRecording(
        previewHandle.recordingStopPreparer.current,
        senders.stopRecording,
      ).finally(() => {
        stopRecordingPromiseRef.current = null;
      });
    }
    return stopRecordingPromiseRef.current;
  };

  const exportAsFile = (recording: Recording, filename?: string) =>
    recordingStorage.current.exportAsFile(recording, filename);
  const importFromFile = () => recordingStorage.current.importFromFile();

  const handleWorkspaceEvent = (event?: WorkspaceWidthDeltas) => {
    if (suppressWorkspaceEventsRef.current) {
      return;
    }

    senders.handleWorkspaceEvent(event);
  };

  const actionsValue: NextEditorActions = {
    ...senders,
    editorRef: config.editorRef,
    stopRecording,
    handleWorkspaceEvent,
    exportAsFile,
    importFromFile,
  };

  return <NextEditorActionsContext value={actionsValue}>{children}</NextEditorActionsContext>;
};

export const NextEditorProvider: React.FC<NextEditorProviderProps> = ({
  children,
  recordingDrafts = true,
}) => {
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

  const config: EditorMachineInput = {
    editorRef,
    enableAudioRecording: true, // Enable built-in synchronized audio recording
    pauseOnUserInteraction: true,
    getSlideState: () => readSlideRecordingState(slidesStore),
    applySlideState: (slideState) => applySlideRecordingState(slidesStore, slideState),

    getPreviewState: () => previewHandle.snapshotGetter.current?.() ?? null,
    applyPreviewState: (previewState) => previewHandle.snapshotApplier.current?.(previewState),
    applyPreviewPatchReplay: (input) => previewHandle.patchReplayApplier.current?.(input),

    getSlides: () => slidesStore.getSnapshot().context.slides,
    applySlides: (nextSlides) => applyRecordingSlides(slidesStore, nextSlides),
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
      // The runtime's workspace sync already moves these files into the container.
      // Saving as well re-runs a finished run-on-save runner on them, so the live
      // console, shown whenever playback is not playing (ready, paused, ended),
      // follows the replayed workspace, including a next lesson loaded in place
      // under the same starter project id. Only for a runtime that has been started
      // (any status but idle): starting one is the auto-start's call
      // (allowAmbientStart, runOnStartup, browser support) or the viewer's, never
      // the replay's.
      if (getRuntimeRecordingSnapshot().status !== "idle") {
        void saveRuntimeWorkspace();
      }
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
    getChatCheckpoint: () => createChatCheckpoint(getAgentStore()),
    requestPreviewCheckpoint: () => previewHandle.recordingCheckpointRequester.current?.(),
    getWhiteboardState: () => whiteboardStore.getSnapshot().context.scene,
    applyWhiteboardState: (scene) => {
      whiteboardStore.trigger.setScene({ scene });
    },
    // Local-only: the screen-capture video is handed straight to a disk download and never touches
    // the Recording, the .ne codec, IndexedDB, or any upload path. `saveScreenRecordingLocally` is
    // the blob's sole exit.
    onScreenRecordingReady: (payload) => saveScreenRecordingLocally(payload),
    // Local-only too: the viewer's own edits to a lesson stay in this browser's IndexedDB.
    onLearnerWorkspaceSaved: (save) => void keepLearnerWorkspace(save),
  };

  return (
    <NextEditorActorContext.Provider options={{ input: config }}>
      <NextEditorProviderContent
        recordingDrafts={recordingDrafts}
        config={config}
        recordingStorage={recordingStorage}
        suppressWorkspaceEventsRef={suppressWorkspaceEventsRef}
      >
        {children}
      </NextEditorProviderContent>
    </NextEditorActorContext.Provider>
  );
};
