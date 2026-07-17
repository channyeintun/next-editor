import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  COLLABORATION_ORIGIN,
  CollaborationProjectController,
  seedCollaborationProject,
} from "./projectDocument";
import {
  projectCollaborationTransaction,
  reprojectCollaborationWorkspace,
} from "./workspaceAdapter";

describe("collaboration workspace projection", () => {
  it("updates only the affected path for text transactions and rebuilds for tree changes", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project);
    const actions = {
      reconcileExternalProject: vi.fn(),
      updateFileContent: vi.fn(),
    };
    let projection = reprojectCollaborationWorkspace(doc, actions);
    actions.reconcileExternalProject.mockClear();
    const controller = new CollaborationProjectController(doc, { canWrite: () => true });
    doc.on("afterTransaction", (transaction) => {
      projection = projectCollaborationTransaction(doc, transaction, projection, actions);
    });

    controller.replaceFileContent(project.entryFilePath, "changed");
    expect(actions.updateFileContent).toHaveBeenCalledWith(project.entryFilePath, "changed");
    expect(actions.reconcileExternalProject).not.toHaveBeenCalled();

    controller.createFile("created.ts", "export {}");
    expect(actions.reconcileExternalProject).toHaveBeenCalledTimes(1);
    expect(projection.project.files["created.ts"].content).toBe("export {}");
  });

  it("does not turn projection-origin store writes into Yjs writes", () => {
    const doc = new Y.Doc();
    seedCollaborationProject(doc, createStarterHtmlCssWorkspace());
    const origins: unknown[] = [];
    doc.on("update", (_update, origin) => origins.push(origin));
    doc.transact(() => {}, COLLABORATION_ORIGIN.workspaceProjection);
    expect(origins).toEqual([]);
  });

  it("projects a queued local Monaco edit without replacing the full file", () => {
    const project = createStarterHtmlCssWorkspace();
    const path = project.entryFilePath;
    const file = project.files[path];
    if (!file || typeof file.content !== "string") throw new Error("Expected a text entry file");

    const doc = new Y.Doc();
    seedCollaborationProject(doc, project);
    const event = {
      fileId: path,
      path,
      beforeVersion: 1,
      afterVersion: 2,
      beforeLength: file.content.length,
      afterLength: file.content.length + 1,
      changes: [{ offset: file.content.length, deleteLength: 0, text: "!" }],
    };
    const actions = {
      reconcileExternalProject: vi.fn(),
      updateFileContent: vi.fn(),
      applyFileTextEdits: vi.fn(() => `${file.content}!`),
    };
    let projection = reprojectCollaborationWorkspace(doc, actions);
    actions.reconcileExternalProject.mockClear();
    const controller = new CollaborationProjectController(doc, { canWrite: () => true });
    doc.on("afterTransaction", (transaction) => {
      projection = projectCollaborationTransaction(doc, transaction, projection, actions, event);
    });

    expect(controller.applyFileTextEdits(event)).toBe(true);
    expect(actions.applyFileTextEdits).toHaveBeenCalledWith(event);
    expect(actions.updateFileContent).not.toHaveBeenCalled();
    expect(actions.reconcileExternalProject).not.toHaveBeenCalled();
  });
});
