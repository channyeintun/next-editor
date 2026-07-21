import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RunnerConfig,
  RuntimePreviewMessage,
} from "./WebContainerRuntimeContext";
import {
  base64ToBytes,
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  getWorkspaceFileMimeType,
  inferLanguageFromPath,
  isBinaryWorkspacePath,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  isWorkspaceTextFile,
  normalizeWorkspacePath,
  parseWorkspacePath,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { getWorkspaceAssetBytes, registerWorkspaceAsset } from "../storage/workspaceAssetStore";
import { createRrwebPreviewRecorderScript } from "../components/preview/rrwebPreview";
import {
  RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
} from "../components/preview/previewIframeUtils";
import { createIframeScreenshotBridgeScript } from "../utils/iframeScreenshotBridge";
import { createIframeConsoleBridgeScript } from "../utils/iframeConsoleBridge";
import { createApiClientProxyScript } from "../utils/apiClientBridge";
import { createIframeInteractionCaptureScript } from "../utils/iframeInteractionCapture";
import { createStudioPreviewCommandBridgeScript } from "../utils/iframeStudioCommandBridge";
import { isMobileBrowser } from "../utils/isMobileBrowser";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "pnpm install",
  runCommand: "pnpm dev",
};

const WEBCONTAINER_VITE_PLUS_RUN_COMMAND = "npx vite --host 0.0.0.0 --configLoader native";

export const TERMINAL_SHELL_CANDIDATES = [
  { command: "jsh", args: [] },
  { command: "bash", args: ["-i"] },
  { command: "sh", args: ["-i"] },
] as const;

const RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";
const RUNTIME_SNAPSHOT_SCRIPT_MARKER = "__NEXT_EDITOR_RUNTIME_SNAPSHOT__";
const RUNTIME_SCREENSHOT_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_SCREENSHOT_BRIDGE__";
const RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_CONSOLE_BRIDGE__";
const RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_INTERACTION_CAPTURE__";
const RUNTIME_RRWEB_RECORD_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_RRWEB_RECORD__";
const RUNTIME_API_CLIENT_PROXY_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_API_CLIENT_PROXY__";
const RUNTIME_STUDIO_COMMAND_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__";
const RUNTIME_IMPORT_IGNORED_ROOTS = new Set([".git", "node_modules"]);

const sharedWebContainerState: {
  instance: WebContainer | null;
  bootPromise: Promise<WebContainer> | null;
} = {
  instance: null,
  bootPromise: null,
};

const webContainerTaskQueues = new WeakMap<WebContainer, Promise<void>>();

/**
 * Serialize filesystem transactions across the runtime UI, reverse sync, and
 * agent tools that share one WebContainer instance.
 */
