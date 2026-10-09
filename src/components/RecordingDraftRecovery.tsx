import { useEffect, useState } from "react";
import { History, Trash2 } from "lucide-react";
import type { Recording } from "../core/src";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  getRecordingDraftStore,
  type RecordingDraftMeta,
} from "../storage/recordingDrafts/recordingDraftStore";
import {
  discardRecordingDraft,
  holdRecordingDraft,
  linkRecordingToDraft,
  listOwnedRecordingDraftIds,
  subscribeRecordingDrafts,
} from "../storage/recordingDrafts/recordingDraftJournal";
import { recoverRecordingDraft } from "../storage/recordingDrafts/recoverRecordingDraft";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";

/** The newest draft no open tab owns: a take whose tab crashed, reloaded or closed. */
async function findOrphanedDraft(): Promise<RecordingDraftMeta | null> {
  const [drafts, owned] = await Promise.all([
    getRecordingDraftStore().listDrafts(),
    listOwnedRecordingDraftIds(),
  ]);
  return drafts.find((draft) => !owned.has(draft.id)) ?? null;
}

const formatStartedAt = (startedAt: number) =>
  new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * Offers back a take the author never saved: the draft journal kept it while it
 * recorded, and its tab went away before it was uploaded or exported. Recovering
 * opens it like a take that just finished.
 */
export default function RecordingDraftRecovery({
  onRecovered,
}: {
  onRecovered: (recording: Recording) => void;
}) {
  const { isRecording } = useNextEditorMetadata();
  const [draft, setDraft] = useState<RecordingDraftMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Keep unmounts as it is pressed, so the Discard that replaces it takes focus.
  const [returnFocusToDiscard, setReturnFocusToDiscard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof indexedDB === "undefined") return;
    let cancelled = false;
    const refresh = () => {
      findOrphanedDraft()
        .then((found) => {
          if (cancelled) return;
          setDraft(found);
          setConfirmingDiscard(false);
          setReturnFocusToDiscard(false);
          setError(null);
        })
        .catch((reason: unknown) => {
          console.warn("Could not check for unsaved recordings:", reason);
        });
    };
    refresh();
    const unsubscribe = subscribeRecordingDrafts(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!draft || isRecording) return null;

  const handleRecover = async () => {
    setBusy(true);
    setError(null);
    try {
      const recording = await recoverRecordingDraft(draft.id);
      if (!recording) {
        setError("Nothing in this recording could be played back.");
        setConfirmingDiscard(true);
        return;
      }
      linkRecordingToDraft(recording.id, draft.id);
      // This tab owns the draft now: it stays until the take is uploaded or exported.
      holdRecordingDraft(draft.id);
      onRecovered(recording);
    } catch (reason) {
      console.error("Failed to recover the recording:", reason);
      setError("This recording could not be recovered.");
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    try {
      await discardRecordingDraft(draft.id);
    } catch (reason) {
      console.error("Failed to delete the unsaved recording:", reason);
      setError("This recording could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="recording-draft-recovery-title"
      className="absolute bottom-3 left-3 z-30 w-[min(22rem,calc(100%-1.5rem))] rounded-lg border border-slate-700 bg-[#151821] p-3 text-sm text-slate-200 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
    >
      <div className="flex items-start gap-2.5">
        <History size={16} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p id="recording-draft-recovery-title" className="font-semibold text-slate-100">
            {draft.finished ? "Unsaved recording" : "Interrupted recording"}
          </p>
          <p className="mt-0.5 text-xs text-slate-400">
            {formatStartedAt(draft.startedAt)} · {formatPlaybackTime(draft.durationMs)}
            {draft.finished ? "" : " before the page closed"}
          </p>
          {error ? (
            <p role="alert" className="mt-1.5 text-xs text-red-400">
              {error}
            </p>
          ) : null}
          <div className="mt-2.5 flex items-center gap-2">
            {confirmingDiscard ? (
              <>
                <span className="mr-auto text-xs text-slate-300">Delete it for good?</span>
                {/* Keyed apart from Discard, which holds the same slot: React would reuse one
                    node for both, leaving focus on Delete and never mounting Discard afresh. */}
                <button
                  key="delete"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDiscard()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  Delete
                </button>
                {/* Mounts only after a press (Discard, or a Recover that found nothing), so it
                    takes focus from the button that just went away. */}
                <button
                  type="button"
                  disabled={busy}
                  autoFocus
                  onClick={() => {
                    setConfirmingDiscard(false);
                    setReturnFocusToDiscard(true);
                  }}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-60"
                >
                  Keep
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRecover()}
                  className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-950 transition-colors hover:bg-white disabled:opacity-60"
                >
                  {busy ? "Recovering…" : "Recover"}
                </button>
                <button
                  key="discard"
                  type="button"
                  disabled={busy}
                  autoFocus={returnFocusToDiscard}
                  onClick={() => {
                    setConfirmingDiscard(true);
                    setReturnFocusToDiscard(false);
                  }}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-60"
                >
                  Discard
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
