import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { WebContainer } from "@webcontainer/api";
import {
  WebContainerRuntimeActionsContext,
  WebContainerRuntimeMetadataContext,
  WebContainerRuntimeOutputContext,
  WebContainerRuntimeSnapshotGetterContext,
  WebContainerRuntimeSaveWorkspaceContext,
  type SaveWorkspaceOptions,
  type WebContainerRuntimeActions,
  type WebContainerRuntimeMetadata,
  type WebContainerRuntimeOutput,
} from "./WebContainerRuntimeContext";
import {
  isRuntimeBusy,
  type EnvironmentVariables,
  type RunnerConfig,
} from "../runtime/webcontainer/types";
import {
  DEFAULT_RUNNER_CONFIG,
  formatCommandError,
  resolveRuntimeRunCommand,
} from "../runtime/webcontainer/commands";
import { getRuntimeErrorMessage } from "../runtime/webcontainer/console";
import {
  loadStoredEnvironmentVariables,
  normalizeEnvironmentVariables,
  persistEnvironmentVariables,
} from "../runtime/webcontainer/environmentVariables";
import { readWorkspaceProject } from "../runtime/webcontainer/files";
import {
  holdSharedWebContainer,
  isWebContainerRuntimeSupported,
} from "../runtime/webcontainer/sharedContainer";
import {
  useWorkspaceFileCount,
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceProjectId,
} from "../hooks/useWorkspace";
import type { WorkspaceSyncMutation } from "../stores/workspaceActions";
import { useWebContainerRuntimeSession } from "./useWebContainerRuntimeSession";
import { isMobileBrowser } from "../utils/isMobileBrowser";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import {
  areWorkspaceProjectsEqual,
  lessonRunsInWebContainer,
  type WorkspaceProject,
} from "../types/workspace";

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
  // Bumped by a reset a consumer asks for, so the auto-start effect looks again.
  const [autoStartRequest, setAutoStartRequest] = useState(0);
  const loadedProjectIdRef = useRef<string | null>(null);
  const reverseSyncTimeoutRef = useRef<number | null>(null);
  const reverseSyncRequestRef = useRef(0);
  const reverseSyncEnabledRef = useRef(true);
  const lessonTypeRef = useRef(lessonType);
  const runnerConfigRef = useRef<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  // What the runner last started on, so a replay re-saving the same workspace does not
  // run it again (see saveWorkspace). Null from a start until its process has spawned.
  const lastRunRef = useRef<{
    project: WorkspaceProject;
    commandLine: string;
    environmentVariables: EnvironmentVariables;
  } | null>(null);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariables>(
    loadStoredEnvironmentVariables,
  );
  // saveWorkspace reads the current variables through this ref: the editor machine
  // keeps the first render's save function, whose closure never sees a replaced object.
  const environmentVariablesRef = useRef(environmentVariables);
  const [runnerConfig, setRunnerConfig] = useState<RunnerConfig>(DEFAULT_RUNNER_CONFIG);
  const {
    ensureProjectMounted,
    flushWorkspaceSync,
    isFsWatchActive,
    isProjectMounted,
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
      })().catch(reportErrorFor(generation));
    }, 150);
  };

  const {
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
    lastOutput,
    clearRunnerOutput,
    latestLifecycleEvent,
    latestPreviewMessage,
    previewPort,
    previewUrl,
    reportErrorFor,
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
    environmentVariablesRef.current = environmentVariables;
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
    lastRunRef.current = null;
    prepareRuntimePromiseRef.current = null;
    cancelPendingReverseSync();
    resetWorkspaceSync();
    resetRuntimeSession();
  };

  /**
   * The reset consumers get: a starter switch, a project import, the studio.
   * Unlike the provider's own resets it re-arms the auto-start, because the
   * workspace it clears the way for has usually auto-started already. A reset
   * that lands after that start (the starter switch's used to, after awaiting
   * the save) cancels it mid-boot, and nothing would start the workspace again:
   * the dock sat on "Waiting for runtime output..." until a page reload.
   */
  const resetRuntimeAndRearmAutoStart = () => {
    resetRuntime();
    hasAutoStartedRef.current = false;
    setAutoStartRequest((request) => request + 1);
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

  /**
   * The instance when the runtime is up and nothing is preparing it; null means go
   * through prepareRuntime.
   */
  const getReadyInstance = (generation: number): WebContainer | null => {
    const instance = instanceRef.current;
    if (
      !instance ||
      !isProjectMounted() ||
      prepareRuntimePromiseRef.current !== null ||
      !isRuntimeGenerationActive(generation)
    ) {
      return null;
    }

    const initCommand = runnerConfigRef.current.initCommand.trim();
    return !initCommand || hasRunInitCommandRef.current ? instance : null;
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

    if (!instance || !isRuntimeGenerationActive(generation)) {
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
    const initExitCode = await runForegroundCommand(instance, initCommand);

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
    // Until this start spawns, a failed boot or spawn must stay retryable.
    lastRunRef.current = null;
    setStatus("booting");
    const instance = await prepareRuntime();
    if (!instance || !isRuntimeGenerationActive(generation)) {
      return;
    }

    if (!runnerConfig.enabled) {
      setStatus("ready");
      return;
    }

    const project = getProject();
    const commandLine = resolveRuntimeRunCommand(project, runnerConfig.runCommand);
    // Only a start that is still the current one spawns. A superseded start resolves
    // false, possibly after the newer start recorded its run, so it must not clear that.
    if (await startRunnerProcess(instance, commandLine)) {
      lastRunRef.current = { project, commandLine, environmentVariables };
    }
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
   *
   * A runtime that is already up is not prepared again: sendTerminalInput runs per
   * keystroke, and a full prepare would clear the runner's error and re-sync the whole
   * project before each key. The workspace-sync subscription keeps the container
   * current, and sendTerminalInput still flushes queued writes first. A changed init
   * command resets hasRunInitCommandRef, so the next call prepares and installs again.
   */
  const withPreparedRuntime = async (
    task: (instance: WebContainer, generation: number) => Promise<void>,
  ) => {
    if (!lessonRunsInWebContainer(lessonType)) {
      return;
    }

    const generation = getRuntimeGeneration();

    await reportFailure(async () => {
      const instance = getReadyInstance(generation) ?? (await prepareRuntime());
      if (instance && isRuntimeGenerationActive(generation)) {
        await task(instance, generation);
      }
    }, reportErrorFor(generation));
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

  const saveWorkspace = async (options?: SaveWorkspaceOptions) => {
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

    // Every pause and paused seek re-saves the workspace the replay shows, and so does
    // every replayed file switch or sidebar scroll, mostly with code the runner already
    // ran. Running it again would spawn the program only to print the same output. The
    // replay's loadProject has queued the project sync already; the whole-project sync
    // below only exists for the rerun to read. The machine holds the first render's
    // save function, so the variables and runner config come from refs, not the closure.
    const lastRun = lastRunRef.current;
    if (
      options?.rerunOnlyIfChanged &&
      lastRun &&
      lastRun.environmentVariables === environmentVariablesRef.current &&
      lastRun.commandLine ===
        resolveRuntimeRunCommand(project, runnerConfigRef.current.runCommand) &&
      areWorkspaceProjectsEqual(lastRun.project, project)
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
          reportErrorFor(generation)(error);
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

    environmentVariablesRef.current = normalizedVariables;
    setEnvironmentVariables(normalizedVariables);
    persistEnvironmentVariables(normalizedVariables);
  };

  const configureRuntime: WebContainerRuntimeActions["configureRuntime"] = (configuration) => {
    const normalizedVariables = normalizeEnvironmentVariables(configuration.environmentVariables);
    runnerConfigRef.current = configuration.runnerConfig;
    environmentVariablesRef.current = normalizedVariables;
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
    autoStartRequest,
  ]);

  useEffect(() => {
    hasRunInitCommandRef.current = false;
  }, [runnerConfig.initCommand]);

  const onWorkspaceSyncMutation = useEffectEvent((mutation: WorkspaceSyncMutation) => {
    const instance = instanceRef.current;
    if (!instance || !isProjectMounted()) {
      return;
    }

    const generation = getRuntimeGeneration();
    const queuedSync =
      mutation.kind === "file"
        ? queueFileSync({ instance, file: mutation.file })
        : queueProjectSync({ instance, project: mutation.project });
    void queuedSync.catch(reportErrorFor(generation));
  });

  // Effect Events are not reactive and get a new identity every render; listing
  // one as a dependency would resubscribe on every runner output chunk.
  useEffect(() => {
    return subscribeWorkspaceSync((mutation) => onWorkspaceSyncMutation(mutation));
  }, [subscribeWorkspaceSync]);

  const onWorkspaceLifecycleBoundary = useEffectEvent(() => {
    const instance = instanceRef.current;
    if (!instance || !isProjectMounted()) return;
    const generation = getRuntimeGeneration();
    void flushWorkspaceSync({ instance }).catch(reportErrorFor(generation));
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
    resetRuntime: resetRuntimeAndRearmAutoStart,
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
    activeTerminalSessionId,
    environmentVariables,
    runnerConfig,
    ambientStartEnabled: allowAmbientStart,
  };

  // Kept out of metadataValue so a streamed chunk, a preview console error or a
  // port event does not re-render every metadata consumer (the preview
  // controller among them), only the output's.
  const outputValue: WebContainerRuntimeOutput = {
    lastOutput,
    terminalSessions,
    latestPreviewMessage,
    latestLifecycleEvent,
  };

  return (
    <WebContainerRuntimeSnapshotGetterContext value={getRecordingSnapshot}>
      <WebContainerRuntimeSaveWorkspaceContext value={saveWorkspace}>
        <WebContainerRuntimeActionsContext value={actionsValue}>
          <WebContainerRuntimeMetadataContext value={metadataValue}>
            <WebContainerRuntimeOutputContext value={outputValue}>
              {children}
            </WebContainerRuntimeOutputContext>
          </WebContainerRuntimeMetadataContext>
        </WebContainerRuntimeActionsContext>
      </WebContainerRuntimeSaveWorkspaceContext>
    </WebContainerRuntimeSnapshotGetterContext>
  );
};
