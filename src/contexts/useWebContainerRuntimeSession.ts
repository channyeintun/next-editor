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
import type {
  RuntimeTerminalSessionSnapshot,
} from "../types/runtime";
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
  onTerminalOutput?: () => void;
}

const RUNNER_OUTPUT_LIMIT = 6000;
const TERMINAL_OUTPUT_LIMIT = 50000;

interface TerminalSessionHandle extends RuntimeTerminalSessionSnapshot {
  inputWriter: WritableStreamDefaultWriter<string> | null;
  process: WebContainerProcess | null;
  startPromise: Promise<TerminalSessionHandle> | null;
}

function safelyReleaseWriter(
  writer: WritableStreamDefaultWriter<string> | null,
): void {
  if (!writer) {
    return;
  }

  try {
    writer.releaseLock();
  } catch {
    // The stream may already be closed after a process exits or is killed.
  }
}

function safelyKillProcess(process: WebContainerProcess | null): void {
  if (!process) {
    return;
  }

  try {
    process.kill();
  } catch {
    // Killing an already-exited WebContainer process is harmless.
  }
}

export function useWebContainerRuntimeSession({
  environmentVariables,
  onTerminalOutput,
}: UseWebContainerRuntimeSessionOptions) {
  const instanceRef = useRef<WebContainer | null>(null);
  const foregroundProcessesRef = useRef<Set<WebContainerProcess>>(new Set());
  const runnerProcessRef = useRef<WebContainerProcess | null>(null);
  const runnerStartIdRef = useRef(0);
  const terminalSessionsRef = useRef<TerminalSessionHandle[]>([]);
  const terminalSessionCounterRef = useRef(0);
  const terminalSizeRef = useRef({ cols: 96, rows: 18 });
  const runtimeGenerationRef = useRef(0);
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
  const activeTerminalSessionIdRef = useRef<string | null>(null);
  const activeCommandRef = useRef<string | null>(null);
  const onTerminalOutputRef = useRef(onTerminalOutput);
  const statusRef = useRef<WebContainerRuntimeStatus>("idle");
  const [status, setStatusState] = useState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, setPreviewUrlState] = useState<string | null>(null);
  const [errorMessage, setErrorMessageState] = useState<string | null>(null);
  const [latestPreviewMessage, setLatestPreviewMessage] =
    useState<RuntimePreviewMessage | null>(null);
  const [openPorts, setOpenPorts] = useState<RuntimePort[]>([]);
  const [latestLifecycleEvent, setLatestLifecycleEvent] =
    useState<RuntimeLifecycleEvent | null>(null);
  const [lastOutput, setLastOutputState] = useState<string | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<
    RuntimeTerminalSessionSnapshot[]
  >([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<
    string | null
  >(null);
  const [activeCommand, setActiveCommandState] = useState<string | null>(null);

  previewUrlRef.current = previewUrl;
  errorMessageRef.current = errorMessage;
  lastOutputRef.current = lastOutput;
  activeTerminalSessionIdRef.current = activeTerminalSessionId;
  activeCommandRef.current = activeCommand;
  onTerminalOutputRef.current = onTerminalOutput;
  statusRef.current = status;

  const isRuntimeGenerationActive = useCallback(
    (generation: number) =>
      isMountedRef.current && runtimeGenerationRef.current === generation,
    [],
  );

  const getRuntimeGeneration = useCallback(
    () => runtimeGenerationRef.current,
    [],
  );

  const setStatus = useCallback((nextStatus: WebContainerRuntimeStatus) => {
    statusRef.current = nextStatus;
    setStatusState(nextStatus);
  }, []);

  const setPreviewUrl = useCallback((nextPreviewUrl: string | null) => {
    previewUrlRef.current = nextPreviewUrl;
    setPreviewUrlState(nextPreviewUrl);
  }, []);

  const setErrorMessage = useCallback((nextErrorMessage: string | null) => {
    errorMessageRef.current = nextErrorMessage;
    setErrorMessageState(nextErrorMessage);
  }, []);

  const setLastOutput = useCallback((nextOutput: string | null) => {
    lastOutputRef.current = nextOutput;
    setLastOutputState(nextOutput);
  }, []);

  const setActiveCommand = useCallback((nextCommand: string | null) => {
    activeCommandRef.current = nextCommand;
    setActiveCommandState(nextCommand);
  }, []);

  const appendOutput = useCallback(
    (chunk: string, options?: { logToConsole?: boolean }) => {
      const sanitizedChunk = sanitizeTerminalChunk(chunk);

      if (!sanitizedChunk) {
        return;
      }

      if (options?.logToConsole) {
        console.log("[runner]", sanitizedChunk);
      }

      setLastOutput(
        `${lastOutputRef.current ?? ""}${sanitizedChunk}`.slice(
          -RUNNER_OUTPUT_LIMIT,
        ),
      );
    },
    [setLastOutput],
  );

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

    const terminalSession = terminalSessionsRef.current.find(
      (entry) => entry.id === sessionId,
    );

    if (!terminalSession) {
      return;
    }

    const nextOutput = `${terminalSession.output}${chunk}`.slice(
      -TERMINAL_OUTPUT_LIMIT,
    );
    terminalSession.output = nextOutput;

    setTerminalSessions((current) =>
      current.map((session) => {
        return {
          ...session,
          output: session.id === sessionId ? nextOutput : session.output,
        };
      }),
    );

    onTerminalOutputRef.current?.();
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
      startPromise: null,
    };
  }, []);

  const stopForegroundProcesses = useCallback(() => {
    for (const process of foregroundProcessesRef.current) {
      safelyKillProcess(process);
    }

    foregroundProcessesRef.current.clear();
  }, []);

  const stopRunnerProcess = useCallback(
    async (options?: { waitForExit?: boolean }) => {
      const process = runnerProcessRef.current;

      if (!process) {
        return;
      }

      runnerProcessRef.current = null;
      const exitPromise = process.exit.catch(() => undefined);
      safelyKillProcess(process);

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
      safelyReleaseWriter(session.inputWriter);
      session.inputWriter = null;
      session.startPromise = null;

      if (!session.process) {
        continue;
      }

      const process = session.process;
      session.process = null;
      safelyKillProcess(process);
    }
  }, []);

  const resetRuntimeSession = useCallback(() => {
    runtimeGenerationRef.current += 1;
    runnerStartIdRef.current += 1;
    stopForegroundProcesses();
    void stopRunnerProcess();
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
  }, [
    setActiveCommand,
    setErrorMessage,
    setLastOutput,
    setPreviewUrl,
    setStatus,
    stopForegroundProcesses,
    stopRunnerProcess,
    stopTerminalProcess,
  ]);

  const bootInstance = useCallback(async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const generation = runtimeGenerationRef.current;
    const instance = await getOrBootSharedWebContainer();

    if (!isRuntimeGenerationActive(generation)) {
      return instance;
    }

    instanceRef.current = instance;

    devServerListenerCleanupRef.current?.();
    devServerListenerCleanupRef.current = instance.on(
      "server-ready",
      (_port, url) => {
        if (
          !isRuntimeGenerationActive(generation) ||
          instanceRef.current !== instance
        ) {
          return;
        }

        if (!runnerProcessRef.current) {
          return;
        }

        setPreviewUrl(url);
        setStatus("ready");
      },
    );

    portListenerCleanupRef.current?.();
    portListenerCleanupRef.current = instance.on("port", (port, type, url) => {
      if (
        !isRuntimeGenerationActive(generation) ||
        instanceRef.current !== instance
      ) {
        return;
      }

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
      if (
        !isRuntimeGenerationActive(generation) ||
        instanceRef.current !== instance
      ) {
        return;
      }

      const message = getRuntimeErrorMessage(error);

      console.error("[runtime] WebContainer error", error);

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
        if (
          !isRuntimeGenerationActive(generation) ||
          instanceRef.current !== instance
        ) {
          return;
        }

        setLatestPreviewMessage({
          id: ++previewMessageIdRef.current,
          ...formatPreviewMessage(message),
        });
      },
    );

    return instance;
  }, [
    isRuntimeGenerationActive,
    pushLifecycleEvent,
    setErrorMessage,
    setPreviewUrl,
    setStatus,
  ]);

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

      appendOutput(`$ ${commandLine}\n`, { logToConsole: true });

      if (options.trackAsActiveCommand) {
        setActiveCommand(commandLine);
      }

      const generation = runtimeGenerationRef.current;
      let process: WebContainerProcess | null = null;

      try {
        process = await instance.spawn(
          parsedCommand.command,
          parsedCommand.args,
          Object.keys(environmentVariables).length > 0
            ? { env: environmentVariables }
            : undefined,
        );

        if (!isRuntimeGenerationActive(generation)) {
          safelyKillProcess(process);
          return 0;
        }

        foregroundProcessesRef.current.add(process);
        const outputPipe = process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              if (isRuntimeGenerationActive(generation)) {
                appendOutput(chunk, { logToConsole: true });
              }
            },
          }),
        ).catch((error) => {
          if (
            isRuntimeGenerationActive(generation) &&
            foregroundProcessesRef.current.has(process!)
          ) {
            console.error("[runner] Command output stream error", error);
            appendOutput(`\n${getRuntimeErrorMessage(error)}\n`, {
              logToConsole: true,
            });
          }
        });
        void outputPipe;

        const exitCode = await process.exit;

        foregroundProcessesRef.current.delete(process);

        if (!isRuntimeGenerationActive(generation)) {
          return 0;
        }

        appendOutput(`\nCommand exited with code ${exitCode}\n`, {
          logToConsole: true,
        });

        if (exitCode !== 0) {
          console.log("[runner]", formatCommandError(commandLine));
        }

        return exitCode;
      } catch (error) {
        if (isRuntimeGenerationActive(generation)) {
          console.log("[runner]", getRuntimeErrorMessage(error), error);
          appendOutput(`\n${getRuntimeErrorMessage(error)}\n`, {
            logToConsole: true,
          });
        }
        return -1;
      } finally {
        if (process) {
          foregroundProcessesRef.current.delete(process);
        }

        if (options.trackAsActiveCommand) {
          if (isRuntimeGenerationActive(generation)) {
            setActiveCommand(null);
          }
        }
      }
    },
    [
      appendOutput,
      environmentVariables,
      isRuntimeGenerationActive,
      setActiveCommand,
      setLastOutput,
    ],
  );

  const startRunnerProcess = useCallback(
    async (instance: WebContainer, commandLine: string) => {
      const startId = ++runnerStartIdRef.current;
      const generation = runtimeGenerationRef.current;
      const parsedCommand = parseCommand(commandLine);

      if (!parsedCommand) {
        setStatus("ready");
        return;
      }

      await stopRunnerProcess({ waitForExit: true });

      if (
        startId !== runnerStartIdRef.current ||
        !isRuntimeGenerationActive(generation)
      ) {
        return;
      }

      setPreviewUrl(null);
      setErrorMessage(null);
      setLastOutput(null);
      setStatus("starting");
      appendOutput(`$ ${commandLine}\n`, { logToConsole: true });

      try {
        const process = await instance.spawn(
          parsedCommand.command,
          parsedCommand.args,
          Object.keys(environmentVariables).length > 0
            ? { env: environmentVariables }
            : undefined,
        );

        if (
          startId !== runnerStartIdRef.current ||
          !isRuntimeGenerationActive(generation)
        ) {
          safelyKillProcess(process);
          return;
        }

        runnerProcessRef.current = process;

        void process.output.pipeTo(
          new WritableStream({
            write(chunk) {
              if (
                runnerProcessRef.current === process &&
                startId === runnerStartIdRef.current &&
                isRuntimeGenerationActive(generation)
              ) {
                appendOutput(chunk, { logToConsole: true });
              }
            },
          }),
        ).catch((error) => {
          if (
            runnerProcessRef.current !== process ||
            startId !== runnerStartIdRef.current ||
            !isRuntimeGenerationActive(generation)
          ) {
            return;
          }

          console.error("[runner] Runner output stream error", error);
          runnerProcessRef.current = null;
          setPreviewUrl(null);
          setStatus("error");
          setErrorMessage(getRuntimeErrorMessage(error));
        });

        void process.exit
          .then((exitCode) => {
            if (
              runnerProcessRef.current !== process ||
              startId !== runnerStartIdRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            runnerProcessRef.current = null;
            setPreviewUrl(null);
            appendOutput(`\nRunner exited with code ${exitCode}\n`, {
              logToConsole: true,
            });

            if (exitCode !== 0) {
              console.error("[runner]", formatCommandError(commandLine));
              setStatus("error");
              setErrorMessage(formatCommandError(commandLine));
            }
          })
          .catch((error) => {
            if (
              runnerProcessRef.current !== process ||
              startId !== runnerStartIdRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            runnerProcessRef.current = null;
            setPreviewUrl(null);
            console.error("[runner] Runner process error", error);
            setStatus("error");
            setErrorMessage(getRuntimeErrorMessage(error));
          });
      } catch (error) {
        if (
          startId !== runnerStartIdRef.current ||
          !isRuntimeGenerationActive(generation)
        ) {
          return;
        }

        console.error("[runner] Failed to start runner process", error);
        setStatus("error");
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    },
    [
      appendOutput,
      environmentVariables,
      isRuntimeGenerationActive,
      setErrorMessage,
      setLastOutput,
      setPreviewUrl,
      setStatus,
      stopRunnerProcess,
    ],
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

      if (session.startPromise) {
        return session.startPromise;
      }

      const generation = runtimeGenerationRef.current;
      const startPromise = (async () => {
        let lastError: unknown = null;

        for (const candidate of TERMINAL_SHELL_CANDIDATES) {
          let process: WebContainerProcess | null = null;

          try {
            process = await instance.spawn(
              candidate.command,
              [...candidate.args],
              {
                env: environmentVariables,
                terminal: terminalSizeRef.current,
              },
            );

            const currentSession = terminalSessionsRef.current.find(
              (entry) => entry.id === sessionId,
            );

            if (
              currentSession !== session ||
              !isRuntimeGenerationActive(generation)
            ) {
              safelyKillProcess(process);
              throw new Error("Terminal session was closed before it started.");
            }

            const inputWriter = process.input.getWriter();
            session.process = process;
            session.inputWriter = inputWriter;

            void process.output
              .pipeTo(
                new WritableStream({
                  write(chunk) {
                    const activeSession = terminalSessionsRef.current.find(
                      (entry) => entry.id === sessionId,
                    );

                    if (
                      activeSession?.process === process &&
                      isRuntimeGenerationActive(generation)
                    ) {
                      appendTerminalOutput(sessionId, chunk);
                    }
                  },
                }),
              )
              .catch((error) => {
                const activeSession = terminalSessionsRef.current.find(
                  (entry) => entry.id === sessionId,
                );

                if (
                  activeSession?.process !== process ||
                  !isRuntimeGenerationActive(generation)
                ) {
                  return;
                }

                appendTerminalOutput(
                  sessionId,
                  `\n${getRuntimeErrorMessage(error)}\n`,
                );
              });

            void process.exit
              .then((exitCode) => {
                const currentSession = terminalSessionsRef.current.find(
                  (entry) => entry.id === sessionId,
                );

                if (
                  !currentSession ||
                  currentSession.process !== process ||
                  !isRuntimeGenerationActive(generation)
                ) {
                  return;
                }

                safelyReleaseWriter(currentSession.inputWriter);
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

                if (
                  !currentSession ||
                  currentSession.process !== process ||
                  !isRuntimeGenerationActive(generation)
                ) {
                  return;
                }

                safelyReleaseWriter(currentSession.inputWriter);
                currentSession.inputWriter = null;
                currentSession.process = null;
                appendTerminalOutput(
                  sessionId,
                  `\n${getRuntimeErrorMessage(error)}\n`,
                );
              });

            return session;
          } catch (error) {
            if (process && session.process !== process) {
              safelyKillProcess(process);
            }

            lastError = error;
          }
        }

        throw lastError ?? new Error("Unable to start the workspace shell.");
      })();

      session.startPromise = startPromise;

      try {
        return await startPromise;
      } finally {
        if (session.startPromise === startPromise) {
          session.startPromise = null;
        }
      }
    },
    [appendTerminalOutput, environmentVariables, isRuntimeGenerationActive],
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
    [
      createTerminalSessionHandle,
      ensureTerminalProcess,
      setActiveTerminalSession,
      syncTerminalSessions,
    ],
  );

  const createTerminalSession = useCallback(
    async (instance: WebContainer) => {
      const session = createTerminalSessionHandle();
      terminalSessionsRef.current = [...terminalSessionsRef.current, session];
      syncTerminalSessions();
      setActiveTerminalSession(session.id);
      await ensureTerminalProcess(instance, session.id);
    },
    [
      createTerminalSessionHandle,
      ensureTerminalProcess,
      setActiveTerminalSession,
      syncTerminalSessions,
    ],
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
    },
    [
      setActiveTerminalSession,
      stopTerminalProcess,
      syncTerminalSessions,
    ],
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
      try {
        session.process?.resize(size);
      } catch {
        // Ignore resize calls racing with process shutdown.
      }
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
    getRuntimeGeneration,
    hasActiveRunner,
    instanceRef,
    isRuntimeGenerationActive,
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
    terminalSessions,
    writeTerminalInput,
  };
}
