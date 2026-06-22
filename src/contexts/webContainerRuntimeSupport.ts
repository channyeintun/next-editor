import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RunnerConfig,
  RuntimePreviewMessage,
} from "./WebContainerRuntimeContext";
import {
  base64ToBytes,
  bytesToBase64,
  collectWorkspaceFolders,
  getWorkspaceBaseName,
  inferLanguageFromPath,
  isBinaryWorkspacePath,
  normalizeWorkspaceFolderPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../types/workspace";
import { createRrwebPreviewRecorderScript } from "../components/preview/rrwebPreview";
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
const RUNTIME_SNAPSHOT_SCRIPT_MARKER = "__NEXT_EDITOR_RUNTIME_SNAPSHOT__";
const RUNTIME_CONSOLE_BRIDGE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_CONSOLE_BRIDGE__";
const RUNTIME_INTERACTION_CAPTURE_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_INTERACTION_CAPTURE__";
const RUNTIME_RRWEB_RECORD_SETUP_MARKER = "__NEXT_EDITOR_RUNTIME_RRWEB_RECORD__";
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

/**
 * Best-effort mobile/tablet detection. WebContainers only run in desktop
 * Chromium/Firefox; on mobile browsers (iOS Safari, Android Chrome) booting one
 * spikes memory enough that the OS reloads or kills the tab. We detect mobile so
 * the runtime stays disabled rather than crashing the page on load.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  // Client Hints are the reliable signal where available (Chromium).
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") {
    return uaData.mobile;
  }

  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports a desktop Safari UA, so treat a touch-capable "Macintosh"
  // (a real Mac never reports touch points) as a tablet too.
  const isIpadOs =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;

  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua) || isIpadOs
  );
}

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
  // vendored UMD bundle is inlined; `slimDOMOptions.script` keeps it (and every
  // other script) out of the snapshots it produces, so the injected recorder
  // never pollutes a recording.
  const rrwebRecordScript = createRrwebPreviewRecorderScript({
    setupMarker: RUNTIME_RRWEB_RECORD_SETUP_MARKER,
  });

  const snapshotScript = `(function(){const marker=${JSON.stringify(
    RUNTIME_SNAPSHOT_SCRIPT_MARKER,
  )};if(window[marker])return;window[marker]=true;const messageType=${JSON.stringify(
    RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  )};${consoleBridgeScript}${interactionCaptureScript}const postSnapshot=()=>{try{window.parent.postMessage({type:messageType,payload:{html:document.documentElement.outerHTML.replace(/<script[\\s\\S]*?<\\/script>/gi,"")}},"*");}catch{}};let frame=0;const schedule=()=>{if(frame)return;frame=window.requestAnimationFrame(()=>{frame=0;postSnapshot();});};const root=document.documentElement;if(root){new MutationObserver(schedule).observe(root,{attributes:true,childList:true,subtree:true,characterData:true});}window.addEventListener("load",schedule);window.addEventListener("pageshow",schedule);document.addEventListener("readystatechange",schedule);schedule();window.setTimeout(schedule,50);window.setTimeout(schedule,250);window.setTimeout(schedule,1000);})();`;

  return `${rrwebRecordScript}\n${snapshotScript}`;
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
  return content
    .replace(/\s*<script data-next-editor-rrweb-record>[\s\S]*?<\/script>\s*/g, "\n")
    .replace(/\s*<script data-next-editor-runtime-snapshot>[\s\S]*?<\/script>\s*/g, "\n");
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

    if (isBinaryWorkspacePath(nextWorkspacePath)) {
      const bytes = await instance.fs.readFile(nextRuntimePath);

      files[nextWorkspacePath] = {
        path: nextWorkspacePath,
        name: getWorkspaceBaseName(nextWorkspacePath),
        language: inferLanguageFromPath(nextWorkspacePath),
        content: bytesToBase64(bytes),
        encoding: "base64",
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
        // The recorder is injected at the preview layer (see
        // createRuntimePreviewScript + setPreviewScript), never written into
        // workspace files, so files are mounted exactly as authored.
        contents: file.encoding === "base64" ? base64ToBytes(file.content) : file.content,
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
    await instance.fs.writeFile(
      path,
      file.encoding === "base64" ? base64ToBytes(file.content) : file.content,
    );
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
  sharedWebContainerState.instance = null;
  sharedWebContainerState.bootPromise = null;
}
