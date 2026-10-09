import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";
import { useSelector } from "@xstate/react";
import type { EditorMachineInput, Recording } from "../core/src";
import {
  selectIsTakeInProgress,
  useNextEditorActorActions,
  useNextEditorInteractionEffects,
  type EditorActorRef,
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
import {
  applyRuntimeRecordingState,
  readRuntimeRecordingState,
} from "../stores/runtimeRecordingAdapter";
import { useWebContainerRuntimeSnapshotGetter } from "../hooks/useWebContainerRuntime";
import { useEndViewerDockOverride } from "../hooks/useRuntimeDockLayout";
import { useWorkspaceRecordingAdapter } from "../hooks/useWorkspaceRecordingAdapter";
import { createRecordingStorage, type RecordingStorage } from "../storage/RecordingStorage";
import { saveScreenRecordingLocally } from "../storage/screenRecordingSave";
import type { WorkspaceWidthDeltas } from "../types/workspace";
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
  editorRef: EditorMachineInput["editorRef"];
  recordingStorage: RecordingStorage;
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

/** Keeps what leaving the page would lose: the viewer's edits, and a take in progress. */
function useLeavePageGuards(actorRef: EditorActorRef): void {
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
  const isTakeInProgress = useSelector(actorRef, selectIsTakeInProgress);
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
}

const NextEditorProviderContent: React.FC<NextEditorProviderContentProps> = ({
  children,
  recordingDrafts,
  editorRef,
  recordingStorage,
  suppressWorkspaceEventsRef,
}) => {
  const actorRef = NextEditorActorContext.useActorRef();
  // Subscription-free senders: the actions context must not change on state
  // transitions. (useNextEditorInteractionEffects below does subscribe to
  // isPlaying and the editor, and useLeavePageGuards to whether a take is in
  // progress, so this component re-renders on those; the compiler keeps
  // actionsValue stable across them.)
  const senders = useNextEditorActorActions(actorRef);
  useNextEditorInteractionEffects(actorRef, editorRef);
  useRecordingDraftJournal(actorRef, recordingDrafts);
  useLeavePageGuards(actorRef);
  useEndViewerDockOverride(actorRef);

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
    recordingStorage.exportAsFile(recording, filename);
  const importFromFile = () => recordingStorage.importFromFile();

  const handleWorkspaceEvent = (event?: WorkspaceWidthDeltas) => {
    if (suppressWorkspaceEventsRef.current) {
      return;
    }

    senders.handleWorkspaceEvent(event);
  };

  const actionsValue: NextEditorActions = {
    ...senders,
    editorRef,
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
  const [recordingStorage] = useState(createRecordingStorage);
  const previewHandle = usePreviewAdapterHandle();
  const { store: slidesStore } = useSlidesStore();
  const { store: whiteboardStore } = useWhiteboardStore();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const getRuntimeRecordingSnapshot = useWebContainerRuntimeSnapshotGetter();
  const { getWorkspaceSnapshot, applyWorkspaceSnapshot, suppressWorkspaceEventsRef } =
    useWorkspaceRecordingAdapter();

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
    getWorkspaceSnapshot,
    applyWorkspaceSnapshot,
    getRuntimeSnapshot: () =>
      readRuntimeRecordingState(getRuntimeRecordingSnapshot(), runtimePanelStore),
    applyRuntimeSnapshot: (snapshot) => applyRuntimeRecordingState(runtimePanelStore, snapshot),
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
        editorRef={editorRef}
        recordingStorage={recordingStorage}
        suppressWorkspaceEventsRef={suppressWorkspaceEventsRef}
      >
        {children}
      </NextEditorProviderContent>
    </NextEditorActorContext.Provider>
  );
};
