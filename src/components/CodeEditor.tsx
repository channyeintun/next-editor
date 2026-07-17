import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useSelector } from "@xstate/store-react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWorkspaceActions,
  useWorkspaceEditorState,
  useWorkspaceLessonType,
  useWorkspaceProjectVersion,
  useWorkspaceSidebarState,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSaveWorkspace } from "../hooks/useWebContainerRuntime";
import { useRuntimeDockRecordedSnapshot } from "../hooks/useRuntimeDockRecordedSnapshot";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import type { EditorSelection } from "../core/src/types";
import type { UpstashRoomProvider } from "../collaboration/upstashRoomProvider";
import { selectIsCollapsed, selectIsFullHeight } from "../stores/runtimePanelStore";
import { lessonRunsInWebContainer } from "../types/workspace";
import type { TextEditEvent } from "../types/textEdit";
import {
  canWriteCollaborationDocument,
  projectCollaborationDocument,
} from "../collaboration/projectDocument";
import {
  collaborationParticipantColorIndex,
  resolveCollaborationCursor,
} from "../collaboration/relativePosition";
import EditorHeader from "./EditorHeader";
import FileSidebar from "./FileSidebar";
import BinaryFilePreview from "./BinaryFilePreview";
import TerminalPanel from "./TerminalPanel";
import {
  CollaborationCursorLabelManager,
  type CollaborationCursorLabel,
} from "./collaborationCursorLabels";
import {
  acknowledgeWorkspaceModelContent,
  disposePlaybackModels,
  getEditorOptions,
  isPlaybackModelUri,
  MonacoEditor,
  monaco,
  setActiveTheme,
  syncPlaybackModel,
  syncWorkspaceModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  type Monaco,
  workspacePathFromMonacoModelUri,
} from "../monaco";
import { startPerformanceSpan } from "../utils/performanceMetrics";

const Preview = lazy(() => import("./Preview"));

interface CodeEditorProps {
  language?: string;
  theme?: string;
  showImportExport?: boolean;
  breadcrumb?: ReactNode;
}

interface WorkspaceEventRecorderProps {
  handleWorkspaceEvent: (event?: { sidebarWidthDelta?: number }) => void;
  shouldTrackWorkspaceChanges: boolean;
}

function WorkspaceEventRecorder({
  handleWorkspaceEvent,
  shouldTrackWorkspaceChanges,
}: WorkspaceEventRecorderProps) {
  const sidebarState = useWorkspaceSidebarState();
  const projectVersion = useWorkspaceProjectVersion();
  const previousSidebarStateRef = useRef(sidebarState);
  const previousProjectVersionRef = useRef(projectVersion);
  const wasTrackingRef = useRef(false);

  useEffect(() => {
    if (!shouldTrackWorkspaceChanges) {
      previousSidebarStateRef.current = sidebarState;
      previousProjectVersionRef.current = projectVersion;
      wasTrackingRef.current = false;
      return;
    }

    if (!wasTrackingRef.current) {
      previousSidebarStateRef.current = sidebarState;
      previousProjectVersionRef.current = projectVersion;
      wasTrackingRef.current = true;
      return;
    }

    if (
      previousSidebarStateRef.current !== sidebarState ||
      previousProjectVersionRef.current !== projectVersion
    ) {
      const sidebarWidthDelta =
        sidebarState.sidebarWidth - previousSidebarStateRef.current.sidebarWidth;
      previousSidebarStateRef.current = sidebarState;
      previousProjectVersionRef.current = projectVersion;
      handleWorkspaceEvent({ sidebarWidthDelta });
    }
  }, [handleWorkspaceEvent, projectVersion, shouldTrackWorkspaceChanges, sidebarState]);

  return null;
}

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

function displayParticipantName(participant: { name: string | null; username: string }): string {
  return participant.name?.trim() || participant.username;
}

/**
 * CodeEditor Component - Monaco Editor wrapper with recording and replay capabilities
 */

