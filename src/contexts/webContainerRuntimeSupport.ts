import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RunnerConfig,
  RuntimePreviewMessage,
} from "./WebContainerRuntimeContext";
import {
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { createIframeConsoleBridgeScript } from "../utils/iframeConsoleBridge";
import { createIframeInteractionCaptureScript } from "../utils/iframeInteractionCapture";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "npm install",
  runCommand: "npm run dev",
};

const WEBCONTAINER_VITE_PLUS_RUN_COMMAND = "npx vite --host 0.0.0.0 --configLoader native";

export const TERMINAL_SHELL_CANDIDATES = [
  { command: "jsh", args: [] },
  { command: "bash", args: ["-i"] },
  { command: "sh", args: ["-i"] },
] as const;

const RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";
const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";
const RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_INITIAL_DOCUMENT";
const RUNTIME_PATCH_BATCH_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_PATCH_BATCH";
const PREVIEW_DOM_PATCH_FORMAT_VERSION = 1;
const RUNTIME_SNAPSHOT_SCRIPT_MARKER = "__NEXT_EDITOR_RUNTIME_SNAPSHOT__";
const RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_CONSOLE_BRIDGE__";
const RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_INTERACTION_CAPTURE__";
const RUNTIME_IMPORT_IGNORED_ROOTS = new Set([".git", "node_modules"]);

const sharedWebContainerState: {
  instance: WebContainer | null;
  bootPromise: Promise<WebContainer> | null;
} = {
  instance: null,
  bootPromise: null,
};

const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const OSC_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][^${BELL_CHARACTER}]*(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  "g",
);

export function getRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown WebContainer runtime error";
}

function stringifyPreviewMessageArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable preview error]";
  }
}

export function formatPreviewMessage(message: {
  args?: unknown[];
  message?: string;
  pathname?: string;
  port?: number;
  type?: string;
}): Omit<RuntimePreviewMessage, "id"> {
  const normalizedType = message.type?.toLowerCase();
  const kind =
    normalizedType === "console-error" || normalizedType === "preview_console_error"
      ? "console-error"
      : normalizedType === "unhandledrejection" ||
          normalizedType === "unhandled-rejection" ||
          normalizedType === "preview_unhandled_rejection"
        ? "unhandled-rejection"
        : "uncaught-exception";
  const text =
    kind === "console-error"
      ? (message.args ?? []).map(stringifyPreviewMessageArg).join(" ") ||
        "console.error called inside preview"
      : message.message?.trim() || "Preview error";

  return {
    kind,
    text,
    port: typeof message.port === "number" ? message.port : null,
    pathname: message.pathname ?? "",
  };
}

export function sanitizeTerminalChunk(chunk: string): string {
  const withoutOsc = chunk.replace(OSC_PATTERN, "");
  const normalized = withoutOsc.replace(/\r/g, "");

  if (/^[\\|/-]$/.test(normalized.trim())) {
    return "";
  }

  return normalized;
}

