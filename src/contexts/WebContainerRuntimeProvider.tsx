import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  loadStoredEnvironmentVariables,
  normalizeEnvironmentVariables,
  persistEnvironmentVariables,
  readWorkspaceProject,
} from "./webContainerRuntimeSupport";
import {
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceProjectName,
  useWorkspaceSyncVersion,
} from "../hooks/useWorkspace";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import { areWorkspaceProjectsEqual } from "../types/workspace";

interface WebContainerRuntimeProviderProps {
  children: React.ReactNode;
}

export const WebContainerRuntimeProvider: React.FC<
  WebContainerRuntimeProviderProps
> = ({ children }) => {
  const {
    getActiveFilePath,
    getCollapsedFolders,
    getProject,
    loadProject,
  } = useWorkspaceActions();
  const lessonType = useWorkspaceLessonType();
  const projectName = useWorkspaceProjectName();
  const syncVersion = useWorkspaceSyncVersion();
  const hasRunInitCommandRef = useRef(false);
  const hasAutoStartedRef = useRef(false);
  const reverseSyncTimeoutRef = useRef<number | null>(null);
  const lessonTypeRef = useRef(lessonType);
  const runnerConfigRef = useRef<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
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
  const {
    activeCommand,
    activeTerminalSessionId,
    bootInstance,
    closeTerminalSession,
    createTerminalSession: createTerminalSessionInRuntime,
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
      if (typeof window === "undefined") {
        return;
      }

      if (reverseSyncTimeoutRef.current !== null) {
        window.clearTimeout(reverseSyncTimeoutRef.current);
      }

      reverseSyncTimeoutRef.current = window.setTimeout(() => {
        reverseSyncTimeoutRef.current = null;

        void (async () => {
          if (lessonTypeRef.current !== "node.js") {
            return;
          }

          const instance = instanceRef.current;

          if (!instance) {
            return;
          }

          const currentProject = getProject();
          const nextProject = await readWorkspaceProject(instance, currentProject);

          if (areWorkspaceProjectsEqual(currentProject, nextProject)) {
            return;
          }

          loadProject(
            nextProject,
            getActiveFilePath(),
            getCollapsedFolders(),
          );
        })().catch((error) => {
          setErrorMessage(getRuntimeErrorMessage(error));
        });
      }, 150);
    },
  });

  lessonTypeRef.current = lessonType;
  runnerConfigRef.current = runnerConfig;

  const isSupported = window.crossOriginIsolated;
  const workspaceRoot = useMemo(
    () => getWorkspaceRoot(projectName),
    [projectName],
  );

  const resetRuntime = useCallback(() => {
    hasRunInitCommandRef.current = false;
    if (
      typeof window !== "undefined" &&
      reverseSyncTimeoutRef.current !== null
    ) {
      window.clearTimeout(reverseSyncTimeoutRef.current);
      reverseSyncTimeoutRef.current = null;
    }
    resetWorkspaceSync();
    resetRuntimeSession();
  }, [resetRuntimeSession, resetWorkspaceSync]);

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
    ensureProjectMounted,
    getProject,
    isMountedRef,
    isSupported,
    runForegroundCommand,
    runnerConfig.initCommand,
    setErrorMessage,
    setStatus,
  ]);

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

      const project = getProject();
      const runCommandLine = resolveRuntimeRunCommand(
        project,
        runnerConfig.runCommand,
      );

      if (!runnerConfig.enabled) {
        setStatus("ready");
        return;
      }

      await startRunnerProcess(instance, runCommandLine);
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [
    lessonType,
    prepareRuntime,
    getProject,
    resetRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    setErrorMessage,
    setStatus,
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

      const project = getProject();
      const runCommandLine = resolveRuntimeRunCommand(
        project,
        runnerConfig.runCommand,
      );

      if (!runnerConfig.enabled) {
        setStatus("ready");
        return;
      }

      await startRunnerProcess(instance, runCommandLine);
    } catch (error) {
      setStatus("error");
      setErrorMessage(getRuntimeErrorMessage(error));
    }
  }, [
    lessonType,
    prepareRuntime,
    getProject,
    resetRuntime,
    runnerConfig.enabled,
    runnerConfig.runCommand,
    setErrorMessage,
    setStatus,
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

  const createTerminalSession = useCallback(async () => {
    if (lessonType !== "node.js") {
      return;
    }

    const instance = await prepareRuntime();
    if (!instance) {
      return;
    }

    await createTerminalSessionInRuntime(instance);
  }, [createTerminalSessionInRuntime, lessonType, prepareRuntime]);

  const sendTerminalInput = useCallback(
    async (input: string) => {
      if (lessonType !== "node.js") {
        return;
      }

      const instance = await prepareRuntime();
      if (!instance) {
        return;
      }

      await writeTerminalInput(instance, input);

      if (
        typeof window !== "undefined" &&
        (input.includes("\n") || input.includes("\u0003"))
      ) {
        if (reverseSyncTimeoutRef.current !== null) {
          window.clearTimeout(reverseSyncTimeoutRef.current);
        }

        reverseSyncTimeoutRef.current = window.setTimeout(() => {
          reverseSyncTimeoutRef.current = null;

          void (async () => {
            const currentProject = getProject();
            const nextProject = await readWorkspaceProject(instance, currentProject);

            if (areWorkspaceProjectsEqual(currentProject, nextProject)) {
              return;
            }

            loadProject(
              nextProject,
              getActiveFilePath(),
              getCollapsedFolders(),
            );
          })().catch((error) => {
            setErrorMessage(getRuntimeErrorMessage(error));
          });
        }, 150);
      }
    },
    [
      getActiveFilePath,
      getCollapsedFolders,
      getProject,
      lessonType,
      loadProject,
      prepareRuntime,
      setErrorMessage,
      writeTerminalInput,
    ],
  );

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
      hasActiveRunner() ||
      currentStatus === "booting" ||
      currentStatus === "mounting" ||
      currentStatus === "installing" ||
      currentStatus === "starting"
    ) {
      return;
    }

    await rerunRunnerRef.current();
  }, [
    getProject,
    hasActiveRunner,
    instanceRef,
    queueProjectSync,
    setErrorMessage,
    statusRef,
  ]);

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
      if (
        typeof window !== "undefined" &&
        reverseSyncTimeoutRef.current !== null
      ) {
        window.clearTimeout(reverseSyncTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      resetRuntime();
    };
  }, [resetRuntime]);

  const actionsValue = useMemo<WebContainerRuntimeActions>(
    () => ({
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
    }),
    [
      createTerminalSession,
      closeTerminalSession,
      resetRuntime,
      resizeTerminal,
      rerunRunner,
      runCommand,
      saveWorkspace,
      sendTerminalInput,
      setActiveTerminalSession,
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
      terminalSessions,
      activeTerminalSessionId,
      activeCommand,
      environmentVariables,
      runnerConfig,
      workspaceRoot,
    }),
    [
      activeCommand,
      activeTerminalSessionId,
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
      terminalSessions,
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
