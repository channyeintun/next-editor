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
import type { RuntimeTerminalSessionSnapshot } from "../types/runtime";
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

const RUNNER_OUTPUT_LIMIT = 6000;
const TERMINAL_OUTPUT_LIMIT = 50000;

interface TerminalSessionHandle extends RuntimeTerminalSessionSnapshot {
  inputWriter: WritableStreamDefaultWriter<string> | null;
  process: WebContainerProcess | null;
}

export function useWebContainerRuntimeSession({
  environmentVariables,
}: UseWebContainerRuntimeSessionOptions) {
  const instanceRef = useRef<WebContainer | null>(null);
  const runnerProcessRef = useRef<WebContainerProcess | null>(null);
  const terminalSessionsRef = useRef<TerminalSessionHandle[]>([]);
  const terminalSessionCounterRef = useRef(0);
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
  const activeTerminalSessionIdRef = useRef<string | null>(null);
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
  const [terminalSessions, setTerminalSessions] = useState<
    RuntimeTerminalSessionSnapshot[]
  >([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<
    string | null
  >(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);

  previewUrlRef.current = previewUrl;
  errorMessageRef.current = errorMessage;
  lastOutputRef.current = lastOutput;
  terminalOutputRef.current =
    terminalSessions.find((session) => session.id === activeTerminalSessionId)
      ?.output ?? null;
  activeTerminalSessionIdRef.current = activeTerminalSessionId;
  activeCommandRef.current = activeCommand;
  statusRef.current = status;

  const appendOutput = useCallback((chunk: string) => {
    const sanitizedChunk = sanitizeTerminalChunk(chunk);

    if (!sanitizedChunk) {
      return;
    }

    setLastOutput((current) => {
      const next = `${current ?? ""}${sanitizedChunk}`;
      return next.slice(-RUNNER_OUTPUT_LIMIT);
    });
  }, []);

  const syncTerminalSessions = useCallback(() => {
    setTerminalSessions(
      terminalSessionsRef.current.map(({ id, output, title }) => ({
        id,
        output,
        title,
      })),
    );
  }, []);

  const setActiveTerminalSession = useCallback((sessionId: string | null) => {
    activeTerminalSessionIdRef.current = sessionId;
    setActiveTerminalSessionId(sessionId);
  }, []);

  const appendTerminalOutput = useCallback((sessionId: string, chunk: string) => {
    if (!chunk) {
      return;
    }

    setTerminalSessions((current) =>
      current.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        const nextOutput = `${session.output}${chunk}`.slice(
          -TERMINAL_OUTPUT_LIMIT,
        );
        const terminalSession = terminalSessionsRef.current.find(
          (entry) => entry.id === sessionId,
        );

        if (terminalSession) {
          terminalSession.output = nextOutput;
        }

        if (activeTerminalSessionIdRef.current === sessionId) {
          terminalOutputRef.current = nextOutput;
        }

        return {
          ...session,
          output: nextOutput,
        };
      }),
    );
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

  const createTerminalSessionHandle = useCallback((): TerminalSessionHandle => {
    terminalSessionCounterRef.current += 1;

    return {
      id: `terminal-${terminalSessionCounterRef.current}`,
      title: "Terminal",
      output: "",
      inputWriter: null,
      process: null,
    };
  }, []);

  const stopRunnerProcess = useCallback(
    async (options?: { waitForExit?: boolean }) => {
      const process = runnerProcessRef.current;

      if (!process) {
        return;
      }

      runnerProcessRef.current = null;
      const exitPromise = process.exit.catch(() => undefined);
      process.kill();

      if (options?.waitForExit) {
        await exitPromise;
      }
    },
    [],
  );

  const stopTerminalProcess = useCallback((sessionId?: string) => {
    const sessions = sessionId
      ? terminalSessionsRef.current.filter((session) => session.id === sessionId)
      : terminalSessionsRef.current;

    for (const session of sessions) {
      session.inputWriter?.releaseLock();
      session.inputWriter = null;

      if (!session.process) {
        continue;
      }

      const process = session.process;
      session.process = null;
      process.kill();
    }
  }, []);

  const resetRuntimeSession = useCallback(() => {
    stopRunnerProcess();
    stopTerminalProcess();
    terminalSessionsRef.current = [];
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
    activeTerminalSessionIdRef.current = null;
    terminalOutputRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setErrorMessage(null);
    setLatestPreviewMessage(null);
    setOpenPorts([]);
    setLatestLifecycleEvent(null);
    setLastOutput(null);
    setTerminalSessions([]);
    setActiveTerminalSessionId(null);
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
        if (!runnerProcessRef.current) {
          return;
        }

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

      await stopRunnerProcess({ waitForExit: true });
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
            setPreviewUrl(null);
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
            setPreviewUrl(null);
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

  const ensureTerminalProcess = useCallback(
    async (instance: WebContainer, sessionId: string) => {
      const session = terminalSessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );

      if (!session) {
        throw new Error("Unable to find the requested terminal session.");
      }

      if (session.process) {
        return session;
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

          session.process = process;
          session.inputWriter = process.input.getWriter();

          process.output
            .pipeTo(
              new WritableStream({
                write(chunk) {
                  appendTerminalOutput(sessionId, chunk);
                },
              }),
            )
            .catch(() => {});

          void process.exit
            .then((exitCode) => {
              const currentSession = terminalSessionsRef.current.find(
                (entry) => entry.id === sessionId,
              );

              if (!currentSession || currentSession.process !== process) {
                return;
              }

              currentSession.inputWriter?.releaseLock();
              currentSession.inputWriter = null;
              currentSession.process = null;
              appendTerminalOutput(
                sessionId,
                `\nTerminal exited with code ${exitCode}\n`,
              );
            })
            .catch((error) => {
              const currentSession = terminalSessionsRef.current.find(
                (entry) => entry.id === sessionId,
              );

              if (!currentSession || currentSession.process !== process) {
                return;
              }

              currentSession.inputWriter?.releaseLock();
              currentSession.inputWriter = null;
              currentSession.process = null;
              appendTerminalOutput(
                sessionId,
                `\n${getRuntimeErrorMessage(error)}\n`,
              );
            });

          return session;
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError ?? new Error("Unable to start the workspace shell.");
    },
    [appendTerminalOutput, environmentVariables],
  );

  const ensureTerminalSession = useCallback(
    async (instance: WebContainer) => {
      let session = terminalSessionsRef.current.find(
        (entry) => entry.id === activeTerminalSessionIdRef.current,
      );

      if (!session) {
        session = createTerminalSessionHandle();
        terminalSessionsRef.current = [...terminalSessionsRef.current, session];
        syncTerminalSessions();
        setActiveTerminalSession(session.id);
      }

      return ensureTerminalProcess(instance, session.id);
    },
    [createTerminalSessionHandle, ensureTerminalProcess, setActiveTerminalSession, syncTerminalSessions],
  );

  const createTerminalSession = useCallback(
    async (instance: WebContainer) => {
      const session = createTerminalSessionHandle();
      terminalSessionsRef.current = [...terminalSessionsRef.current, session];
      syncTerminalSessions();
      setActiveTerminalSession(session.id);
      await ensureTerminalProcess(instance, session.id);
    },
    [createTerminalSessionHandle, ensureTerminalProcess, setActiveTerminalSession, syncTerminalSessions],
  );

  const closeTerminalSession = useCallback(
    (sessionId: string) => {
      const sessions = terminalSessionsRef.current;
      const sessionIndex = sessions.findIndex((session) => session.id === sessionId);

      if (sessionIndex === -1) {
        return;
      }

      stopTerminalProcess(sessionId);

      const nextSessions = sessions.filter((session) => session.id !== sessionId);
      terminalSessionsRef.current = nextSessions;
      syncTerminalSessions();

      if (activeTerminalSessionIdRef.current !== sessionId) {
        return;
      }

      const fallbackSession =
        nextSessions[sessionIndex] ?? nextSessions[sessionIndex - 1] ?? null;

      setActiveTerminalSession(fallbackSession?.id ?? null);
      terminalOutputRef.current = fallbackSession?.output ?? null;
    },
    [setActiveTerminalSession, stopTerminalProcess, syncTerminalSessions],
  );

  const writeTerminalInput = useCallback(
    async (instance: WebContainer, input: string) => {
      const session = await ensureTerminalSession(instance);
      await session?.inputWriter?.write(input);
    },
    [ensureTerminalSession],
  );

  const resizeTerminal = useCallback((size: { cols: number; rows: number }) => {
    terminalSizeRef.current = size;

    for (const session of terminalSessionsRef.current) {
      session.process?.resize(size);
    }
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
      terminalSessions: terminalSessionsRef.current.map(({ id, output, title }) => ({
        id,
        output,
        title,
      })),
      activeTerminalSessionId: activeTerminalSessionIdRef.current,
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
    activeTerminalSessionId,
    bootInstance,
    closeTerminalSession,
    createTerminalSession,
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
    setActiveTerminalSession,
    setErrorMessage,
    setStatus,
    startRunnerProcess,
    status,
    statusRef,
    terminalOutput: terminalOutputRef.current,
    terminalSessions,
    writeTerminalInput,
  };
}
