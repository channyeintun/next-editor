import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import { useSelector } from "@xstate/store-react";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWorkspaceActions,
  useWorkspaceEditorState,
  useWorkspaceLessonType,
  useWorkspaceTreeVersion,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSaveWorkspace } from "../hooks/useWebContainerRuntime";
import { useRuntimeDockRecordedSnapshot } from "../hooks/useRuntimeDockRecordedSnapshot";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  useOptionalCollaboration,
  type CollaborationParticipant,
} from "../contexts/CollaborationContext";
import type { EditorSelection } from "../core/src/types";
import type { CollaborationRoomProvider } from "../collaboration/roomProvider";
import { selectIsCollapsed, selectIsFullHeight } from "../stores/runtimePanelStore";
import {
  executionKindForLessonType,
  isWorkspaceTextFile,
  lessonSupportsPreview,
  lessonSupportsTerminal,
  type WorkspaceExecutionKind,
  type WorkspaceLessonType,
} from "../types/workspace";
import type { TextEditEvent } from "../types/textEdit";
import { collaborationTextForPath } from "../collaboration/collaborationTextForPath";
import { canPublishCollaborationUpdate } from "../collaboration/protocol";
import { resolveMonacoAwarenessSelections } from "../collaboration/monacoAwareness";
import { collaborationParticipantKey } from "../collaboration/participantKey";
import {
  collaborationParticipantColorIndex,
  resolveCollaborationCursor,
} from "../collaboration/relativePosition";
import EditorHeader from "./EditorHeader";
import FileSidebar from "./FileSidebar";
import { WorkspaceEventRecorder } from "./WorkspaceEventRecorder";
import BinaryFilePreview from "./BinaryFilePreview";
import TerminalPanel from "./TerminalPanel";
import GoPlaygroundRunnerPanel from "./GoPlaygroundRunnerPanel";
import KotlinPlaygroundRunnerPanel from "./KotlinPlaygroundRunnerPanel";
import RustPlaygroundRunnerPanel from "./RustPlaygroundRunnerPanel";
import ZigPlaygroundRunnerPanel from "./ZigPlaygroundRunnerPanel";
import HaskellPlaygroundRunnerPanel from "./HaskellPlaygroundRunnerPanel";
import KitePlaygroundRunnerPanel from "./KitePlaygroundRunnerPanel";
import {
  CollaborationCursorLabelManager,
  type CollaborationCursorLabel,
} from "./collaborationCursorLabels";
import { collaboratorDisplayName } from "./collaboratorAppearance";
import {
  participantCursorDecorations,
  remoteSelectionDecorations,
  remoteSelectionToEditorSelection,
  resolveRemoteSelection,
  yMonacoSelectionStyleRules,
} from "./remoteCursors";
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
import {
  createCollaborationEditorViewport,
  resolveCollaborationEditorViewport,
} from "../collaboration/editorViewport";
import { useSlidesContext } from "../contexts/SlidesContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { mayTakeFocus } from "./mayTakeFocus";

const Preview = lazy(() => import("./Preview"));
// The other runner panels are thin clients in front of a Worker proxy, but this
// one reaches the whole first-party x86-64 assembler and CPU in `src/core/x86`,
// which only an `asm` lesson can ever run. Splitting it out keeps that code from
// being fetched and parsed on every editor load, the way `Preview` already is.
const AsmPlaygroundRunnerPanel = lazy(() => import("./AsmPlaygroundRunnerPanel"));

// One entry per non-webcontainer execution kind. The `Record` is what makes a new
// playground kind a compile error here rather than a lesson that renders an editor
// with no dock at all — no Run button, no console, and nothing to point at.
const RUNNER_PANELS: Record<Exclude<WorkspaceExecutionKind, "webcontainer">, ComponentType> = {
  "go-playground": GoPlaygroundRunnerPanel,
  "kotlin-playground": KotlinPlaygroundRunnerPanel,
  "rust-playground": RustPlaygroundRunnerPanel,
  "zig-playground": ZigPlaygroundRunnerPanel,
  "haskell-playground": HaskellPlaygroundRunnerPanel,
  "kite-playground": KitePlaygroundRunnerPanel,
  "asm-playground": AsmPlaygroundRunnerPanel,
};

/**
 * The dock under the editor that runs the lesson: the terminal for a lesson
 * that runs in the WebContainer, its playground's runner panel otherwise, and
 * nothing for a lesson type that has neither.
 */
