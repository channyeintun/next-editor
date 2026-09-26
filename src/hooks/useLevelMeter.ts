import { useEffect, useState, type RefObject } from "react";
import {
  LevelMonitor,
  meterFraction,
  startLevelMeter,
  type MicrophoneVerdict,
} from "../utils/audioLevel";

interface LevelMeterState {
  stream: MediaStream;
  verdict: MicrophoneVerdict;
  noSpeechYet: boolean;
}

/** How fast the bar falls back after a loud moment: a fraction of the gap per frame. */
const METER_RELEASE = 0.12;

/**
 * Meters `stream` into the bar `meter` points at (its scaleX, set per frame without a
 * render) and judges the level: `verdict` over the last few seconds, and `noSpeechYet`
 * once `noSpeechAfterMs` has passed with nothing like speech coming in.
 */
export function useLevelMeter(
  stream: MediaStream | null,
  meter: RefObject<HTMLElement | null>,
  noSpeechAfterMs = 5_000,
): { verdict: MicrophoneVerdict; noSpeechYet: boolean } {
  const [state, setState] = useState<LevelMeterState | null>(null);

  useEffect(() => {
    if (!stream) return;
    const monitor = new LevelMonitor();
    let shown = 0;
    return startLevelMeter(stream, (reading, at) => {
      monitor.add(reading, at);
      const fraction = meterFraction(reading.rmsDb);
      shown = fraction >= shown ? fraction : shown - (shown - fraction) * METER_RELEASE;
      if (meter.current) meter.current.style.transform = `scaleX(${shown})`;

      const verdict = monitor.verdict(at);
      const noSpeechYet = !monitor.heardSpeech && monitor.listenedMs(at) >= noSpeechAfterMs;
      setState((previous) =>
        previous?.stream === stream &&
        previous.verdict === verdict &&
        previous.noSpeechYet === noSpeechYet
          ? previous
          : { stream, verdict, noSpeechYet },
      );
    });
  }, [stream, meter, noSpeechAfterMs]);

  // A reading belongs to the stream it measured; a new stream starts from scratch.
  return state?.stream === stream && stream
    ? { verdict: state.verdict, noSpeechYet: state.noSpeechYet }
    : { verdict: "listening", noSpeechYet: false };
}
