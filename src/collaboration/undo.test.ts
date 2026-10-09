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
