import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
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

  for (const file of Object.values(project.files)) {
    const segments = file.path.split("/");
    const fileName = segments.pop();

    if (!fileName) {
      continue;
    }

    let currentDirectory = tree;

    for (const segment of segments) {
      const existingEntry = currentDirectory[segment];

      if (!existingEntry || !("directory" in existingEntry)) {
        currentDirectory[segment] = { directory: {} };
      }

      const nextEntry = currentDirectory[segment];

      if (!nextEntry || !("directory" in nextEntry)) {
        continue;
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
  filePath: string,
): Promise<void> {
  const segments = filePath.split("/").slice(0, -1);
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

async function syncWorkspaceProject(
  instance: WebContainer,
  previousProject: WorkspaceProject | null,
  nextProject: WorkspaceProject,
): Promise<void> {
  const previousFiles = previousProject?.files ?? {};
  const nextFiles = nextProject.files;

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

    await ensureDirectory(instance, path);
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

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const { getProject } = useWorkspaceActions();
  const { syncVersion } = useWorkspaceMetadata();
  const instanceRef = useRef<WebContainer | null>(null);
  const devServerListenerCleanupRef = useRef<(() => void) | null>(null);
  const hasMountedProjectRef = useRef(false);
  const lastSyncedProjectRef = useRef<WorkspaceProject | null>(null);
  const hasAutoStartedRef = useRef(false);
  const [status, setStatus] = useState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);

  const isSupported = window.crossOriginIsolated;

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

  const resetRuntime = useCallback(() => {
    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = null;
    instanceRef.current?.teardown();
    instanceRef.current = null;
    hasMountedProjectRef.current = false;
    lastSyncedProjectRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setErrorMessage(null);
    setLastOutput(null);
    setActiveCommand(null);
  }, []);

  const bootInstance = useCallback(async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const { WebContainer } = await import("@webcontainer/api");
    const instance = await WebContainer.boot({
      coep: "require-corp",
      workdirName: "next-editor-runtime",
    });

    instanceRef.current = instance;

    return instance;
  }, []);

  const startRuntime = useCallback(async () => {
    if (!isSupported) {
      setStatus("error");
      setErrorMessage(
        "WebContainers require cross-origin isolation. Reload the app from the configured dev or deployed host.",
      );
      return;
    }

    if (status === "ready") {
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
      setErrorMessage(null);
      setLastOutput(null);
      setPreviewUrl(null);
      setStatus("booting");

      const instance = await bootInstance();
      const project = getProject();

      if (!hasMountedProjectRef.current) {
        setStatus("mounting");
        await instance.mount(createWorkspaceTree(project));
        lastSyncedProjectRef.current = structuredClone(project);
        hasMountedProjectRef.current = true;
      }

      setStatus("installing");
      const installProcess = await instance.spawn("npm", ["install"]);
      installProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendOutput(chunk);
          },
        }),
      );

      const installExitCode = await installProcess.exit;
      if (installExitCode !== 0) {
        throw new Error("npm install failed inside the WebContainer runtime");
      }

      devServerListenerCleanupRef.current?.();
      devServerListenerCleanupRef.current = instance.on(
        "server-ready",
        (_port, url) => {
          setPreviewUrl(url);
          setStatus("ready");
        },
      );

      setStatus("starting");
      const devProcess = await instance.spawn("npm", ["run", "dev"]);
      devProcess.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendOutput(chunk);
          },
        }),
      );
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [appendOutput, bootInstance, getProject, isSupported, status]);

  const runCommand = useCallback(
    async (commandLine: string) => {
      const parsedCommand = parseCommand(commandLine);

      if (!parsedCommand) {
        return;
      }

      if (status !== "ready") {
        await startRuntime();
      }

      const instance = instanceRef.current;
      if (!instance) {
        return;
      }

      setActiveCommand(commandLine);
      appendOutput(`\n$ ${commandLine}\n`);

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
      } catch (error) {
        appendOutput(`\n${getRuntimeErrorMessage(error)}\n`);
      } finally {
        setActiveCommand(null);
      }
    },
    [appendOutput, startRuntime, status],
  );

  useEffect(() => {
    if (!isSupported || hasAutoStartedRef.current) {
      return;
    }

    hasAutoStartedRef.current = true;
    void startRuntime();
  }, [isSupported, startRuntime]);

  useEffect(() => {
    if (status !== "ready") {
      return;
    }

    const instance = instanceRef.current;
    if (!instance) {
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
      runCommand,
    }),
    [resetRuntime, runCommand, startRuntime],
  );

  const metadataValue = useMemo<WebContainerRuntimeMetadata>(
    () => ({
      status,
      previewUrl,
      isSupported,
      errorMessage,
      lastOutput,
      activeCommand,
    }),
    [activeCommand, errorMessage, isSupported, lastOutput, previewUrl, status],
  );

  return (
    <WebContainerRuntimeActionsContext value={actionsValue}>
      <WebContainerRuntimeMetadataContext value={metadataValue}>
        {children}
      </WebContainerRuntimeMetadataContext>
    </WebContainerRuntimeActionsContext>
  );
};
