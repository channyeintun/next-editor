import { Check, ShieldCheck } from "lucide-react";
import type { ToolConfirmationRequest } from "../../agent/types";

/** Asks whether the agent may make a tool call that needs the user's permission. */
export default function ToolConfirmationCard({
  request,
  onResolve,
}: {
  request: ToolConfirmationRequest;
  onResolve: (approved: boolean) => void;
}) {
  return (
    // An alert, so the blocking request is announced when it appears; focus is
    // left where the user put it.
    <div
      role="alert"
      className="mx-3 mb-3 rounded-lg border border-[#64a3ff]/25 bg-[#1a202a] p-3 shadow-[0_8px_20px_rgba(0,0,0,0.16)]"
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[#64a3ff]/10 text-[#64a3ff]">
          <ShieldCheck size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64a3ff]">
            Permission required
          </p>
          <p className="mt-0.5 text-xs font-medium text-slate-200">
            Allow {request.toolName} to run this command?
          </p>
        </div>
      </div>
      <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-slate-800 bg-[#0f1319] px-3 py-2 font-mono text-xs leading-5 text-slate-300">
        {request.summary}
      </pre>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onResolve(false)}
          className="h-8 rounded-md border border-slate-700 bg-transparent px-3 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-white"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onResolve(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#173925] px-3 text-xs font-semibold text-[#58d88d] transition-colors hover:bg-[#1f4a31]"
        >
          <Check size={13} />
          Allow
        </button>
      </div>
    </div>
  );
}
