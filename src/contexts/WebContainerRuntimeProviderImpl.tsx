import { useEffect, useEffectEvent, useRef, useState } from "react";
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
  useWorkspaceSyncVersion,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import { areWorkspaceProjectsEqual, lessonRunsInWebContainer } from "../types/workspace";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

export const WebContainerRuntimeProvider: React.FC<WebContainerRuntimeProviderProps> = ({
  children,
}) => {
  const {
    getActiveFilePath,
    getCollapsedFolders,
    getProject,
    getSidebarScrollTop,
    getSidebarWidth,
    loadProject,
  } = useWorkspaceActions();
  const lessonType = useWorkspaceLessonType();
  const projectId = useWorkspaceProjectId();
  const projectName = useWorkspaceProjectName();
  const syncVersion = useWorkspaceSyncVersion();
  const fileCount = useWorkspaceFileCount();
  const hasRunInitCommandRef = useRef(false);
  const hasAutoStartedRef = useRef(false);
  const loadedProjectIdRef = useRef<string | null>(null);
  const reverseSyncTimeoutRef = useRef<number | null>(null);
  const lessonTypeRef = useRef(lessonType);
  const runnerConfigRef = useRef<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariables>(
    loadStoredEnvironmentVariables,
  );
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const { hasMountedProjectRef, ensureProjectMounted, queueProjectSync, resetWorkspaceSync } =
    useWebContainerWorkspaceSync();

  const requestReverseSync = (instance: WebContainer, generation?: number) => {
    if (typeof window === "undefined") {
      return;
    }

    if (reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
    }

    reverseSyncTimeoutRef.current = window.setTimeout(() => {
      reverseSyncTimeoutRef.current = null;

      void (async () => {
        if (!lessonRunsInWebContainer(lessonTypeRef.current)) {
          return;
        }

        if (generation !== undefined && !isRuntimeGenerationActive(generation)) {
          return;
        }

        const currentProject = getProject();
        const nextProject = await readWorkspaceProject(instance, currentProject);

        if (
          (generation !== undefined && !isRuntimeGenerationActive(generation)) ||
          areWorkspaceProjectsEqual(currentProject, nextProject)
        ) {
          return;
        }

        loadProject(
          nextProject,
          getActiveFilePath(),
          getCollapsedFolders(),
          getSidebarScrollTop(),
          getSidebarWidth(),
        );
      })().catch((error) => {
        if (generation === undefined || isRuntimeGenerationActive(generation)) {
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

      requestReverseSync(instance);
    },
    onServerReady: () => {
      if (!lessonRunsInWebContainer(lessonTypeRef.current)) {
        return;
      }

      const instance = instanceRef.current;

      if (!instance) {
        return;
      }

      requestReverseSync(instance);
    },
  });

  lessonTypeRef.current = lessonType;
  runnerConfigRef.current = runnerConfig;

  const isSupported = isWebContainerRuntimeSupported();
  const workspaceRoot = getWorkspaceRoot(projectName);

  const resetRuntime = () => {
    hasRunInitCommandRef.current = false;
    if (typeof window !== "undefined" && reverseSyncTimeoutRef.current !== null) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
      reverseSyncTimeoutRef.current = null;
    }
    resetWorkspaceSync();
    resetRuntimeSession();
  };

  const prepareRuntime = async () => {
    const generation = getRuntimeGeneration();

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
  rerunRunnerRef.current = rerunRunner;

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
  }, [
    getProject,
    hasMountedProjectRef,
    instanceRef,
    queueProjectSync,
    setErrorMessage,
    syncVersion,
  ]);

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
