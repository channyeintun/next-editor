import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWorkspaceActions,
  useWorkspaceEditorState,
  useWorkspaceLessonType,
  useWorkspaceProjectVersion,
  useWorkspaceSidebarState,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSaveWorkspace } from "../hooks/useWebContainerRuntime";
import { lessonRunsInWebContainer } from "../types/workspace";
import EditorHeader from "./EditorHeader";
import FileSidebar from "./FileSidebar";
import BinaryFilePreview from "./BinaryFilePreview";
import TerminalPanel from "./TerminalPanel";
import AgentPanel from "./agent/AgentPanel";
import {
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
  const { saveProject, updateFileContent } = useWorkspaceActions();
  const saveWorkspace = useWebContainerRuntimeSaveWorkspace();
  const { activeFile } = useWorkspaceEditorState();
  const lessonType = useWorkspaceLessonType();
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  const monacoRef = useRef<Monaco | null>(null);
  const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const isApplyingExternalModelValueRef = useRef(false);

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
  const editorOptions = useMemo(() => getEditorOptions(isPlaying), [isPlaying]);

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
      saveProject();
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
    restoreNormalViewState(editor, editor.getModel());

    focusEditorIfNeeded(editor);

    editorDisposablesRef.current = [
      editor.onDidChangeModel(() => {
        if (syncPlaybackEditorModel(editor)) {
          return;
        }

        disposePlaybackModelsIfIdle(editor.getModel()?.uri ?? null);
        syncEditorRef(editor);
      }),
      editor.onDidChangeModelContent(() => {
        syncEditorContentToWorkspace(editor);
        onEditorChange();
      }),
      editor.onDidChangeCursorPosition(() => {
        onEditorChange();
      }),
      editor.onDidChangeCursorSelection(() => {
        onEditorChange();
      }),
      editor.onDidScrollChange(() => {
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
                (isPlaying ? " playback-mode" : "")
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
            <AgentPanel />
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
