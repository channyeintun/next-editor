// Local speaking detection with a Web Audio analyser. Levels never leave the
// page: no WebSocket, storage, or logging (plan §8.5).

const SPEAKING_THRESHOLD = 0.02;
const ATTACK_MS = 120;
const RELEASE_MS = 600;
const SAMPLE_INTERVAL_MS = 100;

export interface SpeakingDetectorHandle {
  stop: () => void;
}

// Every detector (the local microphone and one per remote speaker) shares one
// AudioContext: browsers cap how many a page may hold, and a failed
// construction would silently drop that speaker's indicator. Each detector
// keeps its own source and analyser; the last one to stop closes the context.
let shared: { context: AudioContext; users: number } | null = null;

function acquireContext(): AudioContext {
  shared ??= { context: new AudioContext(), users: 0 };
  shared.users += 1;
  return shared.context;
}

function releaseContext(): void {
  if (!shared) return;
  shared.users -= 1;
  if (shared.users > 0) return;
  void shared.context.close().catch(() => undefined);
  shared = null;
}

export function createSpeakingDetector(
  track: MediaStreamTrack,
  onChange: (isSpeaking: boolean) => void,
): SpeakingDetectorHandle {
  if (typeof AudioContext === "undefined") return { stop: () => undefined };
  let acquired = false;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    const context = acquireContext();
    acquired = true;
    source = context.createMediaStreamSource(new MediaStream([track]));
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
  } catch {
    if (acquired) releaseContext();
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

  let stopped = false;
  return {
    stop() {
      // A second stop must not release the shared context a second time.
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Nodes may already be disconnected.
      }
      releaseContext();
      if (speaking) onChange(false);
    },
  };
}
