import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { normalizeWorkspacePath } from "../types/workspacePaths";
import { useNextEditorActions } from "./useNextEditorContext";
import { useWorkspaceActions } from "./useWorkspace";

/**
 * Opening a workspace file because the viewer asked for it: a click in the
 * file explorer, or a pick in Go to File. The one home of that rule, so every
 * way in records, pauses and leaves a followed member the same way.
 *
 * The order is load-bearing:
 * - A local open ends a collaboration follow, even when the file is already
 *   open, as any other local navigation does.
 * - The file that is already open is left alone: no pause, and no workspace
 *   event that would detach a replay for nothing.
 * - PAUSE goes first. It only acts while a lesson plays, its entry copies the
 *   frame on screen into the file the recording has open, and it is the raw
 *   actor sender, never behind the workspace-event gate, so the lesson stops
 *   even when the workspace event below is swallowed.
 * - The workspace event goes out in the same handler as the switch (cd6987ae):
 *   it detaches a replay before React renders the new file, so no playback
 *   model is built for it, and a take stamps the switch before Monaco binds
 *   the new model. After a pause the event is either swallowed by
 *   useWorkspaceRecordingAdapter's one-task suppression (armed when the paused
 *   entry re-applied the snapshot) or, when no frame was on screen and that
 *   entry applied nothing, reaches the machine in `paused` and runs
 *   detachPlaybackWorkspace again, a no-op after the entry already ran it.
 */
export function useOpenWorkspaceFile(): (path: string) => void {
  const collaboration = useOptionalCollaboration();
  const { pause, handleWorkspaceEvent } = useNextEditorActions();
  const { getActiveFilePath, getFile, setActiveFilePath } = useWorkspaceActions();

  return (path: string) => {
    collaboration?.stopFollowing("local-file-navigation");
    const target = normalizeWorkspacePath(path);
    if (!target || target === getActiveFilePath() || !getFile(target)) return;
    pause();
    setActiveFilePath(target);
    handleWorkspaceEvent();
  };
}
