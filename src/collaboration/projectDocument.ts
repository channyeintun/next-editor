import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  collaborationAssetDescriptorSchema,
  type CollaborationAssetDescriptor,
  type CollaborationRole,
} from "./protocol";
import {
  DEFAULT_WORKSPACE_ENTRY_PATH,
  collectWorkspaceFolders,
  inferLanguageFromPath,
  parseWorkspacePath,
  type WorkspaceFile,
  type WorkspaceFileEncoding,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
import { prepareTextEditEvent, type TextEditEvent } from "../types/textEdit";

export const COLLABORATION_PROJECT_ROOT = "project";
export const COLLABORATION_PROJECT_METADATA = "metadata";
export const COLLABORATION_PROJECT_NODES = "nodes";
export const COLLABORATION_PROJECT_TEXTS = "texts";
export const COLLABORATION_RECOVERY_FOLDER_NAME = "Recovered items";

export const COLLABORATION_ORIGIN = {
  seed: "collaboration-seed",
  localEditor: "local-editor",
  localTreeCommand: "local-tree-command",
  remoteProvider: "remote-provider",
  workspaceProjection: "workspace-projection",
  playback: "playback",
} as const;

export type CollaborationTransactionOrigin =
  (typeof COLLABORATION_ORIGIN)[keyof typeof COLLABORATION_ORIGIN];
export type CollaborationNodeKind = "file" | "folder";

interface CollaborationNodeSnapshot {
  id: string;
  kind: CollaborationNodeKind;
  name: string;
  parentId: string | null;
  orderKey: string;
  deleted: boolean;
  encoding: WorkspaceFileEncoding;
  asset: CollaborationAssetDescriptor | null;
}

export interface CollaborationProjectionIssue {
  nodeId: string;
  kind: "invalid-parent" | "parent-cycle" | "name-collision" | "missing-text" | "missing-asset";
}

export interface CollaborationProjectProjection {
  project: WorkspaceProject;
  nodeIdByPath: ReadonlyMap<string, string>;
  pathByNodeId: ReadonlyMap<string, string>;
  assetsByNodeId: ReadonlyMap<string, CollaborationAssetDescriptor>;
  issues: readonly CollaborationProjectionIssue[];
}

export class CollaborationProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationProjectError";
  }
}

function projectRoot(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(COLLABORATION_PROJECT_ROOT);
}

function childMap<T>(root: Y.Map<unknown>, key: string): Y.Map<T> {
  const value = root.get(key);
  if (value instanceof Y.Map) return value as Y.Map<T>;

  const map = new Y.Map<T>();
  root.set(key, map);
  return map;
}

export function getCollaborationMetadata(doc: Y.Doc): Y.Map<unknown> {
  return childMap(projectRoot(doc), COLLABORATION_PROJECT_METADATA);
}

export function getCollaborationNodes(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return childMap(projectRoot(doc), COLLABORATION_PROJECT_NODES);
}

export function getCollaborationTexts(doc: Y.Doc): Y.Map<Y.Text> {
  return childMap(projectRoot(doc), COLLABORATION_PROJECT_TEXTS);
}

function splitPath(path: string): { parentPath: string; name: string } {
  const normalized = parseWorkspacePath(path);
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { parentPath: "", name: normalized }
    : { parentPath: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}

function sortedFolderPaths(project: WorkspaceProject): string[] {
  return Array.from(
    new Set(
      collectWorkspaceFolders(Object.keys(project.files), project.folders).map((path) =>
        parseWorkspacePath(path),
      ),
    ),
  )
    .filter(Boolean)
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    });
}

function orderedKey(index: number): string {
  return index.toString(36).padStart(8, "0");
}

function createNodeMap(node: CollaborationNodeSnapshot): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("kind", node.kind);
  map.set("name", node.name);
  map.set("parentId", node.parentId);
  map.set("orderKey", node.orderKey);
  map.set("deleted", node.deleted);
  map.set("encoding", node.encoding);
  map.set("assetId", node.asset?.id ?? null);
  map.set("assetMimeType", node.asset?.mimeType ?? null);
  map.set("assetSize", node.asset?.size ?? null);
  return map;
}

export interface SeedCollaborationProjectOptions {
  idFactory?: () => string;
  origin?: CollaborationTransactionOrigin;
  skipBinaryAssets?: boolean;
}

