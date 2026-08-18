import { useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Diamond,
  Maximize2,
  Minimize2,
  Plus,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import AgentPanel from "./agent/AgentPanel";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectActiveTab,
  selectConsoleLines,
  selectIsCollapsed,
  selectIsFullHeight,
  selectIsSettingsOpen,
  selectTerminalScrollLines,
} from "../stores/runtimePanelStore";
import XtermTerminal from "./XtermTerminal";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useRuntimeDockRecordedSnapshot } from "../hooks/useRuntimeDockRecordedSnapshot";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import type {
  RuntimeDockTab,
  RuntimeRecordingSnapshot,
  RuntimeTerminalScrollLines,
} from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

function formatTerminalContent(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

const ANSI_RESET = "\u001b[0m";
const DEFAULT_CONSOLE_LINES: string[] = [];
const RUNTIME_PANEL_BG = "bg-[#15191f]";
const RUNTIME_COMMAND_BAR_CLASS =
  "flex min-h-15.5 items-center justify-between border-b border-[#11151d] bg-[#191d25] px-4 py-3";
const RUNTIME_COMMAND_TEXT_CLASS = "truncate font-mono text-[13px] font-semibold text-slate-400";
const ANSI_COLORS: Record<string, string> = {
  dim: "\u001b[90m",
  blue: "\u001b[94m",
  cyan: "\u001b[96m",
  green: "\u001b[92m",
  red: "\u001b[91m",
  yellow: "\u001b[93m",
};

function decorateConsoleLine(line: string): string {
  const prefixMatch = line.match(/^\[[^\]]+\]/);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const normalizedPrefix = prefix.toLowerCase();

  let prefixColor = ANSI_COLORS.blue;

  if (normalizedPrefix.includes("error")) {
    prefixColor = ANSI_COLORS.red;
  } else if (normalizedPrefix.startsWith("[runtime")) {
    prefixColor = ANSI_COLORS.cyan;
  } else if (normalizedPrefix.startsWith("[preview")) {
    prefixColor = ANSI_COLORS.yellow;
  } else if (normalizedPrefix.startsWith("[command")) {
    prefixColor = ANSI_COLORS.green;
  }

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_COLORS.dim}${suffix}${ANSI_RESET}`;
}

interface RuntimeDockTabConfig {
  id: RuntimeDockTab;
  label: string;
  icon: React.ReactNode;
}

interface RuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  isSettingsOpen: boolean;
  status: string;
  previewUrl: string | null;
  previewPort: number | null;
  activeCommand: string | null;
  errorMessage: string | null;
  consoleLines: string[];
  terminalSessions: RuntimeRecordingSnapshot["terminalSessions"];
  activeTerminalSessionId: string | null;
  terminalScrollLines: RuntimeTerminalScrollLines;
}

const DOCK_TABS: RuntimeDockTabConfig[] = [
  {
    id: "runner",
    label: "Runner",
    icon: <Diamond size={15} strokeWidth={2.25} />,
  },
  {
    id: "console",
    label: "Console",
    icon: <SquareTerminal size={13} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
];

interface RunnerToggleProps {
  checked: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function RunnerToggle({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: RunnerToggleProps) {
  return (
    <label className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-100">{label}</p>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[#10c776]" : "bg-slate-700"
        } disabled:cursor-not-allowed disabled:opacity-60`}
      >
        <span
          className={`absolute top-1 rounded-full bg-white transition-transform size-4 ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
}

function TerminalPanel() {
  const { store: runtimePanelStore, consoleAppender, consoleOpener } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const isSettingsOpen = useSelector(runtimePanelStore, (s) => selectIsSettingsOpen(s.context));
  const consoleLines = useSelector(runtimePanelStore, (s) => selectConsoleLines(s.context));
  const terminalScrollLines = useSelector(runtimePanelStore, (s) =>
    selectTerminalScrollLines(s.context),
  );
  const setActiveTab = (tab: RuntimeDockTab) => runtimePanelStore.trigger.setActiveTab({ tab });
  const setIsCollapsed = (collapsed: boolean) =>
    runtimePanelStore.trigger.setIsCollapsed({ collapsed });
  const setIsFullHeight = (fullHeight: boolean) =>
    runtimePanelStore.trigger.setIsFullHeight({ fullHeight });
  const setIsSettingsOpen = (open: boolean) =>
    runtimePanelStore.trigger.setIsSettingsOpen({ open });
  const [isCreatingTerminal, setIsCreatingTerminal] = useState(false);
  const { handleRuntimeEvent } = useNextEditorActions();
  const {
    closeTerminalSession,
    createTerminalSession,
    rerunRunner,
    resizeTerminal,
    sendTerminalInput,
    setActiveTerminalSession,
    startTerminalSession,
    updateRunnerConfig,
  } = useWebContainerRuntimeActions();
  const {
    activeTerminalSessionId,
    status,
    lastOutput,
    errorMessage,
    activeCommand,
    latestPreviewMessage,
    previewPort,
    previewUrl,
    runnerConfig,
    terminalSessions,
  } = useWebContainerRuntimeMetadata();
  const { currentRecording, isRecording } = useNextEditorMetadata();
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const displayActiveTab = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.activeTab ?? "runner")
    : activeTab;
  const displayIsCollapsed = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
    : isCollapsed;
  const displayIsFullHeight = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
    : isFullHeight;
  const displayIsSettingsOpen = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isSettingsOpen ?? false)
    : isSettingsOpen;
  const recordableActiveTab = activeTab;
  const runtimeStatus = recordedRuntimeSnapshot?.status ?? status;
  const recordedOutput = recordedRuntimeSnapshot?.lastOutput ?? null;
  const effectiveErrorMessage = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.errorMessage ?? null)
    : errorMessage;
  const effectiveConsoleLines = !isPlaybackSnapshotActive
    ? consoleLines
    : recordedRuntimeSnapshot?.consoleLines?.length
      ? recordedRuntimeSnapshot.consoleLines
      : DEFAULT_CONSOLE_LINES;
  const effectiveTerminalSessions = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.terminalSessions ?? [])
    : terminalSessions;
  const effectiveTerminalScrollLines = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.terminalScrollLines ?? {})
    : terminalScrollLines;
  const effectiveActiveTerminalSessionId =
    (isPlaybackSnapshotActive
      ? recordedRuntimeSnapshot?.activeTerminalSessionId
      : activeTerminalSessionId) ||
    effectiveTerminalSessions[0]?.id ||
    null;
  const effectiveTerminalOutput =
    effectiveTerminalSessions.find((session) => session.id === effectiveActiveTerminalSessionId)
      ?.output ?? null;
  const previousCommandRef = useRef<string | null>(null);
  const previousPreviewMessageIdRef = useRef<number | null>(null);
  const previousRuntimeEventStateRef = useRef<RuntimeEventState | null>(null);

  useEffect(() => {
    if (!currentRecording) {
      runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot: null });
    }
  }, [currentRecording, runtimePanelStore]);

  const appendConsoleLine = (message: string) => {
    const nextMessage = message.trim();

    if (!nextMessage) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.consoleLines;
    if (current[current.length - 1] === nextMessage) {
      return;
    }

    runtimePanelStore.trigger.setConsoleLines({
      consoleLines: [...current.slice(-24), nextMessage],
    });
  };

  useEffect(() => {
    consoleAppender.current = (message) => {
      if (isPlaybackSnapshotActive) {
        return;
      }

      appendConsoleLine(message);
    };

    return () => {
      consoleAppender.current = null;
    };
  }, [appendConsoleLine, consoleAppender, isPlaybackSnapshotActive]);

  useEffect(() => {
    consoleOpener.current = () => {
      if (isPlaybackSnapshotActive) {
        return;
      }

      setIsCollapsed(false);
      setActiveTab("console");
    };

    return () => {
      consoleOpener.current = null;
    };
  }, [consoleOpener, isPlaybackSnapshotActive, setActiveTab, setIsCollapsed]);

  const updateTerminalScrollLine = (surfaceId: string | null, scrollLine: number) => {
    if (!surfaceId || isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[surfaceId] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: {
        ...current,
        [surfaceId]: scrollLine,
      },
    });
  };

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    if (activeCommand && previousCommandRef.current !== activeCommand) {
      previousCommandRef.current = activeCommand;
      setActiveTab("terminal");
    }

    if (!activeCommand) {
      previousCommandRef.current = null;
    }
  }, [activeCommand, isPlaybackSnapshotActive]);

  useEffect(() => {
    if (isPlaybackSnapshotActive || !latestPreviewMessage) {
      return;
    }

    if (previousPreviewMessageIdRef.current === latestPreviewMessage.id) {
      return;
    }

    previousPreviewMessageIdRef.current = latestPreviewMessage.id;

    const location = latestPreviewMessage.pathname ? ` ${latestPreviewMessage.pathname}` : "";

    appendConsoleLine(
      `[preview:${latestPreviewMessage.kind}]${location} ${latestPreviewMessage.text}`.trim(),
    );
  }, [appendConsoleLine, isPlaybackSnapshotActive, latestPreviewMessage]);

  const runtimeEventState: RuntimeEventState = {
    activeTab: recordableActiveTab,
    isCollapsed,
    // Part of the recorded snapshot and replayed on playback, so it has to be
    // one of the fields that can trigger a RUNTIME_EVENT on its own — otherwise
    // toggling full height alone never reaches the recorder.
    isFullHeight,
    isSettingsOpen,
    status,
    previewUrl: previewUrl ?? null,
    previewPort: previewPort ?? null,
    activeCommand,
    errorMessage,
    consoleLines,
    terminalSessions,
    activeTerminalSessionId,
    terminalScrollLines,
  };

  useEffect(() => {
    if (!isRecording || isPlaybackSnapshotActive) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      return;
    }

    if (previousRuntimeEventStateRef.current === null) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      return;
    }

    if (!areStructuredDataEqual(previousRuntimeEventStateRef.current, runtimeEventState)) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      handleRuntimeEvent();
    }
  }, [handleRuntimeEvent, isPlaybackSnapshotActive, isRecording, runtimeEventState]);

  // `startTerminalSession` comes from the runtime provider's actions object,
  // which the React Compiler cannot memoize (its try/catch shapes bail out), so
  // its identity changes on every provider render — and the provider re-renders
  // per stdout chunk while a command streams. Without this ref the effect
  // re-invoked startTerminalSession on that churn, once per chunk. The ref keys
  // the request on what actually changed rather than on function identity.
  const requestedTerminalSessionForTabRef = useRef(false);
  useEffect(() => {
    if (isPlaybackSnapshotActive || activeTab !== "terminal" || isCreatingTerminal) {
      if (activeTab !== "terminal") {
        requestedTerminalSessionForTabRef.current = false;
      }
      return;
    }

    if (requestedTerminalSessionForTabRef.current) {
      return;
    }
    requestedTerminalSessionForTabRef.current = true;

    void startTerminalSession();
  }, [activeTab, isCreatingTerminal, isPlaybackSnapshotActive, startTerminalSession]);

  const isBusy =
    runtimeStatus === "booting" ||
    runtimeStatus === "mounting" ||
    runtimeStatus === "installing" ||
    runtimeStatus === "starting";

  const effectiveRunnerOutput = isPlaybackSnapshotActive ? recordedOutput : lastOutput;
  const rawContent = effectiveRunnerOutput
    ? effectiveErrorMessage
      ? `${effectiveRunnerOutput}\n\nRuntime error\n${effectiveErrorMessage}`
      : effectiveRunnerOutput
    : effectiveErrorMessage
      ? `Runtime error\n${effectiveErrorMessage}`
      : runtimeStatus === "installing"
        ? "Installing dependencies inside the WebContainer..."
        : runtimeStatus === "starting"
          ? "Starting the workspace dev server..."
          : "Waiting for runtime output...";
  const content = formatTerminalContent(rawContent);
  const consoleContent =
    effectiveConsoleLines.length === 0
      ? ""
      : effectiveConsoleLines.map(decorateConsoleLine).join("\n");

  const runnerCommand = runnerConfig.runCommand.trim() || "Runner disabled";
  const runnerOutput = content || "Waiting for runner output...";
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";

  return (
    <>
      <div
        className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
          displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
        }`}
        data-cursor-replay-target="runtime-dock"
      >
        <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
          {DOCK_TABS.map((tab) => {
            const isActive = tab.id === displayActiveTab;

            return (
              <button
                key={tab.id}
                data-tour={tab.id === "agent" ? "agent" : undefined}
                type="button"
                disabled={isPlaybackSnapshotActive}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2.5 border-r border-[#11151d] px-4 py-3 text-[13px] font-semibold transition-colors ${
                  isActive
                    ? "border-b border-b-[#64a3ff] bg-[#171b22] text-white"
                    : "text-slate-400 hover:bg-[#171b22] hover:text-white"
                } disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-slate-400`}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}

          {effectiveTerminalSessions.map((session) => {
            const isActiveSession =
              displayActiveTab === "terminal" && session.id === effectiveActiveTerminalSessionId;

            return (
              <div
                key={session.id}
                className={`inline-flex items-center border-r border-[#11151d] text-xs font-medium transition-colors ${
                  isActiveSession
                    ? "border-b border-b-[#64a3ff] bg-[#171b22] text-white"
                    : "text-slate-400 hover:bg-[#171b22] hover:text-white"
                }`}
              >
                <button
                  type="button"
                  disabled={isPlaybackSnapshotActive}
                  onClick={() => {
                    setActiveTab("terminal");
                    setActiveTerminalSession(session.id);
                  }}
                  className="px-4 py-3 disabled:cursor-default"
                >
                  {session.title}
                </button>
                <button
                  type="button"
                  disabled={isPlaybackSnapshotActive}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTerminalSession(session.id);

                    if (activeTab === "terminal" && effectiveTerminalSessions.length === 1) {
                      setActiveTab("runner");
                    }
                  }}
                  className="pr-3 text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:hover:text-slate-500"
                  aria-label="Close terminal"
                  title="Close terminal"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            disabled={isPlaybackSnapshotActive}
            onClick={() => {
              setIsCreatingTerminal(true);
              setActiveTab("terminal");
              void createTerminalSession().finally(() => {
                setIsCreatingTerminal(false);
              });
            }}
            className="inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:hover:text-slate-500"
            aria-label="New terminal"
            title="New terminal"
          >
            <Plus size={15} />
          </button>

          <button
            type="button"
            disabled={isPlaybackSnapshotActive || displayIsCollapsed}
            onClick={() => setIsFullHeight(!runtimePanelStore.getSnapshot().context.isFullHeight)}
            className="ml-auto inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:opacity-40 disabled:hover:text-slate-500"
            aria-label={
              displayIsFullHeight
                ? "Restore runtime dock height"
                : "Expand runtime dock to full height"
            }
            title={
              displayIsFullHeight
                ? "Restore runtime dock height"
                : "Expand runtime dock to full height"
            }
          >
            {displayIsFullHeight ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>

          <button
            data-tour="runner"
            type="button"
            disabled={isPlaybackSnapshotActive}
            onClick={() => setIsCollapsed(!runtimePanelStore.getSnapshot().context.isCollapsed)}
            className="inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:hover:text-slate-500"
            aria-label={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
            title={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
          >
            {displayIsCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {!displayIsCollapsed && (
          <>
            {displayActiveTab === "runner" && (
              <div className={`flex ${dockContentSizeClass} flex-col ${RUNTIME_PANEL_BG}`}>
                <div className={RUNTIME_COMMAND_BAR_CLASS}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <p className={RUNTIME_COMMAND_TEXT_CLASS}>
                      {runnerConfig.enabled ? runnerCommand : "Runner disabled"}
                    </p>
                    {isBusy ? (
                      <span
                        aria-label="Runner is starting"
                        className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                      />
                    ) : null}
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void rerunRunner();
                      }}
                      disabled={isPlaybackSnapshotActive || !runnerConfig.enabled || isBusy}
                      className="rounded-md bg-[#173925] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6] disabled:cursor-not-allowed disabled:bg-[#17241e] disabled:text-[#4f8e68]"
                    >
                      RUN
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsSettingsOpen(true)}
                      disabled={isPlaybackSnapshotActive}
                      className="inline-flex size-8 items-center justify-center text-slate-500 transition-colors hover:text-slate-200 disabled:cursor-default disabled:hover:text-slate-500"
                      aria-label="Open runner settings"
                      title="Open runner settings"
                    >
                      <Settings size={18} />
                    </button>
                  </div>
                </div>

                <div className={`min-h-0 flex-1 overflow-hidden px-5 py-6 ${RUNTIME_PANEL_BG}`}>
                  <XtermTerminal
                    sessionId="runner"
                    output={runnerOutput}
                    interactive={false}
                    scrollLine={
                      isPlaybackSnapshotActive ? effectiveTerminalScrollLines.runner : undefined
                    }
                    onScroll={(scrollLine) => updateTerminalScrollLine("runner", scrollLine)}
                  />
                </div>
              </div>
            )}

            {displayActiveTab === "terminal" && (
              <div
                className={`flex ${dockContentSizeClass} flex-col px-5 py-6 ${RUNTIME_PANEL_BG}`}
              >
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {!effectiveActiveTerminalSessionId && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-[13px] text-slate-500">
                      Open the terminal to start a shell session.
                    </div>
                  )}
                  <XtermTerminal
                    sessionId={effectiveActiveTerminalSessionId}
                    output={effectiveTerminalOutput || ""}
                    interactive={!isPlaybackSnapshotActive}
                    shouldFocus={!isPlaybackSnapshotActive && displayActiveTab === "terminal"}
                    scrollLine={
                      isPlaybackSnapshotActive && effectiveActiveTerminalSessionId
                        ? effectiveTerminalScrollLines[effectiveActiveTerminalSessionId]
                        : undefined
                    }
                    onData={(input) => {
                      if (!isPlaybackSnapshotActive) {
                        void sendTerminalInput(input);
                      }
                    }}
                    onResize={(size) => {
                      if (!displayIsCollapsed && !isPlaybackSnapshotActive) {
                        resizeTerminal(size);
                      }
                    }}
                    onScroll={(scrollLine) =>
                      updateTerminalScrollLine(effectiveActiveTerminalSessionId, scrollLine)
                    }
                  />
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={isPlaybackSnapshotActive || !effectiveActiveTerminalSessionId}
                    onClick={() => {
                      void sendTerminalInput("\u0003");
                    }}
                    className="rounded-md border border-[#303746] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-default disabled:opacity-50 disabled:hover:border-[#303746] disabled:hover:text-slate-400"
                  >
                    Ctrl+C
                  </button>
                </div>
              </div>
            )}

            {displayActiveTab === "console" && (
              <div
                className={`${dockContentSizeClass} overflow-hidden px-5 py-6 ${RUNTIME_PANEL_BG}`}
              >
                <XtermTerminal
                  sessionId="console"
                  output={consoleContent}
                  interactive={false}
                  scrollLine={
                    isPlaybackSnapshotActive ? effectiveTerminalScrollLines.console : undefined
                  }
                  onScroll={(scrollLine) => updateTerminalScrollLine("console", scrollLine)}
                />
              </div>
            )}

            {displayActiveTab === "agent" && (
              <AgentPanel isFullHeight={dockContentSizeClass !== "h-72"} />
            )}
          </>
        )}
      </div>

      {displayIsSettingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
          onClick={() => {
            if (!isPlaybackSnapshotActive) {
              setIsSettingsOpen(false);
            }
          }}
        >
          <div
            className="mx-auto flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-5 overflow-y-auto p-5">
              <RunnerToggle
                checked={runnerConfig.enabled}
                disabled={isPlaybackSnapshotActive}
                label="Enable Runner"
                onChange={(checked) => updateRunnerConfig({ enabled: checked })}
              />
              <RunnerToggle
                checked={runnerConfig.runOnStartup}
                disabled={isPlaybackSnapshotActive}
                label="Run on startup"
                description="Execute script immediately when opening the project"
                onChange={(checked) => updateRunnerConfig({ runOnStartup: checked })}
              />
              <RunnerToggle
                checked={runnerConfig.runOnFileSave}
                disabled={isPlaybackSnapshotActive}
                label="Run on file-save"
                description="Execute script when saving a file"
                onChange={(checked) => updateRunnerConfig({ runOnFileSave: checked })}
              />
              <label className="block">
                <span className="block text-sm font-medium text-slate-100">Init Command</span>
                <input
                  value={runnerConfig.initCommand}
                  disabled={isPlaybackSnapshotActive}
                  onChange={(event) => updateRunnerConfig({ initCommand: event.target.value })}
                  className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 font-mono text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:cursor-default disabled:opacity-70"
                />
                <span className="mt-2 block text-xs text-slate-500">
                  Shell command to run when booting the project
                </span>
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-slate-100">Run Command</span>
                <input
                  value={runnerConfig.runCommand}
                  disabled={isPlaybackSnapshotActive}
                  onChange={(event) => updateRunnerConfig({ runCommand: event.target.value })}
                  className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 font-mono text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:cursor-default disabled:opacity-70"
                />
                <span className="mt-2 block text-xs text-slate-500">
                  Shell command to run inside the workspace
                </span>
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default TerminalPanel;
