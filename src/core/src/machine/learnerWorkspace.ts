import type { EditorActionArgs, EditorContextUpdate, EditorMachineContext } from "./types";
import type { WorkspaceRecordingSnapshot } from "../workspace";
import { areWorkspaceProjectsEqual, isWorkspaceTextFile } from "../workspace";

// ============================================================================
// Keeping the viewer's own edits to a lesson.
//
// Paused or ended, the lesson hands its workspace to the viewer, who may edit
// it. Before the recording takes the workspace back (resume, seek, stop,
// leaving the page), whatever the viewer changed is passed to the app to keep
// (`onLearnerWorkspaceSaved`), and a kept version can be laid back over the
// recording later (RESTORE_LEARNER_WORKSPACE). The bodies are wired into
// `setup()` in editorMachine.ts, which also holds the transition lists that run
// them; the replay cursors the hand-over detaches and reattaches belong to
// replayActions.ts (`detachPlaybackWorkspace`, `reattachPlaybackWorkspace`).
// ============================================================================

/**
 * The viewer's edits to a lesson, saved before the recording took the workspace back
 * (resume, seek, stop, leaving the page). `recordingTime` is where in the lesson they
 * were made.
 */
export interface LearnerWorkspaceSave {
  recordingId: string;
  recordingTime: number;
  snapshot: WorkspaceRecordingSnapshot;
}

/** Save the viewer's edits now, if they have any (e.g. the page is being hidden). */
export type PreserveLearnerWorkspaceEvent = { type: "PRESERVE_LEARNER_WORKSPACE" };

/** Bring back a saved version of the viewer's edits, at the point in the lesson it was made. */
export type RestoreLearnerWorkspaceEvent = {
  type: "RESTORE_LEARNER_WORKSPACE";
  recordingTime: number;
  snapshot: WorkspaceRecordingSnapshot;
};

/** Internal second step of RESTORE_LEARNER_WORKSPACE, once the paused seek has landed. */
export type ApplyLearnerWorkspaceEvent = {
  type: "APPLY_LEARNER_WORKSPACE";
  snapshot: WorkspaceRecordingSnapshot;
};

export const adoptPlaybackWorkspaceAtPause = ({ context }: EditorActionArgs): void => {
  const currentSnapshot = context.getWorkspaceSnapshot?.();
  const activeFilePath = currentSnapshot?.activeFilePath;
  const currentFile = activeFilePath ? currentSnapshot?.project.files[activeFilePath] : undefined;
  const pausedContent = context.currentFrame?.state?.content;

  if (
    !currentSnapshot ||
    !context.applyWorkspaceSnapshot ||
    !activeFilePath ||
    !currentFile ||
    pausedContent === undefined
  ) {
    return;
  }

  if (!isWorkspaceTextFile(currentFile) || currentFile.content === pausedContent) {
    context.applyWorkspaceSnapshot(currentSnapshot);
    return;
  }

  context.applyWorkspaceSnapshot({
    ...currentSnapshot,
    project: {
      ...currentSnapshot.project,
      files: {
        ...currentSnapshot.project.files,
        [activeFilePath]: {
          ...currentFile,
          content: pausedContent,
        },
      },
    },
  });
};

/**
 * Hands the workspace to the viewer (pause, end): remembers it as the recording left
 * it, so `getLearnerWorkspaceSave` can tell the viewer's own edits from the lesson's.
 */
export const captureLearnerWorkspaceBaseline = ({
  context,
}: EditorActionArgs): EditorContextUpdate => ({
  learnerWorkspaceBaseline: context.getWorkspaceSnapshot?.() ?? null,
});

/**
 * The viewer's edits, if the workspace differs from the baseline it was handed, or
 * null. Only the file and folder tree and file contents count: opening a file,
 * collapsing a folder or scrolling is looking around the lesson, not changing it.
 */
const getLearnerWorkspaceSave = (context: EditorMachineContext): LearnerWorkspaceSave | null => {
  const baseline = context.learnerWorkspaceBaseline;
  if (!baseline || !context.recording) return null;
  const current = context.getWorkspaceSnapshot?.();
  if (!current || areWorkspaceProjectsEqual(baseline.project, current.project)) return null;
  return {
    recordingId: context.recording.id,
    recordingTime: context.timeline.currentTime,
    snapshot: current,
  };
};

/**
 * The subset of xstate's `enqueue` object `preserveLearnerWorkspace` uses: a plain
 * action that hands the save to the app, and the assign that moves the baseline. Kept
 * structural, like RetakeEnqueue, so the body doesn't need to thread the machine's full
 * setup() type parameters.
 */
interface PreserveLearnerWorkspaceEnqueue {
  (action: () => void): void;
  assign: (updater: EditorContextUpdate) => void;
}

/**
 * Before the recording takes the workspace back, hand the viewer's own edits (if any)
 * to the app to keep, and treat what was saved as the new baseline so the same edits
 * are not saved twice. editorMachine.ts wraps it as `enqueueActions(...)`.
 */
export const preserveLearnerWorkspace = ({
  context,
  enqueue,
}: {
  context: EditorMachineContext;
  enqueue: PreserveLearnerWorkspaceEnqueue;
}): void => {
  const save = getLearnerWorkspaceSave(context);
  if (!save) return;
  enqueue(() => context.onLearnerWorkspaceSaved?.(save));
  enqueue.assign({ learnerWorkspaceBaseline: save.snapshot });
};

/** Second step of a restore: the paused seek has landed, so lay the saved edits over it. */
export const applyLearnerWorkspace = ({ context, event }: EditorActionArgs): void => {
  if (event.type !== "APPLY_LEARNER_WORKSPACE") return;
  context.applyWorkspaceSnapshot?.(event.snapshot);
};
