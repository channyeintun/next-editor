import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Play,
  Plus,
  Settings2,
  SquareTerminal,
  TerminalSquare,
} from "lucide-react";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import type {
  RuntimeDockTab,
  RuntimeRecordingSnapshot,
} from "../types/runtime";

function formatTerminalContent(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
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

const DOCK_TABS: RuntimeDockTabConfig[] = [
  {
    id: "runner",
    label: "Runner",
    icon: <Play size={13} />,
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: <TerminalSquare size={13} />,
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
  label: string;
  onChange: (checked: boolean) => void;
}

const RunnerToggle = memo(function RunnerToggle({
  checked,
  description,
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
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-[#10c776]" : "bg-slate-700"
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
});

const TerminalPanel = memo(function TerminalPanel() {
  const [activeTab, setActiveTab] = useState<RuntimeDockTab>("runner");
  const [command, setCommand] = useState("");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [playbackRuntimeSnapshot, setPlaybackRuntimeSnapshot] =
    useState<RuntimeRecordingSnapshot | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>([
    "[runner] Runtime dock is ready.",
  ]);
  const {
    handleRuntimeEvent,
    registerRuntimeStateApplier,
    registerRuntimeStateGetter,
  } = useNextEditorActions();
  const { rerunRunner, runCommand, updateRunnerConfig } =
    useWebContainerRuntimeActions();
  const {
    status,
    lastOutput,
    errorMessage,
    activeCommand,
    latestPreviewMessage,
    previewUrl,
    runnerConfig,
    workspaceRoot,
  } = useWebContainerRuntimeMetadata();
  const { currentRecording, isRecording } = useNextEditorMetadata();
  const recordedRuntimeSnapshot =
    playbackRuntimeSnapshot ??
    (isRecording ? null : currentRecording?.runtimeSnapshot) ??
    null;
  const runtimeStatus =
    status === "idle" ? (recordedRuntimeSnapshot?.status ?? status) : status;
  const recordedOutput = recordedRuntimeSnapshot?.terminalOutput ?? null;
  const effectivePreviewUrl = previewUrl || recordedRuntimeSnapshot?.previewUrl;
  const effectiveActiveCommand =
    activeCommand || recordedRuntimeSnapshot?.activeCommand || null;
  const effectiveErrorMessage =
    errorMessage || recordedRuntimeSnapshot?.errorMessage || null;
  const isPlaybackSnapshotActive = Boolean(
    currentRecording && playbackRuntimeSnapshot,
  );
  const previousStatusRef = useRef<string | null>(null);
  const previousPreviewUrlRef = useRef<string | null>(null);
  const previousCommandRef = useRef<string | null>(null);
  const previousErrorRef = useRef<string | null>(null);
  const previousPreviewMessageIdRef = useRef<number | null>(null);
  const previousRuntimeEventKeyRef = useRef<string | null>(null);
  const previousOutputRef = useRef<string | null>(null);

  useEffect(() => {
    registerRuntimeStateGetter(() => ({
      activeTab,
      isCollapsed,
      isSettingsOpen,
      consoleLines,
    }));
  }, [
    activeTab,
    consoleLines,
    isCollapsed,
    isSettingsOpen,
    registerRuntimeStateGetter,
  ]);

  useEffect(() => {
    registerRuntimeStateApplier((snapshot) => {
      setPlaybackRuntimeSnapshot(snapshot);
      setActiveTab(snapshot.activeTab ?? "runner");
      setIsCollapsed(snapshot.isCollapsed ?? false);
      setIsSettingsOpen(snapshot.isSettingsOpen ?? false);
      setConsoleLines(
        snapshot.consoleLines?.length
          ? snapshot.consoleLines
          : ["[runner] Runtime dock is ready."],
      );
    });
  }, [registerRuntimeStateApplier]);

  useEffect(() => {
    if (!currentRecording) {
      setPlaybackRuntimeSnapshot(null);
    }
  }, [currentRecording]);

  const appendConsoleLine = (message: string) => {
    setConsoleLines((current) => [...current.slice(-24), message]);
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
    if (isPlaybackSnapshotActive || !latestPreviewMessage) {
      return;
    }

    if (previousPreviewMessageIdRef.current === latestPreviewMessage.id) {
      return;
    }

    previousPreviewMessageIdRef.current = latestPreviewMessage.id;

    const location = latestPreviewMessage.pathname
      ? ` ${latestPreviewMessage.pathname}`
      : "";

    appendConsoleLine(
      `[preview:${latestPreviewMessage.kind}]${location} ${latestPreviewMessage.text}`.trim(),
    );
    setActiveTab("console");
  }, [isPlaybackSnapshotActive, latestPreviewMessage]);

  const runtimeEventKey = JSON.stringify({
    activeTab,
    isCollapsed,
    isSettingsOpen,
    status: runtimeStatus,
    previewUrl: effectivePreviewUrl,
    activeCommand: effectiveActiveCommand,
    errorMessage: effectiveErrorMessage,
    consoleLines,
  });

  useEffect(() => {
    if (!isRecording || isPlaybackSnapshotActive) {
      previousRuntimeEventKeyRef.current = runtimeEventKey;
      return;
    }

    if (previousRuntimeEventKeyRef.current === null) {
      previousRuntimeEventKeyRef.current = runtimeEventKey;
      return;
    }

    if (previousRuntimeEventKeyRef.current !== runtimeEventKey) {
      previousRuntimeEventKeyRef.current = runtimeEventKey;
      handleRuntimeEvent();
    }
  }, [
    handleRuntimeEvent,
    isPlaybackSnapshotActive,
    isRecording,
    runtimeEventKey,
  ]);

  useEffect(() => {
    if (!isRecording || isPlaybackSnapshotActive) {
      previousOutputRef.current = lastOutput;
      return;
    }

    const timer = window.setTimeout(() => {
      if (previousOutputRef.current !== lastOutput) {
        previousOutputRef.current = lastOutput;
        handleRuntimeEvent();
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [handleRuntimeEvent, isPlaybackSnapshotActive, isRecording, lastOutput]);

  const isBusy =
    runtimeStatus === "booting" ||
    runtimeStatus === "mounting" ||
    runtimeStatus === "installing" ||
    runtimeStatus === "starting";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextCommand = command.trim();
    if (!nextCommand) {
      return;
    }

    setCommand("");
    setActiveTab("terminal");
    await runCommand(nextCommand);
  };

  const rawContent = effectiveErrorMessage
    ? `Runtime error\n${effectiveErrorMessage}`
    : lastOutput ||
      recordedOutput ||
      (runtimeStatus === "installing"
        ? "Installing dependencies inside the WebContainer..."
        : runtimeStatus === "starting"
          ? "Starting the workspace dev server..."
          : "Waiting for runtime output...");
  const content = formatTerminalContent(rawContent);
  const statusLabel = getStatusLabel(runtimeStatus);
  const consoleContent = useMemo(() => {
    if (consoleLines.length === 0) {
      return "No console events yet.";
    }

    return consoleLines.join("\n");
  }, [consoleLines]);

  const runnerCommand = runnerConfig.runCommand.trim() || "Runner disabled";
  const runnerOutput = content || "Waiting for runner output...";

  return (
    <>
      <div className="fixed bottom-12 left-4 right-4 z-40 flex flex-col overflow-hidden rounded-xl border border-slate-900 bg-[#1d1f29] shadow-[0_18px_40px_rgba(2,6,23,0.42)] md:left-76">
        <div className="flex items-center border-b border-slate-800 bg-[#232633] px-2">
          {DOCK_TABS.map((tab) => {
            const isActive = tab.id === activeTab;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 border-r border-slate-800 px-4 py-3 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-b border-b-[#5da4ff] bg-[#1d1f29] text-white"
                    : "text-slate-400 hover:bg-[#1d1f29] hover:text-white"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center text-slate-500 transition-colors hover:text-white"
            aria-label="Open runner settings"
            title="Open runner settings"
          >
            <Plus size={15} />
          </button>

          <button
            type="button"
            onClick={() => setIsCollapsed((current) => !current)}
            className="ml-auto inline-flex h-10 w-10 items-center justify-center text-slate-500 transition-colors hover:text-white"
            aria-label={
              isCollapsed ? "Expand runtime dock" : "Collapse runtime dock"
            }
            title={
              isCollapsed ? "Expand runtime dock" : "Collapse runtime dock"
            }
          >
            {isCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {!isCollapsed && (
          <>
            {activeTab === "runner" && (
              <div className="flex h-72 flex-col bg-[#1d1f29]">
                <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] text-slate-300">
                      {runnerConfig.enabled ? runnerCommand : "Runner disabled"}
                    </p>
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
                      disabled={!runnerConfig.enabled || isBusy}
                      className="text-sm font-semibold uppercase tracking-[0.08em] text-[#13d77d] transition-colors hover:text-[#39f39a] disabled:cursor-not-allowed disabled:text-slate-600"
                    >
                      RERUN
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsSettingsOpen(true)}
                      className="text-slate-500 transition-colors hover:text-white"
                      aria-label="Open runner settings"
                      title="Open runner settings"
                    >
                      <Settings2 size={17} />
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto px-5 py-6">
                  <pre className="font-mono text-[13px] leading-7 text-slate-200 whitespace-pre-wrap">
                    {runnerOutput}
                  </pre>
                </div>
              </div>
            )}

            {activeTab === "terminal" && (
              <div className="flex h-72 flex-col bg-[#1d1f29] px-5 py-6">
                <div className="min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-7 text-slate-200">
                  {content && content !== "Waiting for runtime output..." ? (
                    <pre className="mb-5 whitespace-pre-wrap">{content}</pre>
                  ) : null}
                  <p className="text-[14px] font-semibold text-[#5ca3ff]">
                    {workspaceRoot}
                  </p>
                  <form
                    onSubmit={handleSubmit}
                    className="mt-2 flex items-center gap-3"
                  >
                    <span className="text-[28px] leading-none text-[#b183f7]">
                      ›
                    </span>
                    <input
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder=""
                      disabled={Boolean(effectiveActiveCommand)}
                      className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-slate-100 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed"
                    />
                  </form>
                </div>
              </div>
            )}

            {activeTab === "console" && (
              <div className="h-72 overflow-hidden bg-[#1d1f29]">
                <pre className="h-full overflow-auto px-5 py-6 font-mono text-[12px] leading-6 text-slate-300 whitespace-pre-wrap">
                  {consoleContent}
                </pre>
              </div>
            )}
          </>
        )}
      </div>

      {isSettingsOpen && (
        <div
          className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="mx-auto flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-5 overflow-y-auto px-5 py-5">
              <RunnerToggle
                checked={runnerConfig.enabled}
                label="Enable Runner"
                onChange={(checked) => updateRunnerConfig({ enabled: checked })}
              />
              <RunnerToggle
                checked={runnerConfig.runOnStartup}
                label="Run on startup"
                description="Execute script immediately when opening the project"
                onChange={(checked) =>
                  updateRunnerConfig({ runOnStartup: checked })
                }
              />
              <RunnerToggle
                checked={runnerConfig.runOnFileSave}
                label="Run on file-save"
                description="Execute script when saving a file"
                onChange={(checked) =>
                  updateRunnerConfig({ runOnFileSave: checked })
                }
              />
              <label className="block">
                <span className="block text-sm font-medium text-slate-100">
                  Init Command
                </span>
                <input
                  value={runnerConfig.initCommand}
                  onChange={(event) =>
                    updateRunnerConfig({ initCommand: event.target.value })
                  }
                  className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 font-mono text-sm text-slate-100 outline-none transition-colors focus:border-slate-500"
                />
                <span className="mt-2 block text-xs text-slate-500">
                  Command to run when booting the project
                </span>
              </label>
              <label className="block">
                <span className="block text-sm font-medium text-slate-100">
                  Run Command
                </span>
                <input
                  value={runnerConfig.runCommand}
                  onChange={(event) =>
                    updateRunnerConfig({ runCommand: event.target.value })
                  }
                  className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 font-mono text-sm text-slate-100 outline-none transition-colors focus:border-slate-500"
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
