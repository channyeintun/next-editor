import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Play, SquareTerminal, TerminalSquare } from "lucide-react";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";

function formatTerminalContent(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "booting":
      return "Booting runtime";
    case "mounting":
      return "Mounting project";
    case "installing":
      return "Installing dependencies";
    case "starting":
      return "Starting dev server";
    case "ready":
      return "Runtime ready";
    case "error":
      return "Runtime error";
    default:
      return "Runtime idle";
  }
}

type RuntimeDockTab = "runner" | "terminal" | "console";

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

const TerminalPanel = memo(function TerminalPanel() {
  const [activeTab, setActiveTab] = useState<RuntimeDockTab>("runner");
  const [command, setCommand] = useState("");
  const [consoleLines, setConsoleLines] = useState<string[]>([
    "[runner] Runtime dock is ready.",
  ]);
  const { runCommand, startRuntime, resetRuntime } =
    useWebContainerRuntimeActions();
  const { status, lastOutput, errorMessage, activeCommand, previewUrl } =
    useWebContainerRuntimeMetadata();
  const { currentRecording } = useNextEditorMetadata();
  const recordedRuntimeSnapshot = currentRecording?.runtimeSnapshot;
  const runtimeStatus =
    status === "idle" ? (recordedRuntimeSnapshot?.status ?? status) : status;
  const recordedOutput = recordedRuntimeSnapshot?.terminalOutput ?? null;
  const previousStatusRef = useRef<string | null>(null);
  const previousPreviewUrlRef = useRef<string | null>(null);
  const previousCommandRef = useRef<string | null>(null);
  const previousErrorRef = useRef<string | null>(null);

  const appendConsoleLine = (message: string) => {
    setConsoleLines((current) => [...current.slice(-24), message]);
  };

  useEffect(() => {
    if (previousStatusRef.current !== runtimeStatus) {
      previousStatusRef.current = runtimeStatus;
      appendConsoleLine(
        `[runtime] ${new Date().toLocaleTimeString()} ${getStatusLabel(runtimeStatus)}`,
      );
    }
  }, [runtimeStatus]);

  useEffect(() => {
    if (previewUrl && previousPreviewUrlRef.current !== previewUrl) {
      previousPreviewUrlRef.current = previewUrl;
      appendConsoleLine(`[preview] ${previewUrl}`);
    }
  }, [previewUrl]);

  useEffect(() => {
    if (activeCommand && previousCommandRef.current !== activeCommand) {
      previousCommandRef.current = activeCommand;
      appendConsoleLine(`[command] ${activeCommand}`);
      setActiveTab("terminal");
    }

    if (!activeCommand) {
      previousCommandRef.current = null;
    }
  }, [activeCommand]);

  useEffect(() => {
    if (errorMessage && previousErrorRef.current !== errorMessage) {
      previousErrorRef.current = errorMessage;
      appendConsoleLine(`[error] ${errorMessage}`);
      setActiveTab("console");
    }

    if (!errorMessage) {
      previousErrorRef.current = null;
    }
  }, [errorMessage]);

  const isBusy =
    runtimeStatus === "booting" ||
    runtimeStatus === "mounting" ||
    runtimeStatus === "installing" ||
    runtimeStatus === "starting";
  const canStart = runtimeStatus === "idle" || runtimeStatus === "error";

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

  const rawContent = errorMessage
    ? `Runtime error\n${errorMessage}`
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

  const handleRunnerClick = async () => {
    if (runtimeStatus === "ready") {
      resetRuntime();
      return;
    }

    if (canStart) {
      await startRuntime();
    }
  };

  return (
    <div className="fixed bottom-12 left-4 right-4 z-40 flex h-56 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#171b23] shadow-[0_18px_40px_rgba(2,6,23,0.42)] md:left-[19rem]">
      <div className="flex items-center border-b border-slate-800 bg-[#1b2029] px-2">
        {DOCK_TABS.map((tab) => {
          const isActive = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 border-r border-slate-800 px-4 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-[#171b23] text-slate-100"
                  : "text-slate-400 hover:bg-slate-900 hover:text-white"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-3 px-3 text-[11px] text-slate-500">
          <span>{statusLabel}</span>
          {previewUrl && (
            <span className="max-w-56 truncate text-slate-400">
              {previewUrl}
            </span>
          )}
        </div>
      </div>

      {activeTab === "runner" && (
        <div className="grid flex-1 grid-cols-[minmax(0,1fr)_auto] gap-4 p-4">
          <div className="rounded-lg border border-slate-800 bg-[#11141c] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
              Runner
            </p>
            <p className="mt-3 text-sm text-slate-200">
              Start the WebContainer runtime to install packages and drive the
              live preview.
            </p>
            <div className="mt-4 space-y-2 text-xs text-slate-400">
              <p>
                Status: <span className="text-slate-200">{statusLabel}</span>
              </p>
              <p>
                Preview:{" "}
                <span className="text-slate-200">
                  {previewUrl ?? "Not ready yet"}
                </span>
              </p>
              <p>
                Command:{" "}
                <span className="text-slate-200">
                  {activeCommand ?? "Idle"}
                </span>
              </p>
            </div>
          </div>

          <div className="flex w-56 flex-col justify-between rounded-lg border border-slate-800 bg-[#11141c] p-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Actions
              </p>
              <p className="mt-3 text-xs leading-5 text-slate-400">
                Use Runner to boot or reset the workspace runtime. Terminal and
                Console stay docked below for command and event inspection.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void handleRunnerClick();
              }}
              disabled={isBusy}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-100 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runtimeStatus === "ready" ? "Reset Runtime" : "Start Runtime"}
            </button>
          </div>
        </div>
      )}

      {activeTab === "terminal" && (
        <>
          <div className="flex-1 overflow-hidden bg-[#11141c]">
            <pre className="h-full overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-200 whitespace-pre-wrap">
              {content}
            </pre>
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-3 border-t border-slate-800 bg-[#11141c] px-4 py-3"
          >
            <div className="flex h-10 items-center rounded-md border border-slate-700 bg-[#0d1117] px-3 font-mono text-sm text-slate-300">
              $
            </div>
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm install package-name"
              className="h-10 flex-1 rounded-md border border-slate-700 bg-[#0d1117] px-3 font-mono text-[12px] text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={!command.trim() || Boolean(activeCommand)}
              className="inline-flex h-10 items-center justify-center rounded-md border border-slate-700 bg-slate-900 px-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-100 transition-colors hover:border-slate-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              Run
            </button>
          </form>
        </>
      )}

      {activeTab === "console" && (
        <div className="flex-1 overflow-hidden bg-[#11141c]">
          <pre className="h-full overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-300 whitespace-pre-wrap">
            {consoleContent}
          </pre>
        </div>
      )}
    </div>
  );
});

export default TerminalPanel;
