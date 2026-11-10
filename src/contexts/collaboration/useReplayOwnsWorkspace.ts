import { useState } from "react";
import type { EditorMachineSnapshot } from "../../core/src/useNextEditor";
import { NextEditorActorContext } from "../NextEditorActorContext";

/**
 * Whether a replay owns this tab's workspace: a recording is loading (a lesson
 * link or file being opened, or a finished take being finalized) or is loaded
 * for replay, in any of its states (the editor's isReplayLoaded), whether or
 * not it is playing.
 *
 * A live room and a replay are mutually exclusive in one tab. The replay writes
 * its own workspace (its opening snapshot when it loads, recorded frames into
 * the open editor, a scrub or a stop) through the workspace's base actions,
 * beneath the room's, so nothing of it may reach the room: the room stops
 * projecting and accepting writes while this holds, and reprojects once it no
 * longer does.
 */
export function isWorkspaceOwnedByReplay(
  snapshot: Pick<EditorMachineSnapshot, "matches">,
): boolean {
  return snapshot.matches("loading") || snapshot.matches("playback");
}

/**
 * isWorkspaceOwnedByReplay for the editor in this tab: as a render-time flag,
 * and as a stable reader of the editor's state at the moment it is called. A
 * replay writes its opening frame inside the editor's own transition, before
 * any render could detach the room's bindings, so the room checks each write
 * with the reader.
 */
export function useReplayOwnsWorkspace(): {
  replayOwnsWorkspace: boolean;
  readReplayOwnsWorkspace: () => boolean;
} {
  const editorActor = NextEditorActorContext.useActorRef();
  const replayOwnsWorkspace = NextEditorActorContext.useSelector(isWorkspaceOwnedByReplay);
  const [readReplayOwnsWorkspace] = useState(
    () => () => isWorkspaceOwnedByReplay(editorActor.getSnapshot()),
  );
  return { replayOwnsWorkspace, readReplayOwnsWorkspace };
}