function createRuntimePatchRecorderScript(): string {
  return `
    (function() {
      const initialDocumentMessageType = ${JSON.stringify(RUNTIME_INITIAL_DOCUMENT_MESSAGE_TYPE)};
      const patchBatchMessageType = ${JSON.stringify(RUNTIME_PATCH_BATCH_MESSAGE_TYPE)};
      const version = ${JSON.stringify(PREVIEW_DOM_PATCH_FORMAT_VERSION)};
      const source = 'runtime-preview';
      const documentId = 'runtime-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      const nodeIds = new WeakMap();
      let nextNodeId = 1;
      let revision = 0;
      let pendingRecords = [];
      let patchFrame = 0;
      let didPostInitialDocument = false;

      function getRoute() {
        return (window.location.pathname || '/') + (window.location.search || '') + (window.location.hash || '');
      }

      function getMessageTime() {
        try {
          return Math.max(0, Math.round(performance.now()));
        } catch {
          return 0;
        }
      }

      function postPreviewRecorderMessage(type, payload) {
        try {
          window.parent.postMessage({ type, payload }, '*');
        } catch {}
      }

      function postInitialDocument() {
        if (didPostInitialDocument || !document.documentElement) {
          return;
        }

        didPostInitialDocument = true;
        postPreviewRecorderMessage(initialDocumentMessageType, {
          version,
          time: getMessageTime(),
          documentId,
          route: getRoute(),
          html: document.documentElement.outerHTML,
        });
      }

      function getNodeId(node) {
        if (!node || typeof node !== 'object') {
          return undefined;
        }

        const existingId = nodeIds.get(node);
        if (existingId) {
          return existingId;
        }

        const nextId = 'n' + nextNodeId++;
        nodeIds.set(node, nextId);
        return nextId;
      }

      function getNodePath(node) {
        const root = document.documentElement;
        if (!node || !root) {
          return [];
        }

        if (node === root) {
          return [];
        }

        const path = [];
        let current = node;

        while (current && current !== root) {
          const parent = current.parentNode;
          if (!parent) {
            return [];
          }

          path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
          current = parent;
        }

        return current === root ? path : [];
      }

      function createNodeRef(node, fallbackParent, fallbackIndex) {
        if (fallbackParent && typeof fallbackIndex === 'number') {
          return {
            id: getNodeId(node),
            path: getNodePath(fallbackParent).concat(fallbackIndex),
          };
        }

        return {
          id: getNodeId(node),
          path: getNodePath(node),
        };
      }

      function serializeNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node;
          return {
            kind: 'element',
            tagName: element.tagName.toLowerCase(),
            namespaceURI: element.namespaceURI || null,
            attributes: Array.from(element.attributes).map(function(attribute) {
              return [attribute.name, attribute.value];
            }),
            children: Array.from(element.childNodes).map(serializeNode),
          };
        }

        if (node.nodeType === Node.TEXT_NODE) {
          return { kind: 'text', text: node.nodeValue || '' };
        }

        if (node.nodeType === Node.COMMENT_NODE) {
          return { kind: 'comment', text: node.nodeValue || '' };
        }

        if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
          return { kind: 'doctype', text: node.name || '' };
        }

        return { kind: 'text', text: node.textContent || '' };
      }

      function getChildIndex(parent, child) {
        return Array.prototype.indexOf.call(parent.childNodes, child);
      }

      function getRemovedNodeIndex(record, offset) {
        if (record.nextSibling && record.nextSibling.parentNode === record.target) {
          return getChildIndex(record.target, record.nextSibling) + offset;
        }

        if (record.previousSibling && record.previousSibling.parentNode === record.target) {
          return getChildIndex(record.target, record.previousSibling) + 1 + offset;
        }

        return offset;
      }

      function isNodeInDocument(node) {
        const root = document.documentElement;
        return !!root && (node === root || root.contains(node));
      }

      function getAttributeOp(record) {
        const target = record.target;
        if (!(target instanceof Element) || !record.attributeName) {
          return null;
        }

        const value = record.attributeNamespace
          ? target.getAttributeNS(record.attributeNamespace, record.attributeName)
          : target.getAttribute(record.attributeName);

        if (value === null) {
          return {
            op: 'remove_attribute',
            target: createNodeRef(target),
            name: record.attributeName,
            namespaceURI: record.attributeNamespace || null,
          };
        }

        return {
          op: 'set_attribute',
          target: createNodeRef(target),
          name: record.attributeName,
          value,
          namespaceURI: record.attributeNamespace || null,
        };
      }

      function getOperationKey(operation) {
        const target = operation.target || operation.parent;
        const pathKey = target && target.path ? target.path.join('.') : '';
        const idKey = target && target.id ? target.id : pathKey;

        if (operation.op === 'set_text') {
          return operation.op + ':' + idKey;
        }

        if (operation.op === 'set_attribute' || operation.op === 'remove_attribute') {
          return operation.op.replace('remove_', 'set_') + ':' + idKey + ':' + operation.name + ':' + (operation.namespaceURI || '');
        }

        return '';
      }

      function normalizeMutationRecords(records) {
        const scalarOpsByKey = new Map();
        const replaceSubtreeOps = [];
        const removedNodes = new Map();
        const addedNodes = new Map();

        records.forEach(function(record) {
          if (record.type === 'characterData') {
            if (!isNodeInDocument(record.target)) {
              return;
            }

            const operation = {
              op: 'set_text',
              target: createNodeRef(record.target),
              text: record.target.nodeValue || '',
            };
            scalarOpsByKey.set(getOperationKey(operation), operation);
            return;
          }

          if (record.type === 'attributes') {
            const operation = getAttributeOp(record);
            if (operation) {
              scalarOpsByKey.set(getOperationKey(operation), operation);
            }
            return;
          }

          if (record.type !== 'childList') {
            return;
          }

          const childMutationCount = record.addedNodes.length + record.removedNodes.length;
          if (childMutationCount > 20 && record.target instanceof Element) {
            replaceSubtreeOps.push({
              op: 'replace_subtree',
              target: createNodeRef(record.target),
              html: record.target.innerHTML,
              mode: 'children',
            });
            return;
          }

          Array.from(record.removedNodes).forEach(function(node, index) {
            const nodeId = getNodeId(node);
            removedNodes.set(nodeId, {
              node,
              parent: record.target,
              index: getRemovedNodeIndex(record, index),
            });
          });

          Array.from(record.addedNodes).forEach(function(node) {
            const nodeId = getNodeId(node);
            addedNodes.set(nodeId, {
              node,
              parent: record.target,
              index: getChildIndex(record.target, node),
            });
          });
        });

        const removeOps = [];
        const moveOps = [];
        const insertOps = [];

        removedNodes.forEach(function(removed, nodeId) {
          const added = addedNodes.get(nodeId);
          const finalNodeExists = isNodeInDocument(removed.node);

          if (added) {
            addedNodes.delete(nodeId);

            if (!finalNodeExists) {
              return;
            }

            if (removed.parent === added.parent && removed.index === added.index) {
              return;
            }

            moveOps.push({
              op: 'move_node',
              target: createNodeRef(removed.node, removed.parent, removed.index),
              parent: createNodeRef(added.parent),
              index: added.index,
            });
            return;
          }

          if (!finalNodeExists) {
            removeOps.push({
              op: 'remove_node',
              target: createNodeRef(removed.node, removed.parent, removed.index),
            });
          }
        });

        addedNodes.forEach(function(added) {
          if (!isNodeInDocument(added.node)) {
            return;
          }

          insertOps.push({
            op: 'insert_node',
            parent: createNodeRef(added.parent),
            index: added.index,
            node: serializeNode(added.node),
          });
        });

        removeOps.sort(function(left, right) {
          const leftPath = left.target.path;
          const rightPath = right.target.path;
          const maxLength = Math.max(leftPath.length, rightPath.length);

          for (let index = 0; index < maxLength; index++) {
            const leftValue = leftPath[index] ?? -1;
            const rightValue = rightPath[index] ?? -1;
            if (leftValue !== rightValue) {
              return rightValue - leftValue;
            }
          }

          return rightPath.length - leftPath.length;
        });

        insertOps.sort(function(left, right) {
          return left.index - right.index;
        });

        return removeOps.concat(moveOps, insertOps, replaceSubtreeOps, Array.from(scalarOpsByKey.values()));
      }

      function flushPatchRecords() {
        patchFrame = 0;

        if (!pendingRecords.length) {
          return;
        }

        const records = pendingRecords;
        pendingRecords = [];
        const ops = normalizeMutationRecords(records);

        if (!ops.length) {
          return;
        }

        const baseRevision = revision;
        revision += 1;
        postPreviewRecorderMessage(patchBatchMessageType, {
          version,
          time: getMessageTime(),
          source,
          documentId,
          baseRevision,
          revision,
          route: getRoute(),
          ops,
        });
      }

      function schedulePatchFlush(records) {
        pendingRecords = pendingRecords.concat(Array.from(records));

        if (patchFrame) {
          return;
        }

        patchFrame = window.requestAnimationFrame(flushPatchRecords);
      }

      const root = document.documentElement;
      if (root) {
        postInitialDocument();
        new MutationObserver(schedulePatchFlush).observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
          attributeOldValue: false,
          characterDataOldValue: false,
        });
      }

      window.addEventListener('load', postInitialDocument);
      window.addEventListener('pageshow', postInitialDocument);
    })();
  `;
}

