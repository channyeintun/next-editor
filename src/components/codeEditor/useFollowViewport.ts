import { useLayoutEffect, useRef, type RefObject } from "react";
import { resolveCollaborationEditorViewport } from "../../collaboration/editorViewport";
import { collaborationParticipantKey } from "../../collaboration/participantKey";
import { resolveCollaborationCursor } from "../../collaboration/relativePosition";
import type { useOptionalCollaboration } from "../../contexts/CollaborationContext";
import { monaco } from "../../monaco";
import type { WorkspaceFile } from "../../types/workspace";

/**
 * While this member follows someone whose editor shows the open file, keeps
 * the editor on their viewport, or on their caret when they share no
 * viewport. Each change of theirs is applied once, inside
 * runFollowApplication, which keeps the scroll it causes from being published
 * back to the room.
 */
export function useFollowViewport({
  editorRef,
  collaboration,
  activeFile,
  activeModel,
  usesPlaybackModel,
}: {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  collaboration: ReturnType<typeof useOptionalCollaboration>;
  activeFile: Pick<WorkspaceFile, "path" | "content">;
  activeModel: monaco.editor.ITextModel | null;
  usesPlaybackModel: boolean;
}) {
  // Uncompiled, like the CodeEditor it was extracted from, so its effect runs
  // exactly when it did there.
  "use no memo";
  const appliedFollowViewportRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const target = collaboration?.followedParticipant;
    if (!target) {
      appliedFollowViewportRef.current = null;
      return;
    }
    const targetSurface = target.surface;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (
      !collaboration?.provider ||
      collaboration.connectionState !== "live" ||
      usesPlaybackModel ||
      targetSurface.kind !== "editor" ||
      !targetSurface.fileNodeId ||
      !editor ||
      !model ||
      model !== activeModel ||
      collaboration.getNodeIdForPath(activeFile.path) !== targetSurface.fileNodeId
    ) {
      return;
    }
    const targetFileNodeId = targetSurface.fileNodeId;
    const targetViewport = targetSurface.viewport;
    const targetCursor = target.cursor;
    const applicationKey = `${collaborationParticipantKey(target)}:${target.revision}:${targetFileNodeId}:${model.getVersionId()}`;
    if (appliedFollowViewportRef.current === applicationKey) return;

    let applied = false;
    collaboration.runFollowApplication(() => {
      const resolved = targetViewport
        ? resolveCollaborationEditorViewport(
            collaboration.provider!.doc,
            targetFileNodeId,
            targetViewport,
          )
        : null;
      if (resolved) {
        const position = model.getPositionAt(resolved.topOffset);
        editor.setScrollPosition(
          {
            scrollTop: editor.getTopForLineNumber(position.lineNumber) + resolved.topDeltaPx,
            scrollLeft: resolved.scrollLeftPx,
          },
          monaco.editor.ScrollType.Immediate,
        );
        applied = true;
        return;
      }
      if (targetCursor && targetCursor.fileNodeId === targetFileNodeId) {
        const cursor = resolveCollaborationCursor(collaboration.provider!.doc, targetCursor);
        if (cursor) {
          editor.revealPositionInCenter(
            model.getPositionAt(cursor.headOffset),
            monaco.editor.ScrollType.Immediate,
          );
          applied = true;
        }
      } else if (!targetViewport) {
        applied = true;
      }
    });
    if (applied) appliedFollowViewportRef.current = applicationKey;
  }, [
    activeFile.content,
    activeFile.path,
    activeModel,
    collaboration?.connectionState,
    collaboration?.followedParticipant,
    collaboration?.getNodeIdForPath,
    collaboration?.provider,
    collaboration?.runFollowApplication,
    editorRef,
    usesPlaybackModel,
  ]);
}