function RuntimeDock({ lessonType }: { lessonType: WorkspaceLessonType }) {
  // Uncompiled, like CodeEditor. Compiled, it would hand React the same panel
  // element on every render, so the panels would no longer re-render along
  // with the editor the way they did when CodeEditor rendered them inline.
  "use no memo";
  if (lessonSupportsTerminal(lessonType)) return <TerminalPanel />;
  const executionKind = executionKindForLessonType(lessonType);
  const RunnerPanel = executionKind === "webcontainer" ? null : RUNNER_PANELS[executionKind];
  if (!RunnerPanel) return null;
  return (
    // Only the asm panel is lazy; the rest resolve synchronously and
    // never suspend, so this Suspense is inert for them.
    <Suspense fallback={null}>
      <RunnerPanel />
    </Suspense>
  );
}

const Y_MONACO_BINDING_ENABLED = import.meta.env.VITE_COLLABORATION_Y_MONACO !== "false";

interface CodeEditorProps {
  showImportExport?: boolean;
  breadcrumb?: ReactNode;
}

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

function createMonacoTextEditEvent(
  editor: StandaloneEditor,
  changeEvent: monaco.editor.IModelContentChangedEvent,
  beforeVersion: number,
): TextEditEvent | null {
  const model = editor.getModel();
  const modelPath = model ? workspacePathFromMonacoModelUri(model.uri) : null;
  if (!model || !modelPath) return null;

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
  return {
    fileId: modelPath,
    path: modelPath,
    beforeVersion,
    afterVersion: changeEvent.versionId,
    beforeLength: afterLength - lengthDelta,
    afterLength,
    changes,
  };
}

