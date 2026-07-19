import type * as vscode from "vscode";
import { newSurfaceId, type DocumentId, type SurfaceId } from "../model/ids";

export type SurfaceRecord = {
  surfaceId: SurfaceId;
  documentId: DocumentId;
  visible: boolean;
};

// Live editor-object identity via WeakMap (plan §8.6). A surface is a view
// of a document; historical identity is retained after close.
export class SurfaceRegistry {
  private readonly byEditor = new WeakMap<vscode.TextEditor, SurfaceId>();
  private readonly records = new Map<SurfaceId, SurfaceRecord>();

  known(editor: vscode.TextEditor): SurfaceId | undefined {
    return this.byEditor.get(editor);
  }

  register(editor: vscode.TextEditor, documentId: DocumentId): SurfaceRecord {
    const existingId = this.byEditor.get(editor);
    if (existingId) {
      const record = this.records.get(existingId);
      if (record) {
        record.visible = true;
        return record;
      }
    }
    const record: SurfaceRecord = {
      surfaceId: newSurfaceId(),
      documentId,
      visible: true,
    };
    this.byEditor.set(editor, record.surfaceId);
    this.records.set(record.surfaceId, record);
    return record;
  }

  get(surfaceId: SurfaceId): SurfaceRecord | undefined {
    return this.records.get(surfaceId);
  }

  markHidden(surfaceId: SurfaceId): void {
    const record = this.records.get(surfaceId);
    if (record) {
      record.visible = false;
    }
  }

  visibleSurfaceIds(): Set<SurfaceId> {
    const out = new Set<SurfaceId>();
    for (const [id, record] of this.records) {
      if (record.visible) {
        out.add(id);
      }
    }
    return out;
  }
}
