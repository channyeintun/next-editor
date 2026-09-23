import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { WebContainer } from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeSnapshotGetterContext,
  WebContainerRuntimeSaveWorkspaceContext,
  type EnvironmentVariables,
  type RunnerConfig,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
} from "./WebContainerRuntimeContext";
import {
  DEFAULT_RUNNER_CONFIG,
  formatCommandError,
  getRuntimeErrorMessage,
  holdSharedWebContainer,
  resolveRuntimeRunCommand,
  isRuntimeBusy,
  isWebContainerRuntimeSupported,
  loadStoredEnvironmentVariables,
  normalizeEnvironmentVariables,
  persistEnvironmentVariables,
  readWorkspaceProject,
} from "./webContainerRuntimeSupport";
import {
  useWorkspaceFileCount,
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceProjectId,
} from "../hooks/useWorkspace";
import type { WorkspaceSyncMutation } from "./WorkspaceContext";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";
import { isMobileBrowser } from "../utils/isMobileBrowser";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import { areWorkspaceProjectsEqual, lessonRunsInWebContainer } from "../types/workspace";

/**
 * Awaits `task` and hands a failure to `onError` instead of rejecting.
 * Module-level because the React Compiler skips a component whose try/catch
 * holds conditional or logical expressions.
 */
async function reportFailure(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    onError(error);
  }
}

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
  allowAmbientStart?: boolean;
}

