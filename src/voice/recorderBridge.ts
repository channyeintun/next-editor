// Privacy boundary between voice chat and the recorder (plan §11): remote
// participants' voice plays through this tab, so tab/display audio must never
// reach a recording while voice is joined. Voice sinks are playback-only and
// are never wired into any mix graph; this module additionally strips
// display-audio tracks — at acquisition time and retroactively when voice is
// joined mid-recording. The host's microphone narration is unaffected.

import type { VoiceConnectionState } from "./machine";

// Voice states in which remote voice may be (or is about to be) audible in
// this tab, so recordings must exclude tab/display audio. This module, not the
// machine, owns the rule: the provider imports it eagerly, while the machine
// loads with the lazy voice engine.
export const VOICE_JOINED_STATES: ReadonlySet<VoiceConnectionState> = new Set<VoiceConnectionState>(
  ["joining", "listening", "unmuting", "live", "reconnecting", "leaving"],
);

export function isVoiceJoined(state: VoiceConnectionState): boolean {
  return VOICE_JOINED_STATES.has(state);
}

let voiceJoined = false;
const liveDisplayAudioTracks = new Set<MediaStreamTrack>();

// The recorder ends a take with track.stop(), which never fires "ended" on that
// track, so ended tracks are also dropped whenever the registry is used.
function forgetEndedTracks(): void {
  for (const track of liveDisplayAudioTracks) {
    if (track.readyState === "ended") liveDisplayAudioTracks.delete(track);
  }
}

function stopTrack(track: MediaStreamTrack): void {
  try {
    track.stop();
  } catch {
    // Already ended.
  }
}

// Called by the voice provider whenever the joined state changes. Joining
// mid-recording immediately silences every registered display-audio source;
// the recording itself (video + microphone narration) continues.
export function setVoiceJoinedForRecording(joined: boolean): void {
  voiceJoined = joined;
  forgetEndedTracks();
  if (!joined) return;
  for (const track of liveDisplayAudioTracks) stopTrack(track);
  liveDisplayAudioTracks.clear();
}

export function isVoiceJoinedForRecording(): boolean {
  return voiceJoined;
}

// Called with a freshly acquired display-capture stream, before it reaches
// the screen recorder. Removes tab audio outright when voice is already
// joined (covers the picker race after the audio:false request) and
// registers remaining audio tracks so a later voice join can stop them.
export function applyVoiceRecordingPolicy(stream: MediaStream): MediaStream {
  forgetEndedTracks();
  for (const track of stream.getAudioTracks()) {
    if (voiceJoined) {
      stopTrack(track);
      stream.removeTrack(track);
      continue;
    }
    liveDisplayAudioTracks.add(track);
    track.addEventListener("ended", () => liveDisplayAudioTracks.delete(track), { once: true });
  }
  return stream;
}

export function resetVoiceRecorderBridgeForTests(): void {
  voiceJoined = false;
  liveDisplayAudioTracks.clear();
}