const CodeEditorComponent: React.FC<CodeEditorProps> = ({
  language,
  theme = "next-editor-dark",
  showImportExport = false,
  breadcrumb,
}) => {
  // Opt out of the React Compiler. Monaco is a heavily imperative integration:
  // the active model is reconciled during render (syncWorkspaceModel /
  // syncPlaybackModel below) and the editor is wired through the
  // onMount/useEffectEvent callbacks. The compiler's auto-memoization has
  // disrupted that flow before (broken syntax highlighting), so this
  // component stays uncompiled. See [[react-compiler-babel-preset]].
  "use no memo";
  const { syncEditorRef, handleEditorChange, handleWorkspaceEvent, editorRef } =
    useNextEditorActions();
  const { applyFileTextEdits, saveProject, updateFileContent } = useWorkspaceActions();
  const saveWorkspace = useWebContainerRuntimeSaveWorkspace();
  const { activeFile } = useWorkspaceEditorState();
  const lessonType = useWorkspaceLessonType();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const collaboration = useOptionalCollaboration();
  const displayIsCollapsed = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
    : isCollapsed;
  const displayIsFullHeight = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
    : isFullHeight;
  const isRunnerDockFullHeight = displayIsFullHeight && !displayIsCollapsed;
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  const monacoRef = useRef<Monaco | null>(null);
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const isApplyingExternalModelValueRef = useRef(false);
  const pendingExternalModelCaptureRef = useRef(false);
  const modelVersionByUriRef = useRef(new Map<string, number>());
  const remoteDecorationIdsRef = useRef<string[]>([]);
  const remoteCursorLabelManagerRef = useRef<CollaborationCursorLabelManager | null>(null);
  const recordedRemoteCursorSignaturesRef = useRef(new Map<string, string>());
  const remoteCursorRecordingScopeRef = useRef<{
    provider: UpstashRoomProvider | null;
    path: string;
    isRecording: boolean;
  }>({ provider: null, path: "", isRecording: false });

  // Only subscribe to the flags we actually need for rendering decisions
  const { currentRecording, isPlaying, isRecording, usesPlaybackModel } = useNextEditorMetadata();
  // Binary assets (images, video, …) cannot be edited as text, so the Monaco
  // editor is swapped for a media preview and the editor sync paths are skipped.
  const isBinaryActiveFile = activeFile.encoding === "base64";
  const selectedLanguage = activeFile.language || language || "html";
  const editorModelPath = usesPlaybackModel
    ? toPlaybackModelPath(activeFile.path)
    : toMonacoModelPath(activeFile.path);
  const activeModel = useMemo(() => {
    if (isBinaryActiveFile) {
      return null;
    }

    if (usesPlaybackModel) {
      return syncPlaybackModel(monaco, activeFile.path, activeFile.content, selectedLanguage, {
        preserveExistingContent: true,
      });
    }

    isApplyingExternalModelValueRef.current = true;
    try {
      return syncWorkspaceModel(monaco, activeFile.path, activeFile.content, selectedLanguage);
    } finally {
      isApplyingExternalModelValueRef.current = false;
    }
  }, [
    activeFile.content,
    activeFile.path,
    isBinaryActiveFile,
    selectedLanguage,
    usesPlaybackModel,
  ]);

  // Stable options identity so MonacoEditor's updateOptions only runs when
  // playback state actually changes, not on every keystroke re-render.
  const collaborationReadOnly = Boolean(collaboration?.provider && !collaboration.canWrite);
  const editorOptions = useMemo(
    () => getEditorOptions(isPlaying, collaborationReadOnly),
    [collaborationReadOnly, isPlaying],
  );

  const syncActivePlaybackModel = useEffectEvent((monaco: Monaco) => {
    if (!usesPlaybackModel || isBinaryActiveFile) {
      return null;
    }

    return syncPlaybackModel(monaco, activeFile.path, activeFile.content, selectedLanguage, {
      preserveExistingContent: true,
    });
  });

  const syncPlaybackEditorModel = useEffectEvent((editor: StandaloneEditor | null) => {
    const monaco = monacoRef.current;

    if (!usesPlaybackModel || !monaco || !editor) {
      return false;
    }

    const playbackModel = syncActivePlaybackModel(monaco);

    if (playbackModel && editor.getModel() !== playbackModel) {
      editor.setModel(playbackModel);
    }

    syncEditorRef(editor);
    return true;
  });

  const disposePlaybackModelsIfIdle = useEffectEvent(
    (preservedUri: { toString(): string } | null = null) => {
      const monaco = monacoRef.current;

      if (!monaco || usesPlaybackModel) {
        return;
      }

      disposePlaybackModels(monaco, preservedUri);
    },
  );

  // useEffectEvent provides a stable function reference that always reads
  // the latest playback attachment value without causing dependency issues
  const onEditorChange = useEffectEvent(() => {
    if (usesPlaybackModel || isApplyingExternalModelValueRef.current) return;
    handleEditorChange();
  });

  const recordExternalModelChange = useEffectEvent(() => {
    if (usesPlaybackModel || !isRecording || !collaboration?.provider) return;
    handleEditorChange();
  });

  const recordRemoteSelection = useEffectEvent((selection: EditorSelection) => {
    if (usesPlaybackModel || !isRecording || !collaboration?.provider) return;
    handleEditorChange(selection);
  });

  const publishCollaborationCursor = useEffectEvent((editor: StandaloneEditor | null) => {
    if (!collaboration?.provider || usesPlaybackModel || !editor) return;
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

  const syncEditorContentToWorkspace = useEffectEvent((editor: StandaloneEditor | null) => {
    if (
      usesPlaybackModel ||
      !editor ||
      isBinaryActiveFile ||
      isApplyingExternalModelValueRef.current
    ) {
      return;
    }

    const modelUri = editor.getModel()?.uri;
    const modelPath = modelUri ? workspacePathFromMonacoModelUri(modelUri) : null;

    if (!modelPath) {
      return;
    }

    updateFileContent(modelPath, editor.getValue());
  });

  const applyEditorChangeToWorkspace = useEffectEvent(
    (
      editor: StandaloneEditor,
      changeEvent: monaco.editor.IModelContentChangedEvent,
      beforeVersion: number,
    ): "incremental" | "fallback" | "ignored" => {
      if (usesPlaybackModel || isBinaryActiveFile || isApplyingExternalModelValueRef.current) {
        return "ignored";
      }

      const model = editor.getModel();
      const modelPath = model ? workspacePathFromMonacoModelUri(model.uri) : null;
      if (!model || !modelPath) return "ignored";

      const changes: TextEditEvent["changes"] = changeEvent.changes.map((change) => ({
        offset: change.rangeOffset,
        deleteLength: change.rangeLength,
        text: change.text,
      }));
      const afterLength = model.getValueLength();
      const lengthDelta = changes.reduce(
        (total, change) => total + change.text.length - change.deleteLength,
        0,
      );
      const editEvent: TextEditEvent = {
        fileId: modelPath,
        path: modelPath,
        beforeVersion,
        afterVersion: changeEvent.versionId,
        beforeLength: afterLength - lengthDelta,
        afterLength,
        changes,
      };

      const acceptedContent = applyFileTextEdits(editEvent);
      if (acceptedContent !== null) {
        acknowledgeWorkspaceModelContent(model, acceptedContent);
        return "incremental";
      }

      // Bulk/programmatic changes and stale model events retain a correctness
      // fallback. Ordinary Monaco typing never takes this whole-model read.
      updateFileContent(modelPath, model.getValue());
      return "fallback";
    },
  );

  const runSaveAction = useEffectEvent(async () => {
    if (usesPlaybackModel) {
      return;
    }

    const editor = editorRef.current;

    if (editor) {
      syncEditorContentToWorkspace(editor);
    }

    try {
      await saveWorkspace();
    } finally {
      await saveProject();
    }
  });

  const onSaveShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isSaveShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";

    if (!isSaveShortcut) {
      return;
    }

    event.preventDefault();
    void runSaveAction();
  });

  const onCollaborationUndoShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!collaboration?.provider || !collaboration.canWrite || usesPlaybackModel) return;
    const editor = editorRef.current;
    const editorNode = editor?.getDomNode();
    if (!editorNode?.contains(editorNode.ownerDocument.activeElement)) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

    const key = event.key.toLowerCase();
    const isUndo = key === "z" && !event.shiftKey;
    const isRedo = key === "y" || (key === "z" && event.shiftKey);
    if (!isUndo && !isRedo) return;
    event.preventDefault();
    event.stopPropagation();
    if (isRedo) collaboration.redo();
    else collaboration.undo();
  });

  const focusEditorIfNeeded = useEffectEvent((editor: StandaloneEditor | null) => {
    if (!editor) {
      return;
    }

    const domNode = editor.getDomNode();

    if (domNode?.contains(domNode.ownerDocument.activeElement)) {
      return;
    }

    editor.focus();
  });

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      onCollaborationUndoShortcut(event);
      onSaveShortcut(event);
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, []);

  const disposeEditorListeners = () => {
    editorDisposablesRef.current.forEach((disposable) => {
      disposable.dispose();
    });
    editorDisposablesRef.current = [];
  };

  const saveNormalViewState = useEffectEvent((editor: StandaloneEditor | null) => {
    const model = editor?.getModel();

    if (!editor || !model || isPlaybackModelUri(model.uri)) {
      return;
    }

    viewStatesRef.current.set(model.uri.toString(), editor.saveViewState());
  });

  const restoreNormalViewState = useEffectEvent(
    (editor: StandaloneEditor, model: monaco.editor.ITextModel | null) => {
      if (!model || isPlaybackModelUri(model.uri)) {
        return;
      }

      const viewState = viewStatesRef.current.get(model.uri.toString());

      if (viewState) {
        editor.restoreViewState(viewState);
      }
    },
  );

  const detachEditorOnUnmount = useEffectEvent(() => {
    // The view state was already saved by MonacoEditor's onWillDispose — its
    // cleanup runs before this one and the editor is disposed by now.
    disposeEditorListeners();
    remoteCursorLabelManagerRef.current?.clear();
    const monaco = monacoRef.current;

    if (monaco) {
      // Preserve the active playback model: during StrictMode's dev-only
      // effect replay this teardown runs mid-cycle, and disposing the model
      // memoized in activeModel would hand the replayed editor a disposed
      // model. An idle leftover is disposed by disposePlaybackModelsIfIdle.
      disposePlaybackModels(monaco, usesPlaybackModel ? editorModelPath : null);
    }

    editorRef.current = null;
    syncEditorRef(null);
  });

  // True-unmount-only teardown, keyed on []. The body is destructive — it
  // detaches the editor from the machine and nulls the shared ref — so it must
  // never re-run on dependency identity churn: with function deps, one unstable
  // sender identity silently kills frame/cursor capture and replay (f280e83).
  useEffect(() => {
    return () => {
      detachEditorOnUnmount();
    };
  }, []);

  useEffect(() => {
    disposePlaybackModelsIfIdle(editorRef.current?.getModel()?.uri ?? null);
  }, [editorModelPath, editorRef, usesPlaybackModel]);

  useLayoutEffect(() => {
    const monaco = monacoRef.current;

    if (!monaco || !usesPlaybackModel) {
      return;
    }

    const editor = editorRef.current;

    syncPlaybackEditorModel(editor);
  }, [
    activeFile.content,
    activeFile.path,
    editorRef,
    selectedLanguage,
    syncEditorRef,
    usesPlaybackModel,
  ]);

  useLayoutEffect(() => {
    setActiveTheme(theme);
  }, [theme]);

  useLayoutEffect(() => {
    if (!pendingExternalModelCaptureRef.current) return;
    pendingExternalModelCaptureRef.current = false;
    recordExternalModelChange();
  }, [activeFile.content, activeFile.path]);

  useEffect(() => {
    monacoRef.current = monaco;
    syncActivePlaybackModel(monaco);
  }, [syncActivePlaybackModel]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    syncEditorRef(editor);
  }, [editorModelPath, editorRef, syncEditorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const cursorLabelManager =
      remoteCursorLabelManagerRef.current ?? new CollaborationCursorLabelManager();
    remoteCursorLabelManagerRef.current = cursorLabelManager;
    if (!editor || !model || !collaboration?.provider || !collaboration.doc) {
      cursorLabelManager.clear();
      if (editor && remoteDecorationIdsRef.current.length > 0) {
        remoteDecorationIdsRef.current = editor.deltaDecorations(
          remoteDecorationIdsRef.current,
          [],
        );
      }
      return;
    }
    let activeFileNodeId: string | undefined;
    try {
      activeFileNodeId = projectCollaborationDocument(collaboration.doc).nodeIdByPath.get(
        activeFile.path,
      );
    } catch {
      cursorLabelManager.clear();
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const cursorLabels: CollaborationCursorLabel[] = [];
    for (const participant of collaboration.participants) {
      if (
        participant.sessionId === collaboration.provider.awarenessSessionId ||
        !participant.cursor ||
        participant.cursor.fileNodeId !== activeFileNodeId
      ) {
        continue;
      }
      const cursor = resolveCollaborationCursor(collaboration.doc, participant.cursor);
      if (!cursor) continue;
      const anchor = model.getPositionAt(cursor.anchorOffset);
      const head = model.getPositionAt(cursor.headOffset);
      const startsBeforeHead = cursor.anchorOffset <= cursor.headOffset;
      const start = startsBeforeHead ? anchor : head;
      const end = startsBeforeHead ? head : anchor;
      const color = collaborationParticipantColorIndex(participant);
      const participantName = displayParticipantName(participant);
      if (cursor.anchorOffset !== cursor.headOffset) {
        decorations.push({
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: {
            className: `collaboration-selection collaboration-color-${color}`,
            hoverMessage: { value: participantName },
          },
        });
      }
      decorations.push({
        range: new monaco.Range(head.lineNumber, head.column, head.lineNumber, head.column),
        options: {
          beforeContentClassName: `collaboration-cursor collaboration-color-${color}`,
          hoverMessage: { value: participantName },
        },
      });
      cursorLabels.push({
        id: `${participant.actorId}:${participant.sessionId}`,
        name: participantName,
        colorIndex: color,
        position: head,
      });
    }
    cursorLabelManager.reconcile(editor, cursorLabels, [
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
  }, [activeFile.path, collaboration?.doc, collaboration?.participants, collaboration?.provider]);

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
    const currentSignatures = new Map<string, string>();
    const changedSelections: Array<{
      key: string;
      occurredAt: number;
      selection: EditorSelection;
    }> = [];

    if (editor && model && provider && collaborationDoc && !usesPlaybackModel) {
      let activeFileNodeId: string | undefined;
      try {
        activeFileNodeId = projectCollaborationDocument(collaborationDoc).nodeIdByPath.get(
          activeFile.path,
        );
      } catch {
        activeFileNodeId = undefined;
      }

      for (const participant of participants) {
        if (
          participant.sessionId === provider.awarenessSessionId ||
          !participant.cursor ||
          participant.cursor.fileNodeId !== activeFileNodeId ||
          !canWriteCollaborationDocument(participant.role)
        ) {
          continue;
        }
        const cursor = resolveCollaborationCursor(collaborationDoc, participant.cursor);
        if (!cursor) continue;
        const key = `${participant.actorId}:${participant.sessionId}`;
        const signature = `${cursor.anchorOffset}:${cursor.headOffset}`;
        currentSignatures.set(key, signature);
        if (
          !scopeChanged &&
          isRecording &&
          recordedRemoteCursorSignaturesRef.current.get(key) !== signature
        ) {
          const anchor = model.getPositionAt(cursor.anchorOffset);
          const head = model.getPositionAt(cursor.headOffset);
          const startsBeforeHead = cursor.anchorOffset <= cursor.headOffset;
          const start = startsBeforeHead ? anchor : head;
          const end = startsBeforeHead ? head : anchor;
          changedSelections.push({
            key,
            occurredAt: participant.occurredAt,
            selection: {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
              selectionStartLineNumber: anchor.lineNumber,
              selectionStartColumn: anchor.column,
              positionLineNumber: head.lineNumber,
              positionColumn: head.column,
            },
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

    if (!isRecording || scopeChanged || changedSelections.length === 0) return;
    changedSelections.sort(
      (left, right) => right.occurredAt - left.occurredAt || left.key.localeCompare(right.key),
    );
    recordRemoteSelection(changedSelections[0].selection);
  }, [
    activeFile.content,
    activeFile.path,
    collaboration?.doc,
    collaboration?.participants,
    collaboration?.provider,
    editorRef,
    isRecording,
    usesPlaybackModel,
  ]);

  useEffect(() => {
    if (isPlaying) {
      focusEditorIfNeeded(editorRef.current);
    }
  }, [editorRef, isPlaying]);

  // MonacoEditor unmounts while a binary asset is shown; drop the stale
  // editor reference so recording/save paths don't touch a disposed instance.
  // (The view state was saved by onWillDispose before the editor was disposed.)
  useEffect(() => {
    if (isBinaryActiveFile) {
      disposeEditorListeners();
      editorRef.current = null;
      syncEditorRef(null);
    }
  }, [editorRef, isBinaryActiveFile, syncEditorRef]);

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   */
  const handleEditorDidMount = (editor: StandaloneEditor) => {
    disposeEditorListeners();
    editorRef.current = editor;
    syncEditorRef(editor);
    const mountedModel = editor.getModel();
    if (mountedModel) {
      modelVersionByUriRef.current.set(mountedModel.uri.toString(), mountedModel.getVersionId());
    }
    restoreNormalViewState(editor, editor.getModel());

    focusEditorIfNeeded(editor);

    editorDisposablesRef.current = [
      editor.onDidChangeModel(() => {
        const model = editor.getModel();
        if (model) {
          modelVersionByUriRef.current.set(model.uri.toString(), model.getVersionId());
        }
        if (syncPlaybackEditorModel(editor)) {
          return;
        }

        disposePlaybackModelsIfIdle(editor.getModel()?.uri ?? null);
        syncEditorRef(editor);
        publishCollaborationCursor(editor);
      }),
      editor.onDidChangeModelContent((changeEvent) => {
        const endChangeSpan = startPerformanceSpan("editor.model_change");
        const modelKey = editor.getModel()?.uri.toString();
        const beforeVersion = modelKey
          ? (modelVersionByUriRef.current.get(modelKey) ?? Math.max(0, changeEvent.versionId - 1))
          : Math.max(0, changeEvent.versionId - 1);
        if (modelKey) modelVersionByUriRef.current.set(modelKey, changeEvent.versionId);
        // syncWorkspaceModel can synchronously emit Monaco events while React
        // is rendering. Check the ref before entering a useEffectEvent wrapper,
        // which React intentionally rejects during render (error #440).
        if (isApplyingExternalModelValueRef.current) {
          pendingExternalModelCaptureRef.current = true;
          endChangeSpan({ source: "external" });
          return;
        }
        const updateMode = applyEditorChangeToWorkspace(editor, changeEvent, beforeVersion);
        onEditorChange();
        endChangeSpan({
          source: "local",
          update_mode: updateMode,
          change_count: changeEvent.changes.length,
        });
      }),
      editor.onDidChangeCursorPosition(() => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
        publishCollaborationCursor(editor);
      }),
      editor.onDidChangeCursorSelection(() => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
        publishCollaborationCursor(editor);
      }),
      editor.onDidScrollChange(() => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
      }),
    ];
  };

  return (
    <div className="h-full flex flex-col" data-cursor-replay-target="workspace">
      <WorkspaceEventRecorder
        handleWorkspaceEvent={handleWorkspaceEvent}
        shouldTrackWorkspaceChanges={isRecording || Boolean(currentRecording)}
      />
      <EditorHeader showImportExport={showImportExport} breadcrumb={breadcrumb} />
      <div
        className="flex min-h-0 flex-1 overflow-hidden"
        data-cursor-replay-target="workspace-body"
      >
        <FileSidebar />
        {/* Monaco Editor */}
        <div
          className="flex min-w-0 flex-1 gap-2 overflow-hidden bg-[#11141c]"
          data-cursor-replay-target="editor-and-preview"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
            <div
              className={
                "editor-paint-layer min-h-0 flex-1 overflow-hidden rounded-t-md" +
                (isPlaying ? " playback-mode" : "") +
                (isRunnerDockFullHeight ? " hidden" : "")
              }
              data-cursor-replay-target="code-editor"
            >
              {isBinaryActiveFile || !activeModel ? (
                <BinaryFilePreview file={activeFile} />
              ) : (
                <MonacoEditor
                  className="size-full"
                  model={activeModel}
                  onMount={handleEditorDidMount}
                  onBeforeModelChange={saveNormalViewState}
                  onAfterModelChange={restoreNormalViewState}
                  onWillDispose={saveNormalViewState}
                  options={editorOptions}
                />
              )}
            </div>
            {lessonRunsInWebContainer(lessonType) ? <TerminalPanel /> : null}
          </div>
          <Suspense fallback={null}>
            <Preview />
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default CodeEditorComponent;