function injectRuntimeSnapshotScript(
  project: WorkspaceProject,
  filePath: string,
  content: string,
): string {
  const normalizedFilePath = normalizeWorkspacePath(filePath);
  const normalizedEntryFilePath = normalizeWorkspacePath(project.entryFilePath);
  const isRuntimeHtmlBootstrap =
    normalizedFilePath.toLowerCase().endsWith(".html") &&
    (normalizedFilePath === "index.html" || normalizedFilePath === normalizedEntryFilePath);

  if (
    project.lessonType !== "node.js" ||
    !isRuntimeHtmlBootstrap ||
    content.includes(RUNTIME_SNAPSHOT_SCRIPT_MARKER)
  ) {
    return content;
  }

  const interactionCaptureScript = createIframeInteractionCaptureScript(
    RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER,
    { includeMouseMove: true, includeRouteChange: true },
  );
  const consoleBridgeScript = createIframeConsoleBridgeScript(RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER);
  const runtimePatchRecorderScript = createRuntimePatchRecorderScript();

  const snapshotScript = `<script data-next-editor-runtime-snapshot>(function(){const marker=${JSON.stringify(
    RUNTIME_SNAPSHOT_SCRIPT_MARKER,
  )};if(window[marker])return;window[marker]=true;const messageType=${JSON.stringify(
    RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  )};${consoleBridgeScript}${interactionCaptureScript}${runtimePatchRecorderScript}const postSnapshot=()=>{try{window.parent.postMessage({type:messageType,payload:{html:document.documentElement.outerHTML}},"*");}catch{}};let frame=0;const schedule=()=>{if(frame)return;frame=window.requestAnimationFrame(()=>{frame=0;postSnapshot();});};const root=document.documentElement;if(root){new MutationObserver(schedule).observe(root,{attributes:true,childList:true,subtree:true,characterData:true});}window.addEventListener("load",schedule);window.addEventListener("pageshow",schedule);document.addEventListener("readystatechange",schedule);schedule();window.setTimeout(schedule,50);window.setTimeout(schedule,250);window.setTimeout(schedule,1000);})();</script>`;

  if (content.includes("</head>")) {
    return content.replace("</head>", `${snapshotScript}\n</head>`);
  }

  if (content.includes("</body>")) {
    return content.replace("</body>", `${snapshotScript}\n</body>`);
  }

  return `${content}\n${snapshotScript}`;
}