/**
 * Seeds an empty collaborative document exactly once. The room-creation route
 * persists this update before another member can join, so clients never race
 * to import the same path-based project with different stable node IDs.
 */
export function seedCollaborationProject(
  doc: Y.Doc,
  project: WorkspaceProject,
  options: SeedCollaborationProjectOptions = {},
): void {
  const root = projectRoot(doc);
  const nodes = getCollaborationNodes(doc);
  if (nodes.size > 0 || root.get("schemaVersion") !== undefined) {
    throw new CollaborationProjectError("The collaboration document has already been seeded");
  }

  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const pathIds = new Map<string, string>();
  const unsupportedAsset = Object.values(project.files).find(
    (file) => (file.encoding ?? "utf-8") !== "utf-8",
  );
  if (unsupportedAsset && !options.skipBinaryAssets) {
    throw new CollaborationProjectError(
      `Binary asset ${unsupportedAsset.path} must be uploaded before a collaboration room is created`,
    );
  }

  doc.transact(() => {
    root.set("schemaVersion", COLLABORATION_DOCUMENT_SCHEMA_VERSION);
    const metadata = getCollaborationMetadata(doc);
    const texts = getCollaborationTexts(doc);
    metadata.set("projectId", project.id);
    metadata.set("name", project.name);
    metadata.set("lessonType", project.lessonType);

    let order = 0;
    for (const path of sortedFolderPaths(project)) {
      const { parentPath, name } = splitPath(path);
      const id = idFactory();
      pathIds.set(path, id);
      nodes.set(
        id,
        createNodeMap({
          id,
          kind: "folder",
          name,
          parentId: parentPath ? (pathIds.get(parentPath) ?? null) : null,
          orderKey: orderedKey(order++),
          deleted: false,
          encoding: "utf-8",
          asset: null,
        }),
      );
    }

    const files = Object.values(project.files).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const file of files) {
      if ((file.encoding ?? "utf-8") !== "utf-8") continue;
      const normalizedPath = parseWorkspacePath(file.path);
      const { parentPath, name } = splitPath(normalizedPath);
      const id = idFactory();
      pathIds.set(normalizedPath, id);
      nodes.set(
        id,
        createNodeMap({
          id,
          kind: "file",
          name,
          parentId: parentPath ? (pathIds.get(parentPath) ?? null) : null,
          orderKey: orderedKey(order++),
          deleted: false,
          encoding: "utf-8",
          asset: null,
        }),
      );
      const text = new Y.Text();
      text.insert(0, file.content);
      texts.set(id, text);
    }

    metadata.set("entryNodeId", pathIds.get(parseWorkspacePath(project.entryFilePath)) ?? null);
  }, options.origin ?? COLLABORATION_ORIGIN.seed);
}

function readString(map: Y.Map<unknown>, key: string, fallback: string): string {
  const value = map.get(key);
  return typeof value === "string" ? value : fallback;
}

function readNode(id: string, value: Y.Map<unknown>): CollaborationNodeSnapshot | null {
  const kind = value.get("kind");
  if (kind !== "file" && kind !== "folder") return null;
  const parentId = value.get("parentId");
  const encoding = value.get("encoding");
  const assetResult = collaborationAssetDescriptorSchema.safeParse({
    id: value.get("assetId"),
    mimeType: value.get("assetMimeType"),
    size: value.get("assetSize"),
  });
  return {
    id,
    kind,
    name: readString(value, "name", kind === "file" ? "untitled.txt" : "untitled"),
    parentId: typeof parentId === "string" ? parentId : null,
    orderKey: readString(value, "orderKey", id),
    deleted: value.get("deleted") === true,
    encoding: encoding === "base64" ? "base64" : "utf-8",
    asset: assetResult.success ? assetResult.data : null,
  };
}

const UNSAFE_NODE_NAMES = new Set(["", ".", "..", "__proto__", "prototype", "constructor"]);

function safeNodeName(node: CollaborationNodeSnapshot): string {
  const withoutControls = Array.from(node.name.trim())
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 0x1f && point !== 0x7f && character !== "/" && character !== "\\";
    })
    .join("");
  if (UNSAFE_NODE_NAMES.has(withoutControls)) {
    return node.kind === "file" ? "untitled.txt" : "untitled";
  }
  return withoutControls;
}

const ROOT_PARENT = "__root__";
const RECOVERY_PARENT = "__recovery__";

