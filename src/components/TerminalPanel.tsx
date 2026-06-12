import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Play, Plus, Settings2, SquareTerminal, X } from "lucide-react";
import { useNextEditorDomainAdapters } from "../contexts/NextEditorDomainAdaptersContext";
import XtermTerminal from "./XtermTerminal";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
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
const DEFAULT_CONSOLE_LINES = ["[runner] Runtime dock is ready."];
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

function shouldMirrorConsoleLineToBrowser(line: string): boolean {
  const normalizedLine = line.toLowerCase();

  return (
    normalizedLine.startsWith("[error]") ||
    normalizedLine.startsWith("[runtime:internal-error]") ||
    normalizedLine.startsWith("[preview:console-error]") ||
    normalizedLine.startsWith("[preview:uncaught-exception]") ||
    normalizedLine.startsWith("[preview:unhandled-rejection]")
  );
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "booting":
      return "Booting";
    case "mounting":
      return "Mounting";
    case "installing":
      return "Installing";
    case "starting":
      return "Starting";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
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
    icon: <Play size={13} />,
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
    latestLifecycleEvent,
    latestPreviewMessage,
    openPorts,
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
  const previousStatusRef = useRef<string | null>(null);
  const previousPreviewUrlRef = useRef<string | null>(null);
  const previousCommandRef = useRef<string | null>(null);
  const previousErrorRef = useRef<string | null>(null);
  const previousRunnerOutputRef = useRef<string | null>(null);
  const previousLifecycleEventIdRef = useRef<number | null>(null);
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
    if (!currentRecording) {
      setPlaybackRuntimeSnapshot(null);
    }
  }, [currentRecording]);

  const appendConsoleLine = (message: string) => {
    if (shouldMirrorConsoleLineToBrowser(message)) {
      console.log(message);
    }

    setConsoleLines((current) => [...current.slice(-24), message]);
  };

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

    if (previousStatusRef.current !== runtimeStatus) {
      previousStatusRef.current = runtimeStatus;
      appendConsoleLine(
        `[runtime] ${new Date().toLocaleTimeString()} ${getStatusLabel(runtimeStatus)}`,
      );
    }
  }, [isPlaybackSnapshotActive, runtimeStatus]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    if (previewUrl && previousPreviewUrlRef.current !== previewUrl) {
      previousPreviewUrlRef.current = previewUrl;
      appendConsoleLine(`[preview] ${previewUrl}`);
    }
  }, [isPlaybackSnapshotActive, previewUrl]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    if (activeCommand && previousCommandRef.current !== activeCommand) {
      previousCommandRef.current = activeCommand;
      appendConsoleLine(`[command] ${activeCommand}`);
      setActiveTab("terminal");
    }

    if (!activeCommand) {
      previousCommandRef.current = null;
    }
  }, [activeCommand, isPlaybackSnapshotActive]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    if (!lastOutput) {
      previousRunnerOutputRef.current = null;
      return;
    }

    const previousOutput = previousRunnerOutputRef.current ?? "";

    if (lastOutput === previousOutput) {
      return;
    }

    const nextOutput = lastOutput.startsWith(previousOutput)
      ? lastOutput.slice(previousOutput.length)
      : lastOutput;

    previousRunnerOutputRef.current = lastOutput;

    const formattedOutput = formatTerminalContent(nextOutput);

    if (!formattedOutput) {
      return;
    }

    for (const line of formattedOutput.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      appendConsoleLine(`[runner] ${line}`);
    }
  }, [isPlaybackSnapshotActive, lastOutput]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    if (errorMessage && previousErrorRef.current !== errorMessage) {
      previousErrorRef.current = errorMessage;
      appendConsoleLine(`[error] ${errorMessage}`);
      setActiveTab("console");
    }

    if (!errorMessage) {
      previousErrorRef.current = null;
    }
  }, [errorMessage, isPlaybackSnapshotActive]);

  useEffect(() => {
    if (isPlaybackSnapshotActive || !latestLifecycleEvent) {
      return;
    }

    if (previousLifecycleEventIdRef.current === latestLifecycleEvent.id) {
      return;
    }

    previousLifecycleEventIdRef.current = latestLifecycleEvent.id;

    const details = latestLifecycleEvent.url
      ? ` ${latestLifecycleEvent.url}`
      : latestLifecycleEvent.port !== null
        ? ` ${latestLifecycleEvent.port}`
        : "";

    appendConsoleLine(
      `[runtime:${latestLifecycleEvent.kind}]${details} ${latestLifecycleEvent.text}`.trim(),
    );

    if (latestLifecycleEvent.kind === "internal-error") {
      setActiveTab("console");
    }
  }, [isPlaybackSnapshotActive, latestLifecycleEvent]);

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
  }, [isPlaybackSnapshotActive, latestPreviewMessage]);

  const runtimeEventState = useMemo<RuntimeEventState>(
    () => ({
      activeTab: recordableActiveTab,
      isCollapsed,
      isSettingsOpen,
      status,
      previewUrl: previewUrl ?? null,
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
  const statusLabel = getStatusLabel(runtimeStatus);
  const consoleContent = useMemo(() => {
    if (effectiveConsoleLines.length === 0) {
      return "No console events yet.";
    }

    return effectiveConsoleLines.map(decorateConsoleLine).join("\n");
  }, [effectiveConsoleLines]);

  const runnerCommand = runnerConfig.runCommand.trim() || "Runner disabled";
  const runnerOutput = content || "Waiting for runner output...";
  const openPortSummary = isPlaybackSnapshotActive
    ? recordedRuntimeSnapshot?.previewUrl
      ? recordedRuntimeSnapshot.previewUrl
      : "No open ports"
    : openPorts.length > 0
      ? openPorts.map(({ port, url }) => `${port} ${url}`).join("\n")
      : "No open ports";

  return (
    <>
      <div className="fixed bottom-12 left-4 right-4 z-40 flex flex-col overflow-hidden rounded-xl border border-slate-900 bg-[#1d1f29] shadow-[0_18px_40px_rgba(2,6,23,0.42)] md:left-76">
        <div className="flex items-center border-b border-slate-800 bg-[#232633] px-2">
          {DOCK_TABS.map((tab) => {
            const isActive = tab.id === displayActiveTab;

            return (
              <button
                key={tab.id}
                type="button"
                disabled={isPlaybackSnapshotActive}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 border-r border-slate-800 px-4 py-3 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-b border-b-[#5da4ff] bg-[#1d1f29] text-white"
                    : "text-slate-400 hover:bg-[#1d1f29] hover:text-white"
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
                className={`inline-flex items-center border-r border-slate-800 text-xs font-medium transition-colors ${
                  isActiveSession
                    ? "border-b border-b-[#5da4ff] bg-[#1d1f29] text-white"
                    : "text-slate-400 hover:bg-[#1d1f29] hover:text-white"
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
              <div className="flex h-72 flex-col bg-[#1d1f29]">
                <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] text-slate-300">
                      {runnerConfig.enabled ? runnerCommand : "Runner disabled"}
                    </p>
                    <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-5 text-slate-500">
                      {openPortSummary}
                    </pre>
                  </div>
                  <div className="ml-4 flex items-center gap-4">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {statusLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void rerunRunner();
                      }}
                      disabled={isPlaybackSnapshotActive || !runnerConfig.enabled || isBusy}
                      className="text-sm font-semibold uppercase tracking-[0.08em] text-[#13d77d] transition-colors hover:text-[#39f39a] disabled:cursor-not-allowed disabled:text-slate-600"
                    >
                      RERUN
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsSettingsOpen(true)}
                      disabled={isPlaybackSnapshotActive}
                      className="text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:hover:text-slate-500"
                      aria-label="Open runner settings"
                      title="Open runner settings"
                    >
                      <Settings2 size={17} />
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden px-5 py-6">
                  <div className="size-full overflow-hidden rounded-lg border border-slate-800/80 bg-[#151821]">
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
              </div>
            )}

            {displayActiveTab === "terminal" && (
              <div className="flex h-72 flex-col bg-[#1d1f29] px-5 py-6">
                <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-800/80 bg-[#151821]">
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
                    disabled={isPlaybackSnapshotActive}
                    onClick={() => {
                      void sendTerminalInput("\u0003");
                    }}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-default disabled:hover:border-slate-700 disabled:hover:text-slate-400"
                  >
                    Ctrl+C
                  </button>
                </div>
              </div>
            )}

            {displayActiveTab === "console" && (
              <div className="h-72 overflow-hidden bg-[#1d1f29] px-5 py-6">
                <div className="size-full overflow-hidden rounded-lg border border-slate-800/80 bg-[#151821]">
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
