import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileSystemTree,
  WebContainer,
  WebContainerProcess,
} from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type EnvironmentVariables,
  type RuntimeLifecycleEvent,
  type RuntimePort,
  type RunnerConfig,
  type RuntimePreviewMessage,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeStatus,
} from "./WebContainerRuntimeContext";
import {
  useWorkspaceActions,
  useWorkspaceMetadata,
} from "../hooks/useWorkspace";
import type { WorkspaceProject } from "../types/workspace";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  enabled: true,
  runOnStartup: true,
  runOnFileSave: true,
  initCommand: "npm install",
  runCommand: "npm run dev",
};
const TERMINAL_SHELL_CANDIDATES = [
  { command: "jsh" },
  { command: "bash", args: ["-i"] },
  { command: "sh", args: ["-i"] },
] as const;
const RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";

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

function getRuntimeErrorMessage(error: unknown): string {
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

function formatPreviewMessage(message: {
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

function sanitizeTerminalChunk(chunk: string): string {
  const withoutOsc = chunk.replace(OSC_PATTERN, "");
  const withoutAnsi = withoutOsc.replace(ANSI_PATTERN, "");
  const normalized = withoutAnsi.replace(/\r/g, "");

  if (/^[\\|/-]$/.test(normalized.trim())) {
    return "";
  }

  return normalized;
}

function createWorkspaceTree(project: WorkspaceProject): FileSystemTree {
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
        contents: file.content,
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

async function syncWorkspaceProject(
  instance: WebContainer,
  previousProject: WorkspaceProject | null,
  nextProject: WorkspaceProject,
): Promise<void> {
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
    await instance.fs.writeFile(path, file.content);
  }
}

function parseCommand(
  commandLine: string,
): { command: string; args: string[] } | null {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const [command, ...args] = parts;
  return { command, args };
}

function formatCommandError(commandLine: string): string {
  return `"${commandLine}" failed inside the WebContainer runtime`;
}

function getWorkspaceRoot(projectName: string): string {
  const normalizedProjectName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `~/projects/${normalizedProjectName || "next-editor"}`;
}

function normalizeEnvironmentVariables(
  variables: EnvironmentVariables,
): EnvironmentVariables {
  const entries = Object.entries(variables)
    .map(([key, value]) => [key.trim(), String(value)] as const)
    .filter(([key]) => key.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function loadStoredEnvironmentVariables(): EnvironmentVariables {
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

async function getOrBootSharedWebContainer(): Promise<WebContainer> {
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

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const { getProject } = useWorkspaceActions();
  const { lessonType, projectName, syncVersion } = useWorkspaceMetadata();
  const instanceRef = useRef<WebContainer | null>(null);
  const runnerProcessRef = useRef<WebContainerProcess | null>(null);
  const terminalProcessRef = useRef<WebContainerProcess | null>(null);
  const terminalInputWriterRef =
    useRef<WritableStreamDefaultWriter<string> | null>(null);
  const terminalSizeRef = useRef({ cols: 96, rows: 18 });
  const devServerListenerCleanupRef = useRef<(() => void) | null>(null);
  const portListenerCleanupRef = useRef<(() => void) | null>(null);
  const runtimeErrorListenerCleanupRef = useRef<(() => void) | null>(null);
  const previewMessageListenerCleanupRef = useRef<(() => void) | null>(null);
  const lifecycleEventIdRef = useRef(0);
  const previewMessageIdRef = useRef(0);
  const hasMountedProjectRef = useRef(false);
  const hasRunInitCommandRef = useRef(false);
  const lastSyncedProjectRef = useRef<WorkspaceProject | null>(null);
  const hasAutoStartedRef = useRef(false);
  const isMountedRef = useRef(true);
  const [status, setStatus] = useState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [latestPreviewMessage, setLatestPreviewMessage] =
    useState<RuntimePreviewMessage | null>(null);
  const [openPorts, setOpenPorts] = useState<RuntimePort[]>([]);
  const [latestLifecycleEvent, setLatestLifecycleEvent] =
    useState<RuntimeLifecycleEvent | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [environmentVariables, setEnvironmentVariables] =
    useState<EnvironmentVariables>(loadStoredEnvironmentVariables);
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig>(
    DEFAULT_RUNNER_CONFIG,
  );

  const isSupported = window.crossOriginIsolated;
  const workspaceRoot = useMemo(
    () => getWorkspaceRoot(projectName),
    [projectName],
  );

  const appendOutput = useCallback((chunk: string) => {
    const sanitizedChunk = sanitizeTerminalChunk(chunk);

    if (!sanitizedChunk) {
      return;
    }

    setLastOutput((current) => {
      const next = `${current ?? ""}${sanitizedChunk}`;
      return next.slice(-6000);
    });
  }, []);

  const appendTerminalOutput = useCallback((chunk: string) => {
    const sanitizedChunk = sanitizeTerminalChunk(chunk);

    if (!sanitizedChunk) {
      return;
    }

    setTerminalOutput((current) => {
      const next = `${current ?? ""}${sanitizedChunk}`;
      return next.slice(-6000);
    });
  }, []);

  const pushLifecycleEvent = useCallback(
    (event: Omit<RuntimeLifecycleEvent, "id">) => {
      setLatestLifecycleEvent({
        id: ++lifecycleEventIdRef.current,
        ...event,
      });
    },
    [],
  );

  const stopRunnerProcess = useCallback(() => {
    const process = runnerProcessRef.current;

    if (!process) {
      return;
    }

    runnerProcessRef.current = null;
    process.kill();
  }, []);

  const stopTerminalProcess = useCallback(() => {
    terminalInputWriterRef.current?.releaseLock();
    terminalInputWriterRef.current = null;

    const process = terminalProcessRef.current;

    if (!process) {
      return;
    }

    terminalProcessRef.current = null;
    process.kill();
  }, []);

  const resetRuntime = useCallback(() => {
    stopRunnerProcess();
    stopTerminalProcess();
    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = null;
    portListenerCleanupRef.current?.();
    portListenerCleanupRef.current = null;
    runtimeErrorListenerCleanupRef.current?.();
    runtimeErrorListenerCleanupRef.current = null;
    previewMessageListenerCleanupRef.current?.();
    previewMessageListenerCleanupRef.current = null;
    if (
      instanceRef.current &&
      instanceRef.current === sharedWebContainerState.instance
    ) {
      instanceRef.current.teardown();
      sharedWebContainerState.instance = null;
      sharedWebContainerState.bootPromise = null;
    }
    instanceRef.current = null;
    hasMountedProjectRef.current = false;
    hasRunInitCommandRef.current = false;
    lastSyncedProjectRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setErrorMessage(null);
    setLatestPreviewMessage(null);
    setOpenPorts([]);
    setLatestLifecycleEvent(null);
    setLastOutput(null);
    setTerminalOutput(null);
    setActiveCommand(null);
  }, [stopRunnerProcess, stopTerminalProcess]);

  const bootInstance = useCallback(async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const instance = await getOrBootSharedWebContainer();

    if (!isMountedRef.current) {
      return instance;
    }

    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = instance.on(
      "server-ready",
      (_port, url) => {
        setPreviewUrl(url);
        setStatus("ready");
      },
    );

    portListenerCleanupRef.current?.();
    portListenerCleanupRef.current = instance.on("port", (port, type, url) => {
      setOpenPorts((current) => {
        if (type === "open") {
          return [
            ...current.filter((entry) => entry.port !== port),
            { port, url },
          ].sort((left, right) => left.port - right.port);
        }

        return current.filter((entry) => entry.port !== port);
      });

      if (type === "close") {
        setPreviewUrl((current) => (current === url ? null : current));
      }

      pushLifecycleEvent({
        kind: type === "open" ? "port-open" : "port-close",
        text: type === "open" ? `Port ${port} opened` : `Port ${port} closed`,
        port,
        url,
      });
    });

    runtimeErrorListenerCleanupRef.current?.();
    runtimeErrorListenerCleanupRef.current = instance.on("error", (error) => {
      const message = getRuntimeErrorMessage(error);

      setErrorMessage(message);
      setStatus("error");
      pushLifecycleEvent({
        kind: "internal-error",
        text: message,
        port: null,
        url: null,
      });
    });

    previewMessageListenerCleanupRef.current?.();
    previewMessageListenerCleanupRef.current = instance.on(
      "preview-message",
      (message) => {
        setLatestPreviewMessage({
          id: ++previewMessageIdRef.current,
          ...formatPreviewMessage(message),
        });
      },
    );

    instanceRef.current = instance;

    return instance;
  }, [pushLifecycleEvent]);

  const runForegroundCommand = useCallback(
    async (
      instance: WebContainer,
      commandLine: string,
      options: { clearOutput?: boolean; trackAsActiveCommand?: boolean } = {},
    ) => {
      const parsedCommand = parseCommand(commandLine);

      if (!parsedCommand) {
        return 0;
      }

      if (options.clearOutput) {
        setLastOutput(null);
      }

      appendOutput(`$ ${commandLine}\n`);

      if (options.trackAsActiveCommand) {
        setActiveCommand(commandLine);
      }

      try {
        const process = await instance.spawn(
          parsedCommand.command,
          parsedCommand.args,
          Object.keys(environmentVariables).length > 0
            ? { env: environmentVariables }
            : undefined,
        );

        process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              appendOutput(chunk);
            },
          }),
        );

        const exitCode = await process.exit;
        appendOutput(`\nCommand exited with code ${exitCode}\n`);
        return exitCode;
      } catch (error) {
        appendOutput(`\n${getRuntimeErrorMessage(error)}\n`);
        return -1;
      } finally {
        if (options.trackAsActiveCommand) {
          setActiveCommand(null);
        }
      }
    },
    [appendOutput, environmentVariables],
  );

  const prepareRuntime = useCallback(async () => {
    if (!isSupported) {
      setStatus("error");
      setErrorMessage(
        "WebContainers require cross-origin isolation. Reload the app from the configured dev or deployed host.",
      );
      return null;
    }

    setErrorMessage(null);

    const instance = await bootInstance();

    if (!instance || !isMountedRef.current) {
      return null;
    }

    const project = getProject();

    if (!hasMountedProjectRef.current) {
      setStatus("mounting");
      await instance.mount(createWorkspaceTree(project));
      lastSyncedProjectRef.current = structuredClone(project);
      hasMountedProjectRef.current = true;
    }

    const initCommand = runnerConfig.initCommand.trim();
    if (!initCommand || hasRunInitCommandRef.current) {
      return instance;
    }

    setStatus("installing");
    const initExitCode = await runForegroundCommand(instance, initCommand, {
      clearOutput: true,
    });

    if (initExitCode !== 0) {
      throw new Error(formatCommandError(initCommand));
    }

    hasRunInitCommandRef.current = true;
    return instance;
  }, [
    bootInstance,
    getProject,
    isSupported,
    runForegroundCommand,
    runnerConfig.initCommand,
  ]);

  const startRunnerProcess = useCallback(
    async (instance: WebContainer, commandLine: string) => {
      const parsedCommand = parseCommand(commandLine);

      if (!parsedCommand) {
        setStatus("ready");
        return;
      }

      stopRunnerProcess();
      setPreviewUrl(null);
      setErrorMessage(null);
      setLastOutput(null);
      setStatus("starting");
      appendOutput(`$ ${commandLine}\n`);

      try {
        const process = await instance.spawn(
          parsedCommand.command,
          parsedCommand.args,
          Object.keys(environmentVariables).length > 0
            ? { env: environmentVariables }
            : undefined,
        );
        runnerProcessRef.current = process;

        process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              appendOutput(chunk);
            },
          }),
        );

        void process.exit
          .then((exitCode) => {
            if (runnerProcessRef.current !== process) {
              return;
            }

            runnerProcessRef.current = null;
            appendOutput(`\nRunner exited with code ${exitCode}\n`);

            if (exitCode !== 0) {
              setStatus("error");
              setErrorMessage(formatCommandError(commandLine));
            }
          })
          .catch((error) => {
            if (runnerProcessRef.current !== process) {
              return;
            }

            runnerProcessRef.current = null;
            setStatus("error");
            setErrorMessage(getRuntimeErrorMessage(error));
          });
      } catch (error) {
        setStatus("error");
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    },
    [appendOutput, environmentVariables, stopRunnerProcess],
  );

  const ensureTerminalSession = useCallback(
    async (instance: WebContainer) => {
      if (terminalProcessRef.current) {
        return;
      }

      let lastError: unknown = null;

      for (const candidate of TERMINAL_SHELL_CANDIDATES) {
        try {
          const process = candidate.args
            ? await instance.spawn(candidate.command, [...candidate.args], {
                env: environmentVariables,
                terminal: terminalSizeRef.current,
              })
            : await instance.spawn(candidate.command, {
                env: environmentVariables,
                terminal: terminalSizeRef.current,
              });

          terminalProcessRef.current = process;
          terminalInputWriterRef.current = process.input.getWriter();

          process.output
            .pipeTo(
              new WritableStream({
                write(chunk) {
                  appendTerminalOutput(chunk);
                },
              }),
            )
            .catch(() => {});

          void process.exit
            .then((exitCode) => {
              if (terminalProcessRef.current !== process) {
                return;
              }

              terminalInputWriterRef.current?.releaseLock();
              terminalInputWriterRef.current = null;
              terminalProcessRef.current = null;
              appendTerminalOutput(`\nTerminal exited with code ${exitCode}\n`);
            })
            .catch((error) => {
              if (terminalProcessRef.current !== process) {
                return;
              }

              terminalInputWriterRef.current?.releaseLock();
              terminalInputWriterRef.current = null;
              terminalProcessRef.current = null;
              appendTerminalOutput(`\n${getRuntimeErrorMessage(error)}\n`);
            });

          return;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError ?? new Error("Unable to start the workspace shell.");
    },
    [appendTerminalOutput, environmentVariables],
  );

  const startRuntime = useCallback(async () => {
    if (lessonType !== "spa") {
      resetRuntime();
      return;
    }

    if (
      status === "booting" ||
      status === "mounting" ||
      status === "installing" ||
      status === "starting"
    ) {
      return;
    }

    try {
      setStatus("booting");

      const instance = await prepareRuntime();
      if (!instance) {
        return;
      }

      if (!runnerConfig.enabled) {
        setStatus("ready");
        return;
      }

      await startRunnerProcess(instance, runnerConfig.runCommand);
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [
    lessonType,
    prepareRuntime,
    resetRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    startRunnerProcess,
    status,
  ]);

  const rerunRunner = useCallback(async () => {
    if (lessonType !== "spa") {
      resetRuntime();
      return;
    }

    try {
      setStatus("booting");
      const instance = await prepareRuntime();

      if (!instance) {
        return;
      }

      if (!runnerConfig.enabled) {
        setStatus("ready");
        return;
      }

      await startRunnerProcess(instance, runnerConfig.runCommand);
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [
    lessonType,
    prepareRuntime,
    resetRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    startRunnerProcess,
  ]);

  const startTerminalSession = useCallback(async () => {
    if (lessonType !== "spa") {
      return;
    }

    const instance = await prepareRuntime();
    if (!instance) {
      return;
    }

    await ensureTerminalSession(instance);
  }, [ensureTerminalSession, lessonType, prepareRuntime]);

  const sendTerminalInput = useCallback(
    async (input: string) => {
      if (lessonType !== "spa") {
        return;
      }

      const instance = await prepareRuntime();
      if (!instance) {
        return;
      }

      await ensureTerminalSession(instance);
      await terminalInputWriterRef.current?.write(input);
    },
    [ensureTerminalSession, lessonType, prepareRuntime],
  );

  const resizeTerminal = useCallback((size: { cols: number; rows: number }) => {
    terminalSizeRef.current = size;
    terminalProcessRef.current?.resize(size);
  }, []);

  const runCommand = useCallback(
    async (commandLine: string) => {
      await sendTerminalInput(`${commandLine}\n`);
    },
    [sendTerminalInput],
  );

  const saveWorkspace = useCallback(async () => {
    if (
      lessonType !== "spa" ||
      !runnerConfig.enabled ||
      !runnerConfig.runOnFileSave
    ) {
      return;
    }

    if (
      runnerProcessRef.current ||
      status === "booting" ||
      status === "mounting" ||
      status === "installing" ||
      status === "starting"
    ) {
      return;
    }

    await rerunRunner();
  }, [
    lessonType,
    rerunRunner,
    runnerConfig.enabled,
    runnerConfig.runOnFileSave,
    status,
  ]);

  const updateRunnerConfig = useCallback((config: Partial<RunnerConfig>) => {
    setRunnerConfig((current) => ({
      ...current,
      ...config,
    }));
  }, []);

  const updateEnvironmentVariables = useCallback(
    (variables: EnvironmentVariables) => {
      const normalizedVariables = normalizeEnvironmentVariables(variables);

      setEnvironmentVariables(normalizedVariables);

      if (typeof window === "undefined") {
        return;
      }

      try {
        if (Object.keys(normalizedVariables).length === 0) {
          window.localStorage.removeItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);
          return;
        }

        window.localStorage.setItem(
          RUNTIME_ENVIRONMENT_STORAGE_KEY,
          JSON.stringify(normalizedVariables),
        );
      } catch (error) {
        console.warn("Failed to persist runtime environment variables:", error);
      }
    },
    [],
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    hasAutoStartedRef.current = false;

    if (lessonType === "html-css") {
      resetRuntime();
    }
  }, [lessonType, resetRuntime]);

  useEffect(() => {
    if (
      lessonType !== "spa" ||
      !isSupported ||
      hasAutoStartedRef.current ||
      !runnerConfig.enabled ||
      !runnerConfig.runOnStartup
    ) {
      return;
    }

    hasAutoStartedRef.current = true;
    void startRuntime();
  }, [
    lessonType,
    isSupported,
    runnerConfig.enabled,
    runnerConfig.runOnStartup,
    startRuntime,
  ]);

  useEffect(() => {
    hasRunInitCommandRef.current = false;
  }, [runnerConfig.initCommand]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance || !hasMountedProjectRef.current) {
      return;
    }

    const project = getProject();

    void syncWorkspaceProject(instance, lastSyncedProjectRef.current, project)
      .then(() => {
        lastSyncedProjectRef.current = structuredClone(project);
      })
      .catch((error) => {
        setErrorMessage(getRuntimeErrorMessage(error));
      });
  }, [getProject, status, syncVersion]);

  useEffect(() => {
    return () => {
      resetRuntime();
    };
  }, [resetRuntime]);

  const actionsValue = useMemo<WebContainerRuntimeActions>(
    () => ({
      startRuntime,
      resetRuntime,
      rerunRunner,
      runCommand,
      startTerminalSession,
      sendTerminalInput,
      resizeTerminal,
      saveWorkspace,
      updateEnvironmentVariables,
      updateRunnerConfig,
    }),
    [
      resetRuntime,
      resizeTerminal,
      rerunRunner,
      runCommand,
      saveWorkspace,
      sendTerminalInput,
      startTerminalSession,
      startRuntime,
      updateEnvironmentVariables,
      updateRunnerConfig,
    ],
  );

  const metadataValue = useMemo<WebContainerRuntimeMetadata>(
    () => ({
      status,
      previewUrl,
      isSupported,
      errorMessage,
      latestPreviewMessage,
      openPorts,
      latestLifecycleEvent,
      lastOutput,
      terminalOutput,
      activeCommand,
      environmentVariables,
      runnerConfig,
      workspaceRoot,
    }),
    [
      activeCommand,
      environmentVariables,
      errorMessage,
      isSupported,
      lastOutput,
      latestLifecycleEvent,
      latestPreviewMessage,
      openPorts,
      previewUrl,
      runnerConfig,
      status,
      terminalOutput,
      workspaceRoot,
    ],
  );

  return (
    <WebContainerRuntimeActionsContext value={actionsValue}>
      <WebContainerRuntimeMetadataContext value={metadataValue}>
        {children}
      </WebContainerRuntimeMetadataContext>
    </WebContainerRuntimeActionsContext>
  );
};
