import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FileSystemTree,
  WebContainer,
  WebContainerProcess,
} from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  type RunnerConfig,
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

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const { getProject } = useWorkspaceActions();
  const { projectName, syncVersion } = useWorkspaceMetadata();
  const instanceRef = useRef<WebContainer | null>(null);
  const runnerProcessRef = useRef<WebContainerProcess | null>(null);
  const devServerListenerCleanupRef = useRef<(() => void) | null>(null);
  const hasMountedProjectRef = useRef(false);
  const hasRunInitCommandRef = useRef(false);
  const lastSyncedProjectRef = useRef<WorkspaceProject | null>(null);
  const hasAutoStartedRef = useRef(false);
  const [status, setStatus] = useState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
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

  const stopRunnerProcess = useCallback(() => {
    const process = runnerProcessRef.current;

    if (!process) {
      return;
    }

    runnerProcessRef.current = null;
    process.kill();
  }, []);

  const resetRuntime = useCallback(() => {
    stopRunnerProcess();
    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = null;
    instanceRef.current?.teardown();
    instanceRef.current = null;
    hasMountedProjectRef.current = false;
    hasRunInitCommandRef.current = false;
    lastSyncedProjectRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setErrorMessage(null);
    setLastOutput(null);
    setActiveCommand(null);
  }, [stopRunnerProcess]);

  const bootInstance = useCallback(async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const { WebContainer } = await import("@webcontainer/api");
    const instance = await WebContainer.boot({
      coep: "require-corp",
      workdirName: "next-editor-runtime",
    });

    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = instance.on(
      "server-ready",
      (_port, url) => {
        setPreviewUrl(url);
        setStatus("ready");
      },
    );

    instanceRef.current = instance;

    return instance;
  }, []);

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
    [appendOutput],
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
        );
        runnerProcessRef.current = process;

        process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              appendOutput(chunk);
            },
          }),
        );

        setStatus("ready");

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
    [appendOutput, stopRunnerProcess],
  );

  const startRuntime = useCallback(async () => {
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
    prepareRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    startRunnerProcess,
    status,
  ]);

  const rerunRunner = useCallback(async () => {
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
    prepareRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    startRunnerProcess,
  ]);

  const runCommand = useCallback(
    async (commandLine: string) => {
      const parsedCommand = parseCommand(commandLine);

      if (!parsedCommand) {
        return;
      }

      const instance = await prepareRuntime();
      if (!instance) {
        return;
      }

      await runForegroundCommand(instance, commandLine, {
        trackAsActiveCommand: true,
      });
    },
    [prepareRuntime, runForegroundCommand],
  );

  const saveWorkspace = useCallback(async () => {
    if (!runnerConfig.enabled || !runnerConfig.runOnFileSave) {
      return;
    }

    await rerunRunner();
  }, [rerunRunner, runnerConfig.enabled, runnerConfig.runOnFileSave]);

  const updateRunnerConfig = useCallback((config: Partial<RunnerConfig>) => {
    setRunnerConfig((current) => ({
      ...current,
      ...config,
    }));
  }, []);

  useEffect(() => {
    if (
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
      saveWorkspace,
      updateRunnerConfig,
    }),
    [
      resetRuntime,
      rerunRunner,
      runCommand,
      saveWorkspace,
      startRuntime,
      updateRunnerConfig,
    ],
  );

  const metadataValue = useMemo<WebContainerRuntimeMetadata>(
    () => ({
      status,
      previewUrl,
      isSupported,
      errorMessage,
      lastOutput,
      activeCommand,
      runnerConfig,
      workspaceRoot,
    }),
    [
      activeCommand,
      errorMessage,
      isSupported,
      lastOutput,
      previewUrl,
      runnerConfig,
      status,
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
