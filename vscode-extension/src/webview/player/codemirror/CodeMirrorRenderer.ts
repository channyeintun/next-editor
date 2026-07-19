import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, lineNumbers } from "@codemirror/view";
import type { ContentChange, SelectionRange, VisibleLineRange } from "../../../model/events";
import { applyContentChanges } from "../PlaybackState";
import type { PlaybackRenderer } from "../Renderer";

type SurfaceEntry = {
  view: EditorView | null;
  documentId: string;
  savedSelections: readonly SelectionRange[];
};

// CodeMirror 6 has no shared model object: canonical text lives here and
// every surface view of the same document receives the same dispatches.
export class CodeMirrorRenderer implements PlaybackRenderer {
  readonly id = "codemirror" as const;
  private readonly texts = new Map<string, string>();
  private readonly surfaces = new Map<string, SurfaceEntry>();

  private baseExtensions() {
    return [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorState.allowMultipleSelections.of(true),
      drawSelection(),
      lineNumbers(),
    ];
  }

  createDocument(documentId: string, text: string, _languageId: string): void {
    this.texts.set(documentId, text);
  }

  disposeDocument(documentId: string): void {
    this.texts.delete(documentId);
  }

  private text(documentId: string): string {
    const text = this.texts.get(documentId);
    if (text === undefined) {
      throw new Error(`codemirror text missing for ${documentId}`);
    }
    return text;
  }

  private viewsOf(documentId: string): EditorView[] {
    const views: EditorView[] = [];
    for (const entry of this.surfaces.values()) {
      if (entry.documentId === documentId && entry.view) {
        views.push(entry.view);
      }
    }
    return views;
  }

  applyChanges(documentId: string, changes: readonly ContentChange[]): void {
    const before = this.text(documentId);
    this.texts.set(documentId, applyContentChanges(before, changes));
    for (const view of this.viewsOf(documentId)) {
      // Apply in array order against the evolving buffer (one dispatch per
      // change keeps recorded semantics; batches are small).
      for (const change of changes) {
        view.dispatch({
          changes: {
            from: change.rangeOffsetUtf16,
            to: change.rangeOffsetUtf16 + change.rangeLengthUtf16,
            insert: change.text,
          },
        });
      }
    }
  }

  setDocumentText(documentId: string, text: string): void {
    this.texts.set(documentId, text);
    for (const view of this.viewsOf(documentId)) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    }
  }

  getDocumentText(documentId: string): string {
    // Prefer live view state: it verifies what the renderer actually shows.
    const views = this.viewsOf(documentId);
    const first = views[0];
    return first ? first.state.doc.toString() : this.text(documentId);
  }

  createSurface(surfaceId: string, documentId: string, container: HTMLElement): void {
    const view = new EditorView({
      state: EditorState.create({
        doc: this.text(documentId),
        extensions: this.baseExtensions(),
      }),
      parent: container,
    });
    this.surfaces.set(surfaceId, { view, documentId, savedSelections: [] });
  }

  hasSurface(surfaceId: string): boolean {
    return this.surfaces.has(surfaceId);
  }

  disposeSurface(surfaceId: string): void {
    this.surfaces.get(surfaceId)?.view?.destroy();
    this.surfaces.delete(surfaceId);
  }

  setSelections(surfaceId: string, selections: readonly SelectionRange[]): void {
    const entry = this.surfaces.get(surfaceId);
    if (!entry?.view || selections.length === 0) {
      return;
    }
    const length = entry.view.state.doc.length;
    const clip = (offset: number) => Math.max(0, Math.min(length, offset));
    entry.savedSelections = selections;
    entry.view.dispatch({
      selection: EditorSelection.create(
        selections.map((selection) =>
          EditorSelection.range(
            clip(selection.anchorOffsetUtf16),
            clip(selection.activeOffsetUtf16),
          ),
        ),
      ),
    });
  }

  setViewport(surfaceId: string, visibleRanges: readonly VisibleLineRange[]): void {
    const entry = this.surfaces.get(surfaceId);
    const first = visibleRanges[0];
    if (!entry?.view || !first) {
      return;
    }
    const doc = entry.view.state.doc;
    const lineNumber = Math.max(1, Math.min(doc.lines, first.startLine + 1));
    entry.view.dispatch({
      effects: EditorView.scrollIntoView(doc.line(lineNumber).from, {
        y: "start",
      }),
    });
  }

  suspendSurface(surfaceId: string): void {
    const entry = this.surfaces.get(surfaceId);
    if (entry?.view) {
      entry.view.destroy();
      entry.view = null;
    }
  }

  resumeSurface(surfaceId: string, container: HTMLElement): void {
    const entry = this.surfaces.get(surfaceId);
    if (!entry || entry.view) {
      return;
    }
    entry.view = new EditorView({
      state: EditorState.create({
        doc: this.text(entry.documentId),
        extensions: this.baseExtensions(),
      }),
      parent: container,
    });
    this.setSelections(surfaceId, entry.savedSelections);
  }

  dispose(): void {
    for (const surfaceId of this.surfaces.keys()) {
      this.disposeSurface(surfaceId);
    }
    this.texts.clear();
  }
}
