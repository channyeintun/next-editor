import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  COLLABORATION_ORIGIN,
  getCollaborationNodes,
  getCollaborationTexts,
  projectCollaborationDocument,
  seedCollaborationProject,
} from "./projectDocument";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
];

function idFactory() {
  let index = 0;
  return () => IDS[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("collaboration project document", () => {
  it("round-trips a workspace through stable folder/file nodes", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, { idFactory: idFactory() });

    const projection = projectCollaborationDocument(doc);
    expect(projection.project).toEqual(project);
    expect(projection.issues).toEqual([]);
    expect(projection.nodeIdByPath.size).toBe(project.folders.length + Object.keys(project.files).length);
  });

  it("converges text after concurrent, duplicated, and reordered updates", () => {
    const project = createStarterHtmlCssWorkspace();
    const seed = new Y.Doc();
    seedCollaborationProject(seed, project, { idFactory: idFactory() });
    const snapshot = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, snapshot);
    Y.applyUpdate(right, snapshot);

    const fileId = projectCollaborationDocument(left).nodeIdByPath.get(project.entryFilePath);
    expect(fileId).toBeTruthy();
    left.transact(() => {
      getCollaborationTexts(left).get(fileId!)?.insert(0, "left");
    }, COLLABORATION_ORIGIN.localEditor);
    right.transact(() => {
      getCollaborationTexts(right).get(fileId!)?.insert(0, "right");
    }, COLLABORATION_ORIGIN.localEditor);
    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(seed));
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(seed));

    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    Y.applyUpdate(right, leftUpdate);

    expect(Y.encodeStateAsUpdate(left)).toEqual(Y.encodeStateAsUpdate(right));
    expect(projectCollaborationDocument(left).project).toEqual(
      projectCollaborationDocument(right).project,
    );
  });

  it("repairs invalid parents and cycles deterministically", () => {
    const project = createStarterHtmlCssWorkspace();
    const first = new Y.Doc();
    seedCollaborationProject(first, project, { idFactory: idFactory() });
    const nodes = getCollaborationNodes(first);
    const ids = Array.from(nodes.keys()).sort();
    nodes.get(ids[0])?.set("parentId", "ffffffff-ffff-4fff-8fff-ffffffffffff");
    if (ids[1] && ids[2]) {
      nodes.get(ids[1])?.set("kind", "folder");
      nodes.get(ids[2])?.set("kind", "folder");
      nodes.get(ids[1])?.set("parentId", ids[2]);
      nodes.get(ids[2])?.set("parentId", ids[1]);
    }

    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    expect(projectCollaborationDocument(first)).toEqual(projectCollaborationDocument(second));
    expect(projectCollaborationDocument(first).issues.map((issue) => issue.kind)).toContain(
      "invalid-parent",
    );
    expect(projectCollaborationDocument(first).issues.map((issue) => issue.kind)).toContain(
      "parent-cycle",
    );
  });

  it("keeps colliding siblings with deterministic stable-ID suffixes", () => {
    const project = createStarterHtmlCssWorkspace();
    const first = new Y.Doc();
    seedCollaborationProject(first, project, { idFactory: idFactory() });
    const nodes = Array.from(getCollaborationNodes(first).entries());
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    nodes[0][1].set("name", "same.ts");
    nodes[0][1].set("parentId", null);
    nodes[1][1].set("name", "same.ts");
    nodes[1][1].set("parentId", null);

    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    const firstPaths = Array.from(projectCollaborationDocument(first).pathByNodeId.entries());
    const secondPaths = Array.from(projectCollaborationDocument(second).pathByNodeId.entries());
    expect(firstPaths).toEqual(secondPaths);
    expect(firstPaths.filter(([, path]) => path.startsWith("same.ts")).length).toBe(2);
  });
});