export function runSerializedWebContainerTask<T>(
  instance: WebContainer,
  task: () => Promise<T>,
): Promise<T> {
  const queue = webContainerTaskQueues.get(instance) ?? Promise.resolve();
  const result = queue.then(task, task);
  webContainerTaskQueues.set(
    instance,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

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

// Re-exported so existing runtime-support imports keep working; the
// implementation lives in a dependency-free util that the light landing critical
// path can also import without dragging in this module.
export { isMobileBrowser };

/**
 * Whether the in-browser WebContainer runtime can boot here. It requires both
 * cross-origin isolation (for SharedArrayBuffer) and a non-mobile browser. Mobile
 * is excluded because WebContainers are unsupported there and the boot attempt
 * OOM-reloads the tab. This gates auto-boot, so the runtime never starts on mobile.
 */
export function isWebContainerRuntimeSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.crossOriginIsolated === true && !isMobileBrowser();
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

// Builds the single JS payload injected into every preview page through
// `WebContainer.setPreviewScript`. The WebContainer adds it to *all* HTML
// responses regardless of which server produced them, so the recorder runs no
// matter how the preview is rendered — static HTML, a Vite SPA, an Express
// server, or an SSR/hybrid framework like TanStack Start that assembles its
// document on the fly. Returns a raw script body (no `<script>` wrapper); the
// WebContainer supplies the tag. Both halves are guarded by per-window markers,
// so re-running on navigation (or inside an htmx fragment swap) is a no-op.
export function createRuntimePreviewScript(): string {
  const interactionCaptureScript = createIframeInteractionCaptureScript(
    RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER,
    { includeMouseMove: true, includeRouteChange: true },
  );
  const consoleBridgeScript = createIframeConsoleBridgeScript(RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER);

  // rrweb records the live DOM (+ inner scroll/input/mouse) for replay. The
  // recorder-only @rrweb/record IIFE is materialized at build time;
  // `slimDOMOptions.script` keeps it (and every other script) out of the
  // snapshots it produces, so the injected recorder never pollutes a recording.
  const rrwebRecordScript = createRrwebPreviewRecorderScript({
    setupMarker: RUNTIME_RRWEB_RECORD_SETUP_MARKER,
  });

  const apiClientProxyScript = createApiClientProxyScript(RUNTIME_API_CLIENT_PROXY_SETUP_MARKER);
  const screenshotBridgeScript = createIframeScreenshotBridgeScript(
    RUNTIME_SCREENSHOT_BRIDGE_SETUP_MARKER,
  );
  const studioCommandBridgeScript = createStudioPreviewCommandBridgeScript(
    RUNTIME_STUDIO_COMMAND_SETUP_MARKER,
  );

  const snapshotScript = `(function(){const marker=${JSON.stringify(
    RUNTIME_SNAPSHOT_SCRIPT_MARKER,
  )};if(window[marker])return;window[marker]=true;const responseType=${JSON.stringify(
    RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  )};const requestType=${JSON.stringify(
    RUNTIME_SNAPSHOT_REQUEST_MESSAGE_TYPE,
  )};${consoleBridgeScript}${interactionCaptureScript}const minIntervalMs=100;let snapshotVersion=0;let lastSnapshotAt=-Infinity;let pendingRequestId=null;let snapshotTimer=0;const postSnapshot=(requestId)=>{try{const startedAt=performance.now();const root=document.documentElement;if(!root)return;const clone=root.cloneNode(true);if(!(clone instanceof Element))return;clone.querySelectorAll("script").forEach((script)=>script.remove());const html=clone.outerHTML;const durationMs=Math.max(0,performance.now()-startedAt);const byteLength=new TextEncoder().encode(html).byteLength;snapshotVersion+=1;lastSnapshotAt=performance.now();window.parent.postMessage({type:responseType,payload:{html,requestId,snapshotVersion,durationMs,byteLength}},"*");}catch{}};const scheduleSnapshot=(requestId)=>{pendingRequestId=requestId;if(snapshotTimer)return;const delay=Math.max(0,minIntervalMs-(performance.now()-lastSnapshotAt));snapshotTimer=window.setTimeout(()=>{snapshotTimer=0;const nextRequestId=pendingRequestId;pendingRequestId=null;postSnapshot(nextRequestId);},delay);};window.addEventListener("message",(event)=>{if(event.source!==window.parent)return;const data=event.data;if(!data||data.type!==requestType)return;const payload=data.payload;const requestId=payload&&typeof payload.requestId==="string"?payload.requestId.slice(0,128):null;scheduleSnapshot(requestId);});})();`;

  return `${rrwebRecordScript}\n${apiClientProxyScript}\n${screenshotBridgeScript}\n${studioCommandBridgeScript}\n${snapshotScript}`;
}

function getNormalizedProjectFiles(project: WorkspaceProject | null): Map<string, WorkspaceFile> {
  if (!project) {
    return new Map();
  }

  const files = new Map<string, WorkspaceFile>();

  for (const [path, file] of Object.entries(project.files)) {
    const normalizedPath = parseWorkspacePath(path);
    const normalizedFilePath = parseWorkspacePath(file.path);

    if (normalizedPath !== normalizedFilePath) {
      throw new Error(`Workspace file key "${path}" does not match its path "${file.path}"`);
    }

    if (files.has(normalizedPath)) {
      throw new Error(`Multiple workspace files resolve to "${normalizedPath}"`);
    }

    files.set(normalizedPath, file);
  }

  for (const path of files.keys()) {
    const segments = path.split("/");
    segments.pop();
    while (segments.length > 0) {
      const parentPath = segments.join("/");
      if (files.has(parentPath)) {
        throw new Error(`Workspace path "${parentPath}" conflicts with a nested file`);
      }
      segments.pop();
    }
  }

  return files;
}

function stripRuntimeSnapshotScript(content: string): string {
  return content
    .replace(/\s*<script data-next-editor-rrweb-record>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script data-next-editor-runtime-snapshot>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script data-next-editor-api-client-proxy>[\s\S]*?<\/script>\s*/g, "\n");
}

export function shouldIgnoreRuntimeImportPath(path: string): boolean {
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
    const nextWorkspacePath = parseWorkspacePath(
      workspacePath ? `${workspacePath}/${entry.name}` : entry.name,
    );
    const nextRuntimePath = runtimePath === "." ? entry.name : `${runtimePath}/${entry.name}`;

    if (shouldIgnoreRuntimeImportPath(nextWorkspacePath)) {
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

    if (isBinaryWorkspacePath(nextWorkspacePath)) {
      const bytes = await instance.fs.readFile(nextRuntimePath);
      const content = await registerWorkspaceAsset(bytes, {
        mimeType: getWorkspaceFileMimeType(nextWorkspacePath),
      });

      files[nextWorkspacePath] = {
        path: nextWorkspacePath,
        name: getWorkspaceBaseName(nextWorkspacePath),
        language: inferLanguageFromPath(nextWorkspacePath),
        content,
        encoding: "asset",
      };
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

export async function getWorkspaceRuntimeFileContents(
  file: WorkspaceFile,
): Promise<string | Uint8Array> {
  if (isWorkspaceAssetFile(file)) return getWorkspaceAssetBytes(file.content);
  if (isLegacyWorkspaceBinaryFile(file)) return base64ToBytes(file.content);
  return file.content;
}

function workspaceFileContentsEqual(left: WorkspaceFile, right: WorkspaceFile): boolean {
  if (isWorkspaceAssetFile(left) && isWorkspaceAssetFile(right)) {
    return left.content.assetId === right.content.assetId;
  }
  return isWorkspaceTextFile(left) && isWorkspaceTextFile(right) && left.content === right.content;
}

export async function createWorkspaceTree(project: WorkspaceProject): Promise<FileSystemTree> {
  const createDirectory = (): FileSystemTree => Object.create(null) as FileSystemTree;
  const tree = createDirectory();

  const ensureTreeDirectory = (directoryPath: string) => {
    const normalizedDirectoryPath = directoryPath ? parseWorkspacePath(directoryPath) : "";

    if (!normalizedDirectoryPath) {
      return;
    }

    let currentDirectory = tree;

    for (const segment of normalizedDirectoryPath.split("/")) {
      const existingEntry = currentDirectory[segment];

      if (existingEntry && !("directory" in existingEntry)) {
        throw new Error(`Workspace path "${normalizedDirectoryPath}" conflicts with a file`);
      }

      if (!existingEntry) {
        currentDirectory[segment] = { directory: createDirectory() };
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

  for (const [normalizedPath, file] of getNormalizedProjectFiles(project)) {
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

    if (currentDirectory[fileName]) {
      throw new Error(`Workspace path "${normalizedPath}" conflicts with another entry`);
    }

    currentDirectory[fileName] = {
      file: {
        // The recorder is injected at the preview layer (see
        // createRuntimePreviewScript + setPreviewScript), never written into
        // workspace files, so files are mounted exactly as authored.
        contents: await getWorkspaceRuntimeFileContents(file),
      },
    };
  }

  return tree;
}

async function ensureDirectory(
  instance: WebContainer,
  directoryPath: string,
  onWrite?: (path: string) => void,
): Promise<void> {
  const segments = directoryPath.split("/").filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    onWrite?.(currentPath);

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
  // Reports every container path this sync mutates (created folders, removed
  // paths, written files) so callers can tell their own writes apart from
  // container-originated ones — e.g. to suppress fs.watch echoes.
  onWrite?: (path: string) => void,
): Promise<void> {
  if (previousProject === nextProject) {
    return;
  }

  const previousFiles = getNormalizedProjectFiles(previousProject);
  const nextFiles = getNormalizedProjectFiles(nextProject);
  const previousFolders = new Set(
    (previousProject?.folders ?? []).map((folderPath) => parseWorkspacePath(folderPath)),
  );
  const nextFolders = new Set(
    nextProject.folders.map((folderPath) => parseWorkspacePath(folderPath)),
  );

  for (const folderPath of nextProject.folders) {
    const normalizedFolderPath = parseWorkspacePath(folderPath);

    if (previousFolders.has(normalizedFolderPath)) {
      continue;
    }

    await ensureDirectory(instance, normalizedFolderPath, onWrite);
  }

  const deletedPaths = Array.from(previousFiles.keys()).filter((path) => !nextFiles.has(path));

  for (const path of deletedPaths.sort((left, right) => right.length - left.length)) {
    onWrite?.(path);

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
    onWrite?.(folderPath);

    try {
      await instance.fs.rm(folderPath, { recursive: true, force: true });
    } catch {
      // Ignore directories that are already absent.
    }
  }

  for (const [path, file] of nextFiles) {
    const previousFile = previousFiles.get(path);

    if (previousFile && workspaceFileContentsEqual(previousFile, file)) {
      continue;
    }

    await ensureDirectory(instance, getFileDirectory(path), onWrite);
    onWrite?.(path);
    await instance.fs.writeFile(path, await getWorkspaceRuntimeFileContents(file));
  }
}

export function parseCommand(commandLine: string): { command: string; args: string[] } | null {
  const command = commandLine.trim();

  if (!command) {
    return null;
  }

  // Runner settings intentionally accept shell command lines. Delegating their
  // grammar to the sandbox shell preserves quotes, escaped/empty arguments,
  // environment assignments, pipes, and redirects without a divergent parser.
  return { command: "sh", args: ["-lc", command] };
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

  if (!packageJsonFile || !isWorkspaceTextFile(packageJsonFile)) {
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
      .then(async (instance) => {
        // Install the rrweb recorder into every preview HTML response up front,
        // so replay works regardless of how the app renders (SSR/CSR/hybrid).
        // Set once per boot; it persists for the instance's whole lifetime and
        // applies to every preview reloaded afterwards.
        try {
          await instance.setPreviewScript(createRuntimePreviewScript());
        } catch (error) {
          console.warn("Failed to install runtime preview recorder script:", error);
        }

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
  webContainerTaskQueues.delete(instance);
  sharedWebContainerState.instance = null;
  sharedWebContainerState.bootPromise = null;
}
