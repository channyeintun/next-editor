import { useEffect, useLayoutEffect, useRef } from "react";
import { monaco, type Monaco } from "./runtime";

export interface MonacoEditorProps {
  className?: string;
  model: monaco.editor.ITextModel;
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
}

function withManagedLayout(options?: monaco.editor.IStandaloneEditorConstructionOptions) {
  return { ...options, automaticLayout: false };
}

export function MonacoEditor({
  className,
  model,
  options,
  onChange,
  onMount,
  onBeforeModelChange,
  onAfterModelChange,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disposablesRef = useRef<{ dispose(): void }[]>([]);
  const mountCleanupRef = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  const onBeforeModelChangeRef = useRef(onBeforeModelChange);
  const onAfterModelChangeRef = useRef(onAfterModelChange);

  useEffect(() => {
    onChangeRef.current = onChange;
    onBeforeModelChangeRef.current = onBeforeModelChange;
    onAfterModelChangeRef.current = onAfterModelChange;
  });

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!container || editorRef.current) {
      return;
    }

    const editor = monaco.editor.create(container, withManagedLayout({ ...options, model }));
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

    if (!editor || editor.getModel() === model) {
      return;
    }

    onBeforeModelChangeRef.current?.(editor, editor.getModel());
    editor.setModel(model);
    onAfterModelChangeRef.current?.(editor, model);
  }, [model]);

  useEffect(() => {
    editorRef.current?.updateOptions(withManagedLayout(options));
  }, [options]);

  return <div ref={containerRef} className={className} />;
}
