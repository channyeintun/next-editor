import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import type {
  EnvironmentVariables,
  RuntimeLifecycleEvent,
  RuntimePreviewMessage,
  WebContainerRuntimeRecordingSnapshot,
  WebContainerRuntimeStatus,
} from "./WebContainerRuntimeContext";
import type { RuntimeTerminalSessionSnapshot } from "../types/runtime";
import {
  formatCommandError,
  parseCommand,
  TERMINAL_SHELL_CANDIDATES,
} from "../runtime/webcontainer/commands";
import {
  formatPreviewMessage,
  getRuntimeErrorMessage,
  sanitizeTerminalChunk,
} from "../runtime/webcontainer/console";
import {
  getOrBootSharedWebContainer,
  teardownSharedWebContainer,
} from "../runtime/webcontainer/sharedContainer";

interface UseWebContainerRuntimeSessionOptions {
  environmentVariables: EnvironmentVariables;
  onTerminalOutput?: () => void;
  onServerReady?: () => void;
}

const RUNNER_OUTPUT_LIMIT = 6000;
const TERMINAL_OUTPUT_LIMIT = 50000;

interface TerminalSessionHandle extends RuntimeTerminalSessionSnapshot {
  inputWriter: WritableStreamDefaultWriter<string> | null;
  process: WebContainerProcess | null;
  /** Resolves to null when the session was closed or reset while its shell spawned. */
  startPromise: Promise<TerminalSessionHandle | null> | null;
}

/** Passes the user's environment variables to a spawned process, when there are any. */
function getSpawnOptions(environmentVariables: EnvironmentVariables) {
  return Object.keys(environmentVariables).length > 0 ? { env: environmentVariables } : undefined;
}

function toTerminalSessionSnapshots(
  sessions: TerminalSessionHandle[],
): RuntimeTerminalSessionSnapshot[] {
  return sessions.map(({ id, output, title }) => ({ id, output, title }));
}

function safelyReleaseWriter(writer: WritableStreamDefaultWriter<string> | null): void {
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

function safelyResizeProcess(
  process: WebContainerProcess | null,
  size: { cols: number; rows: number },
): void {
  if (!process) {
    return;
  }

  try {
    process.resize(size);
  } catch {
    // Ignore resize calls racing with process shutdown.
  }
}

/**
 * Awaits `task`, turns a failure into `onError`'s result, and always runs
 * `cleanup`. The try blocks live in module-level helpers like this one because
 * the React Compiler skips a hook containing a try/finally, and a hook it skips
 * hands the runtime provider new functions on every render.
 */
async function settleWithCleanup<T>(
  task: () => Promise<T>,
  onError: (error: unknown) => T,
  cleanup: () => void,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    return onError(error);
  } finally {
    cleanup();
  }
}

/**
 * useState plus a ref that its setter writes at the moment of the change, so
 * getRecordingSnapshot, the provider's busy checks and the async process and
 * container callbacks read the new value before React renders it. Write the
 * value only through the setter, which keeps the two in step.
 */
function useMirroredState<T>(initialValue: T) {
  const ref = useRef(initialValue);
  const [value, setValue] = useState(initialValue);

  const set = (nextValue: T) => {
    ref.current = nextValue;
    setValue(nextValue);
  };

  return [value, ref, set] as const;
}

