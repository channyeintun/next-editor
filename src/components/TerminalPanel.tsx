import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronUp, Diamond, Plus, Settings, SquareTerminal, X } from "lucide-react";
import { useNextEditorDomainAdapters } from "../contexts/NextEditorDomainAdaptersContext";
import { usePreviewPanel } from "../contexts/PreviewPanelContext";
import XtermTerminal from "./XtermTerminal";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useWorkspaceSidebarWidth } from "../hooks/useWorkspace";
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

type RuntimeDockStyle = CSSProperties & {
  "--runtime-dock-left": string;
};

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
];

interface RunnerToggleProps {
  checked: boolean;
  description?: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

const RunnerToggle = memo(function RunnerToggle({
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
});

const TerminalPanel = memo(function TerminalPanel() {
  const [activeTab, setActiveTab] = useState<RuntimeDockTab>("runner");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCreatingTerminal, setIsCreatingTerminal] = useState(false);
  const [playbackRuntimeSnapshot, setPlaybackRuntimeSnapshot] =
    useState<RuntimeRecordingSnapshot | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>(DEFAULT_CONSOLE_LINES);
  const [terminalScrollLines, setTerminalScrollLines] = useState<RuntimeTerminalScrollLines>({});
  const { dockWidth: previewDockWidth, isDocked: isPreviewDocked } = usePreviewPanel();
  const sidebarWidth = useWorkspaceSidebarWidth();
  const { handleRuntimeEvent } = useNextEditorActions();
  const { runtimePanel } = useNextEditorDomainAdapters();
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
  const { currentRecording, isPlaying, isRecording } = useNextEditorMetadata();
  const recordedRuntimeSnapshot =
    isPlaying && !isRecording
      ? (playbackRuntimeSnapshot ??
        currentRecording?.runtimeEvents?.[0]?.snapshot ??
        currentRecording?.runtimeSnapshot ??
        null)
      : null;
  const isPlaybackSnapshotActive = Boolean(recordedRuntimeSnapshot);
  const displayActiveTab = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.activeTab ?? "runner")
    : activeTab;
  const displayIsCollapsed = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
    : isCollapsed;
  const displayIsSettingsOpen = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isSettingsOpen ?? false)
    : isSettingsOpen;
  const recordableActiveTab = activeTab;
  const runtimeStatus = recordedRuntimeSnapshot?.status ?? status;
  const recordedOutput = recordedRuntimeSnapshot?.lastOutput ?? null;
  const effectiveErrorMessage = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.errorMessage ?? null)
    : errorMessage;
  const effectiveConsoleLines = useMemo(() => {
    if (!isPlaybackSnapshotActive) {
      return consoleLines;
    }

    return recordedRuntimeSnapshot?.consoleLines?.length
      ? recordedRuntimeSnapshot.consoleLines
      : DEFAULT_CONSOLE_LINES;
  }, [consoleLines, isPlaybackSnapshotActive, recordedRuntimeSnapshot]);
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
    runtimePanel.setSnapshotGetter(() => ({
      activeTab: recordableActiveTab,
      isCollapsed,
      isSettingsOpen,
      consoleLines,
      terminalScrollLines,
    }));

    return () => {
      runtimePanel.setSnapshotGetter(() => null);
    };
  }, [
    consoleLines,
    isCollapsed,
    isSettingsOpen,
    recordableActiveTab,
    runtimePanel,
    terminalScrollLines,
  ]);

  useEffect(() => {
    runtimePanel.setSnapshotApplier((snapshot) => {
      setPlaybackRuntimeSnapshot(snapshot);
    });

    return () => {
      runtimePanel.setSnapshotApplier((_snapshot) => undefined);
    };
  }, [runtimePanel]);

  useEffect(() => {
    runtimePanel.setConsoleOpener(() => {
      if (isPlaybackSnapshotActive) {
        return;
      }

      setIsCollapsed(false);
      setActiveTab("console");
    });

    return () => {
      runtimePanel.setConsoleOpener(() => undefined);
    };
  }, [isPlaybackSnapshotActive, runtimePanel]);

  useEffect(() => {
    if (!currentRecording) {
      setPlaybackRuntimeSnapshot(null);
    }
  }, [currentRecording]);

  const appendConsoleLine = useCallback((message: string) => {
    const nextMessage = message.trim();

    if (!nextMessage) {
      return;
    }

    setConsoleLines((current) => {
      if (current[current.length - 1] === nextMessage) {
        return current;
      }

      return [...current.slice(-24), nextMessage];
    });
  }, []);

  useEffect(() => {
    runtimePanel.setConsoleAppender((message) => {
      if (isPlaybackSnapshotActive) {
        return;
      }

      appendConsoleLine(message);
      setActiveTab("console");
    });

    return () => {
      runtimePanel.setConsoleAppender(() => undefined);
    };
  }, [appendConsoleLine, isPlaybackSnapshotActive, runtimePanel]);

  const updateTerminalScrollLine = (surfaceId: string | null, scrollLine: number) => {
    if (!surfaceId || isPlaybackSnapshotActive) {
      return;
    }

    setTerminalScrollLines((current) => {
      if (current[surfaceId] === scrollLine) {
        return current;
      }

      return {
        ...current,
        [surfaceId]: scrollLine,
      };
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
    setActiveTab("console");
  }, [appendConsoleLine, isPlaybackSnapshotActive, latestPreviewMessage]);

  const runtimeEventState = useMemo<RuntimeEventState>(
    () => ({
      activeTab: recordableActiveTab,
      isCollapsed,
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
    }),
    [
      activeCommand,
      activeTerminalSessionId,
      consoleLines,
      errorMessage,
      isCollapsed,
      isSettingsOpen,
      previewPort,
      previewUrl,
      recordableActiveTab,
      status,
      terminalScrollLines,
      terminalSessions,
    ],
  );

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

  useEffect(() => {
    if (isPlaybackSnapshotActive || activeTab !== "terminal" || isCreatingTerminal) {
      return;
    }

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
  const consoleContent = useMemo(() => {
    if (effectiveConsoleLines.length === 0) {
      return "";
    }

    return effectiveConsoleLines.map(decorateConsoleLine).join("\n");
  }, [effectiveConsoleLines]);

  const runnerCommand = runnerConfig.runCommand.trim() || "Runner disabled";
  const runnerOutput = content || "Waiting for runner output...";
  const dockStyle: RuntimeDockStyle = {
    "--runtime-dock-left": `${sidebarWidth + 16}px`,
    right: isPreviewDocked ? previewDockWidth + 16 : 16,
  };

  return (
    <>
      <div
        className="runtime-dock fixed bottom-12 z-40 flex flex-col overflow-hidden rounded-lg border border-[#0f131a] bg-[#15191f] shadow-[0_18px_40px_rgba(2,6,23,0.42)]"
        style={dockStyle}
      >
        <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
          {DOCK_TABS.map((tab) => {
            const isActive = tab.id === displayActiveTab;

            return (
              <button
                key={tab.id}
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
            disabled={isPlaybackSnapshotActive}
            onClick={() => setIsCollapsed((current) => !current)}
            className="ml-auto inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:hover:text-slate-500"
            aria-label={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
            title={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
          >
            {displayIsCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {!displayIsCollapsed && (
          <>
            {displayActiveTab === "runner" && (
              <div className={`flex h-72 flex-col ${RUNTIME_PANEL_BG}`}>
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
              <div className={`flex h-72 flex-col px-5 py-6 ${RUNTIME_PANEL_BG}`}>
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
              <div className={`h-72 overflow-hidden px-5 py-6 ${RUNTIME_PANEL_BG}`}>
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
            <div className="space-y-5 overflow-y-auto px-5 py-5">
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
                  Command to run when booting the project
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
                  Command to run inside the workspace
                </span>
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

export default TerminalPanel;
