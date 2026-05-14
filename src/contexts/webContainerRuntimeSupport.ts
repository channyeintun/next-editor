import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RunnerConfig,
  RuntimePreviewMessage,
} from "./WebContainerRuntimeContext";
import type { WorkspaceProject } from "../types/workspace";

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "npm install",
  runCommand: "npm run dev",
};

export const TERMINAL_SHELL_CANDIDATES = [
  { command: "jsh", args: [] },
  { command: "bash", args: ["-i"] },
  { command: "sh", args: ["-i"] },
] as const;

const RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";
const RUNTIME_SNAPSHOT_MESSAGE_TYPE = "NEXT_EDITOR_RUNTIME_SNAPSHOT";
const RUNTIME_SNAPSHOT_SCRIPT_MARKER = "__NEXT_EDITOR_RUNTIME_SNAPSHOT__";

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
const ANSI_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\[[0-9;?]*[ -/]*[@-~]`,
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
  const kind =
    message.type === "console-error"
      ? "console-error"
      : message.type === "unhandledrejection"
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
  const withoutAnsi = withoutOsc.replace(ANSI_PATTERN, "");
  const normalized = withoutAnsi.replace(/\r/g, "");

  if (/^[\\|/-]$/.test(normalized.trim())) {
    return "";
  }

  return normalized;
}

function injectRuntimeSnapshotScript(
  project: WorkspaceProject,
  filePath: string,
  content: string,
): string {
  const isRuntimeHtmlBootstrap =
    filePath.toLowerCase().endsWith(".html") &&
    (filePath === "index.html" || filePath === project.entryFilePath);

  if (
    project.lessonType !== "node.js" ||
    !isRuntimeHtmlBootstrap ||
    content.includes(RUNTIME_SNAPSHOT_SCRIPT_MARKER)
  ) {
    return content;
  }

  const snapshotScript = `<script data-next-editor-runtime-snapshot>(function(){const marker=${JSON.stringify(
    RUNTIME_SNAPSHOT_SCRIPT_MARKER,
  )};if(window[marker])return;window[marker]=true;const messageType=${JSON.stringify(
    RUNTIME_SNAPSHOT_MESSAGE_TYPE,
  )};const postSnapshot=()=>{try{window.parent.postMessage({type:messageType,payload:{html:document.documentElement.outerHTML}},"*");}catch{}};let frame=0;const schedule=()=>{if(frame)return;frame=window.requestAnimationFrame(()=>{frame=0;postSnapshot();});};const root=document.documentElement;if(root){new MutationObserver(schedule).observe(root,{attributes:true,childList:true,subtree:true,characterData:true});}window.addEventListener("load",schedule);window.addEventListener("pageshow",schedule);document.addEventListener("readystatechange",schedule);schedule();window.setTimeout(schedule,50);window.setTimeout(schedule,250);window.setTimeout(schedule,1000);})();</script>`;

  if (content.includes("</head>")) {
    return content.replace("</head>", `${snapshotScript}\n</head>`);
  }

  if (content.includes("</body>")) {
    return content.replace("</body>", `${snapshotScript}\n</body>`);
  }

  return `${content}\n${snapshotScript}`;
}

export function createWorkspaceTree(project: WorkspaceProject): FileSystemTree {
  const tree: FileSystemTree = {};

  const ensureTreeDirectory = (directoryPath: string) => {
    if (!directoryPath) {
      return;
    }

    let currentDirectory = tree;

    for (const segment of directoryPath.split("/")) {
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
    const segments = file.path.split("/");
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
        contents: injectRuntimeSnapshotScript(project, file.path, file.content),
      },
    };
  }

  return tree;
}

async function ensureDirectory(
  instance: WebContainer,
  directoryPath: string,
): Promise<void> {
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

  const previousFiles = previousProject?.files ?? {};
  const nextFiles = nextProject.files;
  const previousFolders = new Set(previousProject?.folders ?? []);

  for (const folderPath of nextProject.folders) {
    if (previousFolders.has(folderPath)) {
      continue;
    }

    await ensureDirectory(instance, folderPath);
  }

  const deletedPaths = Object.keys(previousFiles).filter(
    (path) => !nextFiles[path],
  );

  for (const path of deletedPaths.sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      await instance.fs.rm(path);
    } catch {
      // Ignore files that are already absent.
    }
  }

  for (const [path, file] of Object.entries(nextFiles)) {
    const previousFile = previousFiles[path];

    if (previousFile && previousFile.content === file.content) {
      continue;
    }

    await ensureDirectory(instance, getFileDirectory(path));
    await instance.fs.writeFile(
      path,
      injectRuntimeSnapshotScript(nextProject, path, file.content),
    );
  }
}

export function parseCommand(
  commandLine: string,
): { command: string; args: string[] } | null {
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

export function persistEnvironmentVariables(
  variables: EnvironmentVariables,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(variables).length === 0) {
      window.localStorage.removeItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      RUNTIME_ENVIRONMENT_STORAGE_KEY,
      JSON.stringify(variables),
    );
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

export function teardownSharedWebContainer(
  instance: WebContainer | null,
): void {
  if (!instance || instance !== sharedWebContainerState.instance) {
    return;
  }

  instance.teardown();
  sharedWebContainerState.instance = null;
  sharedWebContainerState.bootPromise = null;
}
