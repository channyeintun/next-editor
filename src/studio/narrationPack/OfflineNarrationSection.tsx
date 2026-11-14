import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import HoverRing from "../../components/hoverRing/HoverRing";
import { COLAB_NOTEBOOK_URL } from "./colabNotebook";
import {
  coverageReportOf,
  exportNarrationRequests,
  importNarrationFiles,
  offlineNarrationStore,
  selectionKeyOf,
  type NarrationCoverageReport,
  type OfflineNarrationApi,
  type OfflineNarrationStatus,
} from "./offlineNarration";

/**
 * The Workflow tab's offline narration controls: export the picked lessons'
 * VoxCPM2 requests for the Colab notebook, import the audio it wrote, and see
 * which of the picked lessons this browser can narrate by itself. The console
 * supplies the actions, bound to the narration it is set to; what is running
 * and how it ended live in the store, so they are still here when the tab
 * comes back.
 */

const BUTTON =
  "shrink-0 rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";

const TONE_CLASS: Record<OfflineNarrationStatus["tone"], string> = {
  ok: "text-slate-300",
  warning: "text-amber-300",
  error: "text-rose-200",
};

/** A selection is often built one click at a time: count once it rests. */
const COVERAGE_DELAY_MS = 300;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function OfflineNarrationSection({
  api,
  slugs,
  onPickOnly,
}: {
  api: OfflineNarrationApi;
  /** The lessons picked for the workflow, in its order. */
  slugs: readonly string[];
  /** Narrow the workflow's selection to these lessons. */
  onPickOnly?: (slugs: readonly string[]) => void;
}) {
  const busy = useSelector(offlineNarrationStore, (snapshot) => snapshot.context.busy);
  const importedTakes = useSelector(
    offlineNarrationStore,
    (snapshot) => snapshot.context.importedTakes,
  );
  const importsEnded = useSelector(
    offlineNarrationStore,
    (snapshot) => snapshot.context.importsEnded,
  );
  const status = useSelector(offlineNarrationStore, (snapshot) => snapshot.context.status);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const coverageRef = useRef<HTMLParagraphElement | null>(null);
  const [coverage, setCoverage] = useState<{
    forKey: string;
    report: NarrationCoverageReport | null;
  } | null>(null);

  // An export's result is about the lessons it was asked for: once the
  // selection changes it no longer describes what the button would export.
  const selectionKey = selectionKeyOf(slugs);
  const shown =
    status && (status.forSlugs === undefined || status.forSlugs === selectionKey) ? status : null;
  const exportHint =
    api.exportBlockedReason ??
    (slugs.length === 0
      ? "Pick the lessons above to export their requests, and to see which of them this browser can already narrate. Audio can be imported at any time."
      : "The export leaves out dialogs this browser already keeps.");

  // What the picked lessons still lack is counted for the selection as it is
  // now and for the takes kept now: an import that ends changes the answer.
  // Without the narrator the requests cannot be told, and during an import
  // the count would be of a cache that is still filling.
  const countable = api.exportBlockedReason === null && slugs.length > 0 && busy !== "import";
  const coverageKey = `${importsEnded}\n${selectionKey}`;
  const countCoverage = useEffectEvent((signal: AbortSignal) => api.coverageOf(slugs, signal));
  useEffect(() => {
    if (!countable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      countCoverage(controller.signal).then(
        (counted) => {
          if (controller.signal.aborted) return;
          setCoverage({ forKey: coverageKey, report: coverageReportOf(counted) });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setCoverage({
            forKey: coverageKey,
            report: {
              status: {
                tone: "warning",
                text: `Could not tell which picked lessons have narration in this browser (${reasonOf(error)}).`,
              },
              completeOnly: null,
            },
          });
        },
      );
    }, COVERAGE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [countable, coverageKey]);
  const counted = countable && coverage?.forKey === coverageKey ? coverage.report : null;
  const completeOnly = counted?.completeOnly ?? null;

  return (
    <div>
      <h3 className="font-semibold text-slate-100">Narrate on Google Colab</h3>
      <p className="mt-1 text-[12px] text-slate-400">
        Makes the Burmese narration on a Colab GPU instead of the hosted one. Export the picked
        lessons&apos; narration requests, run them through{" "}
        <a
          href={COLAB_NOTEBOOK_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sky-300 underline underline-offset-2 hover:text-sky-200"
        >
          the notebook
        </a>
        , then import the audio it writes. Renders find that audio in this browser and ask no speech
        service for it. The notebook writes the audio in parts of a few dozen dialogs each, so the
        number of parts is not the number of lessons that are ready.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void exportNarrationRequests(api, slugs)}
          disabled={api.exportBlockedReason !== null || busy !== null || slugs.length === 0}
          aria-describedby="studio-offline-narration-hint"
          className={BUTTON}
        >
          {busy === "export"
            ? "Exporting…"
            : `Export requests${slugs.length > 0 ? ` (${slugs.length})` : ""}`}
          <HoverRing />
        </button>
        <button
          type="button"
          onClick={() => audioInputRef.current?.click()}
          disabled={busy !== null}
          className={BUTTON}
        >
          {busy === "import"
            ? `Importing… ${importedTakes.toLocaleString("en-US")}`
            : "Import audio…"}
          <HoverRing />
        </button>
        <input
          ref={audioInputRef}
          type="file"
          multiple
          accept=".zip,.flac,.wav"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void importNarrationFiles(api, files);
          }}
        />
      </div>
      <p
        id="studio-offline-narration-hint"
        className={`mt-1 text-[12px] ${api.exportBlockedReason ? "text-amber-300" : "text-slate-400"}`}
      >
        {exportHint}
      </p>
      {/* Always mounted, so what an export or import reports is announced when it arrives. */}
      <p role="status" className={`text-[12px] ${shown ? TONE_CLASS[shown.tone] : ""}`}>
        {shown?.text}
      </p>
      {countable && !counted ? (
        <p className="mt-1 text-[12px] text-slate-400">
          Counting the picked lessons&apos; narration in this browser…
        </p>
      ) : null}
      {/* Always mounted too: the count is announced when it arrives, not while it is made. */}
      <p
        ref={coverageRef}
        tabIndex={-1}
        aria-live="polite"
        data-testid="studio-offline-narration-coverage"
        className={`text-[12px] outline-none ${counted ? `mt-1 ${TONE_CLASS[counted.status.tone]}` : ""}`}
      >
        {counted?.status.text}
      </p>
      {completeOnly && onPickOnly ? (
        <button
          type="button"
          onClick={() => {
            onPickOnly(completeOnly);
            // This button goes with the selection it narrows; the count that
            // replaces it is where the reader's place is.
            coverageRef.current?.focus();
          }}
          className={`mt-1.5 ${BUTTON}`}
        >
          {completeOnly.length === 1
            ? "Pick only the 1 lesson with all its narration"
            : `Pick only the ${completeOnly.length.toLocaleString("en-US")} lessons with all their narration`}
          <HoverRing />
        </button>
      ) : null}
    </div>
  );
}