function getNormalizedProjectFiles(project: WorkspaceProject | null): Map<string, WorkspaceFile> {
  if (!project) {
    return new Map();
  }

  return new Map(
    Object.entries(project.files).map(([path, file]) => [
      normalizeWorkspacePath(path || file.path),
      file,
    ]),
  );
}

function stripRuntimeSnapshotScript(content: string): string {
  return content.replace(
    /\s*<script data-next-editor-runtime-snapshot>[\s\S]*?<\/script>\s*/g,
    "\n",
  );
}

function shouldIgnoreRuntimeImportPath(path: string): boolean {
  const normalizedPath = normalizeWorkspacePath(path);
  const rootSegment = normalizedPath.split("/")[0];

  return rootSegment ? RUNTIME_IMPORT_IGNORED_ROOTS.has(rootSegment) : false;
}

async function readRuntimeDirectory(
  instance: WebContainer,
  runtimePath: string,
  workspacePath: string,
  files: Record<string, WorkspaceFile>,
  folders: Set<string>,
): Promise<void> {
  const entries = await instance.fs.readdir(runtimePath, { withFileTypes: true });
  const orderedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of orderedEntries) {
    const nextWorkspacePath = normalizeWorkspacePath(
      workspacePath ? `${workspacePath}/${entry.name}` : entry.name,
    );
    const nextRuntimePath = runtimePath === "." ? entry.name : `${runtimePath}/${entry.name}`;

    if (!nextWorkspacePath || shouldIgnoreRuntimeImportPath(nextWorkspacePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      folders.add(nextWorkspacePath);
      await readRuntimeDirectory(instance, nextRuntimePath, nextWorkspacePath, files, folders);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const content = stripRuntimeSnapshotScript(
      await instance.fs.readFile(nextRuntimePath, "utf-8"),
    );

    files[nextWorkspacePath] = {
      path: nextWorkspacePath,
      name: getWorkspaceBaseName(nextWorkspacePath),
      language: inferLanguageFromPath(nextWorkspacePath),
      content,
    };
  }
}

export async function readWorkspaceProject(
  instance: WebContainer,
  currentProject: WorkspaceProject,
): Promise<WorkspaceProject> {
  const files: Record<string, WorkspaceFile> = {};
  const folders = new Set<string>();

  await readRuntimeDirectory(instance, ".", "", files, folders);

  return {
    ...currentProject,
    folders: collectWorkspaceFolders(Object.keys(files), Array.from(folders)),
    files,
  };
}

export function createWorkspaceTree(project: WorkspaceProject): FileSystemTree {
  const tree: FileSystemTree = {};

  const ensureTreeDirectory = (directoryPath: string) => {
    const normalizedDirectoryPath = normalizeWorkspaceFolderPath(directoryPath);

    if (!normalizedDirectoryPath) {
      return;
    }

    let currentDirectory = tree;

    for (const segment of normalizedDirectoryPath.split("/")) {
      const existingEntry = currentDirectory[segment];

      if (!existingEntry || !("directory" in existingEntry)) {
        currentDirectory[segment] = { directory: {} };
      }

      const nextEntry = currentDirectory[segment];

      if (!nextEntry || !("directory" in nextEntry)) {
        return;
      }

      currentDirectory = nextEntry.directory;
    }
  };

  for (const folderPath of project.folders) {
    ensureTreeDirectory(folderPath);
  }

  for (const file of Object.values(project.files)) {
    const normalizedPath = normalizeWorkspacePath(file.path);
    if (!normalizedPath) {
      continue;
    }

    const segments = normalizedPath.split("/");
    const fileName = segments.pop();

    if (!fileName) {
      continue;
    }

    ensureTreeDirectory(segments.join("/"));

    let currentDirectory = tree;
    for (const segment of segments) {
      const nextEntry = currentDirectory[segment];
      if (!nextEntry || !("directory" in nextEntry)) {
        return tree;
      }

      currentDirectory = nextEntry.directory;
    }

    currentDirectory[fileName] = {
      file: {
        contents: injectRuntimeSnapshotScript(project, normalizedPath, file.content),
      },
    };
  }

  return tree;
}

async function ensureDirectory(instance: WebContainer, directoryPath: string): Promise<void> {
  const segments = directoryPath.split("/").filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;

    try {
      await instance.fs.mkdir(currentPath);
    } catch {
      // Ignore directories that already exist.
    }
  }
}

