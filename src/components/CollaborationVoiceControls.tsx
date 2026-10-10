import { Headphones, LogOut, Mic, MicOff, RefreshCw, Volume2 } from "lucide-react";
import {
  useCollaborationVoice,
  useCollaborationVoiceState,
} from "../contexts/CollaborationVoiceContext";
import type { VoiceClientErrorCode } from "../voice/machine";

const VOICE_STATUS_LABELS = {
  idle: "Not in voice",
  joining: "Connecting…",
  listening: "Listening",
  unmuting: "Enabling microphone…",
  live: "Live",
  reconnecting: "Reconnecting…",
  failed: "Voice failed",
  leaving: "Leaving…",
  unavailable: "Unavailable",
} as const;

const VOICE_ERROR_COPY: Partial<Record<VoiceClientErrorCode, string>> = {
  "microphone-permission-denied":
    "Microphone access was denied. Allow the microphone in your browser settings, then try again.",
  "microphone-unavailable": "No usable microphone was found. Check your device and try again.",
  network: "The voice connection failed. Document collaboration is unaffected.",
  capacity: "The voice room is full.",
  "rate-limited": "Voice is briefly rate limited. Try again in a moment.",
};

function voiceErrorCopy(code: VoiceClientErrorCode): string {
  return VOICE_ERROR_COPY[code] ?? "Voice is temporarily unavailable. Try again.";
}

// Voice controls live in their own component so speaking/roster updates
// rerender only the voice UI, never the surrounding panel or editor.
export function VoiceControls() {
  const voice = useCollaborationVoice();
  const state = useCollaborationVoiceState();

  if (state.state === "unavailable") {
    if (state.unavailableReason === "unsupported-browser") {
      return (
        <p className="rounded-lg border border-slate-700/70 bg-slate-950/30 px-3 py-2 text-[11px] text-slate-300">
          Voice chat is not supported in this browser. Document collaboration still works.
        </p>
      );
    }
    return null;
  }

  const status = VOICE_STATUS_LABELS[state.state];
  const inVoice = state.state !== "idle";
  const canJoin = state.state === "idle";
  const showMute =
    state.state === "live" ||
    state.state === "unmuting" ||
    (state.state === "reconnecting" && state.wantsMicrophone);
  const showUnmute =
    state.state === "listening" || (state.state === "reconnecting" && !state.wantsMicrophone);
  // Mute and Unmute are one button, so React keeps its DOM node, and the
  // keyboard focus on it, when one replaces the other. Join stays separate:
  // a second press on Join must never turn the microphone on.
  const micToggle = showMute
    ? {
        label: "Mute",
        Icon: MicOff,
        onClick: voice.mute,
        className: "bg-amber-500/15 text-amber-200 hover:bg-amber-500/25",
      }
    : showUnmute
      ? {
          label: "Unmute",
          Icon: Mic,
          onClick: voice.unmute,
          className: "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25",
        }
      : null;

  return (
    <section
      aria-label="Voice chat"
      className="rounded-lg border border-slate-700/70 bg-slate-950/30 p-3"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 text-slate-300">
          <Headphones size={13} aria-hidden="true" /> Voice
        </span>
        <span
          role="status"
          className={
            state.state === "live" || state.state === "listening"
              ? "text-emerald-300"
              : state.state === "failed"
                ? "text-rose-300"
                : "text-amber-300"
          }
        >
          {status}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {canJoin ? (
          <button
            type="button"
            onClick={voice.join}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
          >
            <Headphones size={13} aria-hidden="true" /> Join voice
          </button>
        ) : null}
        {micToggle ? (
          <button
            key="mic-toggle"
            type="button"
            onClick={micToggle.onClick}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ${micToggle.className}`}
          >
            <micToggle.Icon size={13} aria-hidden="true" /> {micToggle.label}
          </button>
        ) : null}
        {state.state === "failed" ? (
          <button
            type="button"
            onClick={voice.retry}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25"
          >
            <RefreshCw size={13} aria-hidden="true" /> Retry voice
          </button>
        ) : null}
        {inVoice && state.state !== "leaving" ? (
          <button
            type="button"
            onClick={voice.leave}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/10"
          >
            <LogOut size={13} aria-hidden="true" /> Leave voice
          </button>
        ) : null}
      </div>

      {state.autoplayBlocked ? (
        <button
          type="button"
          onClick={voice.enableAudio}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-violet-500/15 px-3 py-1.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25"
        >
          <Volume2 size={13} aria-hidden="true" /> Enable audio
        </button>
      ) : null}

      {state.errorCode ? (
        <p role="alert" className="mt-2 text-[11px] leading-4 text-rose-200">
          {voiceErrorCopy(state.errorCode)}
        </p>
      ) : null}

      {state.state === "listening" ? (
        <p className="mt-2 text-[10px] leading-4 text-slate-300">
          You are muted. Others cannot hear you until you unmute.
        </p>
      ) : null}
    </section>
  );
}

// Per-row voice indicator, correlated by canonical user + session identity
// (never by display name).
export function VoiceParticipantBadge({
  userId,
  sessionId,
}: {
  userId: string;
  sessionId: string;
}) {
  const state = useCollaborationVoiceState();
  const entry = state.roster.find(
    (candidate) =>
      candidate.participant.userId === userId &&
      candidate.participant.collaborationSessionId === sessionId,
  );
  if (!entry) return null;
  const publishing = entry.participant.publishedTrack !== null && !entry.participant.muted;
  const speaking = publishing && (entry.isSelf ? state.isLocalSpeaking : entry.isSpeaking);
  if (!publishing) {
    return (
      <span
        role="img"
        aria-label="In voice, muted"
        title="In voice, muted"
        className="text-slate-500"
      >
        <MicOff size={13} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={speaking ? "Speaking" : "In voice"}
      title={speaking ? "Speaking" : "In voice"}
      className={speaking ? "text-emerald-300 motion-safe:animate-pulse" : "text-emerald-400/80"}
    >
      <Mic size={13} />
    </span>
  );
}
