// Privacy boundary between voice chat and the recorder (plan §11): remote
// participants' voice plays through this tab, so tab/display audio must never
// reach a recording while voice is joined. Voice sinks are playback-only and
// are never wired into any mix graph; this module additionally strips
// display-audio tracks — at acquisition time and retroactively when voice is
// joined mid-recording. The host's microphone narration is unaffected.

let voiceJoined = false;
const liveDisplayAudioTracks = new Set<MediaStreamTrack>();

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
