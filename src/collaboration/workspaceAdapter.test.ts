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
});
