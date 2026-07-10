import { useEffect, useLayoutEffect, useRef } from "react";
import { monaco, type Monaco } from "./runtime";

export interface MonacoEditorProps {
  className?: string;
  model: monaco.editor.ITextModel | null;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  onChange?: (value: string, editor: monaco.editor.IStandaloneCodeEditor) => void;
  onMount?: (editor: monaco.editor.IStandaloneCodeEditor, monaco: Monaco) => void | (() => void);
  onBeforeModelChange?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    currentModel: monaco.editor.ITextModel | null,
  ) => void;
  onAfterModelChange?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    nextModel: monaco.editor.ITextModel | null,
  ) => void;
  /**
   * Called with the editor still fully alive, immediately before this
   * component disposes it on unmount — the last chance to read editor state
   * (e.g. saveViewState). Unmount does not fire onBeforeModelChange.
   */
  onWillDispose?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    currentModel: monaco.editor.ITextModel | null,
  ) => void;
}

function withManagedLayout(options?: monaco.editor.IStandaloneEditorConstructionOptions) {
  return { ...options, automaticLayout: false };
}

// A model can reach this component already disposed: StrictMode's dev-only
// effect replay disposes caller-owned models after the last render, with no
// re-render before this component's replayed setup runs. Attaching a disposed
// model makes Monaco throw ("Model is disposed!"), so attach null instead and
// let the owner's re-created model arrive via the [model] effect.
function attachableModel(model: monaco.editor.ITextModel | null) {
  return model && !model.isDisposed() ? model : null;
}

export function MonacoEditor({
  className,
  model,
  options,
  onChange,
  onMount,
  onBeforeModelChange,
  onAfterModelChange,
  onWillDispose,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposablesRef = useRef<{ dispose(): void }[]>([]);
  const mountCleanupRef = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  const onBeforeModelChangeRef = useRef(onBeforeModelChange);
  const onAfterModelChangeRef = useRef(onAfterModelChange);
  const onWillDisposeRef = useRef(onWillDispose);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
    onBeforeModelChangeRef.current = onBeforeModelChange;
    onAfterModelChangeRef.current = onAfterModelChange;
    onWillDisposeRef.current = onWillDispose;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || editorRef.current) {
      return;
    }

    const editor = monaco.editor.create(
      container,
      withManagedLayout({ ...options, model: attachableModel(model) }),
    );
    editorRef.current = editor;

    disposablesRef.current = [
      editor.onDidChangeModelContent(() => {
        onChangeRef.current?.(editor.getValue(), editor);
      }),
    ];

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        editor.layout();
      });
      resizeObserver.observe(container);
      resizeObserverRef.current = resizeObserver;
    }

    editor.layout();
    const mountCleanup = onMount?.(editor, monaco);
    mountCleanupRef.current = typeof mountCleanup === "function" ? mountCleanup : null;

    return () => {
      onWillDisposeRef.current?.(editor, editor.getModel());
      mountCleanupRef.current?.();
      mountCleanupRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const nextModel = attachableModel(model);

    if (!editor || editor.getModel() === nextModel) {
      return;
    }

    onBeforeModelChangeRef.current?.(editor, editor.getModel());
    editor.setModel(nextModel);
    onAfterModelChangeRef.current?.(editor, nextModel);
  }, [model]);

  useEffect(() => {
    editorRef.current?.updateOptions(withManagedLayout(options));
  }, [options]);

  return <div ref={containerRef} className={className} />;
}
