import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import { isWorkspaceTextFile } from "../types/workspace";
import {
  assertCollaborationProjectStructure,
  COLLABORATION_ORIGIN,
  COLLABORATION_PROJECT_ROOT,
  CollaborationProjectController,
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

describe("collaboration project structure guard", () => {
  it("accepts an unseeded document and a correctly seeded one", () => {
    // Unseeded: the room exists but nothing has been written yet.
    expect(() => assertCollaborationProjectStructure(new Y.Doc())).not.toThrow();

    const doc = new Y.Doc();
    seedCollaborationProject(doc, createStarterHtmlCssWorkspace(), { idFactory: idFactory() });
    expect(() => assertCollaborationProjectStructure(doc)).not.toThrow();
  });

  it("rejects a poisoned schemaVersion that would brick the room for everyone", () => {
    const doc = new Y.Doc();
    seedCollaborationProject(doc, createStarterHtmlCssWorkspace(), { idFactory: idFactory() });

    // One ordinary CRDT write, well under the update size limit. Before this
    // guard it was persisted and rebroadcast, and projectCollaborationDocument
    // then threw for every participant — permanently, with no way to reset it.
    doc.getMap(COLLABORATION_PROJECT_ROOT).set("schemaVersion", 2);

    expect(() => assertCollaborationProjectStructure(doc)).toThrow(/schema version/i);
    expect(() => projectCollaborationDocument(doc)).toThrow(/schema version/i);
  });

  it("rejects replacing a child map with a scalar", () => {
    // childMap() silently overwrites a non-map with a fresh empty one, so this
    // would have discarded every file and its contents on the next read.
    for (const key of ["texts", "nodes", "metadata"]) {
      const doc = new Y.Doc();
      seedCollaborationProject(doc, createStarterHtmlCssWorkspace(), { idFactory: idFactory() });
      doc.getMap(COLLABORATION_PROJECT_ROOT).set(key, "not-a-map");
      expect(() => assertCollaborationProjectStructure(doc)).toThrow(new RegExp(key));
    }
  });
});

describe("collaboration project document", () => {
  it("round-trips a workspace through stable folder/file nodes", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, { idFactory: idFactory() });

    const projection = projectCollaborationDocument(doc);
    expect(projection.project).toEqual(project);
    expect(projection.issues).toEqual([]);
    expect(projection.nodeIdByPath.size).toBe(
      project.folders.length + Object.keys(project.files).length,
    );
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
    const firstProjection = projectCollaborationDocument(first);
    const secondProjection = projectCollaborationDocument(second);
    expect(firstProjection.project).toEqual(secondProjection.project);
    expect(Array.from(firstProjection.nodeIdByPath.entries())).toEqual(
      Array.from(secondProjection.nodeIdByPath.entries()),
    );
    expect(Array.from(firstProjection.pathByNodeId.entries())).toEqual(
      Array.from(secondProjection.pathByNodeId.entries()),
    );
    expect(Array.from(firstProjection.textIdByType.values()).sort()).toEqual(
      Array.from(secondProjection.textIdByType.values()).sort(),
    );
    expect(Array.from(firstProjection.assetsByNodeId.entries())).toEqual(
      Array.from(secondProjection.assetsByNodeId.entries()),
    );
    expect(firstProjection.issues).toEqual(secondProjection.issues);
    expect(firstProjection.issues.map((issue) => issue.kind)).toContain("invalid-parent");
    expect(firstProjection.issues.map((issue) => issue.kind)).toContain("parent-cycle");
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

  it("projects file and tree commands and rejects writes for viewers", () => {
    const project = createStarterHtmlCssWorkspace();
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, { idFactory: idFactory() });
    let commandId = 0;
    const controller = new CollaborationProjectController(doc, {
      canWrite: () => true,
      idFactory: () => `f0000000-0000-4000-8000-${String(++commandId).padStart(12, "0")}`,
    });

    controller.createFolder("examples");
    controller.createFile("examples/demo.ts", "export const demo = 1;");
    controller.replaceFileContent("examples/demo.ts", "export const demo = 2;");
    controller.renameFile("examples/demo.ts", "examples/renamed.ts");
    controller.setEntryFile("examples/renamed.ts");
    const projection = projectCollaborationDocument(doc).project;
    expect(projection.files["examples/renamed.ts"].content).toBe("export const demo = 2;");
    expect(projection.entryFilePath).toBe("examples/renamed.ts");

    const viewer = new CollaborationProjectController(doc, { canWrite: () => false });
    expect(() => viewer.createFile("blocked.ts")).toThrow("read-only");
    expect(projectCollaborationDocument(doc).project.files["blocked.ts"]).toBeUndefined();

    controller.deleteFolder("examples");
    expect(projectCollaborationDocument(doc).project.files["examples/renamed.ts"]).toBeUndefined();
  });

  it("applies Monaco text ranges to Y.Text without replacing the whole value", () => {
    const project = createStarterHtmlCssWorkspace();
    const path = project.entryFilePath;
    const file = project.files[path];
    if (!isWorkspaceTextFile(file)) throw new Error("Expected a text entry file");
    const before = file.content;
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, { idFactory: idFactory() });
    const projection = projectCollaborationDocument(doc);
    const getProjection = vi.fn<() => typeof projection>(() => projection);
    const controller = new CollaborationProjectController(doc, {
      canWrite: () => true,
      getProjection,
    });
    const insertion = "<!-- incremental -->\n";

    expect(
      controller.applyFileTextEdits({
        fileId: path,
        path,
        beforeVersion: 10,
        afterVersion: 11,
        beforeLength: before.length,
        afterLength: before.length + insertion.length,
        changes: [{ offset: 0, deleteLength: 0, text: insertion }],
      }),
    ).toBe(true);
    expect(projectCollaborationDocument(doc).project.files[path].content).toBe(insertion + before);

    expect(
      controller.applyFileTextEdits({
        fileId: path,
        path,
        beforeVersion: 11,
        afterVersion: 12,
        beforeLength: before.length,
        afterLength: before.length + 1,
        changes: [{ offset: 0, deleteLength: 0, text: "!" }],
      }),
    ).toBe(false);
    expect(getProjection).toHaveBeenCalledTimes(2);
  });

  it("keeps binary bytes outside Yjs and projects content-addressed asset descriptors", () => {
    const project = createStarterHtmlCssWorkspace();
    project.files["logo.png"] = {
      path: "logo.png",
      name: "logo.png",
      language: "plaintext",
      content: {
        kind: "asset",
        assetId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        mimeType: "image/png",
        size: 5,
      },
      encoding: "asset",
    };
    const doc = new Y.Doc();
    seedCollaborationProject(doc, project, {
      idFactory: idFactory(),
      skipBinaryAssets: true,
    });
    const controller = new CollaborationProjectController(doc, {
      canWrite: () => true,
      idFactory: () => "f0000000-0000-4000-8000-000000000001",
    });
    const asset = {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mimeType: "image/png",
      size: 5,
    } as const;
    controller.createAssetFile("logo.png", asset);

    const unloaded = projectCollaborationDocument(doc);
    const assetNodeId = unloaded.nodeIdByPath.get("logo.png");
    expect(assetNodeId).toBeTruthy();
    expect(unloaded.project.files["logo.png"].content).toEqual({
      kind: "asset",
      assetId: asset.id,
      mimeType: asset.mimeType,
      size: asset.size,
    });
    expect(unloaded.assetsByNodeId.get(assetNodeId!)).toEqual(asset);
    expect(getCollaborationTexts(doc).get(assetNodeId!)).toBeUndefined();
    expect(unloaded.issues).not.toContainEqual({ nodeId: assetNodeId, kind: "missing-text" });
  });

  it("converges concurrent tree commands with deterministic collision paths", () => {
    const project = createStarterHtmlCssWorkspace();
    const seed = new Y.Doc();
    seedCollaborationProject(seed, project, { idFactory: idFactory() });
    const snapshot = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, snapshot);
    Y.applyUpdate(right, snapshot);
    const leftController = new CollaborationProjectController(left, { canWrite: () => true });
    const rightController = new CollaborationProjectController(right, {
      canWrite: () => true,
      idFactory: () => "f0000000-0000-4000-8000-000000000001",
    });
    leftController.renameFile(project.entryFilePath, "same.ts");
    rightController.createFile("same.ts", "other");

    const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(seed));
    const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(seed));
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);
    expect(projectCollaborationDocument(left).project).toEqual(
      projectCollaborationDocument(right).project,
    );
    expect(
      Object.keys(projectCollaborationDocument(left).project.files).filter((path) =>
        path.startsWith("same.ts"),
      ),
    ).toHaveLength(2);
  });
});
