import { useEffectEvent } from "react";
import { createCollaborationEditorViewport } from "../../collaboration/editorViewport";
import type { useOptionalCollaboration } from "../../contexts/CollaborationContext";
import { workspacePathFromMonacoModelUri, type monaco } from "../../monaco";

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

/**
 * What this member's editor tells the room: its caret and selection, unless
 * the y-monaco binding already publishes them, and its viewport, neither
 * while an overlay covers the editor; that it stops following someone the
 * moment it works in the editor itself; and, when its text loses focus, the
 * edits still waiting for the batch timer. Its callbacks read the latest
 * render, so the listeners CodeEditor registers once on mount can call them.
 */
export function useCollaborationPresence({
  collaboration,
  usesPlaybackModel,
  isEditorCovered,
  isBindingActive,
}: {
  collaboration: ReturnType<typeof useOptionalCollaboration>;
  usesPlaybackModel: boolean;
  isEditorCovered: boolean;
  /** Whether y-monaco is bound, and so publishes the selection itself. */
  isBindingActive: () => boolean;
}) {
  // Uncompiled, like the CodeEditor it was extracted from.
  "use no memo";
  const publishCursor = useEffectEvent((editor: StandaloneEditor | null) => {
    if (!collaboration?.provider || usesPlaybackModel || !editor || isEditorCovered) {
      return;
    }
    if (isBindingActive()) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const modelPath = workspacePathFromMonacoModelUri(model.uri);
    if (!modelPath) return;
    collaboration.updateCursor(
      modelPath,
      model.getOffsetAt({
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn,
      }),
      model.getOffsetAt({
        lineNumber: selection.positionLineNumber,
        column: selection.positionColumn,
      }),
    );
  });

  const publishViewport = useEffectEvent((editor: StandaloneEditor | null) => {
    if (!collaboration?.provider || usesPlaybackModel || !editor || isEditorCovered) {
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    const path = workspacePathFromMonacoModelUri(model.uri);
    const firstVisible = editor.getVisibleRanges()[0];
    if (!path || !firstVisible) return;
    const fileNodeId = collaboration.getNodeIdForPath(path);
    if (!fileNodeId) return;
    const topOffset = model.getOffsetAt({
      lineNumber: firstVisible.startLineNumber,
      column: 1,
    });
    const viewport = createCollaborationEditorViewport(
      collaboration.provider.doc,
      fileNodeId,
      topOffset,
      Math.max(0, editor.getScrollTop() - editor.getTopForLineNumber(firstVisible.startLineNumber)),
      editor.getScrollLeft(),
    );
    collaboration.publishSurface({ kind: "editor", fileNodeId, viewport });
  });

  const flushOnBlur = useEffectEvent(() => {
    void collaboration?.provider?.flushNow();
  });

  const stopFollowingForLocalIntent = useEffectEvent(
    (reason: "local-editor-input" | "local-scroll") => {
      collaboration?.stopFollowing(reason);
    },
  );

  /**
   * Stops following someone as soon as this member works in the editor
   * themselves: a key, a click, a paste or the start of IME composition counts
   * as editor input, the wheel as a local scroll. Returns the disposable that
   * removes those listeners again.
   */
  const listenForLocalIntent = (editor: StandaloneEditor): { dispose(): void } => {
    const editorDomNode = editor.getDomNode();
    const localIntentListeners: Array<{
      type: "keydown" | "pointerdown" | "wheel" | "paste" | "compositionstart";
      listener: EventListener;
    }> = [];
    if (editorDomNode) {
      const addLocalIntentListener = (
        type: (typeof localIntentListeners)[number]["type"],
        reason: "local-editor-input" | "local-scroll",
      ) => {
        const listener: EventListener = () => stopFollowingForLocalIntent(reason);
        editorDomNode.addEventListener(type, listener, {
          capture: true,
          passive: type === "wheel",
        });
        localIntentListeners.push({ type, listener });
      };
      addLocalIntentListener("keydown", "local-editor-input");
      addLocalIntentListener("pointerdown", "local-editor-input");
      addLocalIntentListener("wheel", "local-scroll");
      addLocalIntentListener("paste", "local-editor-input");
      addLocalIntentListener("compositionstart", "local-editor-input");
    }

    return {
      dispose: () => {
        if (!editorDomNode) return;
        for (const { type, listener } of localIntentListeners) {
          editorDomNode.removeEventListener(type, listener, true);
        }
      },
    };
  };

  return { publishCursor, publishViewport, flushOnBlur, listenForLocalIntent };
}
