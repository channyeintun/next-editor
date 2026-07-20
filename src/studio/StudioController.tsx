import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "@next-editor/infra";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { markTourSeen } from "../components/tour/productTour";
import { canonicalJson } from "./hash";
import type { StudioRuntimeMode } from "./plan";
import { DEFAULT_STUDIO_PLAN_SLUG, STUDIO_PLANS } from "./plans";
import type { ActionReceipt, StudioCheckResult } from "./report";
import { compareRenderSemantics, runStudioRender, type StudioRunResult } from "./runStudioRender";
import type { RenderSemantics } from "./compare";

/**
 * Dev-only render console for the studio route: prepares the pinned workspace,
 * drives one unattended render of a checked-in plan through the Performer, and
 * surfaces receipts, QA gates, and the two-render repeatability verdict
 * (docs/agent-lesson-production.md §12 M0). Results are also published on
 * `window.__NEXT_EDITOR_STUDIO__` so an automation harness can read them
 * without scraping the DOM.
 */

interface StudioRunEntry {
  index: number;
  mode: StudioRuntimeMode;
  result: StudioRunResult;
}

// Module-level so StrictMode remounts and rerenders never re-trigger or lose
// runs; cleared only by a full page load.
const runHistory: StudioRunEntry[] = [];
let autostartFired = false;

declare global {
  interface Window {
    __NEXT_EDITOR_STUDIO__?: {
      runs: {
        index: number;
        mode: StudioRuntimeMode;
        outcome: string;
        report: StudioRunEntry["result"]["report"];
        manifest: StudioRunEntry["result"]["manifest"];
      }[];
      comparison: StudioCheckResult[] | null;
      running: boolean;
    };
  }
}

function semanticsStorageKey(slug: string, mode: StudioRuntimeMode): string {
  return `next-editor:studio:semantics:${slug}:${mode}`;
}

function readStoredSemantics(slug: string, mode: StudioRuntimeMode): RenderSemantics | null {
  try {
    const raw = sessionStorage.getItem(semanticsStorageKey(slug, mode));
    return raw ? (JSON.parse(raw) as RenderSemantics) : null;
  } catch {
    return null;
  }
}

