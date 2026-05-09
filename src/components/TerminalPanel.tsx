import { memo, useState } from "react";
import { Circle, LoaderCircle, TerminalSquare } from "lucide-react";
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

const TerminalPanel = memo(function TerminalPanel() {
  const [command, setCommand] = useState("");
  const { runCommand } = useWebContainerRuntimeActions();
  const { status, lastOutput, errorMessage, activeCommand, previewUrl } =
    useWebContainerRuntimeMetadata();
  const { currentRecording } = useNextEditorMetadata();
  const recordedRuntimeSnapshot = currentRecording?.runtimeSnapshot;
  const runtimeStatus =
    status === "idle" ? (recordedRuntimeSnapshot?.status ?? status) : status;
  const recordedOutput = recordedRuntimeSnapshot?.terminalOutput ?? null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextCommand = command.trim();
    if (!nextCommand) {
      return;
    }

    setCommand("");
    await runCommand(nextCommand);
  };

  if (
    runtimeStatus === "idle" &&
    !lastOutput &&
    !recordedOutput &&
    !errorMessage
  ) {
    return null;
  }

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
  const statusTone =
    runtimeStatus === "error"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
      : runtimeStatus === "ready"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
        : "border-sky-500/30 bg-sky-500/10 text-sky-100";

  return (
    <div className="fixed bottom-24 left-6 z-40 flex h-[18.5rem] w-[min(34rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-[24px] border border-slate-700/80 bg-slate-950/90 shadow-[0_30px_80px_rgba(2,6,23,0.55)] backdrop-blur-xl md:left-[20rem] md:w-[min(36rem,calc(100vw-23rem))]">
      <div className="border-b border-slate-800/80 bg-[linear-gradient(180deg,rgba(15,23,42,0.92),rgba(2,6,23,0.9))] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Circle size={8} className="fill-rose-400 text-rose-400" />
              <Circle size={8} className="fill-amber-400 text-amber-400" />
              <Circle size={8} className="fill-emerald-400 text-emerald-400" />
            </div>
            <div>
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-400">
                <TerminalSquare size={14} />
                Terminal
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {activeCommand
                  ? `Running ${activeCommand}`
                  : (previewUrl ?? "Workspace runtime shell")}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium ${statusTone}`}
          >
            {runtimeStatus !== "ready" && runtimeStatus !== "error" && (
              <LoaderCircle size={12} className="animate-spin" />
            )}
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden bg-[#020617]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.12),transparent_35%),linear-gradient(180deg,rgba(15,23,42,0.12),rgba(2,6,23,0))]" />
        <pre className="relative h-full overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-slate-200 whitespace-pre-wrap selection:bg-sky-500/30">
          {content}
        </pre>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-3 border-t border-slate-800/80 bg-slate-950/95 px-4 py-3"
      >
        <div className="flex h-11 items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/80 px-3 text-slate-400 shadow-[inset_0_1px_0_rgba(148,163,184,0.08)]">
          <span className="font-mono text-sm text-sky-400">$</span>
        </div>
        <div className="flex flex-1 items-center rounded-2xl border border-slate-800 bg-slate-900/80 px-3 shadow-[inset_0_1px_0_rgba(148,163,184,0.08)] transition-colors focus-within:border-sky-500/60">
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npm install package-name"
            className="h-11 w-full bg-transparent font-mono text-[12px] text-slate-100 outline-none placeholder:text-slate-500"
          />
        </div>
        <button
          type="submit"
          disabled={!command.trim() || Boolean(activeCommand)}
          className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/90 px-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-100 transition-all hover:-translate-y-0.5 hover:border-sky-500/60 hover:text-white disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Run
        </button>
      </form>
    </div>
  );
});

export default TerminalPanel;
