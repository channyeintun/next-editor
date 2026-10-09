import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Loader2, Scissors, Sparkles, VolumeX, X } from "lucide-react";
import type { Recording } from "../core/src";
import {
  useLiveTime,
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
} from "../hooks/useNextEditorContext";
import { selectLiveTime } from "../core/src/useNextEditor";
import { usePlaybackSettings } from "../hooks/usePlaybackSettings";
import { applyRecordingEdit } from "../core/src/recordingEdit";
import {
  computeAudioPeaks,
  suggestDeadAirCuts,
  type AudioPeaks,
} from "../core/src/utils/audioPeaks";
import { normalizeMediaSpans, type MediaSpan } from "../core/src/utils/mediaSpans";
import { relinkRecordingDraft } from "../storage/recordingDrafts/recordingDraftJournal";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";

type EditKind = "cut" | "mute";

interface EditSpan extends MediaSpan {
  kind: EditKind;
}

/** A drag shorter than this is a click: it seeks instead of selecting. */
const CLICK_SLOP_PX = 4;

const EDIT_COLORS: Record<EditKind, string> = {
  cut: "rgba(239, 68, 68, 0.35)",
  mute: "rgba(245, 158, 11, 0.35)",
};

type NarrationState = "loading" | "ready" | "none" | "failed";

/** Shown over the waveform while it has no narration drawn on it. */
const NARRATION_NOTICE: Record<Exclude<NarrationState, "ready">, string> = {
  loading: "Reading the narration…",
  none: "No narration: cuts still apply to everything else",
  failed: "The narration could not be read",
};

/** The Cut, Mute and Suggest buttons under the waveform. */
const EDIT_BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-600 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-slate-700 disabled:opacity-40";

/** When anything was recorded happening, for telling dead air from a quiet demo. */
function activityTimes(recording: Recording): number[] {
  const times: number[] = [];
  const add = (entries: ReadonlyArray<{ timestamp: number }> | undefined) => {
    for (const entry of entries ?? []) times.push(entry.timestamp);
  };
  add(recording.frames);
  add(recording.slideEvents);
  add(recording.previewEvents);
  add(recording.workspaceEvents);
  add(recording.runtimeEvents);
  add(recording.whiteboardEvents);
  add(recording.chatEvents);
  for (const batch of recording.previewPatchBatches ?? []) times.push(batch.time);
  return times;
}

/** The recording's narration as a Blob: a take has one, an imported lesson may only link it. */
async function loadNarration(recording: Recording): Promise<Blob | null> {
  if (recording.audioBlob instanceof Blob) return recording.audioBlob;
  if (!recording.audioUrl) return null;
  const response = await fetch(recording.audioUrl);
  if (!response.ok) throw new Error(`The narration could not be loaded (${response.status})`);
  return response.blob();
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: AudioPeaks | null,
  durationMs: number,
  audioOffsetMs: number,
) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#475569";
  const middle = height / 2;
  if (!peaks || durationMs <= 0) {
    context.fillRect(0, middle, width, 1);
    return;
  }
  for (let x = 0; x < width; x++) {
    const from = ((x / width) * durationMs - audioOffsetMs) / peaks.bucketMs;
    const to = (((x + 1) / width) * durationMs - audioOffsetMs) / peaks.bucketMs;
    let level = 0;
    for (let bucket = Math.max(0, Math.floor(from)); bucket < Math.ceil(to); bucket++) {
      level = Math.max(level, peaks.peaks[bucket] ?? 0);
    }
    const bar = Math.max(1, level * (height - 4));
    context.fillRect(x, middle - bar / 2, 1, bar);
  }
}

/** The playhead, and the preview of the pending edits while the recording plays. */
function EditPlayhead({
  durationMs,
  cuts,
  mutes,
}: {
  durationMs: number;
  cuts: readonly MediaSpan[];
  mutes: readonly MediaSpan[];
}) {
  const currentTime = useLiveTime();
  const { isPlaying } = useNextEditorMetadata();
  const { seekTo, setVolume } = useNextEditorActions();
  const { volume } = usePlaybackSettings();

  // Playing through the pending edits: a cut is skipped and a mute is silent, so the
  // author hears the result before applying it.
  const insideCut = isPlaying
    ? cuts.find((cut) => currentTime >= cut.start && currentTime < cut.end - 1)
    : undefined;
  useEffect(() => {
    if (insideCut) seekTo(insideCut.end);
  }, [insideCut, seekTo]);

  const insideMute =
    isPlaying && mutes.some((mute) => currentTime >= mute.start && currentTime < mute.end);
  useEffect(() => {
    setVolume(insideMute ? 0 : volume);
  }, [insideMute, setVolume, volume]);
  // Closing the panel inside a muted stretch must not leave playback silent.
  useEffect(() => () => setVolume(volume), [setVolume, volume]);

  const left = durationMs > 0 ? Math.min(100, (currentTime / durationMs) * 100) : 0;
  return (
    <div
      className="pointer-events-none absolute inset-y-0 w-px bg-sky-400"
      style={{ left: `${left}%` }}
    />
  );
}

