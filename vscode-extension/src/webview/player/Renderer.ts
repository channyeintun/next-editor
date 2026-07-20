// Shared renderer contract (plan §11.1). The playback engine owns truth;
// a renderer is a disposable projection of PlaybackSessionState.
import type { ContentChange, EolMode, SelectionRange, VisibleLineRange } from "../../model/events";

export type RendererId = "monaco" | "codemirror";

export interface PlaybackRenderer {
  readonly id: RendererId;

  /** Create a document model. */
  createDocument(documentId: string, text: string, languageId: string): void;
  disposeDocument(documentId: string): void;
  setDocumentLanguage(documentId: string, languageId: string): void;
  setDocumentEol(documentId: string, eol: EolMode): void;

  /** Apply one atomic change batch to a document model. */
  applyChanges(documentId: string, changes: readonly ContentChange[]): void;

  /** Replace a document's full text (checkpoint restore on seek). */
  setDocumentText(documentId: string, text: string): void;

  /** Get the model text back (correctness verification). */
  getDocumentText(documentId: string): string;

  /** Create an editor surface bound to a document, in a container. */
  createSurface(surfaceId: string, documentId: string, container: HTMLElement): void;
  hasSurface(surfaceId: string): boolean;
  disposeSurface(surfaceId: string): void;

  /** Independent per-surface view state. */
  setSelections(surfaceId: string, selections: readonly SelectionRange[]): void;
  setViewport(surfaceId: string, visibleRanges: readonly VisibleLineRange[]): void;

  /** Suspend/resume rendering for hidden surfaces. */
  suspendSurface(surfaceId: string): void;
  resumeSurface(surfaceId: string, container: HTMLElement): void;

  /** Dispose everything. */
  dispose(): void;
}

/** Resolves after the browser has produced a frame (render-complete). */
export function afterFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}
