import { useRef } from "react";
import { useSelector } from "@xstate/store-react";
import HoverRing from "../../components/hoverRing/HoverRing";
import { COLAB_NOTEBOOK_URL } from "./colabNotebook";
import {
  exportNarrationRequests,
  importNarrationFiles,
  offlineNarrationStore,
  selectionKeyOf,
  type OfflineNarrationApi,
  type OfflineNarrationStatus,
} from "./offlineNarration";

/**
 * The Workflow tab's offline narration controls: export the picked lessons'
 * VoxCPM2 requests for the Colab notebook, and import the audio it wrote. The
 * console supplies both actions, bound to the narration it is set to; what is
 * running and how it ended live in the store, so they are still here when the
 * tab comes back.
 */

const BUTTON =
  "shrink-0 rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";

const TONE_CLASS: Record<OfflineNarrationStatus["tone"], string> = {
  ok: "text-slate-300",
  warning: "text-amber-300",
  error: "text-rose-200",
};

export default function OfflineNarrationSection({
  api,
  slugs,
}: {
  api: OfflineNarrationApi;
  /** The lessons picked for the workflow, in its order. */
  slugs: readonly string[];
}) {
  const busy = useSelector(offlineNarrationStore, (snapshot) => snapshot.context.busy);
  const importedTakes = useSelector(
    offlineNarrationStore,
    (snapshot) => snapshot.context.importedTakes,
  );
  const status = useSelector(offlineNarrationStore, (snapshot) => snapshot.context.status);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  // An export's result is about the lessons it was asked for: once the
  // selection changes it no longer describes what the button would export.
  const shown =
    status && (status.forSlugs === undefined || status.forSlugs === selectionKeyOf(slugs))
      ? status
      : null;
  const exportHint =
    api.exportBlockedReason ??
    (slugs.length === 0
      ? "Pick the lessons above to export their requests. Audio can be imported at any time."
      : "The export leaves out dialogs this browser already keeps.");

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
        service for it.
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
    </div>
  );
}
