import { useEffect, useRef, useState } from "react";
import { AudioLines, Mic, X } from "lucide-react";
import { openMicrophone } from "../core/src/machine/microphone";
import { useAudioInputDevices } from "../hooks/useAudioInputDevices";
import { useLevelMeter } from "../hooks/useLevelMeter";
import { useRecordingMicrophoneStream } from "../hooks/useNextEditorContext";
import { useRecordingSettings } from "../hooks/useRecordingSettings";
import { recordingSettingsStore } from "../stores/recordingSettingsStore";
import type { MicrophoneVerdict } from "../utils/audioLevel";

const VERDICT_TEXT: Record<MicrophoneVerdict, string> = {
  listening: "Listening…",
  silent:
    "No sound yet. Say a few words; if the bar stays still, check that the microphone is on and not muted.",
  waiting: "Say a few words to check the level.",
  quiet: "A little quiet. Move closer, or raise the input level.",
  good: "Sounds good.",
  loud: "Too loud: it may distort. Lower the input level.",
};

function describeMicrophoneError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it for this site in the browser's settings.";
  }
  if (name === "NotFoundError") return "No microphone was found.";
  if (name === "NotReadableError") {
    return "The microphone is in use by another app, or the system is blocking it.";
  }
  return "The microphone could not be opened.";
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function LevelBar({ meterRef }: { meterRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-700">
      <div
        ref={meterRef}
        className="origin-left rounded-full bg-emerald-400 size-full"
        style={{ transform: "scaleX(0)" }}
      />
    </div>
  );
}

/**
 * The microphone check: which microphone takes record from, and its live level, so a
 * muted or wrong microphone shows up before the take rather than after it.
 */
function MicrophoneCheckPanel({ onClose }: { onClose: () => void }) {
  const { microphoneDeviceId } = useRecordingSettings();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const devices = useAudioInputDevices(stream);
  const meterRef = useRef<HTMLDivElement>(null);
  const { verdict } = useLevelMeter(stream, meterRef);

  // Listen the way a take will record: the picked microphone, or the default when it is gone.
  useEffect(() => {
    let cancelled = false;
    let opened: MediaStream | null = null;
    openMicrophone({ deviceId: microphoneDeviceId ?? undefined }).then(
      (next) => {
        if (cancelled) {
          stopStream(next);
          return;
        }
        opened = next;
        setStream(next);
        setError(null);
      },
      (reason: unknown) => {
        if (!cancelled) setError(describeMicrophoneError(reason));
      },
    );
    return () => {
      cancelled = true;
      if (opened) stopStream(opened);
    };
  }, [microphoneDeviceId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pickedIsMissing =
    microphoneDeviceId !== null &&
    devices.length > 0 &&
    !devices.some((device) => device.deviceId === microphoneDeviceId);

  return (
    <div
      role="dialog"
      aria-label="Microphone check"
      className="absolute bottom-full left-0 z-46 mb-2 w-72 rounded-lg border border-slate-700 bg-[#151821] p-3 text-sm text-slate-200 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
          Microphone
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the microphone check"
          className="text-slate-500 transition-colors hover:text-white"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <select
        aria-label="Microphone to record from"
        value={pickedIsMissing ? "" : (microphoneDeviceId ?? "")}
        onChange={(event) =>
          recordingSettingsStore.trigger.setMicrophoneDeviceId({
            deviceId: event.target.value || null,
          })
        }
        className="mb-3 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-sky-500"
      >
        <option value="">System default</option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
      {error ? null : <LevelBar meterRef={meterRef} />}
      {/* One live line, mounted throughout, so an error that replaces the verdict (most
          often a blocked microphone) is announced like the verdict is. */}
      <p
        aria-live="polite"
        className={error ? "text-xs text-red-400" : "mt-2 text-xs text-slate-400"}
      >
        {error ?? VERDICT_TEXT[verdict]}
      </p>
      {pickedIsMissing ? (
        <p className="mt-2 text-xs text-amber-300">
          The microphone picked before is not connected; takes use the system default.
        </p>
      ) : null}
    </div>
  );
}

/** The button beside the Mic source that opens the microphone check. */
export default function MicrophoneCheck() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Closing unmounts the check, so focus inside it goes back to the button that opened
  // it; focus anywhere else (the editor, when Escape closes it) is left where it is.
  const close = () => {
    if (wrapperRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    setOpen(false);
  };
  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Check the microphone"
        className={`inline-flex h-7 items-center rounded-full border px-2 text-xs shadow-sm transition-colors ${
          open
            ? "border-slate-500 bg-slate-800 text-white"
            : "border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800 hover:text-white"
        }`}
      >
        <AudioLines size={13} aria-hidden="true" />
      </button>
      {open ? <MicrophoneCheckPanel onClose={close} /> : null}
    </div>
  );
}

/**
 * The running take's microphone level, beside its timer: proof the narration is coming
 * in, and a warning when nothing like speech has since the take began.
 */
export function RecordingMicrophoneLevel() {
  const stream = useRecordingMicrophoneStream();
  const meterRef = useRef<HTMLDivElement>(null);
  const { noSpeechYet } = useLevelMeter(stream, meterRef);
  if (!stream) return null;
  const device = stream.getAudioTracks()[0]?.label;
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 pointer-events-auto"
      title={
        noSpeechYet
          ? "No sound from the microphone yet. Check that it is on and not muted."
          : device
            ? `Recording from ${device}`
            : "Microphone level"
      }
    >
      <Mic
        size={12}
        className={noSpeechYet ? "text-amber-400" : "text-slate-400"}
        aria-hidden="true"
      />
      <div className="w-10">
        <LevelBar meterRef={meterRef} />
      </div>
      {/* Mounted before the warning, and at every width, so it is announced: the short
          visible note is hidden on narrow screens and says less. */}
      <span role="status" className="sr-only">
        {noSpeechYet ? "No sound from the microphone yet. Check that it is on and not muted." : ""}
      </span>
      {noSpeechYet ? (
        <span aria-hidden="true" className="hidden text-[11px] text-amber-300 sm:inline">
          No sound yet
        </span>
      ) : null}
    </div>
  );
}