function storeSemantics(slug: string, mode: StudioRuntimeMode, semantics: RenderSemantics): void {
  try {
    sessionStorage.setItem(semanticsStorageKey(slug, mode), JSON.stringify(semantics));
  } catch {
    // Session storage unavailable — cross-reload comparison is best-effort.
  }
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function publishWindowHandle(comparison: StudioCheckResult[] | null, running: boolean): void {
  window.__NEXT_EDITOR_STUDIO__ = {
    runs: runHistory.map((entry) => ({
      index: entry.index,
      mode: entry.mode,
      outcome: entry.result.report.outcome,
      report: entry.result.report,
      manifest: entry.result.manifest,
    })),
    comparison,
    running,
  };
}

export default function StudioController() {
  const [searchParams] = useSearchParams();
  const actor = NextEditorActorContext.useActorRef();
  const nextEditor = useNextEditorActions();
  const workspace = useWorkspaceActions();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const { isSignedIn, isLoading: authLoading } = useAuth();

  const planSlug = searchParams.get("plan") ?? DEFAULT_STUDIO_PLAN_SLUG;
  const requestedMode = searchParams.get("runtime") === "live" ? "live" : null;
  const autostart = searchParams.get("autostart") === "1";

  const [phase, setPhase] = useState<string>("idle");
  const [running, setRunning] = useState(false);
  const [receipts, setReceipts] = useState<ActionReceipt[]>([]);
  const [latest, setLatest] = useState<StudioRunEntry | null>(runHistory.at(-1) ?? null);
  const [comparison, setComparison] = useState<StudioCheckResult[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const runningRef = useRef(false);

  // The product tour would overlay the editor mid-render in a fresh profile.
  useEffect(() => {
    markTourSeen();
  }, []);

  const runRender = async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setFatal(null);
    setReceipts([]);
    setComparison(null);
    publishWindowHandle(null, true);

    try {
      const createPlan = STUDIO_PLANS[planSlug];
      if (!createPlan) {
        throw new Error(
          `Unknown plan "${planSlug}" — available: ${Object.keys(STUDIO_PLANS).join(", ")}`,
        );
      }
      const plan = createPlan();
      const mode: StudioRuntimeMode = requestedMode ?? plan.runtime.defaultMode;

      const result = await runStudioRender(plan, mode, {
        actor,
        nextEditor,
        getEditor: () => nextEditor.editorRef.current,
        workspace,
        runtimePanelStore,
        isSignedIn,
        onPhase: setPhase,
        onProgress: (receipt) => setReceipts((current) => [...current, receipt]),
      });

      const entry: StudioRunEntry = { index: runHistory.length + 1, mode, result };
      runHistory.push(entry);
      setLatest(entry);

      let nextComparison: StudioCheckResult[] | null = null;
      if (result.semantics) {
        const previous =
          runHistory
            .slice(0, -1)
            .reverse()
            .find((run) => run.mode === mode)?.result.semantics ??
          readStoredSemantics(plan.lesson.slug, mode);
        if (previous) {
          nextComparison = compareRenderSemantics(previous, result.semantics);
          setComparison(nextComparison);
        }
        storeSemantics(plan.lesson.slug, mode, result.semantics);
      }
      publishWindowHandle(nextComparison, false);
      setPhase(result.report.outcome === "passed" ? "done" : "failed");
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
      setPhase("failed");
      publishWindowHandle(null, false);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  useEffect(() => {
    publishWindowHandle(comparison, runningRef.current);
  }, [comparison, latest]);

  // One-shot per page load (module flag): StrictMode remounts and later
  // re-renders must not restart an unattended render.
  useEffect(() => {
    if (!autostart || autostartFired || authLoading) {
      return;
    }
    autostartFired = true;
    void runRender();
  }, [autostart, authLoading, runRender]);

  const report = latest?.result.report ?? null;
  const artifacts = latest?.result.artifacts ?? null;
  const planFactory = STUDIO_PLANS[planSlug];
  const effectiveModeLabel =
    requestedMode ?? (planFactory ? planFactory().runtime.defaultMode : "?");

  const downloadBundle = () => {
    if (!latest || !artifacts) {
      return;
    }
    const base = `lesson-${latest.result.report.planSlug}`;
    downloadBlob(`${base}.ne`, artifacts.neBlob);
    downloadBlob(artifacts.audioFileName || `${base}.m4a`, artifacts.audioBlob);
    downloadBlob(
      "build-manifest.json",
      new Blob([canonicalJson(latest.result.manifest)], { type: "application/json" }),
    );
    downloadBlob(
      "render-report.json",
      new Blob([JSON.stringify(latest.result.report, null, 2)], { type: "application/json" }),
    );
  };

  const downloadReport = () => {
    if (!latest) {
      return;
    }
    downloadBlob(
      "render-report.json",
      new Blob([JSON.stringify(latest.result.report, null, 2)], { type: "application/json" }),
    );
  };

  return (
    <div className="fixed right-3 top-14 z-70 w-96 max-h-[75vh] overflow-y-auto rounded-xl border border-slate-700 bg-[#0d1117]/95 p-4 text-slate-200 shadow-2xl backdrop-blur text-[13px] leading-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-white">Studio render</h2>
        <span
          className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
            phase === "done"
              ? "bg-emerald-500/15 text-emerald-300"
              : phase === "failed"
                ? "bg-rose-500/15 text-rose-300"
                : running
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-slate-500/15 text-slate-300"
          }`}
        >
          {running ? phase : phase === "idle" ? "ready" : phase}
        </span>
      </div>

      <p className="mt-1 text-slate-400">
        plan <span className="font-mono text-slate-300">{planSlug}</span>
        {" · runtime "}
        <span className="font-mono text-slate-300">{effectiveModeLabel}</span>
        {" · run #"}
        {runHistory.length + (running ? 1 : 0) || 1}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void runRender();
          }}
          disabled={running || authLoading}
          className="rounded-md bg-[#173925] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {runHistory.length === 0 ? "Start render" : "Render again"}
        </button>
        <button
          type="button"
          onClick={downloadBundle}
          disabled={!artifacts}
          className="rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Download bundle
        </button>
        {report && !artifacts ? (
          <button
            type="button"
            onClick={downloadReport}
            className="rounded-md bg-[#3b2a22] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#efb28d] transition-colors hover:bg-[#4d382a]"
          >
            Download report
          </button>
        ) : null}
      </div>

      {fatal ? (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-200">
          {fatal}
        </p>
      ) : null}

      {receipts.length > 0 ? (
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
                        : "text-slate-500"
                  }
                >
                  {receipt.status === "ok" ? "✓" : receipt.status === "failed" ? "✗" : "–"}
                </span>
                <span className="truncate">{receipt.actionId}</span>
                <span className="ml-auto shrink-0 text-slate-500">
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
                .map((receipt) => (
                  <li key={`${receipt.actionId}-error`}>
                    {receipt.actionId}: {receipt.error}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {report ? (
        <div className="mt-3">
          <h3 className="font-semibold text-slate-300">
            Checks{" "}
            <span className="text-slate-500">
              ({report.checks.filter((check) => check.ok).length}/{report.checks.length} ok
              {report.timing ? ` · p95 ${report.timing.p95Ms}ms` : ""})
            </span>
          </h3>
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {report.checks.map((check) => (
              <li key={check.id} className={check.ok ? "text-slate-400" : "text-rose-300"}>
                {check.ok ? "✓" : "✗"} <span className="font-mono">{check.id}</span> —{" "}
                {check.detail}
              </li>
            ))}
          </ul>
          {report.errors.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[12px] text-rose-300">
              {report.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {comparison ? (
        <div className="mt-3">
          <h3 className="font-semibold text-slate-300">
            Repeatability{" "}
            <span
              className={
                comparison.every((check) => check.ok) ? "text-emerald-400" : "text-rose-400"
              }
            >
              {comparison.every((check) => check.ok) ? "PASS" : "FAIL"}
            </span>
          </h3>
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {comparison.map((check) => (
              <li key={check.id} className={check.ok ? "text-slate-400" : "text-rose-300"}>
                {check.ok ? "✓" : "✗"} <span className="font-mono">{check.id}</span> —{" "}
                {check.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
