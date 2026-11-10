import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { createStarterHtmlCssWorkspace } from "../starters/htmlCss";
import {
  assertCollaborationProjectStructure,
  CollaborationProjectController,
  getCollaborationNodes,
  MAX_COLLABORATION_PROJECT_NODES,
  projectCollaborationDocument,
  seedCollaborationProject,
} from "./projectDocument";

// Trees an editor can write with ordinary Yjs updates but no client ever
// creates. Every member projects them on every join and tree change, so the
// projection's cost has to stay linear in the node count and its result has to
// stay a usable workspace.

function seededDoc(): Y.Doc {
  const doc = new Y.Doc();
  let index = 0;
  seedCollaborationProject(doc, createStarterHtmlCssWorkspace(), {
    idFactory: () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
  });
  return doc;
}

/**
 * `count` distinct node ids that all compact to "abcdefgh" once hyphens are
 * removed and case is folded, as shortStableId does: every hyphen placement in
 * the 9 gaps of the id, then every case variant of each.
 */
function idsCompactingToTheSameSuffix(count: number): string[] {
  const letters = "abcdefgh";
  const ids: string[] = [];
  for (let caseMask = 0; caseMask < 1 << letters.length && ids.length < count; caseMask += 1) {
    const cased = Array.from(letters, (letter, index) =>
      caseMask & (1 << index) ? letter.toUpperCase() : letter,
    );
    for (let hyphenMask = 0; hyphenMask < 1 << 9 && ids.length < count; hyphenMask += 1) {
      let id = "";
      for (let gap = 0; gap <= cased.length; gap += 1) {
        if (hyphenMask & (1 << gap)) id += "-";
        if (gap < cased.length) id += cased[gap];
      }
      ids.push(id);
    }
  }
  return ids;
}

/** Counts Array.prototype.find predicate calls made while `run` runs. */
function countFindPredicateCalls<T>(run: () => T): { result: T; calls: number } {
  const original = Array.prototype.find;
  let calls = 0;
  Array.prototype.find = function find(
    this: unknown[],
    predicate: (value: unknown, index: number, array: unknown[]) => unknown,
    thisArg?: unknown,
  ) {
    return original.call(
      this,
      (value: unknown, index: number, array: unknown[]) => {
        calls += 1;
        return predicate.call(thisArg, value, index, array);
      },
      thisArg,
    );
  } as typeof Array.prototype.find;
  try {
    return { result: run(), calls };
  } finally {
    Array.prototype.find = original;
  }
}

