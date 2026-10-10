import { Captions, Download, Loader2, Sparkles } from "lucide-react";
import type { CaptionTrack, Recording } from "../../core/src/types";
import { serializeCuesToVtt } from "../../captions/serializeVtt";
import {
  describeCaptionGeneration,
  type CaptionGeneration,
} from "../../hooks/useCaptionGeneration";
import { downloadBlob } from "../../utils/downloadBlob";

/**
 * The captions rows of the player's Settings menu: Import, Generate (or the running job with
 * Cancel), Download, and an alert for an import or a captioning job that failed. The player
 * bar keeps the captioning job (so it outlives the menu) and the hidden file input.
 */
const CaptionSettings = ({
  recording,
  effectiveRecordMode,
  captionGeneration,
  activeCaptionTrack,
  importError,
  onImport,
}: {
  recording: Recording;
  effectiveRecordMode: boolean;
  captionGeneration: CaptionGeneration;
  /** The track the viewer would see, which Download saves. */
  activeCaptionTrack: CaptionTrack | null;
  importError: string | null;
  onImport: () => void;
}) => {
  const hasNarration = Boolean(recording.audioBlob || recording.audioUrl);
  // Until a cut reaches the narration, its audio runs on the old clock.
  const isNarrationBeingEdited = Boolean(recording.pendingAudioEdit);
  const isGeneratingCaptions = captionGeneration.state.status === "running";

  const handleDownloadCaptions = () => {
    if (!activeCaptionTrack) return;
    downloadBlob(
      new Blob([serializeCuesToVtt(activeCaptionTrack.cues)], { type: "text/vtt" }),
      `${recording.name || "recording"}.${activeCaptionTrack.language}.vtt`,
    );
  };

  return (
    <div className="border-t border-slate-700 pt-3">
      <button
        type="button"
        onClick={onImport}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
      >
        <Captions size={14} aria-hidden="true" />
        Import captions…
      </button>
      {/* Alerts: they come after the picker closes, with focus left on the
              button, and are inserted (not changed in place) on each failure. */}
      {importError && (
        <p role="alert" className="px-2 pt-2 text-xs text-red-400">
          {importError}
        </p>
      )}
      {effectiveRecordMode && hasNarration ? (
        isGeneratingCaptions ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-300">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            <span className="flex-1">{describeCaptionGeneration(captionGeneration.state)}</span>
            <button
              type="button"
              onClick={captionGeneration.cancel}
              className="font-medium text-slate-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void captionGeneration.start(recording)}
            disabled={isNarrationBeingEdited}
            title="Transcribe the narration on this device; the audio never leaves your browser"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Sparkles size={14} aria-hidden="true" />
            Generate captions
          </button>
        )
      ) : null}
      {captionGeneration.state.status === "failed" ? (
        <p role="alert" className="px-2 pt-1 text-xs text-red-400">
          {describeCaptionGeneration(captionGeneration.state)}
        </p>
      ) : null}
      {effectiveRecordMode && activeCaptionTrack ? (
        <button
          type="button"
          onClick={handleDownloadCaptions}
          title="Save these captions as WebVTT, to correct and import again"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
        >
          <Download size={14} aria-hidden="true" />
          Download captions (.vtt)
        </button>
      ) : null}
    </div>
  );
};

export default CaptionSettings;
