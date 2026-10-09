import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import { collaborationTextForPath } from "../../collaboration/collaborationTextForPath";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import { trackCollaborationUndoOrigin } from "../../collaboration/undo";
import type { useOptionalCollaboration } from "../../contexts/CollaborationContext";
import { acknowledgeWorkspaceModelContent, monaco } from "../../monaco";
import type { TextEditEvent } from "../../types/textEdit";
import { yMonacoBindsModel } from "../remoteCursors";
import { createMonacoTextEditEvent } from "./textEditEvent";

// y-monaco transactions carry their MonacoBinding as the origin. Registered
// here, at module load and so before any binding exists, because undo.ts must
// not import y-monaco itself: that would put Monaco in the static closure of
// everything that reaches CollaborationContext.
trackCollaborationUndoOrigin(MonacoBinding);

const Y_MONACO_BINDING_ENABLED = import.meta.env.VITE_COLLABORATION_Y_MONACO !== "false";

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

function publishYMonacoSelection(
  provider: CollaborationRoomProvider,
  editor: StandaloneEditor,
  model: monaco.editor.ITextModel,
  text: Y.Text,
): void {
  const selection = editor.getSelection();
  if (!selection) return;
  let anchorOffset = model.getOffsetAt(selection.getStartPosition());
  let headOffset = model.getOffsetAt(selection.getEndPosition());
  if (selection.getDirection() === monaco.SelectionDirection.RTL) {
    [anchorOffset, headOffset] = [headOffset, anchorOffset];
  }
  provider.awareness.setLocalStateField("selection", {
    anchor: Y.createRelativePositionFromTypeIndex(text, anchorOffset),
    head: Y.createRelativePositionFromTypeIndex(text, headOffset),
  });
}

interface ActiveYMonacoBinding {
  binding: MonacoBinding;
  editor: StandaloneEditor;
  model: monaco.editor.ITextModel;
  provider: CollaborationRoomProvider;
  text: Y.Text;
  path: string;
}

/** How a local edit y-monaco owns was routed, for the change's performance span. */
export type YMonacoEditRoute = "binding-setup" | "incremental" | "direct-ytext";

/**
 * The y-monaco binding between the open file's Monaco model and its shared
 * text in the room. It is set up, replaced and torn down as the room, the
 * editor's model and this member's permissions change, publishes this
 * member's selection through awareness while it is bound, routes the local
 * edits it owns, and flushes the room's pending edits when a take stops.
 */
