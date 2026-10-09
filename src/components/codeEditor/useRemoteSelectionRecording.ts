import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { collaborationTextForPath } from "../../collaboration/collaborationTextForPath";
import { resolveMonacoAwarenessSelections } from "../../collaboration/monacoAwareness";
import { canPublishCollaborationUpdate } from "../../collaboration/protocol";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import type { useOptionalCollaboration } from "../../contexts/CollaborationContext";
import type { NextEditorActions } from "../../contexts/NextEditorContext";
import type { EditorSelection } from "../../core/src/types";
import type { monaco } from "../../monaco";
import type { WorkspaceFile } from "../../types/workspace";
import {
  collectRemoteEditorSelections,
  remoteSelectionToEditorSelection,
  resolveAwarenessText,
  resolveRemoteSelection,
  type YMonacoBindingTarget,
} from "../remoteCursors";

/**
 * During a take, records the other participants' selections in the open
 * file into the cursor track: on each run, the most recent one that moved
 * since the run before. A take's first run in a room and file only takes
 * that baseline, and a viewer's selection is never recorded.
 */
export function useRemoteSelectionRecording({
  editorRef,
  collaboration,
  activeFile,
  usesPlaybackModel,
  isRecording,
  handleEditorChange,
  getYMonacoBinding,
}: {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  collaboration: ReturnType<typeof useOptionalCollaboration>;
  activeFile: Pick<WorkspaceFile, "path" | "content">;
  usesPlaybackModel: boolean;
  isRecording: boolean;
  handleEditorChange: NextEditorActions["handleEditorChange"];
  getYMonacoBinding: () => YMonacoBindingTarget | null;
}) {
  // Uncompiled, like the CodeEditor it was extracted from, so its effect runs
  // exactly when it did there.
  "use no memo";
  const recordedRemoteCursorSignaturesRef = useRef(new Map<string, string>());
  const remoteCursorRecordingScopeRef = useRef<{
    provider: CollaborationRoomProvider | null;
    path: string;
    isRecording: boolean;
  }>({ provider: null, path: "", isRecording: false });

  const recordRemoteSelection = useEffectEvent((selection: EditorSelection) => {
    if (usesPlaybackModel || !isRecording || !collaboration?.provider) return;
    handleEditorChange(selection);
  });

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const provider = collaboration?.provider ?? null;
    const collaborationDoc = collaboration?.doc ?? null;
    const participants = collaboration?.participants ?? [];
    const scope = remoteCursorRecordingScopeRef.current;
    const scopeChanged =
      scope.provider !== provider ||
      scope.path !== activeFile.path ||
      scope.isRecording !== isRecording;
    // Outside a take nothing is recorded, and a take's first run finds its
    // scope changed and starts from a fresh baseline, so there is nothing to
    // resolve until then. The scope is still kept for that first run.
    if (!isRecording) {
      recordedRemoteCursorSignaturesRef.current = new Map();
      remoteCursorRecordingScopeRef.current = { provider, path: activeFile.path, isRecording };
      return;
    }
    const currentSignatures = new Map<string, string>();
    const changedSelections: Array<{
      key: string;
      occurredAt: number;
      selection: EditorSelection;
    }> = [];

    if (editor && model && collaboration && provider && collaborationDoc && !usesPlaybackModel) {
      const { text: awarenessText } = resolveAwarenessText(getYMonacoBinding(), editor, model, () =>
        collaborationTextForPath(collaboration, collaborationDoc, activeFile.path),
      );
      for (const { key, participant, anchorOffset, headOffset } of collectRemoteEditorSelections({
        awarenessSelections: awarenessText
          ? resolveMonacoAwarenessSelections(provider.awareness, awarenessText)
          : [],
        doc: collaborationDoc,
        participants,
        ownParticipantKey: collaboration.ownParticipantKey,
        activeFileNodeId: collaboration.getNodeIdForPath(activeFile.path) ?? undefined,
      })) {
        // A viewer's selection is drawn, but never recorded.
        if (!canPublishCollaborationUpdate(participant.role)) continue;
        const signature = `${anchorOffset}:${headOffset}`;
        currentSignatures.set(key, signature);
        if (!scopeChanged && recordedRemoteCursorSignaturesRef.current.get(key) !== signature) {
          changedSelections.push({
            key,
            occurredAt: participant.occurredAt,
            selection: remoteSelectionToEditorSelection(
              resolveRemoteSelection(model, anchorOffset, headOffset),
            ),
          });
        }
      }
    }

    recordedRemoteCursorSignaturesRef.current = currentSignatures;
    remoteCursorRecordingScopeRef.current = {
      provider,
      path: activeFile.path,
      isRecording,
    };

    if (scopeChanged || changedSelections.length === 0) return;
    changedSelections.sort(
      (left, right) => right.occurredAt - left.occurredAt || left.key.localeCompare(right.key),
    );
    recordRemoteSelection(changedSelections[0].selection);
  }, [
    activeFile.content,
    activeFile.path,
    collaboration?.doc,
    collaboration?.getNodeIdForPath,
    collaboration?.ownParticipantKey,
    collaboration?.participants,
    collaboration?.provider,
    editorRef,
    isRecording,
    usesPlaybackModel,
  ]);
}
