// Local speaking detection with a Web Audio analyser. Levels never leave the
// page: no WebSocket, storage, or logging (plan §8.5).

const SPEAKING_THRESHOLD = 0.02;
const ATTACK_MS = 120;
const RELEASE_MS = 600;
const SAMPLE_INTERVAL_MS = 100;

export interface SpeakingDetectorHandle {
  stop: () => void;
}

export function createSpeakingDetector(
  track: MediaStreamTrack,
  onChange: (isSpeaking: boolean) => void,
): SpeakingDetectorHandle {
  if (typeof AudioContext === "undefined") return { stop: () => undefined };
  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    context = new AudioContext();
    source = context.createMediaStreamSource(new MediaStream([track]));
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
  } catch {
    return { stop: () => undefined };
  }

  const samples = new Uint8Array(analyser.fftSize);
  let speaking = false;
  let aboveSince: number | null = null;
  let belowSince: number | null = null;

  const interval = setInterval(() => {
    if (track.readyState === "ended") return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    // Attack/release hysteresis keeps indicators from flickering.
    if (rms >= SPEAKING_THRESHOLD) {
      belowSince = null;
      aboveSince ??= now;
      if (!speaking && now - aboveSince >= ATTACK_MS) {
        speaking = true;
        onChange(true);
      }
    } else {
      aboveSince = null;
      belowSince ??= now;
      if (speaking && now - belowSince >= RELEASE_MS) {
        speaking = false;
        onChange(false);
      }
    }
  }, SAMPLE_INTERVAL_MS);

  return {
    stop() {
      clearInterval(interval);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Nodes may already be disconnected.
      }
      void context.close().catch(() => undefined);
      if (speaking) onChange(false);
    },
  };
}