interface ActiveYMonacoBinding {
  binding: MonacoBinding;
  editor: StandaloneEditor;
  model: monaco.editor.ITextModel;
  provider: CollaborationRoomProvider;
  text: Y.Text;
  path: string;
}

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
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const collaboration = useOptionalCollaboration();
  const slidesContext = useSlidesContext();
  const whiteboardContext = useWhiteboardContext();
  // Slides or the whiteboard cover the editor, so this member's published
  // surface is that overlay (see CollaborationSurfaceBridge); the editor's
  // selection, cursor and viewport are not published over it.
  const isEditorCovered = slidesContext.previewState.isOpen || whiteboardContext.isOpen;
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
  const remoteAwarenessStyleRef = useRef<HTMLStyleElement | null>(null);
  const appliedFollowViewportRef = useRef<string | null>(null);
  const yMonacoBindingRef = useRef<ActiveYMonacoBinding | null>(null);
  const isConfiguringYMonacoRef = useRef(false);
  const recordedRemoteCursorSignaturesRef = useRef(new Map<string, string>());
  const remoteCursorRecordingScopeRef = useRef<{
    provider: CollaborationRoomProvider | null;
    path: string;
    isRecording: boolean;
  }>({ provider: null, path: "", isRecording: false });

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

  const recordRemoteSelection = useEffectEvent((selection: EditorSelection) => {
    if (usesPlaybackModel || !isRecording || !collaboration?.provider) return;
    handleEditorChange(selection);
  });

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

    const text = collaborationTextForPath(collaboration, provider.doc, activeFile.path);
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
      current.path === activeFile.path
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
        path: activeFile.path,
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

  const publishCollaborationCursor = useEffectEvent((editor: StandaloneEditor | null) => {
    if (!collaboration?.provider || usesPlaybackModel || !editor || isEditorCovered) {
      return;
    }
    if (yMonacoBindingRef.current) return;
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

  const publishCollaborationViewport = useEffectEvent((editor: StandaloneEditor | null) => {
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
    disposeYMonacoBinding();
    remoteCursorLabelManagerRef.current?.clear();
    remoteAwarenessStyleRef.current?.remove();
    remoteAwarenessStyleRef.current = null;
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
      yMonacoBindingRef.current?.model,
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
    publishCollaborationCursor(editor);
    publishCollaborationViewport(editor);
  }, [
    editorModelPath,
    editorRef,
    slidesContext.previewState.isOpen,
    syncEditorRef,
    whiteboardContext.isOpen,
  ]);

  useLayoutEffect(() => {
    reconcileYMonacoBinding(editorRef.current);
  }, [
    activeFile.path,
    activeModel,
    collaboration?.canWrite,
    collaboration?.connectionState,
    collaboration?.followedParticipantKey,
    collaboration?.provider,
    isBinaryActiveFile,
    slidesContext.previewState.isOpen,
    usesPlaybackModel,
    whiteboardContext.isOpen,
  ]);

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

  const wasRecordingRef = useRef(isRecording);
  useEffect(() => {
    const stoppedRecording = wasRecordingRef.current && !isRecording;
    wasRecordingRef.current = isRecording;
    if (stoppedRecording) void collaboration?.provider?.flushNow();
  }, [collaboration?.provider, isRecording]);

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
    const yMonacoBinding = yMonacoBindingRef.current;
    const yMonacoRendersSelections = Boolean(
      yMonacoBinding?.editor === editor && yMonacoBinding.model === model,
    );
    const awarenessText =
      (yMonacoRendersSelections ? yMonacoBinding?.text : undefined) ??
      collaborationTextForPath(collaboration, collaboration.doc, activeFile.path);
    if (awarenessText) {
      const selections = resolveMonacoAwarenessSelections(
        collaboration.provider.awareness,
        awarenessText,
      );
      const labels: CollaborationCursorLabel[] = [];
      const awarenessDecorations: monaco.editor.IModelDeltaDecoration[] = [];
      const styleRules: string[] = [];
      const standardParticipantKeys = new Set<string>();
      for (const selection of selections) {
        standardParticipantKeys.add(collaborationParticipantKey(selection.participant));
        const colorIndex = collaborationParticipantColorIndex(selection.participant);
        if (yMonacoRendersSelections) {
          styleRules.push(...yMonacoSelectionStyleRules(selection.clientId, colorIndex));
        } else {
          awarenessDecorations.push(
            ...remoteSelectionDecorations(
              resolveRemoteSelection(model, selection.anchorOffset, selection.headOffset),
              colorIndex,
              collaboratorDisplayName(selection.participant),
            ),
          );
        }
        labels.push({
          id: collaborationParticipantKey(selection.participant),
          name: collaboratorDisplayName(selection.participant),
          colorIndex,
          position: model.getPositionAt(selection.headOffset),
        });
      }
      const activeFileNodeId = collaboration.getNodeIdForPath(activeFile.path) ?? undefined;
      for (const participant of collaboration.participants) {
        const key = collaborationParticipantKey(participant);
        if (
          standardParticipantKeys.has(key) ||
          key === collaboration.ownParticipantKey ||
          !participant.cursor ||
          participant.cursor.fileNodeId !== activeFileNodeId
        ) {
          continue;
        }
        const cursor = resolveCollaborationCursor(collaboration.doc, participant.cursor);
        if (!cursor) continue;
        const drawn = participantCursorDecorations(model, key, participant, cursor);
        awarenessDecorations.push(...drawn.decorations);
        labels.push(drawn.label);
      }
      if (styleRules.length > 0) {
        let style = remoteAwarenessStyleRef.current;
        if (!style) {
          style = document.createElement("style");
          style.dataset.nextEditorCollaborationAwareness = "true";
          document.head.append(style);
          remoteAwarenessStyleRef.current = style;
        }
        style.textContent = styleRules.join("\n");
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
        awarenessDecorations,
      );
      return;
    }
    remoteAwarenessStyleRef.current?.remove();
    remoteAwarenessStyleRef.current = null;
    const activeFileNodeId = collaboration.getNodeIdForPath(activeFile.path) ?? undefined;
    if (!activeFileNodeId) {
      cursorLabelManager.clear();
      remoteDecorationIdsRef.current = editor.deltaDecorations(remoteDecorationIdsRef.current, []);
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const cursorLabels: CollaborationCursorLabel[] = [];
    for (const participant of collaboration.participants) {
      const key = collaborationParticipantKey(participant);
      if (
        key === collaboration.ownParticipantKey ||
        !participant.cursor ||
        participant.cursor.fileNodeId !== activeFileNodeId
      ) {
        continue;
      }
      const cursor = resolveCollaborationCursor(collaboration.doc, participant.cursor);
      if (!cursor) continue;
      const drawn = participantCursorDecorations(model, key, participant, cursor);
      decorations.push(...drawn.decorations);
      cursorLabels.push(drawn.label);
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
  }, [
    activeFile.path,
    collaboration?.canWrite,
    collaboration?.connectionState,
    collaboration?.doc,
    collaboration?.getNodeIdForPath,
    collaboration?.ownParticipantKey,
    collaboration?.participants,
    collaboration?.provider,
  ]);

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

    if (editor && model && collaboration && provider && collaborationDoc && !usesPlaybackModel) {
      const captureSelection = (
        participant: CollaborationParticipant,
        anchorOffset: number,
        headOffset: number,
      ) => {
        if (!canPublishCollaborationUpdate(participant.role)) return;
        const key = collaborationParticipantKey(participant);
        const signature = `${anchorOffset}:${headOffset}`;
        currentSignatures.set(key, signature);
        if (
          !scopeChanged &&
          isRecording &&
          recordedRemoteCursorSignaturesRef.current.get(key) !== signature
        ) {
          changedSelections.push({
            key,
            occurredAt: participant.occurredAt,
            selection: remoteSelectionToEditorSelection(
              resolveRemoteSelection(model, anchorOffset, headOffset),
            ),
          });
        }
      };

      const yMonacoBinding = yMonacoBindingRef.current;
      const standardParticipantKeys = new Set<string>();
      const awarenessText =
        (yMonacoBinding?.editor === editor && yMonacoBinding.model === model
          ? yMonacoBinding.text
          : undefined) ??
        collaborationTextForPath(collaboration, collaborationDoc, activeFile.path);
      if (awarenessText) {
        for (const selection of resolveMonacoAwarenessSelections(
          provider.awareness,
          awarenessText,
        )) {
          standardParticipantKeys.add(collaborationParticipantKey(selection.participant));
          captureSelection(selection.participant, selection.anchorOffset, selection.headOffset);
        }
      }
      const activeFileNodeId = collaboration.getNodeIdForPath(activeFile.path) ?? undefined;

      for (const participant of participants) {
        const key = collaborationParticipantKey(participant);
        if (
          standardParticipantKeys.has(key) ||
          key === collaboration.ownParticipantKey ||
          !participant.cursor ||
          participant.cursor.fileNodeId !== activeFileNodeId
        ) {
          continue;
        }
        const cursor = resolveCollaborationCursor(collaborationDoc, participant.cursor);
        if (!cursor) continue;
        captureSelection(participant, cursor.anchorOffset, cursor.headOffset);
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
    collaboration?.getNodeIdForPath,
    collaboration?.ownParticipantKey,
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
      disposeYMonacoBinding();
      editorRef.current = null;
      syncEditorRef(null);
    }
  }, [editorRef, isBinaryActiveFile, syncEditorRef]);

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
        const listener: EventListener = () => collaboration?.stopFollowing(reason);
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
    const yMonacoBinding = yMonacoBindingRef.current;
    if (isConfiguringYMonacoRef.current) {
      onEditorChange();
      endChangeSpan({
        source: "y-monaco",
        update_mode: "binding-setup",
        change_count: changeEvent.changes.length,
      });
      return;
    }
    if (yMonacoBinding?.editor === editor && yMonacoBinding.model === editor.getModel()) {
      const editEvent = changeEvent.isFlush
        ? null
        : createMonacoTextEditEvent(editor, changeEvent, beforeVersion);
      if (editEvent) {
        const editedModel = yMonacoBinding.model;
        collaboration?.queueLocalTextEdit(editEvent, (projectedContent) => {
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
      endChangeSpan({
        source: "y-monaco",
        update_mode: editEvent ? "incremental" : "direct-ytext",
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
      listenForLocalIntent(editor),
      editor.onDidChangeModel(() => {
        disposeYMonacoBinding();
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
        publishCollaborationViewport(editor);
        reconcileYMonacoBinding(editor);
      }),
      editor.onDidChangeModelContent((changeEvent) =>
        handleModelContentChange(editor, changeEvent),
      ),
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
      editor.onDidScrollChange((event) => {
        if (isApplyingExternalModelValueRef.current) return;
        onEditorChange();
        if (event.scrollTopChanged || event.scrollLeftChanged) {
          publishCollaborationViewport(editor);
        }
      }),
      editor.onDidBlurEditorText(() => {
        void collaboration?.provider?.flushNow();
      }),
    ];
    reconcileYMonacoBinding(editor);
    publishCollaborationViewport(editor);
  };

  return (
    <div className="h-full flex flex-col" data-cursor-replay-target="workspace">
      <WorkspaceEventRecorder
        handleWorkspaceEvent={handleWorkspaceEvent}
        isRecording={isRecording}
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
            <RuntimeDock lessonType={lessonType} />
          </div>
          {/* Go, Kotlin, and Python lessons have no preview surface at all —
              the dock console is their only runtime output. */}
          {lessonSupportsPreview(lessonType) ? (
            <Suspense fallback={null}>
              <Preview />
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default CodeEditorComponent;