function effectiveParents(
  nodes: ReadonlyMap<string, CollaborationNodeSnapshot>,
  issues: CollaborationProjectionIssue[],
): Map<string, string> {
  const result = new Map<string, string>();

  for (const node of nodes.values()) {
    if (!node.parentId) {
      result.set(node.id, ROOT_PARENT);
      continue;
    }
    const parent = nodes.get(node.parentId);
    if (!parent || parent.kind !== "folder" || parent.id === node.id) {
      result.set(node.id, RECOVERY_PARENT);
      issues.push({ nodeId: node.id, kind: "invalid-parent" });
      continue;
    }
    result.set(node.id, parent.id);
  }

  // Parent edges have out-degree one, so walking from every node is enough to
  // find each cycle. Breaking the greatest stable ID produces the same tree in
  // every client regardless of update arrival order.
  const repairedCycles = new Set<string>();
  for (const startId of nodes.keys()) {
    const seenAt = new Map<string, number>();
    const path: string[] = [];
    let current: string | undefined = startId;
    while (current && current !== ROOT_PARENT && current !== RECOVERY_PARENT) {
      const cycleStart = seenAt.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const breakId = cycle.sort((left, right) => left.localeCompare(right)).at(-1);
        if (breakId && !repairedCycles.has(breakId)) {
          result.set(breakId, RECOVERY_PARENT);
          issues.push({ nodeId: breakId, kind: "parent-cycle" });
          repairedCycles.add(breakId);
        }
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = result.get(current);
    }
  }

  return result;
}

function shortStableId(id: string, length: number): string {
  const compact = id.replaceAll("-", "").toLowerCase();
  return compact.slice(0, Math.min(length, compact.length)) || "node";
}

function namesByNode(
  children: readonly CollaborationNodeSnapshot[],
  issues: CollaborationProjectionIssue[],
): Map<string, string> {
  const byBase = new Map<string, CollaborationNodeSnapshot[]>();
  for (const child of children) {
    const name = safeNodeName(child);
    const group = byBase.get(name) ?? [];
    group.push(child);
    byBase.set(name, group);
  }

  const result = new Map<string, string>();
  for (const [base, group] of byBase) {
    group.sort((left, right) => left.id.localeCompare(right.id));
    group.forEach((node, index) => {
      result.set(node.id, index === 0 ? base : `${base}~${shortStableId(node.id, 8)}`);
      if (index > 0) issues.push({ nodeId: node.id, kind: "name-collision" });
    });
  }

  // An explicit name can equal another node's generated conflict name. Grow
  // stable-ID suffixes until every sibling name is unique.
  for (let suffixLength = 10; suffixLength <= 32; suffixLength += 2) {
    const claimants = new Map<string, string[]>();
    for (const [id, name] of result) {
      const ids = claimants.get(name) ?? [];
      ids.push(id);
      claimants.set(name, ids);
    }
    const collisions = Array.from(claimants.values()).filter((ids) => ids.length > 1);
    if (collisions.length === 0) break;
    for (const ids of collisions) {
      ids.sort((left, right) => left.localeCompare(right));
      for (const id of ids.slice(1)) {
        const node = children.find((candidate) => candidate.id === id);
        if (node) result.set(id, `${safeNodeName(node)}~${shortStableId(id, suffixLength)}`);
      }
    }
  }

  return result;
}

function isWorkspaceLessonType(value: unknown): value is WorkspaceLessonType {
  return (
    typeof value === "string" &&
    [
      "html-css",
      "react",
      "vue",
      "solid",
      "svelte",
      "htmx-express",
      "alpine-express",
      "express-ts",
    ].includes(value)
  );
}

export interface ProjectCollaborationDocumentOptions {
  assetContentById?: ReadonlyMap<string, string>;
}

