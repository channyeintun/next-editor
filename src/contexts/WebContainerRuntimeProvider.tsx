import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeSnapshotGetterContext,
  WebContainerRuntimeSaveWorkspaceContext,
  type EnvironmentVariables,
  type WebContainerRuntimeRecordingSnapshot,
  type RuntimeLifecycleEvent,
  type RuntimePort,
  type RunnerConfig,
  type RuntimePreviewMessage,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeStatus,
} from "./WebContainerRuntimeContext";
import {
  DEFAULT_RUNNER_CONFIG,
  formatCommandError,
  formatPreviewMessage,
  getOrBootSharedWebContainer,
  getRuntimeErrorMessage,
  getWorkspaceRoot,
  loadStoredEnvironmentVariables,
  normalizeEnvironmentVariables,
  parseCommand,
  persistEnvironmentVariables,
  sanitizeTerminalChunk,
  teardownSharedWebContainer,
  TERMINAL_SHELL_CANDIDATES,
} from "./webContainerRuntimeSupport";
import {
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceProjectName,
  useWorkspaceSaveVersion,
} from "../hooks/useWorkspace";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const { getProject } = useWorkspaceActions();
  const lessonType = useWorkspaceLessonType();
  const projectName = useWorkspaceProjectName();
  const saveVersion = useWorkspaceSaveVersion();
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
  const hasRunInitCommandRef = useRef(false);
  const hasAutoStartedRef = useRef(false);
  const isMountedRef = useRef(true);
  const lessonTypeRef = useRef(lessonType);
  const previewUrlRef = useRef<string | null>(null);
  const errorMessageRef = useRef<string | null>(null);
  const lastOutputRef = useRef<string | null>(null);
  const terminalOutputRef = useRef<string | null>(null);
  const activeCommandRef = useRef<string | null>(null);
  const runnerConfigRef = useRef<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const statusRef = useRef<WebContainerRuntimeStatus>("idle");
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
  const {
    hasMountedProjectRef,
    ensureProjectMounted,
    queueProjectSync,
    resetWorkspaceSync,
  } = useWebContainerWorkspaceSync();

  lessonTypeRef.current = lessonType;
  previewUrlRef.current = previewUrl;
  errorMessageRef.current = errorMessage;
  lastOutputRef.current = lastOutput;
  terminalOutputRef.current = terminalOutput;
  activeCommandRef.current = activeCommand;
  runnerConfigRef.current = runnerConfig;
  statusRef.current = status;

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
    teardownSharedWebContainer(instanceRef.current);
    instanceRef.current = null;
    hasRunInitCommandRef.current = false;
    resetWorkspaceSync();
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

    await ensureProjectMounted({
      instance,
      project,
      onMountStart: () => setStatus("mounting"),
    });

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
          const process = await instance.spawn(
            candidate.command,
            [...candidate.args],
            {
              env: environmentVariables,
              terminal: terminalSizeRef.current,
            },
          );

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
    if (lessonType !== "node.js") {
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
    if (lessonType !== "node.js") {
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
  const rerunRunnerRef = useRef(rerunRunner);
  rerunRunnerRef.current = rerunRunner;

  const startTerminalSession = useCallback(async () => {
    if (lessonType !== "node.js") {
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
      if (lessonType !== "node.js") {
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
    if (lessonTypeRef.current !== "node.js") {
      return;
    }

    const instance = instanceRef.current;

    if (instance) {
      const project = getProject();

      try {
        await queueProjectSync({ instance, project });
      } catch (error) {
        setErrorMessage(getRuntimeErrorMessage(error));
        throw error;
      }
    }

    const currentRunnerConfig = runnerConfigRef.current;
    const currentStatus = statusRef.current;

    if (!currentRunnerConfig.enabled || !currentRunnerConfig.runOnFileSave) {
      return;
    }

    if (
      runnerProcessRef.current ||
      currentStatus === "booting" ||
      currentStatus === "mounting" ||
      currentStatus === "installing" ||
      currentStatus === "starting"
    ) {
      return;
    }

    await rerunRunnerRef.current();
  }, [getProject, queueProjectSync]);

  const getRecordingSnapshot = useCallback<
    () => WebContainerRuntimeRecordingSnapshot
  >(() => {
    return {
      status: statusRef.current,
      previewUrl: previewUrlRef.current,
      lastOutput: lastOutputRef.current,
      terminalOutput: terminalOutputRef.current,
      activeCommand: activeCommandRef.current,
      errorMessage: errorMessageRef.current,
    };
  }, []);

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
      persistEnvironmentVariables(normalizedVariables);
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
      lessonType !== "node.js" ||
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

    void queueProjectSync({ instance, project }).catch((error) => {
      setErrorMessage(getRuntimeErrorMessage(error));
    });
  }, [getProject, hasMountedProjectRef, queueProjectSync, saveVersion]);

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
    <WebContainerRuntimeSnapshotGetterContext value={getRecordingSnapshot}>
      <WebContainerRuntimeSaveWorkspaceContext value={saveWorkspace}>
        <WebContainerRuntimeActionsContext value={actionsValue}>
          <WebContainerRuntimeMetadataContext value={metadataValue}>
            {children}
          </WebContainerRuntimeMetadataContext>
        </WebContainerRuntimeActionsContext>
      </WebContainerRuntimeSaveWorkspaceContext>
    </WebContainerRuntimeSnapshotGetterContext>
  );
};