function getFileDirectory(path: string): string {
  const segments = path.split("/").slice(0, -1);
  return segments.join("/");
}

export async function syncWorkspaceProject(
  instance: WebContainer,
  previousProject: WorkspaceProject | null,
  nextProject: WorkspaceProject,
): Promise<void> {
  if (previousProject === nextProject) {
    return;
  }

  const previousFiles = getNormalizedProjectFiles(previousProject);
  const nextFiles = getNormalizedProjectFiles(nextProject);
  const previousFolders = new Set(
    (previousProject?.folders ?? [])
      .map((folderPath) => normalizeWorkspaceFolderPath(folderPath))
      .filter(Boolean),
  );
  const nextFolders = new Set(
    nextProject.folders
      .map((folderPath) => normalizeWorkspaceFolderPath(folderPath))
      .filter(Boolean),
  );

  for (const folderPath of nextProject.folders) {
    const normalizedFolderPath = normalizeWorkspaceFolderPath(folderPath);

    if (!normalizedFolderPath || previousFolders.has(normalizedFolderPath)) {
      continue;
    }

    await ensureDirectory(instance, normalizedFolderPath);
  }

  const deletedPaths = Array.from(previousFiles.keys()).filter((path) => !nextFiles.has(path));

  for (const path of deletedPaths.sort((left, right) => right.length - left.length)) {
    try {
      await instance.fs.rm(path);
    } catch {
      // Ignore files that are already absent.
    }
  }

  const deletedFolders = Array.from(previousFolders).filter(
    (folderPath) => !nextFolders.has(folderPath),
  );

  for (const folderPath of deletedFolders.sort((left, right) => right.length - left.length)) {
    try {
      await instance.fs.rm(folderPath, { recursive: true, force: true });
    } catch {
      // Ignore directories that are already absent.
    }
  }

  for (const [path, file] of nextFiles) {
    const previousFile = previousFiles.get(path);

    if (previousFile && previousFile.content === file.content) {
      continue;
    }

    await ensureDirectory(instance, getFileDirectory(path));
    await instance.fs.writeFile(path, injectRuntimeSnapshotScript(nextProject, path, file.content));
  }
}