export function projectCollaborationDocument(
  doc: Y.Doc,
  options: ProjectCollaborationDocumentOptions = {},
): CollaborationProjectProjection {
  const root = projectRoot(doc);
  if (root.get("schemaVersion") !== COLLABORATION_DOCUMENT_SCHEMA_VERSION) {
    throw new CollaborationProjectError("Unsupported collaboration document schema version");
  }

  const metadata = getCollaborationMetadata(doc);
  const sharedNodes = getCollaborationNodes(doc);
  const texts = getCollaborationTexts(doc);
  const nodes = new Map<string, CollaborationNodeSnapshot>();
  for (const [id, value] of sharedNodes) {
    if (!(value instanceof Y.Map)) continue;
    const node = readNode(id, value);
    if (node && !node.deleted) nodes.set(id, node);
  }

  const issues: CollaborationProjectionIssue[] = [];
  const parents = effectiveParents(nodes, issues);
  const children = new Map<string, CollaborationNodeSnapshot[]>();
  for (const node of nodes.values()) {
    const parent = parents.get(node.id) ?? RECOVERY_PARENT;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id),
    );
  }

  const files: Record<string, WorkspaceFile> = {};
  const folders: string[] = [];
  const nodeIdByPath = new Map<string, string>();
  const pathByNodeId = new Map<string, string>();
  const assetsByNodeId = new Map<string, CollaborationAssetDescriptor>();
  const recoveryChildren = children.get(RECOVERY_PARENT) ?? [];
  let recoveryPath = COLLABORATION_RECOVERY_FOLDER_NAME;
  const rootNames = new Set(
    (children.get(ROOT_PARENT) ?? []).map((node) => safeNodeName(node).toLocaleLowerCase()),
  );
  if (rootNames.has(recoveryPath.toLocaleLowerCase())) {
    recoveryPath = `${COLLABORATION_RECOVERY_FOLDER_NAME}~system`;
  }
  if (recoveryChildren.length > 0) folders.push(recoveryPath);

  const visit = (parentId: string, parentPath: string) => {
    const siblings = children.get(parentId) ?? [];
    const resolvedNames = namesByNode(siblings, issues);
    for (const node of siblings) {
      const name = resolvedNames.get(node.id) ?? safeNodeName(node);
      const path = parentPath ? `${parentPath}/${name}` : name;
      nodeIdByPath.set(path, node.id);
      pathByNodeId.set(node.id, path);
      if (node.kind === "folder") {
        folders.push(path);
        visit(node.id, path);
        continue;
      }

      const text = texts.get(node.id);
      if (node.encoding === "base64") {
        if (node.asset) assetsByNodeId.set(node.id, node.asset);
        else issues.push({ nodeId: node.id, kind: "missing-asset" });
      } else if (!(text instanceof Y.Text)) {
        issues.push({ nodeId: node.id, kind: "missing-text" });
      }
      files[path] = {
        path,
        name,
        language: inferLanguageFromPath(path),
        content:
          node.encoding === "base64"
            ? node.asset
              ? (options.assetContentById?.get(node.asset.id) ?? "")
              : ""
            : text instanceof Y.Text
              ? text.toString()
              : "",
        ...(node.encoding === "base64" ? { encoding: node.encoding } : {}),
      };
    }
  };

  visit(ROOT_PARENT, "");
  if (recoveryChildren.length > 0) visit(RECOVERY_PARENT, recoveryPath);

  const sortedPaths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const entryNodeId = metadata.get("entryNodeId");
  const requestedEntry =
    typeof entryNodeId === "string" ? pathByNodeId.get(entryNodeId) : undefined;
  const entryFilePath =
    (requestedEntry && files[requestedEntry] ? requestedEntry : undefined) ??
    (files[DEFAULT_WORKSPACE_ENTRY_PATH] ? DEFAULT_WORKSPACE_ENTRY_PATH : sortedPaths[0]) ??
    DEFAULT_WORKSPACE_ENTRY_PATH;
  if (sortedPaths.length === 0) {
    files[entryFilePath] = {
      path: entryFilePath,
      name: entryFilePath,
      language: inferLanguageFromPath(entryFilePath),
      content: "",
    };
  }

  const lessonTypeValue = metadata.get("lessonType");
  return {
    project: {
      id: readString(metadata, "projectId", "collaboration-project"),
      name: readString(metadata, "name", "Collaborative project"),
      lessonType: isWorkspaceLessonType(lessonTypeValue) ? lessonTypeValue : "html-css",
      entryFilePath,
      folders: Array.from(new Set(folders)).sort((left, right) => left.localeCompare(right)),
      files,
    },
    nodeIdByPath,
    pathByNodeId,
    assetsByNodeId,
    issues,
  };
}

export function canWriteCollaborationDocument(role: CollaborationRole): boolean {
  return role === "owner" || role === "editor";
}

export interface CollaborationProjectControllerOptions {
  canWrite: () => boolean;
  idFactory?: () => string;
}

const COLLABORATION_TEXT_INSERT_CHUNK_CHARS = 12 * 1024;

