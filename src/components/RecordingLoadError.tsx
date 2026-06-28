interface RecordingLoadErrorProps {
  /** Human-readable failure message from the loader. */
  message: string;
  /** Re-run the load. Omitted when there is nothing sensible to retry (e.g. a dropped file). */
  onRetry?: () => void;
  /** Dismiss the panel without retrying. Used when the failure isn't retryable. */
  onDismiss?: () => void;
}

/**
 * Inline, themeable failure panel shown in place of the editor's play button when a
 * recording (from `?url=` or a dropped file) fails to load. Replaces the old blocking
 * `alert()` so a broken share link reads as a clear in-context error with a way out,
 * rather than a blank editor behind an OS dialog.
 */
export default function RecordingLoadError({
  message,
  onRetry,
  onDismiss,
}: RecordingLoadErrorProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-6" role="alert">
      <div className="max-w-sm rounded-xl border border-slate-700 bg-[#151821] p-6 text-center shadow-[0_18px_40px_rgba(2,6,23,0.45)]">
        <p className="text-sm font-semibold text-white">Couldn&rsquo;t load this recording</p>
        <p className="mt-2 text-xs leading-relaxed text-slate-400 wrap-break-word">{message}</p>
        {onRetry || onDismiss ? (
          <div className="mt-4 flex items-center justify-center gap-2">
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg bg-slate-700 px-4 py-2 text-xs font-medium text-slate-100 transition-colors hover:bg-slate-600 hover:text-white"
              >
                Retry
              </button>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg px-4 py-2 text-xs font-medium text-slate-400 transition-colors hover:text-white"
              >
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
