import { useEffect, useRef, type RefObject } from "react";
import { collaborationTextForPath } from "../../collaboration/collaborationTextForPath";
import { resolveMonacoAwarenessSelections } from "../../collaboration/monacoAwareness";
import { collaborationParticipantColorIndex } from "../../collaboration/relativePosition";
import type { useOptionalCollaboration } from "../../contexts/CollaborationContext";
import { monaco } from "../../monaco";
import {
  CollaborationCursorLabelManager,
  type CollaborationCursorLabel,
} from "../collaborationCursorLabels";
import { collaboratorDisplayName } from "../collaboratorAppearance";
import {
  collectRemoteEditorSelections,
  participantCursorDecorations,
  remoteSelectionDecorations,
  resolveAwarenessText,
  resolveRemoteSelection,
  yMonacoSelectionStyleRules,
  type YMonacoBindingTarget,
} from "../remoteCursors";

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

/**
 * Draws the other participants' selections in the open file: carets with
 * name labels, highlights over selected text, and the colours of the
 * selections y-monaco draws itself while it is bound to this editor.
 */
export function useRemoteCursorDecorations({
  editorRef,
  collaboration,
  activeFilePath,
  getYMonacoBinding,
}: {
  editorRef: RefObject<StandaloneEditor | null>;
  collaboration: ReturnType<typeof useOptionalCollaboration>;
  activeFilePath: string;
  getYMonacoBinding: () => YMonacoBindingTarget | null;
}) {
  // Uncompiled, like the CodeEditor it was extracted from, so its effect runs
  // exactly when it did there.
  "use no memo";
  const remoteDecorationIdsRef = useRef<string[]>([]);
  const remoteCursorLabelManagerRef = useRef<CollaborationCursorLabelManager | null>(null);
  const remoteAwarenessStyleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const cursorLabelManager =
      remoteCursorLabelManagerRef.current ?? new CollaborationCursorLabelManager();
    remoteCursorLabelManagerRef.current = cursorLabelManager;
    if (!editor || !model || !collaboration?.provider || !collaboration.doc) {
      cursorLabelManager.clear();
      remoteAwarenessStyleRef.current?.remove();
      remoteAwarenessStyleRef.current = null;
      if (editor && remoteDecorationIdsRef.current.length > 0) {
        remoteDecorationIdsRef.current = editor.deltaDecorations(
          remoteDecorationIdsRef.current,
          [],
        );
      }
      return;
    }
    const collaborationDoc = collaboration.doc;
    const { text: awarenessText, yMonacoRendersSelections } = resolveAwarenessText(
      getYMonacoBinding(),
      editor,
      model,
      () => collaborationTextForPath(collaboration, collaborationDoc, activeFilePath),
    );
    const activeFileNodeId = collaboration.getNodeIdForPath(activeFilePath) ?? undefined;
    const labels: CollaborationCursorLabel[] = [];
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const styleRules: string[] = [];
    for (const selection of collectRemoteEditorSelections({
      awarenessSelections: awarenessText
        ? resolveMonacoAwarenessSelections(collaboration.provider.awareness, awarenessText)
        : [],
      doc: collaborationDoc,
      participants: collaboration.participants,
      ownParticipantKey: collaboration.ownParticipantKey,
      activeFileNodeId,
    })) {
      if (!selection.fromAwareness) {
        const drawn = participantCursorDecorations(
          model,
          selection.key,
          selection.participant,
          selection,
        );
        decorations.push(...drawn.decorations);
        labels.push(drawn.label);
        continue;
      }
      const colorIndex = collaborationParticipantColorIndex(selection.participant);
      const name = collaboratorDisplayName(selection.participant);
      if (yMonacoRendersSelections) {
        styleRules.push(...yMonacoSelectionStyleRules(selection.clientId, colorIndex));
      } else {
        decorations.push(
          ...remoteSelectionDecorations(
            resolveRemoteSelection(model, selection.anchorOffset, selection.headOffset),
            colorIndex,
            name,
          ),
        );
      }
      labels.push({
        id: selection.key,
        name,
        colorIndex,
        position: model.getPositionAt(selection.headOffset),
      });
    }
    if (awarenessText) {
      if (styleRules.length > 0) {
        let style = remoteAwarenessStyleRef.current;
        if (!style) {
          style = document.createElement("style");
          style.dataset.nextEditorCollaborationAwareness = "true";
          document.head.append(style);
          remoteAwarenessStyleRef.current = style;
        }
        // The rules follow client ids and colours, not anyone's cursor, so
        // most runs leave them as they are.
        const css = styleRules.join("\n");
        if (style.textContent !== css) style.textContent = css;
      } else {
        remoteAwarenessStyleRef.current?.remove();
        remoteAwarenessStyleRef.current = null;
      }
      cursorLabelManager.reconcile(editor, labels, [
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
        monaco.editor.ContentWidgetPositionPreference.BELOW,
      ]);
      remoteDecorationIdsRef.current = editor.deltaDecorations(
        remoteDecorationIdsRef.current,
        decorations,
      );
      return;
    }
    remoteAwarenessStyleRef.current?.remove();
    remoteAwarenessStyleRef.current = null;
    if (!activeFileNodeId) {
      cursorLabelManager.clear();
      remoteDecorationIdsRef.current = editor.deltaDecorations(remoteDecorationIdsRef.current, []);
      return;
    }
    cursorLabelManager.reconcile(editor, labels, [
      monaco.editor.ContentWidgetPositionPreference.ABOVE,
      monaco.editor.ContentWidgetPositionPreference.BELOW,
    ]);
    remoteDecorationIdsRef.current = editor.deltaDecorations(
      remoteDecorationIdsRef.current,
      decorations,
    );
    return () => {
      if (editorRef.current === editor) {
        remoteDecorationIdsRef.current = editor.deltaDecorations(
          remoteDecorationIdsRef.current,
          [],
        );
      }
    };
  }, [
    activeFilePath,
    collaboration?.canWrite,
    collaboration?.connectionState,
    collaboration?.doc,
    collaboration?.getNodeIdForPath,
    collaboration?.ownParticipantKey,
    collaboration?.participants,
    collaboration?.provider,
  ]);

  return {
    /** Removes the name labels and the selection colours, for the editor's unmount. */
    clear: () => {
      remoteCursorLabelManagerRef.current?.clear();
      remoteAwarenessStyleRef.current?.remove();
      remoteAwarenessStyleRef.current = null;
    },
  };
}
