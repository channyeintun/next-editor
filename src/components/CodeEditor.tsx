import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWorkspaceActions,
  useWorkspaceEditorState,
  useWorkspaceLessonType,
  useWorkspaceTreeVersion,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSaveWorkspace } from "../hooks/useWebContainerRuntime";
import { useRuntimeDockLayout } from "../hooks/useRuntimeDockLayout";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { isWorkspaceTextFile, lessonSupportsPreview } from "../types/workspace";
import type { TextEditEvent } from "../types/textEdit";
import EditorHeader from "./EditorHeader";
import FileSidebar from "./FileSidebar";
import { WorkspaceEventRecorder } from "./WorkspaceEventRecorder";
import BinaryFilePreview from "./BinaryFilePreview";
import RuntimeDock from "./terminalPanel/RuntimeDock";
import { createMonacoTextEditEvent } from "./codeEditor/textEditEvent";
import { useCollaborationPresence } from "./codeEditor/useCollaborationPresence";
import { useFollowViewport } from "./codeEditor/useFollowViewport";
import { useRemoteCursorDecorations } from "./codeEditor/useRemoteCursorDecorations";
import { useRemoteSelectionRecording } from "./codeEditor/useRemoteSelectionRecording";
import { useYMonacoBinding } from "./codeEditor/useYMonacoBinding";
import {
  acknowledgeWorkspaceModelContent,
  disposePlaybackModels,
  disposeRemovedWorkspaceModels,
  getEditorOptions,
  isPlaybackModelUri,
  MonacoEditor,
  monaco,
  getOrCreatePlaybackModel,
  syncWorkspaceModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  type Monaco,
  workspacePathFromMonacoModelUri,
} from "../monaco";
import { startPerformanceSpan } from "../utils/performanceMetrics";
import { useSlidesContext } from "../contexts/SlidesContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { mayTakeFocus } from "./mayTakeFocus";
import { addEscapeThenTabExit, LEAVE_EDITOR_HINT } from "./editorTabFocus";

const Preview = lazy(() => import("./Preview"));
interface CodeEditorProps {
  showImportExport?: boolean;
  breadcrumb?: ReactNode;
}

type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;

/**
 * CodeEditor Component - Monaco Editor wrapper with recording and replay capabilities
 */