export function useWebContainerRuntimeSession({
  environmentVariables,
  onTerminalOutput,
  onServerReady,
}: UseWebContainerRuntimeSessionOptions) {
  const instanceRef = useRef<WebContainer | null>(null);
  const foregroundProcessesRef = useRef<Set<WebContainerProcess>>(new Set());
  const runnerProcessRef = useRef<WebContainerProcess | null>(null);
  const runnerStartIdRef = useRef(0);
  const terminalSessionsRef = useRef<TerminalSessionHandle[]>([]);
  const terminalSessionCounterRef = useRef(0);
  const terminalSizeRef = useRef({ cols: 96, rows: 18 });
  const runtimeGenerationRef = useRef(0);
  // Unsubscribers for the listeners bootInstance adds to the current instance.
  const instanceListenersRef = useRef<Array<() => void>>([]);
  const lifecycleEventIdRef = useRef(0);
  const previewMessageIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const onTerminalOutputRef = useRef(onTerminalOutput);
  const onServerReadyRef = useRef(onServerReady);
  const [status, statusRef, setStatus] = useMirroredState<WebContainerRuntimeStatus>("idle");
  const [previewUrl, previewUrlRef, setPreviewUrl] = useMirroredState<string | null>(null);
  const [previewPort, previewPortRef, setPreviewPort] = useMirroredState<number | null>(null);
  const [errorMessage, errorMessageRef, setErrorMessage] = useMirroredState<string | null>(null);
  const [latestPreviewMessage, latestPreviewMessageRef, setLatestPreviewMessage] =
    useMirroredState<RuntimePreviewMessage | null>(null);
  const [latestLifecycleEvent, latestLifecycleEventRef, setLatestLifecycleEvent] =
    useMirroredState<RuntimeLifecycleEvent | null>(null);
  const [lastOutput, lastOutputRef, setLastOutput] = useMirroredState<string | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<RuntimeTerminalSessionSnapshot[]>([]);
  const [activeTerminalSessionId, activeTerminalSessionIdRef, setActiveTerminalSession] =
    useMirroredState<string | null>(null);
  const [activeCommand, activeCommandRef, setActiveCommand] = useMirroredState<string | null>(null);

  // The callbacks are read only from async process and container events, so a
  // layout effect keeps them current.
  useLayoutEffect(() => {
    onTerminalOutputRef.current = onTerminalOutput;
    onServerReadyRef.current = onServerReady;
  });

  const isRuntimeGenerationActive = (generation: number) =>
    isMountedRef.current && runtimeGenerationRef.current === generation;

  const getRuntimeGeneration = () => runtimeGenerationRef.current;

  /**
   * Shows a failure in the runner console, unless a reset has replaced the
   * runtime `generation` it happened in since.
   */
  const reportErrorFor = (generation: number) => (error: unknown) => {
    if (isRuntimeGenerationActive(generation)) {
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  };

  // Runner output is mirrored to the browser console for local debugging;
  // session replay never records it (POSTHOG_REPLAY_PRIVACY_OPTIONS).
  const appendOutput = (chunk: string) => {
    const sanitizedChunk = sanitizeTerminalChunk(chunk);

    if (!sanitizedChunk) {
      return;
    }

    const consoleChunk = sanitizedChunk.trim();

    if (consoleChunk) {
      console.log("[runner]", consoleChunk);
    }

    setLastOutput(`${lastOutputRef.current ?? ""}${sanitizedChunk}`.slice(-RUNNER_OUTPUT_LIMIT));
  };

  const syncTerminalSessions = () => {
    setTerminalSessions(toTerminalSessionSnapshots(terminalSessionsRef.current));
  };

  const findTerminalSession = (sessionId: string | null) =>
    terminalSessionsRef.current.find((entry) => entry.id === sessionId);

  const appendTerminalOutput = (sessionId: string, chunk: string) => {
    if (!chunk) {
      return;
    }

    const terminalSession = findTerminalSession(sessionId);

    if (!terminalSession) {
      return;
    }

    const nextOutput = `${terminalSession.output}${chunk}`.slice(-TERMINAL_OUTPUT_LIMIT);
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
  };

  const pushLifecycleEvent = (event: Omit<RuntimeLifecycleEvent, "id">) => {
    setLatestLifecycleEvent({
      id: ++lifecycleEventIdRef.current,
      ...event,
    });
  };

  const createTerminalSessionHandle = (): TerminalSessionHandle => {
    terminalSessionCounterRef.current += 1;

    return {
      id: `terminal-${terminalSessionCounterRef.current}`,
      title: "Terminal",
      output: "",
      inputWriter: null,
      process: null,
      startPromise: null,
    };
  };

  const stopForegroundProcesses = () => {
    for (const process of foregroundProcessesRef.current) {
      safelyKillProcess(process);
    }

    foregroundProcessesRef.current.clear();
  };

  const stopRunnerProcess = async (options?: { waitForExit?: boolean }) => {
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
  };

  const stopTerminalProcess = (sessionId?: string) => {
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
  };

  /**
   * Empties the runner console without touching the running process, the
   * WebContainer, or the terminal sessions — the Clear button, not a reset.
   * The error message goes with it: it is rendered into the same console box
   * (see TerminalPanel's rawContent), so leaving it behind would clear the
   * output and keep a stale failure on screen.
   */
  const clearRunnerOutput = () => {
    setLastOutput(null);
    setErrorMessage(null);
  };

  const resetRuntimeSession = () => {
    runtimeGenerationRef.current += 1;
    runnerStartIdRef.current += 1;
    stopForegroundProcesses();
    void stopRunnerProcess();
    stopTerminalProcess();
    terminalSessionsRef.current = [];
    removeInstanceListeners();
    teardownSharedWebContainer(instanceRef.current);
    instanceRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setPreviewPort(null);
    setErrorMessage(null);
    setLatestPreviewMessage(null);
    setLatestLifecycleEvent(null);
    setLastOutput(null);
    setTerminalSessions([]);
    setActiveTerminalSession(null);
    setActiveCommand(null);
  };

  const removeInstanceListeners = () => {
    for (const unsubscribe of instanceListenersRef.current.splice(0)) {
      unsubscribe();
    }
  };

  const bootInstance = async () => {
    if (instanceRef.current) {
      return instanceRef.current;
    }

    const generation = runtimeGenerationRef.current;
    const instance = await getOrBootSharedWebContainer();

    if (!isRuntimeGenerationActive(generation)) {
      return instance;
    }

    instanceRef.current = instance;
    removeInstanceListeners();

    const onServerReady = instance.on("server-ready", (port, url) => {
      if (!isRuntimeGenerationActive(generation) || instanceRef.current !== instance) {
        return;
      }

      if (!runnerProcessRef.current) {
        return;
      }

      setPreviewPort(port);
      setPreviewUrl(url);
      setStatus("ready");
      onServerReadyRef.current?.();
    });

    const onPort = instance.on("port", (port, type, url) => {
      if (!isRuntimeGenerationActive(generation) || instanceRef.current !== instance) {
        return;
      }

      pushLifecycleEvent({
        kind: type === "open" ? "port-open" : "port-close",
        text: type === "open" ? `Port ${port} opened` : `Port ${port} closed`,
        port,
        url,
      });
    });

    const onError = instance.on("error", (error) => {
      if (!isRuntimeGenerationActive(generation) || instanceRef.current !== instance) {
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

    const onPreviewMessage = instance.on("preview-message", (message) => {
      if (!isRuntimeGenerationActive(generation) || instanceRef.current !== instance) {
        return;
      }

      setLatestPreviewMessage({
        id: ++previewMessageIdRef.current,
        ...formatPreviewMessage(message),
      });
    });

    instanceListenersRef.current = [onServerReady, onPort, onError, onPreviewMessage];
    return instance;
  };

  const runForegroundCommand = async (
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

    const generation = runtimeGenerationRef.current;
    let process: WebContainerProcess | null = null;

    const runToExit = async () => {
      const spawned = await instance.spawn(
        parsedCommand.command,
        parsedCommand.args,
        getSpawnOptions(environmentVariables),
      );
      process = spawned;

      if (!isRuntimeGenerationActive(generation)) {
        safelyKillProcess(spawned);
        return 0;
      }

      foregroundProcessesRef.current.add(spawned);
      void spawned.output
        .pipeTo(
          new WritableStream({
            write(chunk) {
              if (isRuntimeGenerationActive(generation)) {
                appendOutput(chunk);
              }
            },
          }),
          // The process lifecycle owns shutdown (via process.kill()). Allowing
          // pipeTo to cancel the source during teardown races WebContainer's
          // own reader cleanup, which can try to cancel an already-released
          // reader.
          { preventCancel: true },
        )
        .catch((error) => {
          if (
            isRuntimeGenerationActive(generation) &&
            foregroundProcessesRef.current.has(spawned)
          ) {
            console.error("[runner] Command output stream error", error);
            appendOutput(`\n${getRuntimeErrorMessage(error)}\n`);
          }
        });

      const exitCode = await spawned.exit;

      // Removed here, not only in the cleanup, so a late output-stream error
      // is not printed after "Command exited".
      foregroundProcessesRef.current.delete(spawned);

      if (!isRuntimeGenerationActive(generation)) {
        return 0;
      }

      appendOutput(`\nCommand exited with code ${exitCode}\n`);

      if (exitCode !== 0) {
        console.log("[runner]", formatCommandError(commandLine));
      }

      return exitCode;
    };

    return settleWithCleanup(
      runToExit,
      (error) => {
        if (isRuntimeGenerationActive(generation)) {
          console.log("[runner]", getRuntimeErrorMessage(error), error);
          appendOutput(`\n${getRuntimeErrorMessage(error)}\n`);
        }
        return -1;
      },
      () => {
        if (process) {
          foregroundProcessesRef.current.delete(process);
        }

        if (options.trackAsActiveCommand && isRuntimeGenerationActive(generation)) {
          setActiveCommand(null);
        }
      },
    );
  };

  /** The runner's output stream or process failed: drop the runner and show why. */
  const failRunner = (label: string, error: unknown) => {
    console.error(label, error);
    runnerProcessRef.current = null;
    setPreviewUrl(null);
    setPreviewPort(null);
    setStatus("error");
    setErrorMessage(getRuntimeErrorMessage(error));
  };

  const startRunnerProcess = async (instance: WebContainer, commandLine: string) => {
    const startId = ++runnerStartIdRef.current;
    const generation = runtimeGenerationRef.current;
    // Neither a later start nor a reset has superseded this start.
    const isCurrentStart = () =>
      startId === runnerStartIdRef.current && isRuntimeGenerationActive(generation);
    // The runner is still `runner`, and this start is still current.
    const isCurrentRunner = (runner: WebContainerProcess) =>
      runnerProcessRef.current === runner && isCurrentStart();
    const parsedCommand = parseCommand(commandLine);

    if (!parsedCommand) {
      setStatus("ready");
      return;
    }

    await stopRunnerProcess({ waitForExit: true });

    if (!isCurrentStart()) {
      return;
    }

    setPreviewUrl(null);
    setPreviewPort(null);
    setErrorMessage(null);
    setLastOutput(null);
    setStatus("starting");
    appendOutput(`$ ${commandLine}\n`);

    const spawnOptions = getSpawnOptions(environmentVariables);
    let process: WebContainerProcess;

    try {
      process = await instance.spawn(parsedCommand.command, parsedCommand.args, spawnOptions);
    } catch (error) {
      if (!isCurrentStart()) {
        return;
      }

      console.error("[runner] Failed to start runner process", error);
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
      return;
    }

    if (!isCurrentStart()) {
      safelyKillProcess(process);
      return;
    }

    runnerProcessRef.current = process;

    void process.output
      .pipeTo(
        new WritableStream({
          write(chunk) {
            if (isCurrentRunner(process)) {
              appendOutput(chunk);
            }
          },
        }),
        // process.kill(), not this consumer, owns the output stream's
        // cancellation; see the matching foreground-command pipe above.
        { preventCancel: true },
      )
      .catch((error) => {
        if (isCurrentRunner(process)) {
          failRunner("[runner] Runner output stream error", error);
        }
      });

    void process.exit
      .then((exitCode) => {
        if (!isCurrentRunner(process)) {
          return;
        }

        runnerProcessRef.current = null;
        setPreviewUrl(null);
        setPreviewPort(null);
        appendOutput(`\nRunner exited with code ${exitCode}\n`);

        if (exitCode !== 0) {
          console.error("[runner]", formatCommandError(commandLine));
          setStatus("error");
          setErrorMessage(formatCommandError(commandLine));
        } else {
          // Script-style runners (e.g. python lessons) exit cleanly instead
          // of keeping a server alive, so no `server-ready` event will ever
          // move the status off "starting" — settle it here.
          setStatus("ready");
        }
      })
      .catch((error) => {
        if (isCurrentRunner(process)) {
          failRunner("[runner] Runner process error", error);
        }
      });
  };

  const ensureTerminalProcess = async (
    instance: WebContainer,
    sessionId: string,
  ): Promise<TerminalSessionHandle | null> => {
    const session = findTerminalSession(sessionId);

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
    // The shell `process` exited or failed: release the session's input, drop
    // the process and say why, unless the session has since been closed, runs
    // another shell or belongs to a reset runtime.
    const endTerminalProcess = (process: WebContainerProcess, message: string) => {
      const currentSession = findTerminalSession(sessionId);

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
      appendTerminalOutput(sessionId, message);
    };
    const startShell = async () => {
      let lastError: unknown = null;

      for (const candidate of TERMINAL_SHELL_CANDIDATES) {
        let process: WebContainerProcess;

        try {
          process = await instance.spawn(candidate.command, [...candidate.args], {
            env: environmentVariables,
            terminal: terminalSizeRef.current,
          });
        } catch (error) {
          // This shell is not in the container image; try the next one.
          lastError = error;
          continue;
        }

        const currentSession = findTerminalSession(sessionId);

        if (currentSession !== session || !isRuntimeGenerationActive(generation)) {
          // Closed or reset while the shell spawned: a cancellation, not a
          // failure, so no other shell and nothing to report.
          safelyKillProcess(process);
          return null;
        }

        const inputWriter = process.input.getWriter();
        session.process = process;
        session.inputWriter = inputWriter;

        void process.output
          .pipeTo(
            new WritableStream({
              write(chunk) {
                const activeSession = findTerminalSession(sessionId);

                if (activeSession?.process === process && isRuntimeGenerationActive(generation)) {
                  appendTerminalOutput(sessionId, chunk);
                }
              },
            }),
            // Closing a terminal kills its process. Do not also have
            // pipeTo cancel the WebContainer stream during that teardown.
            { preventCancel: true },
          )
          .catch((error) => {
            const activeSession = findTerminalSession(sessionId);

            if (activeSession?.process !== process || !isRuntimeGenerationActive(generation)) {
              return;
            }

            appendTerminalOutput(sessionId, `\n${getRuntimeErrorMessage(error)}\n`);
          });

        void process.exit
          .then((exitCode) =>
            endTerminalProcess(process, `\nTerminal exited with code ${exitCode}\n`),
          )
          .catch((error) => endTerminalProcess(process, `\n${getRuntimeErrorMessage(error)}\n`));

        return session;
      }

      throw lastError ?? new Error("Unable to start the workspace shell.");
    };

    const startPromise: Promise<TerminalSessionHandle | null> = startShell().finally(() => {
      if (session.startPromise === startPromise) {
        session.startPromise = null;
      }
    });
    session.startPromise = startPromise;
    return startPromise;
  };

  const ensureTerminalSession = async (instance: WebContainer) => {
    let session = findTerminalSession(activeTerminalSessionIdRef.current);

    if (!session) {
      session = createTerminalSessionHandle();
      terminalSessionsRef.current = [...terminalSessionsRef.current, session];
      syncTerminalSessions();
      setActiveTerminalSession(session.id);
    }

    return ensureTerminalProcess(instance, session.id);
  };

  const createTerminalSession = async (instance: WebContainer) => {
    const session = createTerminalSessionHandle();
    terminalSessionsRef.current = [...terminalSessionsRef.current, session];
    syncTerminalSessions();
    setActiveTerminalSession(session.id);
    await ensureTerminalProcess(instance, session.id);
  };

  const closeTerminalSession = (sessionId: string) => {
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

    const fallbackSession = nextSessions[sessionIndex] ?? nextSessions[sessionIndex - 1] ?? null;

    setActiveTerminalSession(fallbackSession?.id ?? null);
  };

  const writeTerminalInput = async (instance: WebContainer, input: string) => {
    const session = await ensureTerminalSession(instance);
    await session?.inputWriter?.write(input);
  };

  const resizeTerminal = (size: { cols: number; rows: number }) => {
    terminalSizeRef.current = size;

    for (const session of terminalSessionsRef.current) {
      safelyResizeProcess(session.process, size);
    }
  };

  const hasActiveRunner = () => runnerProcessRef.current !== null;

  const getRecordingSnapshot = (): WebContainerRuntimeRecordingSnapshot => ({
    status: statusRef.current,
    previewUrl: previewUrlRef.current,
    previewPort: previewPortRef.current,
    lastOutput: lastOutputRef.current,
    activeCommand: activeCommandRef.current,
    errorMessage: errorMessageRef.current,
    terminalSessions: toTerminalSessionSnapshots(terminalSessionsRef.current),
    activeTerminalSessionId: activeTerminalSessionIdRef.current,
    latestPreviewMessage: latestPreviewMessageRef.current,
    latestLifecycleEvent: latestLifecycleEventRef.current,
  });

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
    clearRunnerOutput,
    createTerminalSession,
    ensureTerminalSession,
    errorMessage,
    getRecordingSnapshot,
    getRuntimeGeneration,
    hasActiveRunner,
    instanceRef,
    isRuntimeGenerationActive,
    lastOutput,
    latestLifecycleEvent,
    latestPreviewMessage,
    previewUrl,
    previewPort,
    reportErrorFor,
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
