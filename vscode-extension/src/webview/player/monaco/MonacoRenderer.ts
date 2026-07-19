import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// Inline worker so it loads under the webview CSP (worker-src blob:).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker&inline";
import type { ContentChange, SelectionRange, VisibleLineRange } from "../../../model/events";
import type { PlaybackRenderer } from "../Renderer";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (moduleId: string, label: string) => Worker;
    };
  }
}

let environmentInstalled = false;
function ensureEnvironment(): void {
  if (!environmentInstalled) {
    environmentInstalled = true;
    self.MonacoEnvironment = {
      getWorker: () => new EditorWorker(),
    };
  }
}

type SurfaceEntry = {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  documentId: string;
  viewState: monaco.editor.ICodeEditorViewState | null;
};

export class MonacoRenderer implements PlaybackRenderer {
  readonly id = "monaco" as const;
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly surfaces = new Map<string, SurfaceEntry>();

  constructor() {
    ensureEnvironment();
  }

  createDocument(documentId: string, text: string, languageId: string): void {
    const model = monaco.editor.createModel(text, languageId);
    this.models.set(documentId, model);
  }

  disposeDocument(documentId: string): void {
    this.models.get(documentId)?.dispose();
    this.models.delete(documentId);
  }

  private model(documentId: string): monaco.editor.ITextModel {
    const model = this.models.get(documentId);
    if (!model) {
      throw new Error(`monaco model missing for ${documentId}`);
    }
    return model;
  }

  applyChanges(documentId: string, changes: readonly ContentChange[]): void {
    const model = this.model(documentId);
    // Recorded transactions apply against the evolving buffer in array
    // order; one applyEdits per change preserves those semantics exactly.
    for (const change of changes) {
      const start = model.getPositionAt(change.rangeOffsetUtf16);
      const end = model.getPositionAt(change.rangeOffsetUtf16 + change.rangeLengthUtf16);
      model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: change.text }]);
    }
  }

  setDocumentText(documentId: string, text: string): void {
    this.model(documentId).setValue(text);
  }

  getDocumentText(documentId: string): string {
    return this.model(documentId).getValue(monaco.editor.EndOfLinePreference.TextDefined);
  }

  createSurface(surfaceId: string, documentId: string, container: HTMLElement): void {
    const editor = monaco.editor.create(container, {
      model: this.model(documentId),
      readOnly: true,
      minimap: { enabled: false },
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: "none",
      wordWrap: "off",
      contextmenu: false,
    });
    this.surfaces.set(surfaceId, { editor, documentId, viewState: null });
  }

  hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  disposeSurface(surfaceId: string): void {
    const entry = this.surfaces.get(surfaceId);
    entry?.editor?.dispose();
    this.surfaces.delete(surfaceId);
  }

  private editorOf(surfaceId: string): monaco.editor.IStandaloneCodeEditor | null {
    return this.surfaces.get(surfaceId)?.editor ?? null;
  }

  setSelections(surfaceId: string, selections: readonly SelectionRange[]): void {
    const entry = this.surfaces.get(surfaceId);
    const editor = entry?.editor;
    if (!entry || !editor) {
      return;
    }
    const model = this.model(entry.documentId);
    const monacoSelections = selections.map((selection) => {
      const anchor = model.getPositionAt(selection.anchorOffsetUtf16);
      const active = model.getPositionAt(selection.activeOffsetUtf16);
      return new monaco.Selection(
        anchor.lineNumber,
        anchor.column,
        active.lineNumber,
        active.column,
      );
    });
    if (monacoSelections.length > 0) {
      editor.setSelections(monacoSelections);
    }
  }

  setViewport(surfaceId: string, visibleRanges: readonly VisibleLineRange[]): void {
    const editor = this.editorOf(surfaceId);
    const first = visibleRanges[0];
    if (!editor || !first) {
      return;
    }
    editor.revealRangeAtTop(
      new monaco.Range(first.startLine + 1, 1, first.startLine + 1, 1),
      monaco.editor.ScrollType.Immediate,
    );
  }

  suspendSurface(surfaceId: string): void {
    const entry = this.surfaces.get(surfaceId);
    if (entry?.editor) {
      entry.viewState = entry.editor.saveViewState();
      entry.editor.dispose();
      entry.editor = null;
    }
  }

  resumeSurface(surfaceId: string, container: HTMLElement): void {
    const entry = this.surfaces.get(surfaceId);
    if (!entry || entry.editor) {
      return;
    }
    entry.editor = monaco.editor.create(container, {
      model: this.model(entry.documentId),
      readOnly: true,
      minimap: { enabled: false },
      automaticLayout: true,
      contextmenu: false,
    });
    if (entry.viewState) {
      entry.editor.restoreViewState(entry.viewState);
    }
  }

  dispose(): void {
    for (const surfaceId of this.surfaces.keys()) {
      this.disposeSurface(surfaceId);
    }
    for (const documentId of this.models.keys()) {
      this.disposeDocument(documentId);
    }
  }
}
