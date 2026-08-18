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
  resolveRuntimeRunCommand,
  getWorkspaceRoot,
  isMobileBrowser,
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
  useWorkspaceProjectName,
} from "../hooks/useWorkspace";
import type { WorkspaceSyncMutation } from "./WorkspaceContext";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import { areWorkspaceProjectsEqual, lessonRunsInWebContainer } from "../types/workspace";

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
  const projectName = useWorkspaceProjectName();
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
    runSerializedRuntimeTask,
    resetWorkspaceSync,
  } = useWebContainerWorkspaceSync({
    // A container process changed a file our own sync didn't write — pull the
    // container filesystem back into the workspace.
    onExternalFileChange: (instance) => requestReverseSync(instance, getRuntimeGeneration()),
  });

  const requestReverseSync = (instance: WebContainer, generation: number) => {
    if (typeof window === "undefined") {
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
    latestLifecycleEvent,
    latestPreviewMessage,
    openPorts,
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
  const workspaceRoot = getWorkspaceRoot(projectName);

  const resetRuntime = () => {
    hasRunInitCommandRef.current = false;
    prepareRuntimePromiseRef.current = null;
    reverseSyncRequestRef.current += 1;
    if (typeof window !== "undefined" && reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
      reverseSyncTimeoutRef.current = null;
    }
    resetWorkspaceSync();
    resetRuntimeSession();
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

  const startRuntime = async () => {
    if (!lessonRunsInWebContainer(lessonType)) {
      resetRuntime();
      return;
    }

    const currentStatus = statusRef.current;
    if (
      currentStatus === "booting" ||
      currentStatus === "mounting" ||
      currentStatus === "installing" ||
      currentStatus === "starting"
    ) {
      return;
    }

    const generation = getRuntimeGeneration();

    try {
      setStatus("booting");

      const instance = await prepareRuntime();
      if (!instance || !isRuntimeGenerationActive(generation)) {
        return;
      }

      const project = getProject();
      const runCommandLine = resolveRuntimeRunCommand(project, runnerConfig.runCommand);

      if (!runnerConfig.enabled) {
        if (isRuntimeGenerationActive(generation)) {
          setStatus("ready");
        }
        return;
      }

      await startRunnerProcess(instance, runCommandLine);
    } catch (error) {
      if (isRuntimeGenerationActive(generation)) {
        setStatus("error");
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    }
  };

  const rerunRunner = async () => {
    if (!lessonRunsInWebContainer(lessonType)) {
      resetRuntime();
      return;
    }

    const generation = getRuntimeGeneration();

    try {
      setStatus("booting");
      const instance = await prepareRuntime();

      if (!instance || !isRuntimeGenerationActive(generation)) {
        return;
      }

      const project = getProject();
      const runCommandLine = resolveRuntimeRunCommand(project, runnerConfig.runCommand);

      if (!runnerConfig.enabled) {
        if (isRuntimeGenerationActive(generation)) {
          setStatus("ready");
        }
        return;
      }

      await startRunnerProcess(instance, runCommandLine);
    } catch (error) {
      if (isRuntimeGenerationActive(generation)) {
        setStatus("error");
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    }
  };
  const rerunRunnerRef = useRef(rerunRunner);
  // Layout-effect sync (not render-time) for the same compiler-bailout reason as
  // the lessonType/runnerConfig refs above; only read from async save callbacks.
  useLayoutEffect(() => {
    rerunRunnerRef.current = rerunRunner;
  });

  const startTerminalSession = async () => {
    if (!lessonRunsInWebContainer(lessonType)) {
      return;
    }

    const generation = getRuntimeGeneration();

    try {
      const instance = await prepareRuntime();
      if (!instance || !isRuntimeGenerationActive(generation)) {
        return;
      }

      await ensureTerminalSession(instance);
    } catch (error) {
      if (isRuntimeGenerationActive(generation)) {
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    }
  };

  const createTerminalSession = async () => {
    if (!lessonRunsInWebContainer(lessonType)) {
      return;
    }

    const generation = getRuntimeGeneration();

    try {
      const instance = await prepareRuntime();
      if (!instance || !isRuntimeGenerationActive(generation)) {
        return;
      }

      await createTerminalSessionInRuntime(instance);
    } catch (error) {
      if (isRuntimeGenerationActive(generation)) {
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    }
  };

  const sendTerminalInput = async (input: string) => {
    if (!lessonRunsInWebContainer(lessonType)) {
      return;
    }

    const generation = getRuntimeGeneration();

    try {
      const instance = await prepareRuntime();
      if (!instance || !isRuntimeGenerationActive(generation)) {
        return;
      }

      await flushWorkspaceSync({ instance });
      await writeTerminalInput(instance, input);

      if (input.includes("\n") || input.includes("\u0003")) {
        requestReverseSync(instance, generation);
      }
    } catch (error) {
      if (isRuntimeGenerationActive(generation)) {
        setErrorMessage(getRuntimeErrorMessage(error));
      }
    }
  };

  const runCommand = async (commandLine: string) => {
    await sendTerminalInput(`${commandLine}\n`);
  };

  const saveWorkspace = async () => {
    if (!lessonRunsInWebContainer(lessonTypeRef.current)) {
      return;
    }

    const instance = instanceRef.current;

    if (instance) {
      try {
        // Save is an explicit durability boundary. A latest-project sync also
        // covers mutations that landed during an effect subscription handoff.
        await queueProjectSync({ instance, project: getProject() });
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
      hasActiveRunner() ||
      currentStatus === "booting" ||
      currentStatus === "mounting" ||
      currentStatus === "installing" ||
      currentStatus === "starting"
    ) {
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

    const queuedSync =
      mutation.kind === "file"
        ? queueFileSync({ instance, file: mutation.file })
        : queueProjectSync({ instance, project: mutation.project });
    void queuedSync.catch((error) => {
      setErrorMessage(getRuntimeErrorMessage(error));
    });
  });

  useEffect(() => {
    return subscribeWorkspaceSync(onWorkspaceSyncMutation);
  }, [onWorkspaceSyncMutation, subscribeWorkspaceSync]);

  const onWorkspaceLifecycleBoundary = useEffectEvent(() => {
    const instance = instanceRef.current;
    if (!instance || !hasMountedProjectRef.current) return;
    void flushWorkspaceSync({ instance }).catch((error) => {
      setErrorMessage(getRuntimeErrorMessage(error));
    });
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("blur", onWorkspaceLifecycleBoundary);
    window.addEventListener("pagehide", onWorkspaceLifecycleBoundary);
    return () => {
      window.removeEventListener("blur", onWorkspaceLifecycleBoundary);
      window.removeEventListener("pagehide", onWorkspaceLifecycleBoundary);
    };
  }, [onWorkspaceLifecycleBoundary]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && reverseSyncTimeoutRef.current !== null) {
        window.clearTimeout(reverseSyncTimeoutRef.current);
      }
    };
  }, []);

  const onUnmount = useEffectEvent(() => {
    resetRuntime();
  });

  useEffect(() => {
    return () => {
      onUnmount();
    };
  }, []);

  const actionsValue: WebContainerRuntimeActions = {
    createTerminalSession,
    closeTerminalSession,
    startRuntime,
    resetRuntime,
    rerunRunner,
    runCommand,
    setActiveTerminalSession,
    startTerminalSession,
    sendTerminalInput,
    resizeTerminal,
    saveWorkspace,
    updateEnvironmentVariables,
    updateRunnerConfig,
    configureRuntime,
  };

  const metadataValue: WebContainerRuntimeMetadata = {
    status,
    previewUrl,
    previewPort,
    isSupported,
    errorMessage,
    latestPreviewMessage,
    openPorts,
    latestLifecycleEvent,
    lastOutput,
    terminalSessions,
    activeTerminalSessionId,
    activeCommand,
    environmentVariables,
    runnerConfig,
    workspaceRoot,
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
