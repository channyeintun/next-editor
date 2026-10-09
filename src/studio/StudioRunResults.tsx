import type { ActionReceipt, StudioCheckResult, StudioRenderReport } from "./report";

/**
 * The studio console's results for a render (see StudioController): each action's
 * receipt as it lands, the finished report's QA checks, and the two-render
 * repeatability verdict. Stateless; the controller decides when each is shown.
 */

/** One line per performed action (status, planned-vs-actual start), then the failures. */
export function ReceiptList({ receipts }: { receipts: ActionReceipt[] }) {
  return (
    <div className="mt-3">
      <h3 className="font-semibold text-slate-300">Receipts</h3>
      <ul className="mt-1 space-y-0.5 font-mono text-[12px]">
        {receipts.map((receipt) => (
          <li key={receipt.actionId} className="flex items-center gap-2">
            <span
              className={
                receipt.status === "ok"
                  ? "text-emerald-400"
                  : receipt.status === "failed"
                    ? "text-rose-400"
                    : "text-slate-400"
              }
            >
              {receipt.status === "ok" ? "✓" : receipt.status === "failed" ? "✗" : "–"}
            </span>
            <span className="truncate">{receipt.actionId}</span>
            <span className="ml-auto shrink-0 text-slate-400">
              {receipt.startedAtMs !== null
                ? `${Math.round(receipt.startedAtMs)}ms (+${Math.round(
                    (receipt.startedAtMs ?? 0) - receipt.plannedAtMs,
                  )})`
                : "—"}
            </span>
          </li>
        ))}
      </ul>
      {receipts.some((receipt) => receipt.error) ? (
        <ul className="mt-1 space-y-0.5 text-[12px] text-rose-300">
          {receipts
            .filter((receipt) => receipt.error)
            .map((receipt) => {
              const screenshot = receipt.detail?.diagnosticScreenshot;
              const screenshotDataUrl =
                screenshot &&
                typeof screenshot === "object" &&
                "dataUrl" in screenshot &&
                typeof screenshot.dataUrl === "string"
                  ? screenshot.dataUrl
                  : null;
              return (
                <li key={`${receipt.actionId}-error`}>
                  {receipt.actionId}: {receipt.error}
                  {screenshotDataUrl ? (
                    <img
                      src={screenshotDataUrl}
                      alt={`Preview diagnostic for ${receipt.actionId}`}
                      className="mt-1 max-h-40 rounded border border-rose-400/30"
                    />
                  ) : null}
                </li>
              );
            })}
        </ul>
      ) : null}
    </div>
  );
}

/** The finished render's QA checks (with any preview diagnostic) and page errors. */
export function CheckList({ report }: { report: StudioRenderReport }) {
  return (
    <div className="mt-3">
      <h3 className="font-semibold text-slate-300">
        Checks{" "}
        <span className="text-slate-400">
          ({report.checks.filter((check) => check.ok).length}/{report.checks.length} ok
          {report.timing ? ` · p95 ${report.timing.p95Ms}ms` : ""})
        </span>
      </h3>
      <ul className="mt-1 space-y-0.5 text-[12px]">
        {report.checks.map((check) => {
          const screenshot = check.diagnostic?.previewScreenshot;
          return (
            <li key={check.id} className={check.ok ? "text-slate-400" : "text-rose-300"}>
              {check.ok ? "✓" : "✗"} <span className="font-mono">{check.id}</span> — {check.detail}
              {screenshot && "dataUrl" in screenshot ? (
                <img
                  src={screenshot.dataUrl}
                  alt={`Preview diagnostic for ${check.id}`}
                  className="mt-1 max-h-40 rounded border border-rose-400/30"
                />
              ) : screenshot && "error" in screenshot ? (
                <span className="block text-rose-400">Screenshot: {screenshot.error}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {report.errors.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[12px] text-rose-300">
          {report.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Whether this render matched the previous render of the same plan, check by check. */
export function RepeatabilityVerdict({ checks }: { checks: StudioCheckResult[] }) {
  const passed = checks.every((check) => check.ok);
  return (
    <div className="mt-3">
      <h3 className="font-semibold text-slate-300">
        Repeatability{" "}
        <span className={passed ? "text-emerald-400" : "text-rose-400"}>
          {passed ? "PASS" : "FAIL"}
        </span>
      </h3>
      <ul className="mt-1 space-y-0.5 text-[12px]">
        {checks.map((check) => (
          <li key={check.id} className={check.ok ? "text-slate-400" : "text-rose-300"}>
            {check.ok ? "✓" : "✗"} <span className="font-mono">{check.id}</span> — {check.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