export function useYMonacoBinding({
  editorRef,
  collaboration,
  activeFilePath,
  activeModel,
  usesPlaybackModel,
  isBinaryActiveFile,
  isEditorCovered,
  isRecording,
}: {
  editorRef: RefObject<StandaloneEditor | null>;
  collaboration: ReturnType<typeof useOptionalCollaboration>;
  activeFilePath: string;
  activeModel: monaco.editor.ITextModel | null;
  usesPlaybackModel: boolean;
  isBinaryActiveFile: boolean;
  isEditorCovered: boolean;
  isRecording: boolean;
}) {
  // Uncompiled, like the CodeEditor it was extracted from, so its effects run
  // exactly when they did there.
  "use no memo";
  const yMonacoBindingRef = useRef<ActiveYMonacoBinding | null>(null);
  const isConfiguringYMonacoRef = useRef(false);

  const disposeYMonacoBinding = useEffectEvent((clearAwareness = true) => {
    const active = yMonacoBindingRef.current;
    yMonacoBindingRef.current = null;
    active?.binding.destroy();
    if (clearAwareness && active) {
      active.provider.awareness.setLocalStateField("selection", null);
    }
  });

  const reconcileYMonacoBinding = useEffectEvent((editor: StandaloneEditor | null) => {
    const provider = collaboration?.provider;
    const model = editor?.getModel();
    if (
      !Y_MONACO_BINDING_ENABLED ||
      !provider ||
      !collaboration.canWrite ||
      usesPlaybackModel ||
      isBinaryActiveFile ||
      !editor ||
      !model ||
      model !== activeModel
    ) {
      disposeYMonacoBinding();
      return false;
    }

    const text = collaborationTextForPath(collaboration, provider.doc, activeFilePath);
    if (!text) {
      disposeYMonacoBinding();
      return false;
    }

    const shouldPublishSelection = !isEditorCovered && !collaboration.followedParticipantKey;
    const current = yMonacoBindingRef.current;
    if (
      current?.editor === editor &&
      current.model === model &&
      current.provider === provider &&
      current.text === text &&
      current.path === activeFilePath
    ) {
      if (shouldPublishSelection) {
        publishYMonacoSelection(provider, editor, model, text);
      }
      return true;
    }

    disposeYMonacoBinding(false);
    isConfiguringYMonacoRef.current = true;
    try {
      const binding = new MonacoBinding(text, model, new Set([editor]), provider.awareness);
      yMonacoBindingRef.current = {
        binding,
        editor,
        model,
        provider,
        text,
        path: activeFilePath,
      };
      if (shouldPublishSelection) {
        publishYMonacoSelection(provider, editor, model, text);
      }
      return true;
    } catch {
      yMonacoBindingRef.current = null;
      provider.awareness.setLocalStateField("selection", null);
      return false;
    } finally {
      isConfiguringYMonacoRef.current = false;
    }
  });

  const queueCollaborationTextEdit = useEffectEvent(
    (editEvent: TextEditEvent, onProjected: (content: string | null) => void) => {
      collaboration?.queueLocalTextEdit(editEvent, onProjected);
    },
  );

  useLayoutEffect(() => {
    reconcileYMonacoBinding(editorRef.current);
  }, [
    activeFilePath,
    activeModel,
    collaboration?.canWrite,
    collaboration?.connectionState,
    collaboration?.followedParticipantKey,
    collaboration?.provider,
    isBinaryActiveFile,
    isEditorCovered,
    usesPlaybackModel,
  ]);

  const wasRecordingRef = useRef(isRecording);
  useEffect(() => {
    const stoppedRecording = wasRecordingRef.current && !isRecording;
    wasRecordingRef.current = isRecording;
    if (stoppedRecording) void collaboration?.provider?.flushNow();
  }, [collaboration?.provider, isRecording]);

  /**
   * Routes a local Monaco change y-monaco owns. One it makes while setting up
   * the binding is only recorded; one in the bound editor and model is queued
   * on the room's document, then recorded. Returns how it was routed, or null
   * for a change the binding does not own, which CodeEditor applies to the
   * workspace itself.
   */
  const routeLocalEdit = (
    editor: StandaloneEditor,
    changeEvent: monaco.editor.IModelContentChangedEvent,
    beforeVersion: number,
    onEditorChange: (textEdit?: TextEditEvent) => void,
  ): YMonacoEditRoute | null => {
    if (isConfiguringYMonacoRef.current) {
      onEditorChange();
      return "binding-setup";
    }
    const yMonacoBinding = yMonacoBindingRef.current;
    if (!yMonacoBindsModel(yMonacoBinding, editor, editor.getModel())) return null;
    const editEvent = changeEvent.isFlush
      ? null
      : createMonacoTextEditEvent(editor, changeEvent, beforeVersion);
    if (editEvent) {
      const editedModel = yMonacoBinding.model;
      queueCollaborationTextEdit(editEvent, (projectedContent) => {
        if (
          projectedContent !== null &&
          editor.getModel() === editedModel &&
          editedModel.getVersionId() === editEvent.afterVersion
        ) {
          acknowledgeWorkspaceModelContent(editedModel, projectedContent);
        }
      });
    }
    onEditorChange(editEvent ?? undefined);
    return editEvent ? "incremental" : "direct-ytext";
  };

  return {
    /** Binds, rebinds or unbinds `editor` to match the room and the open file. */
    reconcile: reconcileYMonacoBinding,
    /** Unbinds, clearing this member's awareness selection unless told not to. */
    dispose: disposeYMonacoBinding,
    /** The binding's editor, model and text, or null while nothing is bound. */
    getActive: (): Readonly<ActiveYMonacoBinding> | null => yMonacoBindingRef.current,
    routeLocalEdit,
  };
}