const CodeEditorComponent: React.FC<CodeEditorProps> = ({
  showImportExport = false,
  breadcrumb,
}) => {
  // Opt out of the React Compiler. Monaco is a heavily imperative integration:
  // the active model is reconciled during render (syncWorkspaceModel /
  // getOrCreatePlaybackModel below) and the editor is wired through the
  // onMount/useEffectEvent callbacks. The compiler's auto-memoization has
  // disrupted that flow before (broken syntax highlighting), so this
  // component stays uncompiled. See [[react-compiler-babel-preset]].
  "use no memo";
  const { syncEditorRef, handleEditorChange, handleWorkspaceEvent, editorRef } =
    useNextEditorActions();
  const { applyFileTextEdits, getProject, saveProject, updateFileContent } = useWorkspaceActions();
  const saveWorkspace = useWebContainerRuntimeSaveWorkspace();
  const { activeFile } = useWorkspaceEditorState();
  const lessonType = useWorkspaceLessonType();
  const treeVersion = useWorkspaceTreeVersion();
  // The dock's on-screen layout, so the editor hides behind a full-height dock
  // exactly when the dock shows itself full height (the viewer's choice included).
  const { fillsColumn: isRunnerDockFullHeight } = useRuntimeDockLayout();
  const collaboration = useOptionalCollaboration();
  const slidesContext = useSlidesContext();
  const whiteboardContext = useWhiteboardContext();
  // Slides or the whiteboard cover the editor, so this member's published
  // surface is that overlay (see CollaborationSurfaceBridge); the editor's
  // selection, cursor and viewport are not published over it.
  const isEditorCovered = slidesContext.previewState.isOpen || whiteboardContext.isOpen;
  // A maximized slide deck or the whiteboard is drawn over the whole workspace
  // (a non-maximized deck is not drawn at all). While one is, the workspace is
  // inert: keyboard focus and screen readers cannot reach controls hidden under
  // the overlay's scrim, just as a pointer cannot. The player bar sits outside.
  const isWorkspaceCovered =
    (slidesContext.previewState.isOpen && slidesContext.previewState.isMaximized === true) ||
    whiteboardContext.isOpen;
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  const monacoRef = useRef<Monaco | null>(null);
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const isApplyingExternalModelValueRef = useRef(false);
  const pendingExternalModelCaptureRef = useRef(false);
  const modelVersionByUriRef = useRef(new Map<string, number>());

  // Only subscribe to the flags we actually need for rendering decisions
  const { currentRecording, isPlaying, isRecording, usesPlaybackModel } = useNextEditorMetadata();
  // Binary assets (images, video, …) cannot be edited as text, so the Monaco
  // editor is swapped for a media preview and the editor sync paths are skipped.
  const isBinaryActiveFile = !isWorkspaceTextFile(activeFile);
  const activeTextContent = isWorkspaceTextFile(activeFile) ? activeFile.content : "";
  const selectedLanguage = activeFile.language || "html";
  const editorModelPath = usesPlaybackModel
    ? toPlaybackModelPath(activeFile.path)
    : toMonacoModelPath(activeFile.path);
  const activeModel = useMemo(() => {
    if (isBinaryActiveFile) {
      return null;
    }

    if (usesPlaybackModel) {
      return getOrCreatePlaybackModel(monaco, activeFile.path, activeTextContent, selectedLanguage);
    }

    isApplyingExternalModelValueRef.current = true;
    try {
      return syncWorkspaceModel(monaco, activeFile.path, activeTextContent, selectedLanguage);
    } finally {
      isApplyingExternalModelValueRef.current = false;
    }
  }, [activeTextContent, activeFile.path, isBinaryActiveFile, selectedLanguage, usesPlaybackModel]);

  // Stable options identity so MonacoEditor's updateOptions only runs when
  // playback state or the open file actually changes, not on every keystroke
  // re-render. The accessible name says which file is open and how to leave.
  const collaborationReadOnly = Boolean(collaboration?.provider && !collaboration.canWrite);
  const editorOptions = useMemo(
    () => ({
      ...getEditorOptions(isPlaying, collaborationReadOnly),
      ariaLabel: `${activeFile.path}, code editor. ${LEAVE_EDITOR_HINT}`,
    }),
    [activeFile.path, collaborationReadOnly, isPlaying],
  );

  const syncActivePlaybackModel = useEffectEvent((monaco: Monaco) => {
    if (!usesPlaybackModel || isBinaryActiveFile) {
      return null;
    }

    return getOrCreatePlaybackModel(monaco, activeFile.path, activeTextContent, selectedLanguage);
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
  const onEditorChange = useEffectEvent((textEdit?: TextEditEvent) => {
    if (usesPlaybackModel || isApplyingExternalModelValueRef.current) return;
    handleEditorChange(undefined, textEdit);
  });

  const recordExternalModelChange = useEffectEvent(() => {
    if (usesPlaybackModel || !isRecording || !collaboration?.provider) return;
    handleEditorChange();
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
    ): {
      mode: "incremental" | "fallback" | "ignored";
      editEvent?: TextEditEvent;
    } => {
      if (usesPlaybackModel || isBinaryActiveFile || isApplyingExternalModelValueRef.current) {
        return { mode: "ignored" };
      }

      const model = editor.getModel();
      if (!model) return { mode: "ignored" };
      const editEvent = createMonacoTextEditEvent(editor, changeEvent, beforeVersion);
      if (!editEvent) return { mode: "ignored" };

      const acceptedContent = applyFileTextEdits(editEvent);
      if (acceptedContent !== null) {
        acknowledgeWorkspaceModelContent(model, acceptedContent);
        return { mode: "incremental", editEvent };
      }

      // Bulk/programmatic changes and stale model events retain a correctness
      // fallback. Ordinary Monaco typing never takes this whole-model read.
      updateFileContent(editEvent.path, model.getValue());
      return { mode: "fallback" };
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

    await collaboration?.provider?.flushNow();

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

    if (!mayTakeFocus(domNode)) {
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
    yMonacoBinding.dispose();
    remoteCursorDecorations.clear();
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

  // A file leaves the project only through a topology change (delete, rename, a
  // different project), which bumps treeVersion. Release its model then; the
  // one the editor shows and the one the collaboration binding holds are kept.
  useEffect(() => {
    const disposedUris = disposeRemovedWorkspaceModels(monaco, getProject().files, [
      yMonacoBinding.getActive()?.model,
    ]);
    for (const uri of disposedUris) {
      viewStatesRef.current.delete(uri);
      modelVersionByUriRef.current.delete(uri);
    }
  }, [treeVersion]);

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
    if (!pendingExternalModelCaptureRef.current) return;
    pendingExternalModelCaptureRef.current = false;
    recordExternalModelChange();
  }, [activeFile.content, activeFile.path]);

  // syncActivePlaybackModel is a useEffectEvent, and React 19.3 returns a new
  // function for it on every render, so this effect runs after every commit,
  // not once. It is also the only place monacoRef is set: until it first runs,
  // the playback layout effect above finds no Monaco and does nothing.
  useEffect(() => {
    monacoRef.current = monaco;
    syncActivePlaybackModel(monaco);
  }, [syncActivePlaybackModel]);

  const presence = useCollaborationPresence({
    collaboration,
    usesPlaybackModel,
    isEditorCovered,
    isBindingActive: () => yMonacoBinding.getActive() !== null,
  });

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    syncEditorRef(editor);
    presence.publishCursor(editor);
    presence.publishViewport(editor);
  }, [
    editorModelPath,
    editorRef,
    slidesContext.previewState.isOpen,
    syncEditorRef,
    whiteboardContext.isOpen,
  ]);

  // The room's side of the editor. These hooks sit here, after the playback
  // layout effects above, so their effects keep their place in each commit;
  // the code above reaches the binding and the decorations only from
  // callbacks that run after render.
  const yMonacoBinding = useYMonacoBinding({
    editorRef,
    collaboration,
    activeFilePath: activeFile.path,
    activeModel,
    usesPlaybackModel,
    isBinaryActiveFile,
    isEditorCovered,
    isRecording,
  });
  useFollowViewport({ editorRef, collaboration, activeFile, activeModel, usesPlaybackModel });
  const remoteCursorDecorations = useRemoteCursorDecorations({
    editorRef,
    collaboration,
    activeFilePath: activeFile.path,
    getYMonacoBinding: yMonacoBinding.getActive,
  });
  useRemoteSelectionRecording({
    editorRef,
    collaboration,
    activeFile,
    usesPlaybackModel,
    isRecording,
    handleEditorChange,
    getYMonacoBinding: yMonacoBinding.getActive,
  });

  // Also re-runs when an overlay closes mid-playback: going inert blurred the
  // editor, and Monaco hides its caret without focus.
  useEffect(() => {
    if (isPlaying && !isWorkspaceCovered) {
      focusEditorIfNeeded(editorRef.current);
    }
  }, [editorRef, isPlaying, isWorkspaceCovered]);

  // MonacoEditor unmounts while a binary asset is shown; drop the stale
  // editor reference so recording/save paths don't touch a disposed instance.
  // (The view state was saved by onWillDispose before the editor was disposed.)
  useEffect(() => {
    if (isBinaryActiveFile) {
      disposeEditorListeners();
      yMonacoBinding.dispose();
      editorRef.current = null;
      syncEditorRef(null);
    }
  }, [editorRef, isBinaryActiveFile, syncEditorRef]);

  /**
   * Routes one Monaco content change. A change CodeEditor itself writes into
   * the model during render is only flagged, for a layout effect to record
   * after the render; one y-monaco makes while setting up its binding is only
   * recorded. Otherwise the edit is queued on the room's document when y-monaco
   * is bound to this editor, or applied to the workspace. Every path ends the
   * change's performance span.
   */
  const handleModelContentChange = (
    editor: StandaloneEditor,
    changeEvent: monaco.editor.IModelContentChangedEvent,
  ) => {
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
    const yMonacoRoute = yMonacoBinding.routeLocalEdit(
      editor,
      changeEvent,
      beforeVersion,
      onEditorChange,
    );
    if (yMonacoRoute) {
      endChangeSpan({
        source: "y-monaco",
        update_mode: yMonacoRoute,
        change_count: changeEvent.changes.length,
      });
      return;
    }
    const update = applyEditorChangeToWorkspace(editor, changeEvent, beforeVersion);
    onEditorChange(
      update.mode === "incremental" && !changeEvent.isFlush ? update.editEvent : undefined,
    );
    endChangeSpan({
      source: "local",
      update_mode: update.mode,
      change_count: changeEvent.changes.length,
    });
  };

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   *
   * MonacoEditor calls onMount once, so this closure, its listeners included,
   * belongs to the render that mounted the editor. It may read directly only
   * what never changes after that render (refs, the stable editor actions);
   * anything that does, such as `collaboration`, it reads through a
   * useEffectEvent callback, as the collaboration hooks' callbacks do.
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
      presence.listenForLocalIntent(editor),
      // Tab types a tab here; Escape, then Tab, leaves the editor.
      addEscapeThenTabExit(editor),
      editor.onDidChangeModel(() => {
        yMonacoBinding.dispose();
        const model = editor.getModel();
        if (model) {
          modelVersionByUriRef.current.set(model.uri.toString(), model.getVersionId());
        }
        if (syncPlaybackEditorModel(editor)) {
          return;
        }

        disposePlaybackModelsIfIdle(editor.getModel()?.uri ?? null);
        syncEditorRef(editor);
        presence.publishCursor(editor);
        presence.publishViewport(editor);
        yMonacoBinding.reconcile(editor);
      }),
      editor.onDidChangeModelContent((changeEvent) =>
        handleModelContentChange(editor, changeEvent),
      ),
      // Monaco fires the position and the selection events back to back for
      // the same cursor-state change (codeEditorWidget's CursorStateChanged),
      // so this one listener covers caret moves as well as selections; a
      // position listener would only capture the same state a second time.
      // The studio driver relies on selection capture coming from here too.
      editor.onDidChangeCursorSelection(() => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
        presence.publishCursor(editor);
      }),
      editor.onDidScrollChange((event) => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
        if (event.scrollTopChanged || event.scrollLeftChanged) {
          presence.publishViewport(editor);
        }
      }),
      editor.onDidBlurEditorText(() => presence.flushOnBlur()),
    ];
    yMonacoBinding.reconcile(editor);
    presence.publishViewport(editor);
  };

  // This component re-renders on every keystroke (the editor state carries the
  // active file's content), and being uncompiled it would hand these children
  // new elements each time, so all of them would re-render too. They subscribe
  // to their own state, so keep their elements until a prop changes. <Preview />
  // is left out on purpose: its uncompiled controller's effects would run less
  // often, which needs a replay check in Chrome (see reactCompilerCoverage.test.ts).
  const shouldTrackWorkspaceChanges = isRecording || Boolean(currentRecording);
  const workspaceEventRecorder = useMemo(
    () => (
      <WorkspaceEventRecorder
        handleWorkspaceEvent={handleWorkspaceEvent}
        isRecording={isRecording}
        shouldTrackWorkspaceChanges={shouldTrackWorkspaceChanges}
      />
    ),
    [handleWorkspaceEvent, isRecording, shouldTrackWorkspaceChanges],
  );
  const editorHeader = useMemo(
    () => <EditorHeader showImportExport={showImportExport} breadcrumb={breadcrumb} />,
    [breadcrumb, showImportExport],
  );
  const fileSidebar = useMemo(() => <FileSidebar />, []);
  const runtimeDock = useMemo(() => <RuntimeDock lessonType={lessonType} />, [lessonType]);

  return (
    <div
      className="h-full flex flex-col"
      data-cursor-replay-target="workspace"
      inert={isWorkspaceCovered}
    >
      {workspaceEventRecorder}
      {/* Lets keyboard users bypass the header that repeats on every lesson.
          Focus moves without following the hash, which the router would see
          as a navigation. */}
      <a
        href="#editor-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("editor-main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-slate-950"
      >
        Skip to editor
      </a>
      {editorHeader}
      <main
        id="editor-main"
        tabIndex={-1}
        className="flex min-h-0 flex-1 overflow-hidden outline-none"
        data-cursor-replay-target="workspace-body"
      >
        {fileSidebar}
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
                <BinaryFilePreview key={activeFile.path} file={activeFile} />
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
            {runtimeDock}
          </div>
          {/* Go, Kotlin, and Python lessons have no preview surface at all —
              the dock console is their only runtime output. */}
          {lessonSupportsPreview(lessonType) ? (
            <Suspense fallback={null}>
              <Preview />
            </Suspense>
          ) : null}
        </div>
      </main>
    </div>
  );
};

export default CodeEditorComponent;
