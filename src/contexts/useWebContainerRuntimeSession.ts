import { useCallback, useEffect, useRef, useState } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RuntimeLifecycleEvent,
  RuntimePort,
  RuntimePreviewMessage,
  WebContainerRuntimeRecordingSnapshot,
  WebContainerRuntimeStatus,
} from "./WebContainerRuntimeContext";
import {
  formatCommandError,
  formatPreviewMessage,
  getOrBootSharedWebContainer,
  getRuntimeErrorMessage,
  parseCommand,
  sanitizeTerminalChunk,
  teardownSharedWebContainer,
  TERMINAL_SHELL_CANDIDATES,
} from "./webContainerRuntimeSupport";

interface UseWebContainerRuntimeSessionOptions {
  environmentVariables: EnvironmentVariables;
}

export function useWebContainerRuntimeSession({
  environmentVariables,
}: UseWebContainerRuntimeSessionOptions) {
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
  const isMountedRef = useRef(true);
  const previewUrlRef = useRef<string | null>(null);
  const errorMessageRef = useRef<string | null>(null);
  const lastOutputRef = useRef<string | null>(null);
  const terminalOutputRef = useRef<string | null>(null);
  const activeCommandRef = useRef<string | null>(null);
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

  previewUrlRef.current = previewUrl;
  errorMessageRef.current = errorMessage;
  lastOutputRef.current = lastOutput;
  terminalOutputRef.current = terminalOutput;
  activeCommandRef.current = activeCommand;
  statusRef.current = status;

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

  const resetRuntimeSession = useCallback(() => {
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

  const writeTerminalInput = useCallback(
    async (instance: WebContainer, input: string) => {
      await ensureTerminalSession(instance);
      await terminalInputWriterRef.current?.write(input);
    },
    [ensureTerminalSession],
  );

  const resizeTerminal = useCallback((size: { cols: number; rows: number }) => {
    terminalSizeRef.current = size;
    terminalProcessRef.current?.resize(size);
  }, []);

  const hasActiveRunner = useCallback(
    () => runnerProcessRef.current !== null,
    [],
  );

  const getRecordingSnapshot = useCallback(
    (): WebContainerRuntimeRecordingSnapshot => ({
      status: statusRef.current,
      previewUrl: previewUrlRef.current,
      lastOutput: lastOutputRef.current,
      terminalOutput: terminalOutputRef.current,
      activeCommand: activeCommandRef.current,
      errorMessage: errorMessageRef.current,
    }),
    [],
  );

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return {
    activeCommand,
    bootInstance,
    ensureTerminalSession,
    errorMessage,
    getRecordingSnapshot,
    hasActiveRunner,
    instanceRef,
    isMountedRef,
    lastOutput,
    latestLifecycleEvent,
    latestPreviewMessage,
    openPorts,
    previewUrl,
    resetRuntimeSession,
    resizeTerminal,
    runForegroundCommand,
    setErrorMessage,
    setStatus,
    startRunnerProcess,
    status,
    statusRef,
    terminalOutput,
    writeTerminalInput,
  };
}
