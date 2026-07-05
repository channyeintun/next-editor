import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import Editor, { type OnMount, type BeforeMount, type Monaco } from "@monaco-editor/react";
// Self-host a trimmed Monaco (only the languages this editor uses) and point
// @monaco-editor/react at it instead of the default CDN. Side-effect import.
import "./monacoSetup";
// monaco-editor 0.55 moved the TypeScript language API out of
// `monaco.languages.typescript` and into named exports of this contribution
// module (the `languages.typescript = …` wiring now lives in editor.main.js,
// which our trimmed ./monacoSetup intentionally never imports). The module
// ships an empty `.d.ts`, so we re-type it below through the main entry's
// top-level `typescript` namespace, where the real declarations live.
import * as monacoTypeScriptModule from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
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
import {
  disposePlaybackModels,
  syncPlaybackModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  workspacePathFromMonacoModelUri,
} from "./editorModels";
import {
  MONACO_REACT_EXTRA_LIBS,
  defineNextEditorTheme,
  getEditorOptions,
  getMonacoCompilerOptions,
} from "./editorConstants";

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

let hasConfiguredMonacoTypeScript = false;
const monacoTypeScript =
  monacoTypeScriptModule as unknown as typeof import("monaco-editor").typescript;

function configureMonacoTypeScript() {
  if (hasConfiguredMonacoTypeScript) {
    return;
  }

  const compilerOptions = getMonacoCompilerOptions();
  const defaults = [monacoTypeScript.typescriptDefaults, monacoTypeScript.javascriptDefaults];

  defaults.forEach((currentDefaults) => {
    currentDefaults.setEagerModelSync(true);
    currentDefaults.setCompilerOptions(compilerOptions);

    MONACO_REACT_EXTRA_LIBS.forEach(({ content, filePath }) => {
      currentDefaults.addExtraLib(content, filePath);
    });
  });

  hasConfiguredMonacoTypeScript = true;
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
  // the theme is registered in `beforeMount`, and the model/language/tokenizer
  // depend on the exact render-to-render flow of the <Editor> props and the
  // onMount/useEffectEvent callbacks. The compiler's auto-memoization disrupts
  // that flow and breaks syntax highlighting, so this component stays uncompiled.
  // See [[react-compiler-babel-preset]].
  "use no memo";
  const { syncEditorRef, handleEditorChange, handleWorkspaceEvent, editorRef } =
    useNextEditorActions();
  const { saveProject, updateFileContent } = useWorkspaceActions();
  const saveWorkspace = useWebContainerRuntimeSaveWorkspace();
  const { activeFile } = useWorkspaceEditorState();
  const lessonType = useWorkspaceLessonType();
  const editorDisposablesRef = useRef<{ dispose(): void }[]>([]);
  const monacoRef = useRef<Monaco | null>(null);

  // Only subscribe to the flags we actually need for rendering decisions
  const { currentRecording, isPlaying, isRecording, usesPlaybackModel } = useNextEditorMetadata();
  // Binary assets (images, video, …) cannot be edited as text, so the Monaco
  // editor is swapped for a media preview and the editor sync paths are skipped.
  const isBinaryActiveFile = activeFile.encoding === "base64";
  const selectedLanguage = activeFile.language || language || "html";
  const editorModelPath = usesPlaybackModel
    ? toPlaybackModelPath(activeFile.path)
    : toMonacoModelPath(activeFile.path);

  const syncActivePlaybackModel = useEffectEvent((monaco: Monaco) => {
    if (!usesPlaybackModel || isBinaryActiveFile) {
      return null;
    }

    return syncPlaybackModel(monaco, activeFile.path, activeFile.content, selectedLanguage, {
      preserveExistingContent: true,
    });
  });

  const syncPlaybackEditorModel = useEffectEvent((editor: Parameters<OnMount>[0] | null) => {
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
    if (usesPlaybackModel) return; // Skip while playback owns the editor model
    handleEditorChange();
  });

  const syncEditorContentToWorkspace = useEffectEvent((editor: Parameters<OnMount>[0] | null) => {
    if (usesPlaybackModel || !editor || isBinaryActiveFile) {
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

  const focusEditorIfNeeded = useEffectEvent((editor: Parameters<OnMount>[0] | null) => {
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

  const detachEditorOnUnmount = useEffectEvent(() => {
    disposeEditorListeners();
    const monaco = monacoRef.current;

    if (monaco) {
      disposePlaybackModels(monaco);
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

  // The Monaco <Editor> unmounts while a binary asset is shown; drop the stale
  // editor reference so recording/save paths don't touch a disposed instance.
  useEffect(() => {
    if (isBinaryActiveFile) {
      editorRef.current = null;
      syncEditorRef(null);
    }
  }, [editorRef, isBinaryActiveFile, syncEditorRef]);

  /**
   * Handle Monaco Editor mount event
   * Sets up the editor reference for use in recording and replay
   */
  const handleEditorDidMount: OnMount = (editor) => {
    disposeEditorListeners();
    editorRef.current = editor;
    syncEditorRef(editor);
    syncEditorContentToWorkspace(editor);

    focusEditorIfNeeded(editor);

    editorDisposablesRef.current = [
      editor.onDidChangeModel(() => {
        if (syncPlaybackEditorModel(editor)) {
          return;
        }

        disposePlaybackModelsIfIdle(editor.getModel()?.uri ?? null);
        syncEditorContentToWorkspace(editor);
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

  /**
   * Handle Monaco Editor before mount event
   * Defines the custom theme so it's available when the editor initializes
   */
  const handleEditorBeforeMount: BeforeMount = (monaco: Monaco) => {
    monacoRef.current = monaco;
    configureMonacoTypeScript();
    syncActivePlaybackModel(monaco);
    defineNextEditorTheme(monaco);
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
              {isBinaryActiveFile ? (
                <BinaryFilePreview file={activeFile} />
              ) : (
                <Editor
                  height="100%"
                  path={editorModelPath}
                  language={selectedLanguage}
                  theme={theme}
                  defaultValue={usesPlaybackModel ? activeFile.content : undefined}
                  value={usesPlaybackModel ? undefined : activeFile.content}
                  saveViewState={!usesPlaybackModel}
                  onMount={handleEditorDidMount}
                  beforeMount={handleEditorBeforeMount}
                  options={getEditorOptions(isPlaying)}
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
