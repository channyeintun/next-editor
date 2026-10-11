import { describe, expect, it } from "vite-plus/test";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  COLLABORATION_ORIGIN,
  getCollaborationTexts,
  projectCollaborationDocument,
  seedCollaborationProject,
} from "./projectDocument";
import { MAX_YJS_UPDATE_BYTES } from "./protocol";
import { createCollaborationUndoManager, trackCollaborationUndoOrigin } from "./undo";

// CodeEditor's binding hook registers this at module load; undo.ts itself
// stays Monaco-free.
trackCollaborationUndoOrigin(MonacoBinding);

function seedEntryText() {
  const project = createStarterHtmlCssWorkspace();
  const doc = new Y.Doc();
  seedCollaborationProject(doc, project);
  const fileId = projectCollaborationDocument(doc).nodeIdByPath.get(project.entryFilePath);
  const text = fileId ? getCollaborationTexts(doc).get(fileId) : undefined;
  if (!text) throw new Error("collaboration text is missing");
  return { doc, text, initial: project.files[project.entryFilePath].content };
}

describe("collaboration undo", () => {
  it("undoes local editor changes without capturing remote updates", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project);
    const fileId = projectCollaborationDocument(doc).nodeIdByPath.get(project.entryFilePath);
    const text = fileId ? getCollaborationTexts(doc).get(fileId) : undefined;
    expect(text).toBeInstanceOf(Y.Text);
    const manager = createCollaborationUndoManager(doc);

    doc.transact(() => text!.insert(0, "local-"), COLLABORATION_ORIGIN.localEditor);
    manager.stopCapturing();
    doc.transact(() => text!.insert(text!.length, "-remote"), COLLABORATION_ORIGIN.remoteProvider);
    manager.undo();

    expect(text!.toString()).toBe(`${project.files[project.entryFilePath].content}-remote`);
    manager.redo();
    expect(text!.toString()).toBe(`local-${project.files[project.entryFilePath].content}-remote`);
    manager.destroy();
  });

  it("tracks y-monaco transactions by binding constructor", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project);
    const fileId = projectCollaborationDocument(doc).nodeIdByPath.get(project.entryFilePath);
    const text = fileId ? getCollaborationTexts(doc).get(fileId) : undefined;
    if (!text) throw new Error("collaboration text is missing");
    const manager = createCollaborationUndoManager(doc);
    const bindingOrigin = Object.create(MonacoBinding.prototype) as MonacoBinding;

    doc.transact(() => text.insert(0, "bound-"), bindingOrigin);
    manager.undo();
    expect(text.toString()).toBe(project.files[project.entryFilePath].content);

    manager.destroy();
    doc.destroy();
  });

  it("tracks an origin registered after the manager was created", () => {
    // A room can sync, and so create its manager, before the lazy CodeEditor
    // module that registers MonacoBinding has evaluated.
    const { doc, text, initial } = seedEntryText();
    const manager = createCollaborationUndoManager(doc);
    class LateOrigin {}
    trackCollaborationUndoOrigin(LateOrigin);

    doc.transact(() => text.insert(0, "late-"), new LateOrigin());
    manager.undo();
    expect(text.toString()).toBe(initial);

    manager.destroy();
    doc.destroy();
  });

  // The room refuses a single update over MAX_YJS_UPDATE_BYTES, and the
  // provider ends the session on one. Undoing a deletion re-inserts all of it
  // in one update, so a deletion too large for that is not undoable.
  describe("a change too large to restore in one room update", () => {
    function largestUpdateDuring(doc: Y.Doc, run: () => void): number {
      let largest = 0;
      const onUpdate = (update: Uint8Array) => {
        largest = Math.max(largest, update.byteLength);
      };
      doc.on("update", onUpdate);
      run();
      doc.off("update", onUpdate);
      return largest;
    }

    function insertInChunks(text: Y.Text, content: string, origin: unknown) {
      for (let offset = 0; offset < content.length; offset += 10_000) {
        text.doc!.transact(
          () => text.insert(text.length, content.slice(offset, offset + 10_000)),
          origin,
        );
      }
    }

    for (const [label, content] of [
      ["70,000 ASCII characters", "x".repeat(70_000)],
      ["30,000 CJK characters (about 90 KB of UTF-8)", "\u4e00".repeat(30_000)],
    ] as const) {
      it(`leaves a deletion of ${label} deleted instead of failing the room`, () => {
        const { doc, text } = seedEntryText();
        const initial = text.toString();
        insertInChunks(text, content, COLLABORATION_ORIGIN.remoteProvider);
        const manager = createCollaborationUndoManager(doc);

        doc.transact(
          () => text.delete(initial.length, content.length),
          COLLABORATION_ORIGIN.localEditor,
        );
        expect(largestUpdateDuring(doc, () => manager.undo())).toBeLessThanOrEqual(
          MAX_YJS_UPDATE_BYTES,
        );
        expect(text.toString()).toBe(initial);

        manager.destroy();
        doc.destroy();
      });
    }

    it("does not offer a redo that would re-insert a large chunked insertion", () => {
      const { doc, text } = seedEntryText();
      const initial = text.toString();
      const manager = createCollaborationUndoManager(doc);
      insertInChunks(text, "x".repeat(70_000), COLLABORATION_ORIGIN.localEditor);

      manager.undo();
      expect(text.toString()).toBe(initial);
      expect(largestUpdateDuring(doc, () => manager.redo())).toBeLessThanOrEqual(
        MAX_YJS_UPDATE_BYTES,
      );
      expect(text.toString()).toBe(initial);

      manager.destroy();
      doc.destroy();
    });

    it("still undoes and redoes an ordinary deletion", () => {
      const { doc, text } = seedEntryText();
      const initial = text.toString();
      insertInChunks(text, "y".repeat(1_000), COLLABORATION_ORIGIN.remoteProvider);
      const manager = createCollaborationUndoManager(doc);

      doc.transact(() => text.delete(initial.length, 1_000), COLLABORATION_ORIGIN.localEditor);
      manager.undo();
      expect(text.toString()).toBe(`${initial}${"y".repeat(1_000)}`);
      manager.redo();
      expect(text.toString()).toBe(initial);

      manager.destroy();
      doc.destroy();
    });
  });

  it("stops updating a manager once it is destroyed", () => {
    const destroyedExplicitly = createCollaborationUndoManager(seedEntryText().doc);
    destroyedExplicitly.destroy();
    const { doc } = seedEntryText();
    const destroyedWithDoc = createCollaborationUndoManager(doc);
    doc.destroy();
    class AfterDestroyOrigin {}
    trackCollaborationUndoOrigin(AfterDestroyOrigin);

    expect(destroyedExplicitly.trackedOrigins.has(AfterDestroyOrigin)).toBe(false);
    expect(destroyedWithDoc.trackedOrigins.has(AfterDestroyOrigin)).toBe(false);
  });
});
