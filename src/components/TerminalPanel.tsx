import { memo } from "react";
import { useWebContainerRuntimeMetadata } from "../hooks/useWebContainerRuntime";

const TerminalPanel = memo(function TerminalPanel() {
  const { status, lastOutput, errorMessage } = useWebContainerRuntimeMetadata();

  if (status === "idle" && !lastOutput && !errorMessage) {
    return null;
  }

  const content = errorMessage
    ? `Runtime error\n${errorMessage}`
    : lastOutput || "Waiting for runtime output...";

  return (
    <div className="fixed bottom-24 left-6 z-40 flex h-56 w-[min(32rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-400">
            Terminal
          </p>
          <p className="text-xs text-slate-400">Read-only runtime output</p>
        </div>
        <span className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
          {status}
        </span>
      </div>
      <pre className="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5 text-slate-200 whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  );
});

export default TerminalPanel;
