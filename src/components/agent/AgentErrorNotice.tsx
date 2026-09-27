import { AlertTriangle, RotateCcw } from "lucide-react";

/** The agent's last error, with a Retry button when the failed run can be retried. */
export default function AgentErrorNotice({
  error,
  canRetry,
  isRetryDisabled,
  onRetry,
}: {
  error: string;
  canRetry: boolean;
  isRetryDisabled: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-red-500/25 bg-red-500/[0.07] p-3" role="alert">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-red-200">The agent hit an error</p>
          <pre className="mt-1 whitespace-pre-wrap wrap-break-word font-sans text-xs leading-5 text-red-300/90">
            {error}
          </pre>
          <p className="mt-2 text-[11px] text-slate-500">
            Try again. If it keeps failing, check the provider status or choose another model.
          </p>
        </div>
      </div>
      {canRetry ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onRetry}
            disabled={isRetryDisabled}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#173925] px-3 text-xs font-semibold text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw size={13} />
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