function sharedTextReplacement(text: Y.Text, nextContent: string) {
  const current = text.toString();
  if (current === nextContent) return null;
  let prefixLength = 0;
  const commonLength = Math.min(current.length, nextContent.length);
  while (prefixLength < commonLength && current[prefixLength] === nextContent[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < commonLength - prefixLength &&
    current[current.length - 1 - suffixLength] ===
      nextContent[nextContent.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  const deleteLength = current.length - prefixLength - suffixLength;
  const insertion = nextContent.slice(prefixLength, nextContent.length - suffixLength);
  return { prefixLength, deleteLength, insertion };
}

export class CollaborationProjectController {
  private readonly doc: Y.Doc;
  private readonly canWriteDocument: () => boolean;
  private readonly idFactory: () => string;

  constructor(doc: Y.Doc, options: CollaborationProjectControllerOptions) {
    this.doc = doc;
    this.canWriteDocument = options.canWrite;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  private assertWritable(): void {
    if (!this.canWriteDocument()) {
      throw new CollaborationProjectError("This collaboration room is read-only");
    }
  }

  private nodeAtPath(path: string): { id: string; node: Y.Map<unknown> } {
    const normalized = parseWorkspacePath(path);
    const id = projectCollaborationDocument(this.doc).nodeIdByPath.get(normalized);
    const node = id ? getCollaborationNodes(this.doc).get(id) : undefined;
    if (!id || !(node instanceof Y.Map)) {
      throw new CollaborationProjectError(`Collaboration node not found: ${normalized}`);
    }
    return { id, node };
  }

  private parentIdForPath(parentPath: string): string | null {
    if (!parentPath) return null;
    const parent = this.nodeAtPath(parentPath);
    if (parent.node.get("kind") !== "folder" || parent.node.get("deleted") === true) {
      throw new CollaborationProjectError(`Collaboration folder not found: ${parentPath}`);
    }
    return parent.id;
  }

  replaceFileContent(path: string, content: string): void {
    this.assertWritable();
    const { id, node } = this.nodeAtPath(path);
    if (node.get("kind") !== "file" || node.get("deleted") === true) {
      throw new CollaborationProjectError(`Collaboration file not found: ${path}`);
    }
    const text = getCollaborationTexts(this.doc).get(id);
    if (!(text instanceof Y.Text)) {
      throw new CollaborationProjectError(`Collaboration text not found: ${path}`);
    }
    const replacement = sharedTextReplacement(text, content);
    if (!replacement) return;
    if (replacement.deleteLength > 0) {
      this.doc.transact(
        () => text.delete(replacement.prefixLength, replacement.deleteLength),
        COLLABORATION_ORIGIN.localEditor,
      );
    }
    for (
      let offset = 0;
      offset < replacement.insertion.length;
      offset += COLLABORATION_TEXT_INSERT_CHUNK_CHARS
    ) {
      const chunk = replacement.insertion.slice(
        offset,
        offset + COLLABORATION_TEXT_INSERT_CHUNK_CHARS,
      );
      this.doc.transact(
        () => text.insert(replacement.prefixLength + offset, chunk),
        COLLABORATION_ORIGIN.localEditor,
      );
    }
  }

  applyFileTextEdits(event: TextEditEvent): boolean {
    this.assertWritable();
    const { id, node } = this.nodeAtPath(event.path);
    if (node.get("kind") !== "file" || node.get("deleted") === true) {
      throw new CollaborationProjectError(`Collaboration file not found: ${event.path}`);
    }
    const text = getCollaborationTexts(this.doc).get(id);
    if (!(text instanceof Y.Text)) {
      throw new CollaborationProjectError(`Collaboration text not found: ${event.path}`);
    }
    const prepared = prepareTextEditEvent(event, text.length);
    if (!prepared) return false;

    this.doc.transact(() => {
      for (const change of prepared.changes) {
        if (change.deleteLength > 0) text.delete(change.offset, change.deleteLength);
        if (change.text.length > 0) text.insert(change.offset, change.text);
      }
    }, COLLABORATION_ORIGIN.localEditor);
    return true;
  }

  createFile(path: string, content = "", encoding: WorkspaceFileEncoding = "utf-8"): void {
    this.createNode("file", path, content, encoding);
  }

  createAssetFile(path: string, asset: CollaborationAssetDescriptor): void {
    this.createNode("file", path, "", "base64", collaborationAssetDescriptorSchema.parse(asset));
  }

  createFolder(path: string): void {
    this.createNode("folder", path, "", "utf-8");
  }

  private createNode(
    kind: CollaborationNodeKind,
    path: string,
    content: string,
    encoding: WorkspaceFileEncoding,
    asset: CollaborationAssetDescriptor | null = null,
  ): void {
    this.assertWritable();
    if (encoding !== "utf-8" && !asset) {
      throw new CollaborationProjectError("Binary collaboration assets must be uploaded first");
    }
    const normalized = parseWorkspacePath(path);
    const projection = projectCollaborationDocument(this.doc);
    if (projection.nodeIdByPath.has(normalized)) {
      throw new CollaborationProjectError(`Collaboration path already exists: ${normalized}`);
    }
    const { parentPath, name } = splitPath(normalized);
    const parentId = this.parentIdForPath(parentPath);
    const id = this.idFactory();
    this.doc.transact(() => {
      getCollaborationNodes(this.doc).set(
        id,
        createNodeMap({
          id,
          kind,
          name,
          parentId,
          orderKey: `${Date.now().toString(36)}:${id}`,
          deleted: false,
          encoding,
          asset,
        }),
      );
      if (kind === "file" && encoding === "utf-8") {
        const text = new Y.Text();
        if (content) text.insert(0, content);
        getCollaborationTexts(this.doc).set(id, text);
      }
    }, COLLABORATION_ORIGIN.localTreeCommand);
  }

  renameFile(currentPath: string, nextPath: string): void {
    this.renameNode("file", currentPath, nextPath);
  }

  renameFolder(currentPath: string, nextPath: string): void {
    this.renameNode("folder", currentPath, nextPath);
  }

  private renameNode(kind: CollaborationNodeKind, currentPath: string, nextPath: string): void {
    this.assertWritable();
    const current = this.nodeAtPath(currentPath);
    if (current.node.get("kind") !== kind || current.node.get("deleted") === true) {
      throw new CollaborationProjectError(`Collaboration ${kind} not found: ${currentPath}`);
    }
    const normalizedNextPath = parseWorkspacePath(nextPath);
    const { parentPath, name } = splitPath(normalizedNextPath);
    const normalizedCurrentPath = parseWorkspacePath(currentPath);
    if (
      kind === "folder" &&
      (parentPath === normalizedCurrentPath || parentPath.startsWith(`${normalizedCurrentPath}/`))
    ) {
      throw new CollaborationProjectError("A folder cannot be moved inside itself");
    }
    const parentId = this.parentIdForPath(parentPath);
    this.doc.transact(() => {
      current.node.set("name", name);
      current.node.set("parentId", parentId);
    }, COLLABORATION_ORIGIN.localTreeCommand);
  }

  deleteFile(path: string): void {
    this.deleteNode("file", path);
  }

  deleteFolder(path: string): void {
    this.deleteNode("folder", path);
  }

  private deleteNode(kind: CollaborationNodeKind, path: string): void {
    this.assertWritable();
    const normalized = parseWorkspacePath(path);
    const target = this.nodeAtPath(normalized);
    if (target.node.get("kind") !== kind) {
      throw new CollaborationProjectError(`Collaboration ${kind} not found: ${normalized}`);
    }
    const projection = projectCollaborationDocument(this.doc);
    const ids =
      kind === "folder"
        ? Array.from(projection.nodeIdByPath.entries())
            .filter(
              ([candidatePath]) =>
                candidatePath === normalized || candidatePath.startsWith(`${normalized}/`),
            )
            .map(([, id]) => id)
        : [target.id];
    this.doc.transact(() => {
      const nodes = getCollaborationNodes(this.doc);
      for (const id of ids) nodes.get(id)?.set("deleted", true);
    }, COLLABORATION_ORIGIN.localTreeCommand);
  }

  setEntryFile(path: string): void {
    this.assertWritable();
    const { id, node } = this.nodeAtPath(path);
    if (node.get("kind") !== "file") {
      throw new CollaborationProjectError(`Collaboration file not found: ${path}`);
    }
    this.doc.transact(() => {
      getCollaborationMetadata(this.doc).set("entryNodeId", id);
    }, COLLABORATION_ORIGIN.localTreeCommand);
  }

  updateLessonType(lessonType: WorkspaceLessonType): void {
    this.assertWritable();
    this.doc.transact(() => {
      getCollaborationMetadata(this.doc).set("lessonType", lessonType);
    }, COLLABORATION_ORIGIN.localTreeCommand);
  }
}