export function parseCommand(commandLine: string): { command: string; args: string[] } | null {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const [command, ...args] = parts;
  return { command, args };
}

export function formatCommandError(commandLine: string): string {
  return `"${commandLine}" failed inside the WebContainer runtime`;
}

export function resolveRuntimeRunCommand(
  project: WorkspaceProject | null,
  commandLine: string,
): string {
  const normalizedCommandLine = commandLine.trim();

  if (normalizedCommandLine !== DEFAULT_RUNNER_CONFIG.runCommand) {
    return normalizedCommandLine;
  }

  const packageJsonFile = project?.files["package.json"];

  if (!packageJsonFile) {
    return normalizedCommandLine;
  }

  try {
    const packageJson = JSON.parse(packageJsonFile.content) as {
      scripts?: Record<string, string | undefined>;
    };
    const devScript = packageJson.scripts?.dev?.trim() ?? "";

    if (devScript === "vp dev" || devScript.startsWith("vp dev ")) {
      return WEBCONTAINER_VITE_PLUS_RUN_COMMAND;
    }
  } catch {
    return normalizedCommandLine;
  }

  return normalizedCommandLine;
}

export function getWorkspaceRoot(projectName: string): string {
  const normalizedProjectName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `~/projects/${normalizedProjectName || "next-editor"}`;
}

export function normalizeEnvironmentVariables(
  variables: EnvironmentVariables,
): EnvironmentVariables {
  const entries = Object.entries(variables)
    .map(([key, value]) => [key.trim(), String(value)] as const)
    .filter(([key]) => key.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

export function loadStoredEnvironmentVariables(): EnvironmentVariables {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);

    if (!stored) {
      return {};
    }

    const parsed = JSON.parse(stored) as EnvironmentVariables;
    return normalizeEnvironmentVariables(parsed);
  } catch (error) {
    console.warn("Failed to load runtime environment variables:", error);
    return {};
  }
}

export function persistEnvironmentVariables(variables: EnvironmentVariables): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(variables).length === 0) {
      window.localStorage.removeItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(RUNTIME_ENVIRONMENT_STORAGE_KEY, JSON.stringify(variables));
  } catch (error) {
    console.warn("Failed to persist runtime environment variables:", error);
  }
}

export async function getOrBootSharedWebContainer(): Promise<WebContainer> {
  if (sharedWebContainerState.instance) {
    return sharedWebContainerState.instance;
  }

  if (!sharedWebContainerState.bootPromise) {
    sharedWebContainerState.bootPromise = import("@webcontainer/api")
      .then(({ WebContainer }) =>
        WebContainer.boot({
          coep: "require-corp",
          forwardPreviewErrors: true,
          workdirName: "next-editor-runtime",
        }),
      )
      .then((instance) => {
        sharedWebContainerState.instance = instance;
        return instance;
      })
      .catch((error) => {
        sharedWebContainerState.bootPromise = null;
        throw error;
      });
  }

  return sharedWebContainerState.bootPromise;
}

export function teardownSharedWebContainer(instance: WebContainer | null): void {
  if (!instance || instance !== sharedWebContainerState.instance) {
    return;
  }

  instance.teardown();
  sharedWebContainerState.instance = null;
  sharedWebContainerState.bootPromise = null;
}