export const WebContainerRuntimeProvider: React.FC<WebContainerRuntimeProviderProps> = ({
  children,
  allowAmbientStart = true,
}) => {
  const { getProject, getWorkspaceRevision, reconcileExternalProject, subscribeWorkspaceSync } =
    useWorkspaceActions();
  const lessonType = useWorkspaceLessonType();
  const projectId = useWorkspaceProjectId();
  const fileCount = useWorkspaceFileCount();
  const hasRunInitCommandRef = useRef(false);
  // `hasRunInitCommandRef` only flips AFTER the init command finishes, so it
  // cannot deduplicate callers that arrive *during* it. Five entry points call
  // prepareRuntime and only startRuntime checks the busy status — one of them,
  // sendTerminalInput, fires per keystroke — so a Terminal click (or typing)
  // during `pnpm install` used to spawn a second install against the same
  // node_modules. Sharing the in-flight promise is what that flag was reaching
  // for; it makes every entry point join the one boot/mount/install.
  const prepareRuntimePromiseRef = useRef<{
    generation: number;
    promise: Promise<WebContainer | null>;
  } | null>(null);
  const hasAutoStartedRef = useRef(false);
  const loadedProjectIdRef = useRef<string | null>(null);
  const reverseSyncTimeoutRef = useRef<number | null>(null);
  const reverseSyncRequestRef = useRef(0);
  const reverseSyncEnabledRef = useRef(true);
  const lessonTypeRef = useRef(lessonType);
  const runnerConfigRef = useRef<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariables>(
    loadStoredEnvironmentVariables,
  );
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const {
    hasMountedProjectRef,
    ensureProjectMounted,
    flushWorkspaceSync,
    isFsWatchActive,
    queueFileSync,
    queueProjectSync,
    recordContainerProject,
    runSerializedRuntimeTask,
    resetWorkspaceSync,
  } = useWebContainerWorkspaceSync({
    // A container process changed a file our own sync didn't write — pull the
    // container filesystem back into the workspace.
    onExternalFileChange: (instance) => requestReverseSync(instance, getRuntimeGeneration()),
  });

  const requestReverseSync = (instance: WebContainer, generation: number) => {
    if (typeof window === "undefined" || !reverseSyncEnabledRef.current) {
      return;
    }

    const requestId = ++reverseSyncRequestRef.current;

    if (reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
    }

    reverseSyncTimeoutRef.current = window.setTimeout(() => {
      reverseSyncTimeoutRef.current = null;

      void (async () => {
        if (!lessonRunsInWebContainer(lessonTypeRef.current)) {
          return;
        }

        if (!isRuntimeGenerationActive(generation)) {
          return;
        }

        await flushWorkspaceSync({ instance });
        await runSerializedRuntimeTask({
          instance,
          task: async () => {
            if (
              requestId !== reverseSyncRequestRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            const workspaceRevision = getWorkspaceRevision();
            const currentProject = getProject();
            const nextProject = await readWorkspaceProject(instance, currentProject);

            if (
              requestId !== reverseSyncRequestRef.current ||
              !isRuntimeGenerationActive(generation)
            ) {
              return;
            }

            // An editor/store mutation landed while the recursive read was in
            // flight. Let its forward sync finish, then read a converged tree.
            if (workspaceRevision !== getWorkspaceRevision()) {
              requestReverseSync(instance, generation);
              return;
            }

            // The container holds nextProject, so the forward sync that the
            // reconcile below triggers must not write it back.
            recordContainerProject(instance, nextProject);
            if (!areWorkspaceProjectsEqual(currentProject, nextProject)) {
              reconcileExternalProject(nextProject);
            }
          },
        });
      })().catch((error) => {
        if (isRuntimeGenerationActive(generation)) {
          setErrorMessage(getRuntimeErrorMessage(error));
        }
      });
    }, 150);
  };

  const {
    activeCommand,
    activeTerminalSessionId,
    bootInstance,
    closeTerminalSession,
    createTerminalSession: createTerminalSessionInRuntime,
    ensureTerminalSession,
    errorMessage,
    getRecordingSnapshot,
    getRuntimeGeneration,
    hasActiveRunner,
    instanceRef,
    isRuntimeGenerationActive,
    isMountedRef,
    lastOutput,
    clearRunnerOutput,
    latestLifecycleEvent,
    latestPreviewMessage,
    previewPort,
    previewUrl,
    resetRuntimeSession,
    resizeTerminal,
    runForegroundCommand,
    setErrorMessage,
    setActiveTerminalSession,
    setStatus,
    startRunnerProcess,
    status,
    statusRef,
    terminalSessions,
    writeTerminalInput,
  } = useWebContainerRuntimeSession({
    environmentVariables,
    onTerminalOutput: () => {
      const instance = instanceRef.current;

      if (!instance) {
        return;
      }

      // With a recursive fs.watch running, terminal output is a redundant (and
      // very noisy — every log chunk) proxy for "a file may have changed"; the
      // heuristic only remains as a fallback when watch is unavailable.
      if (isFsWatchActive()) {
        return;
      }

      requestReverseSync(instance, getRuntimeGeneration());
    },
    onServerReady: () => {
      if (!lessonRunsInWebContainer(lessonTypeRef.current)) {
        return;
      }

      const instance = instanceRef.current;

      if (!instance) {
        return;
      }

      requestReverseSync(instance, getRuntimeGeneration());
    },
  });

  // Mirrored via a layout effect (not during render) so the provider stays
  // memoizable by the React Compiler — render-time ref writes bail out the whole
  // component, which made the runtime context values new objects on every render.
  // All readers are async (timeouts, command callbacks), so commit-time freshness
  // is sufficient.
  useLayoutEffect(() => {
    lessonTypeRef.current = lessonType;
    runnerConfigRef.current = runnerConfig;
  });

  const isSupported = isWebContainerRuntimeSupported();

  /** Clears a queued reverse sync; the new request ID makes one in flight return unapplied. */
  const cancelPendingReverseSync = () => {
    reverseSyncRequestRef.current += 1;
    if (typeof window !== "undefined" && reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
      reverseSyncTimeoutRef.current = null;
    }
  };

  const resetRuntime = () => {
    hasRunInitCommandRef.current = false;
    prepareRuntimePromiseRef.current = null;
    cancelPendingReverseSync();
    resetWorkspaceSync();
    resetRuntimeSession();
  };

  const setReverseSyncEnabled = (enabled: boolean) => {
    reverseSyncEnabledRef.current = enabled;
    if (!enabled) {
      cancelPendingReverseSync();
    }
  };

  const prepareRuntime = (): Promise<WebContainer | null> => {
    const generation = getRuntimeGeneration();
    const inFlight = prepareRuntimePromiseRef.current;
    if (inFlight && inFlight.generation === generation) {
      return inFlight.promise;
    }

    const promise = runPrepareRuntime(generation).finally(() => {
      if (prepareRuntimePromiseRef.current?.promise === promise) {
        prepareRuntimePromiseRef.current = null;
      }
    });
    prepareRuntimePromiseRef.current = { generation, promise };
    return promise;
  };

  const runPrepareRuntime = async (generation: number) => {
    if (!isSupported) {
      setStatus("error");
      setErrorMessage(
        isMobileBrowser()
          ? "The in-browser runtime isn't supported on mobile browsers. Open this lesson on a desktop Chromium or Firefox browser to run it."
          : "WebContainers require cross-origin isolation. Reload the app from the configured dev or deployed host.",
      );
      return null;
    }

    setErrorMessage(null);

    const instance = await bootInstance();

    if (!instance || !isMountedRef.current || !isRuntimeGenerationActive(generation)) {
      return null;
    }

    const project = getProject();

    await ensureProjectMounted({
      instance,
      project,
      onMountStart: () => setStatus("mounting"),
    });

    // The workspace may change while the initial mount promise is in flight.
    // Reconcile once at this lifecycle boundary before starting any process.
    await queueProjectSync({ instance, project: getProject() });

    if (!isRuntimeGenerationActive(generation)) {
      return null;
    }

    const initCommand = runnerConfig.initCommand.trim();
    if (!initCommand || hasRunInitCommandRef.current) {
      return instance;
    }

    setStatus("installing");
    const initExitCode = await runForegroundCommand(instance, initCommand, {
      clearOutput: true,
    });

    if (!isRuntimeGenerationActive(generation)) {
      return null;
    }

    if (initExitCode !== 0) {
      throw new Error(formatCommandError(initCommand));
    }

    hasRunInitCommandRef.current = true;
    requestReverseSync(instance, generation);
    return instance;
  };

  /** Boots or joins the runtime, then (re)starts the runner. Failures reach the caller. */
  const bootAndStartRunner = async (generation: number) => {
    setStatus("booting");
    const instance = await prepareRuntime();
    if (!instance || !isRuntimeGenerationActive(generation)) {
      return;
    }

    if (!runnerConfig.enabled) {
      setStatus("ready");
      return;
    }

    await startRunnerProcess(
      instance,
      resolveRuntimeRunCommand(getProject(), runnerConfig.runCommand),
    );
  };

  /** Restarts the runner, even while one is starting: the Run button and run-on-save. */
  const rerunRunner = async () => {
    if (!lessonRunsInWebContainer(lessonType)) {
      resetRuntime();
      return;
    }

    const generation = getRuntimeGeneration();

    await reportFailure(
      () => bootAndStartRunner(generation),
      (error) => {
        if (isRuntimeGenerationActive(generation)) {
          setStatus("error");
          setErrorMessage(getRuntimeErrorMessage(error));
        }
      },
    );
  };

  /** Like rerunRunner, but leaves a boot, mount, install or start under way alone. */
  const startRuntime = async () => {
    if (lessonRunsInWebContainer(lessonType) && isRuntimeBusy(statusRef.current)) {
      return;
    }

    await rerunRunner();
  };
  const rerunRunnerRef = useRef(rerunRunner);
  // Layout-effect sync (not render-time) for the same compiler-bailout reason as
  // the lessonType/runnerConfig refs above; only read from async save callbacks.
  useLayoutEffect(() => {
    rerunRunnerRef.current = rerunRunner;
  });

  /**
   * Prepares the runtime (joining a boot or install already under way) and runs a
   * terminal task on it; a failure is reported in the runner console.
   */
  const withPreparedRuntime = async (
    task: (instance: WebContainer, generation: number) => Promise<void>,
  ) => {
    if (!lessonRunsInWebContainer(lessonType)) {
      return;
    }

    const generation = getRuntimeGeneration();

    await reportFailure(
      async () => {
        const instance = await prepareRuntime();
        if (instance && isRuntimeGenerationActive(generation)) {
          await task(instance, generation);
        }
      },
      (error) => {
        if (isRuntimeGenerationActive(generation)) {
          setErrorMessage(getRuntimeErrorMessage(error));
        }
      },
    );
  };

  const startTerminalSession = () =>
    withPreparedRuntime(async (instance) => {
      await ensureTerminalSession(instance);
    });

  const createTerminalSession = () => withPreparedRuntime(createTerminalSessionInRuntime);

  const sendTerminalInput = (input: string) =>
    withPreparedRuntime(async (instance, generation) => {
      await flushWorkspaceSync({ instance });
      await writeTerminalInput(instance, input);

      if (input.includes("\n") || input.includes("\u0003")) {
        requestReverseSync(instance, generation);
      }
    });

  const runCommand = async (commandLine: string) => {
    await sendTerminalInput(`${commandLine}\n`);
  };

  const saveWorkspace = async () => {
    // A replayed recording load calls this in the same task as loadProject, before
    // this provider re-renders, so the project comes from the store rather than the
    // render refs. A project the runtime has not switched to yet is left to the
    // switch: the project and lesson-type effects reset the runtime, and the
    // auto-start decides whether the new one runs.
    const project = getProject();
    if (
      !lessonRunsInWebContainer(project.lessonType) ||
      project.id !== loadedProjectIdRef.current
    ) {
      return;
    }

    const generation = getRuntimeGeneration();
    const instance = instanceRef.current;

    if (instance) {
      // Save is an explicit durability boundary: a whole-project sync (it supersedes
      // the debounced per-file queue) makes the rerun below read what was saved.
      const synced = await queueProjectSync({ instance, project }).then(
        () => true,
        (error: unknown) => {
          // Both callers fire and forget, so the runner console is where a
          // failed save is reported.
          if (isRuntimeGenerationActive(generation)) {
            setErrorMessage(getRuntimeErrorMessage(error));
          }
          return false;
        },
      );
      if (!synced) {
        return;
      }
    }

    // A reset during the sync abandoned this save; rerunning would boot the
    // runtime the reset just stopped.
    if (!isRuntimeGenerationActive(generation)) {
      return;
    }

    const currentRunnerConfig = runnerConfigRef.current;

    if (!currentRunnerConfig.enabled || !currentRunnerConfig.runOnFileSave) {
      return;
    }

    if (hasActiveRunner() || isRuntimeBusy(statusRef.current)) {
      return;
    }

    await rerunRunnerRef.current();
  };

  const updateRunnerConfig = (config: Partial<RunnerConfig>) => {
    setRunnerConfig((current) => ({
      ...current,
      ...config,
    }));
  };

  const updateEnvironmentVariables = (variables: EnvironmentVariables) => {
    const normalizedVariables = normalizeEnvironmentVariables(variables);

    setEnvironmentVariables(normalizedVariables);
    persistEnvironmentVariables(normalizedVariables);
  };

  const configureRuntime: WebContainerRuntimeActions["configureRuntime"] = (configuration) => {
    const normalizedVariables = normalizeEnvironmentVariables(configuration.environmentVariables);
    runnerConfigRef.current = configuration.runnerConfig;
    setRunnerConfig(configuration.runnerConfig);
    setEnvironmentVariables(normalizedVariables);
  };

  const onLessonTypeChange = useEffectEvent(() => {
    hasAutoStartedRef.current = false;
    if (!lessonRunsInWebContainer(lessonType)) {
      resetRuntime();
    }
  });

  useEffect(() => {
    onLessonTypeChange();
  }, [lessonType]);

  const onProjectChange = useEffectEvent(() => {
    // A different project was loaded — an imported `.ne` recording, a starter
    // switch, or a `?url=` lesson. The WebContainer is a shared singleton, so it
    // still holds the *previous* project's node_modules, and `hasRunInitCommandRef`
    // is still set from that install. Without a reset, `prepareRuntime` skips
    // `pnpm install` and `pnpm dev` then fails with "command not found" for the
    // new project's dev binary (vite/tsx/...) that was never installed. Tearing
    // the runtime down forces a clean boot + reinstall for the new project.
    if (loadedProjectIdRef.current !== null && loadedProjectIdRef.current !== projectId) {
      resetRuntime();
      hasAutoStartedRef.current = false;
    }

    loadedProjectIdRef.current = projectId;
  });

  useEffect(() => {
    onProjectChange();
  }, [projectId]);

  const onAutoStart = useEffectEvent(() => {
    hasAutoStartedRef.current = true;
    void startRuntime();
  });

  useEffect(() => {
    if (
      !lessonRunsInWebContainer(lessonType) ||
      !allowAmbientStart ||
      !isSupported ||
      hasAutoStartedRef.current ||
      !runnerConfig.enabled ||
      !runnerConfig.runOnStartup ||
      // Don't boot a runtime for an empty workspace (e.g. while a `?url=` recording
      // is still loading); the effect re-runs once its files land.
      fileCount === 0
    ) {
      return;
    }

    onAutoStart();
  }, [
    fileCount,
    lessonType,
    isSupported,
    projectId,
    runnerConfig.enabled,
    runnerConfig.runOnStartup,
    allowAmbientStart,
  ]);

  useEffect(() => {
    hasRunInitCommandRef.current = false;
  }, [runnerConfig.initCommand]);

  const onWorkspaceSyncMutation = useEffectEvent((mutation: WorkspaceSyncMutation) => {
    const instance = instanceRef.current;
    if (!instance || !hasMountedProjectRef.current) {
      return;
    }

    const generation = getRuntimeGeneration();
    const queuedSync =
      mutation.kind === "file"
        ? queueFileSync({ instance, file: mutation.file })
        : queueProjectSync({ instance, project: mutation.project });
    void queuedSync.catch((error) => {
      if (isRuntimeGenerationActive(generation)) {
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    });
  });

  // Effect Events are not reactive and get a new identity every render; listing
  // one as a dependency would resubscribe on every runner output chunk.
  useEffect(() => {
    return subscribeWorkspaceSync((mutation) => onWorkspaceSyncMutation(mutation));
  }, [subscribeWorkspaceSync]);

  const onWorkspaceLifecycleBoundary = useEffectEvent(() => {
    const instance = instanceRef.current;
    if (!instance || !hasMountedProjectRef.current) return;
    const generation = getRuntimeGeneration();
    void flushWorkspaceSync({ instance }).catch((error) => {
      if (isRuntimeGenerationActive(generation)) {
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    });
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flushAtBoundary = () => onWorkspaceLifecycleBoundary();
    window.addEventListener("blur", flushAtBoundary);
    window.addEventListener("pagehide", flushAtBoundary);
    return () => {
      window.removeEventListener("blur", flushAtBoundary);
      window.removeEventListener("pagehide", flushAtBoundary);
    };
  }, []);

  // resetRuntime also clears the pending reverse-sync timer.
  const onUnmount = useEffectEvent(() => {
    resetRuntime();
  });

  // The editor holds the shared container while it is mounted. On unmount,
  // resetRuntime stops our processes and tears down the instance our session
  // claimed; the release then tears down whatever is left, such as a container
  // the agent booted or a boot still in flight once it lands, unless another
  // editor holds the container by then.
  useEffect(() => {
    const releaseSharedWebContainer = holdSharedWebContainer();
    return () => {
      onUnmount();
      releaseSharedWebContainer();
    };
  }, []);

  const actionsValue: WebContainerRuntimeActions = {
    createTerminalSession,
    closeTerminalSession,
    startRuntime,
    resetRuntime,
    clearRunnerOutput,
    rerunRunner,
    runCommand,
    setActiveTerminalSession,
    startTerminalSession,
    sendTerminalInput,
    resizeTerminal,
    updateEnvironmentVariables,
    updateRunnerConfig,
    configureRuntime,
    setReverseSyncEnabled,
  };

  const metadataValue: WebContainerRuntimeMetadata = {
    status,
    previewUrl,
    previewPort,
    isSupported,
    errorMessage,
    latestPreviewMessage,
    latestLifecycleEvent,
    lastOutput,
    terminalSessions,
    activeTerminalSessionId,
    activeCommand,
    environmentVariables,
    runnerConfig,
    ambientStartEnabled: allowAmbientStart,
  };

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