/**
 * Cuts and mutes stretches of a finished recording. The author selects a stretch on
 * the narration's waveform (or asks for the dead air), and applying loads the edited
 * recording in place of this one (see applyRecordingEdit).
 */
export default function RecordingEditPanel({
  recording,
  onClose,
  onApplied,
}: {
  recording: Recording;
  onClose: () => void;
  onApplied: (recording: Recording) => void;
}) {
  const { seekTo, loadRecording } = useNextEditorActions();
  const { currentRecording } = useNextEditorMetadata();
  // The playhead is read when an edge is marked, not subscribed to: useLiveTime would
  // re-render the whole panel on every frame.
  const { editorActor } = useNextEditorPlayback();
  const [edits, setEdits] = useState<EditSpan[]>([]);
  const [selection, setSelection] = useState<MediaSpan | null>(null);
  const [narration, setNarration] = useState<{ blob: Blob; peaks: AudioPeaks } | null>(null);
  const [narrationState, setNarrationState] = useState<NarrationState>("loading");
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startTime: number } | null>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);

  const durationMs = recording.duration;
  const audioOffsetMs = recording.audioStartOffsetMs ?? 0;
  const cuts = normalizeMediaSpans(edits.filter((edit) => edit.kind === "cut"));
  const mutes = normalizeMediaSpans(edits.filter((edit) => edit.kind === "mute"));
  const removedMs = cuts.reduce((total, cut) => total + (cut.end - cut.start), 0);

  // The panel is rendered before the player bar that opens it, so Tab from the opener
  // would never reach it: focus moves into it on open. Closing unmounts the focused
  // control, so focus goes back to the opener, but only when it was lost with the panel
  // (never taken from the editor or anything else focused since).
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      const active = document.activeElement;
      if ((active === null || active === document.body) && opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadNarration(recording)
      .then(async (blob) => {
        if (!blob) {
          if (!cancelled) setNarrationState("none");
          return;
        }
        const peaks = await computeAudioPeaks(blob);
        if (cancelled) return;
        setNarration({ blob, peaks });
        setNarrationState("ready");
      })
      .catch((reason: unknown) => {
        console.warn("Could not read the narration for editing:", reason);
        if (!cancelled) setNarrationState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawWaveform(canvas, narration?.peaks ?? null, durationMs, audioOffsetMs);
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [narration, durationMs, audioOffsetMs]);

  // Applying loads the edited recording, whose narration is cut while it loads. Only the
  // loaded one has the cut narration, so that is the one handed on (to be uploaded).
  useEffect(() => {
    if (!applyingId || currentRecording?.id !== applyingId) return;
    onApplied(currentRecording);
    onClose();
  }, [applyingId, currentRecording, onApplied, onClose]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * durationMs;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startTime: timeAt(event.clientX) };
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || Math.abs(event.clientX - drag.startX) < CLICK_SLOP_PX) return;
    const time = timeAt(event.clientX);
    setSelection({ start: Math.min(drag.startTime, time), end: Math.max(drag.startTime, time) });
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && Math.abs(event.clientX - drag.startX) < CLICK_SLOP_PX) {
      setSelection(null);
      seekTo(drag.startTime);
    }
  };

  // The keyboard (and single-pointer) way to select: seek, then mark each edge at the
  // playhead. An edge past the other one moves both to it.
  const markSelection = (edge: "start" | "end") => {
    const time = Math.min(durationMs, Math.max(0, selectLiveTime(editorActor.getSnapshot())));
    setSelection((current) =>
      edge === "start"
        ? { start: time, end: Math.max(time, current?.end ?? time) }
        : { start: Math.min(time, current?.start ?? time), end: time },
    );
  };

  const addEdit = (kind: EditKind) => {
    if (!selection || selection.end - selection.start < 1) return;
    setEdits((current) => [...current, { kind, ...selection }]);
    setSelection(null);
    // Cut and Mute are disabled once the selection clears, which would drop keyboard
    // focus to the page; the next stretch starts from here.
    startButtonRef.current?.focus();
  };

  const handleSuggest = () => {
    const suggested = suggestDeadAirCuts({
      durationMs,
      audio: narration ? { ...narration.peaks, offsetMs: audioOffsetMs } : undefined,
      activityTimes: activityTimes(recording),
    });
    if (suggested.length === 0) {
      setError("No stretch of dead air long enough to cut.");
      return;
    }
    setError(null);
    setEdits((current) => [
      ...current,
      ...suggested.map((span) => ({ kind: "cut" as const, ...span })),
    ]);
  };

  const handleApply = () => {
    setError(null);
    // Worked out before the try: the React Compiler skips a whole component that has a
    // conditional inside a try block. Spreading the recording cannot throw.
    const source = narration ? { ...recording, audioBlob: narration.blob } : recording;
    try {
      const edited = applyRecordingEdit(source, { cuts, mutes });
      relinkRecordingDraft(recording.id, edited.id);
      setApplyingId(edited.id);
      loadRecording(edited);
    } catch (reason) {
      setApplyingId(null);
      setError(reason instanceof Error ? reason.message : "The edit could not be applied.");
    }
  };

  const percent = (time: number) => `${(time / durationMs) * 100}%`;
  const applying = applyingId !== null;
  // Suggestions read the narration to keep speech: without it (unreadable, or still
  // loading) they would cut straight through what was said.
  const canSuggest = narrationState === "ready" || narrationState === "none";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="Edit recording"
      tabIndex={-1}
      className="pointer-events-auto absolute bottom-full left-0 z-46 mb-2 w-full rounded-lg border border-slate-700 bg-[#151821] p-3 text-sm text-slate-200 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
    >
      <div className="mb-2 flex items-center gap-2">
        <Scissors size={14} className="text-slate-400" aria-hidden="true" />
        <span className="font-semibold text-slate-100">Edit recording</span>
        <span className="text-xs text-slate-500">
          Drag across the waveform, or set a start and end at the playhead; click to jump there
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the editor"
          className="ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-slate-700 hover:text-white"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div
        className="relative h-20 cursor-crosshair touch-none select-none overflow-hidden rounded-md bg-[#0f131a]"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <canvas ref={canvasRef} className="absolute inset-0 size-full" />
        {edits.map((edit, index) => (
          <div
            key={`${edit.kind}-${index}`}
            className="pointer-events-none absolute inset-y-0"
            style={{
              left: percent(edit.start),
              width: percent(edit.end - edit.start),
              background: EDIT_COLORS[edit.kind],
            }}
          />
        ))}
        {selection ? (
          <div
            className="pointer-events-none absolute inset-y-0 border-x border-sky-300 bg-sky-400/20"
            style={{
              left: percent(selection.start),
              width: percent(selection.end - selection.start),
            }}
          />
        ) : null}
        <EditPlayhead durationMs={durationMs} cuts={cuts} mutes={mutes} />
        {narrationState !== "ready" ? (
          <span className="pointer-events-none absolute right-2 top-1.5 text-[11px] text-slate-500">
            {NARRATION_NOTICE[narrationState]}
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          ref={startButtonRef}
          type="button"
          disabled={applying}
          onClick={() => markSelection("start")}
          className={EDIT_BUTTON_CLASS}
        >
          Start at playhead
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={() => markSelection("end")}
          className={EDIT_BUTTON_CLASS}
        >
          End at playhead
        </button>
        <button
          type="button"
          disabled={!selection || applying}
          onClick={() => addEdit("cut")}
          className={EDIT_BUTTON_CLASS}
        >
          <Scissors size={12} aria-hidden="true" />
          Cut selection
        </button>
        <button
          type="button"
          disabled={!selection || applying || narrationState === "none"}
          onClick={() => addEdit("mute")}
          className={EDIT_BUTTON_CLASS}
        >
          <VolumeX size={12} aria-hidden="true" />
          Mute selection
        </button>
        <button
          type="button"
          disabled={applying || !canSuggest}
          onClick={handleSuggest}
          title="Suggest cuts for long stretches where nobody spoke and nothing happened"
          className={EDIT_BUTTON_CLASS}
        >
          <Sparkles size={12} aria-hidden="true" />
          Suggest dead-air cuts
        </button>
        {/* Always mounted, so each edge marked at the playhead is announced. */}
        <span role="status" className="text-xs text-slate-400">
          {selection
            ? `${formatPlaybackTime(selection.start)}–${formatPlaybackTime(selection.end)}`
            : ""}
        </span>
      </div>

      {edits.length > 0 ? (
        <ul className="mt-2.5 flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
          {edits.map((edit, index) => (
            <li
              key={`${edit.kind}-${index}`}
              className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 py-0.5 pr-1 pl-2 text-xs"
            >
              <button
                type="button"
                onClick={() => seekTo(edit.start)}
                className={edit.kind === "cut" ? "text-red-300" : "text-amber-300"}
              >
                {edit.kind === "cut" ? "Cut" : "Mute"} {formatPlaybackTime(edit.start)}–
                {formatPlaybackTime(edit.end)}
              </button>
              <button
                type="button"
                aria-label={`Remove this ${edit.kind}`}
                disabled={applying}
                onClick={() => setEdits((current) => current.filter((_, at) => at !== index))}
                className="rounded-full p-0.5 text-slate-500 transition-colors hover:text-white"
              >
                <X size={11} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Mounted before any message, so the result of Suggest or Apply is announced. */}
      <div aria-live="polite">
        {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {/* A status, so the time the cuts remove is announced as Cut or Suggest adds them. */}
        <span role="status" className="mr-auto text-xs text-slate-400">
          {removedMs > 0
            ? `Removes ${formatPlaybackTime(removedMs)} — ${formatPlaybackTime(
                durationMs - removedMs,
              )} left`
            : "Playback previews your edits"}
        </span>
        <button
          type="button"
          onClick={onClose}
          disabled={applying}
          className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={edits.length === 0 || applying || narrationState === "loading"}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-950 transition-colors hover:bg-white disabled:opacity-40"
        >
          {applying ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
          {applying ? "Applying…" : "Apply edits"}
        </button>
      </div>
    </div>
  );
}
