// Local speaking detection with a Web Audio analyser. Levels never leave the
// page: no WebSocket, storage, or logging (plan §8.5).

import { resumeSharedAudioContext } from "../core/src/utils/audioContext";

const SPEAKING_THRESHOLD = 0.02;
const ATTACK_MS = 120;
const RELEASE_MS = 600;
const SAMPLE_INTERVAL_MS = 100;

export interface SpeakingDetectorHandle {
  stop: () => void;
}

// Every detector (the local microphone and one per remote speaker) reads from
// the page's one shared AudioContext: browsers cap how many a page may hold,
// and a failed construction would silently drop that speaker's indicator.
// Detectors are made from async callbacks, outside any user gesture, where
// WebKit starts a context suspended and an analyser reads only silence, so
// taking the context through resumeSharedAudioContext resumes it now or on the
// next gesture. Analysers never connect to the destination, so nothing is
// heard through it. Each detector keeps its own source and analyser and
// disconnects them on stop; the shared context is never closed or suspended.

/**
 * Resumes the context the detectors read from. The engine calls it from the
 * Enable audio click, which can resume a context no earlier gesture did.
 */
export function resumeSpeakingDetection(): void {
  if (typeof AudioContext === "undefined") return;
  try {
    resumeSharedAudioContext();
  } catch {
    // No context could be made; detectors are already no-ops.
  }
}

export function createSpeakingDetector(
  track: MediaStreamTrack,
  onChange: (isSpeaking: boolean) => void,
): SpeakingDetectorHandle {
  if (typeof AudioContext === "undefined") return { stop: () => undefined };
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    const context = resumeSharedAudioContext();
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

  let stopped = false;
  return {
    stop() {
      // A second stop must not report silence a second time.
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Nodes may already be disconnected.
      }
      if (speaking) onChange(false);
    },
  };
}