describe("collaboration projection of hostile trees", () => {
  it("names colliding siblings uniquely in linear work, even when their ids compact alike", () => {
    const count = 2_000;
    const doc = seededDoc();
    const ids = idsCompactingToTheSameSuffix(count);
    expect(new Set(ids).size).toBe(count);
    const nodes = getCollaborationNodes(doc);
    doc.transact(() => {
      for (const id of ids) {
        // Only the kind: the name defaults to "untitled" and the order key to
        // the id, so every sibling collides on the same base name.
        const node = new Y.Map<unknown>();
        node.set("kind", "folder");
        nodes.set(id, node);
      }
    });

    const { result: projection, calls } = countFindPredicateCalls(() =>
      projectCollaborationDocument(doc),
    );

    // The suffix loop used to search the siblings once per colliding id in each
    // of its 12 rounds: about 6n^2 (24 million here) predicate calls.
    expect(calls).toBeLessThan(count * 10);
    const paths = ids.map((id) => projection.pathByNodeId.get(id));
    expect(paths.every((path) => typeof path === "string")).toBe(true);
    // Every node keeps its own path, so each one can still be opened, renamed
    // and deleted by path.
    expect(new Set(paths).size).toBe(count);
    for (const id of ids) {
      expect(projection.nodeIdByPath.get(projection.pathByNodeId.get(id) ?? "")).toBe(id);
    }
    expect(projection.nodeIdByPath.size).toBe(projection.pathByNodeId.size);

    // Deterministic: a peer that received the same state projects the same names.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(Array.from(projectCollaborationDocument(peer).pathByNodeId.entries()).sort()).toEqual(
      Array.from(projection.pathByNodeId.entries()).sort(),
    );
  });

  it("keeps a unique fallback name clear of an explicit name that claims it", () => {
    const doc = seededDoc();
    const ids = idsCompactingToTheSameSuffix(3);
    const nodes = getCollaborationNodes(doc);
    doc.transact(() => {
      for (const id of ids) {
        const node = new Y.Map<unknown>();
        node.set("kind", "folder");
        nodes.set(id, node);
      }
      const squatter = new Y.Map<unknown>();
      squatter.set("kind", "folder");
      squatter.set("name", "untitled~abcdefgh~2");
      nodes.set("ffffffff-ffff-4fff-8fff-ffffffffffff", squatter);
    });

    const projection = projectCollaborationDocument(doc);

    const paths = [...ids, "ffffffff-ffff-4fff-8fff-ffffffffffff"].map((id) =>
      projection.pathByNodeId.get(id),
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(projection.pathByNodeId.get("ffffffff-ffff-4fff-8fff-ffffffffffff")).toBe(
      "untitled~abcdefgh~2",
    );
    expect(projection.nodeIdByPath.size).toBe(projection.pathByNodeId.size);
  });

  it("projects a folder chain far deeper than any workspace in linear work", () => {
    const doc = seededDoc();
    const nodes = getCollaborationNodes(doc);
    // As deep as the room's node limit allows.
    const depth = MAX_COLLABORATION_PROJECT_NODES - nodes.size;
    doc.transact(() => {
      for (let index = 0; index < depth; index += 1) {
        // Only kind and parentId: a chain node needs nothing else.
        const node = new Y.Map<unknown>();
        node.set("kind", "folder");
        node.set("parentId", index === 0 ? null : `chain-${index - 1}`);
        nodes.set(`chain-${index}`, node);
      }
    });
    // Nothing in the room's per-update check looks at the tree's shape.
    expect(() => assertCollaborationProjectStructure(doc)).not.toThrow();

    // The projection walked to the root again from every node (about d^2/2
    // steps) and then recursed once per level, so a chain this deep threw
    // RangeError for every member, on every join and every later change.
    const startedAt = performance.now();
    const projection = projectCollaborationDocument(doc);
    expect(performance.now() - startedAt).toBeLessThan(2_000);

    // Every node is still in the workspace: what lies past the depth limit is
    // moved, a level at a time, into the recovery folder.
    for (let index = 0; index < depth; index += 1) {
      expect(projection.pathByNodeId.has(`chain-${index}`)).toBe(true);
    }
    const allPaths = [...projection.pathByNodeId.values()];
    expect(Math.max(...allPaths.map((path) => path.split("/").length))).toBeLessThanOrEqual(64);
    expect(projection.nodeIdByPath.size).toBe(projection.pathByNodeId.size);
    expect(projection.recoveryFolderPath).toBe("Recovered items");
    expect(projection.issues.some((issue) => issue.kind === "depth-limit")).toBe(true);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(Array.from(projectCollaborationDocument(peer).pathByNodeId.entries()).sort()).toEqual(
      Array.from(projection.pathByNodeId.entries()).sort(),
    );
  }, 30_000);

  it("bounds every projected name and path, however long the stored names are", () => {
    const doc = seededDoc();
    const nodes = getCollaborationNodes(doc);
    doc.transact(() => {
      const huge = new Y.Map<unknown>();
      huge.set("kind", "file");
      huge.set("name", `${"a".repeat(100_000)}.txt`);
      nodes.set("huge-name", huge);
      // 40 levels of 250-character names: within the depth limit, but a path
      // of about 10,000 characters if nothing moved part of it.
      for (let index = 0; index < 40; index += 1) {
        const node = new Y.Map<unknown>();
        node.set("kind", "folder");
        node.set("name", `${String(index).padStart(3, "0")}${"b".repeat(247)}`);
        node.set("parentId", index === 0 ? null : `long-${index - 1}`);
        nodes.set(`long-${index}`, node);
      }
    });

    const projection = projectCollaborationDocument(doc);

    const hugePath = projection.pathByNodeId.get("huge-name") ?? "";
    expect(hugePath.length).toBeGreaterThan(0);
    expect(Array.from(hugePath).length).toBeLessThanOrEqual(255);
    for (let index = 0; index < 40; index += 1) {
      expect(projection.pathByNodeId.has(`long-${index}`)).toBe(true);
    }
    for (const path of projection.pathByNodeId.values()) {
      expect(path.length).toBeLessThanOrEqual(4096);
    }
  });

  it("refuses a document with more nodes than a room holds, and creating past it", () => {
    const doc = seededDoc();
    const nodes = getCollaborationNodes(doc);
    const seeded = nodes.size;
    doc.transact(() => {
      for (let index = seeded; index < MAX_COLLABORATION_PROJECT_NODES; index += 1) {
        const node = new Y.Map<unknown>();
        node.set("kind", "folder");
        node.set("deleted", true);
        nodes.set(`filler-${index}`, node);
      }
    });
    expect(() => assertCollaborationProjectStructure(doc)).not.toThrow();

    const controller = new CollaborationProjectController(doc, { canWrite: () => true });
    expect(() => controller.createFile("one-too-many.txt", "")).toThrow(/at most/i);
    expect(() => controller.createFolder("one-too-many")).toThrow(/at most/i);
    expect(nodes.size).toBe(MAX_COLLABORATION_PROJECT_NODES);

    // A peer that skips the controller is refused by the room's update check.
    const extra = new Y.Map<unknown>();
    extra.set("kind", "file");
    nodes.set("one-past-the-limit", extra);
    expect(() => assertCollaborationProjectStructure(doc)).toThrow(/at most/i);
  });

  it("refuses to start a room from a workspace past the node limit", () => {
    const project = createStarterHtmlCssWorkspace();
    const files = { ...project.files };
    for (let index = 0; index <= MAX_COLLABORATION_PROJECT_NODES; index += 1) {
      const path = `many/file-${index}.txt`;
      files[path] = { path, name: `file-${index}.txt`, language: "plaintext", content: "" };
    }

    expect(() => seedCollaborationProject(new Y.Doc(), { ...project, files })).toThrow(/at most/i);
  });
});
