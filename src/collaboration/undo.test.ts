import { describe, expect, it } from "vitest";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  COLLABORATION_ORIGIN,
  getCollaborationTexts,
  projectCollaborationDocument,
  seedCollaborationProject,
} from "./projectDocument";
import { createCollaborationUndoManager } from "./undo";

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
});
