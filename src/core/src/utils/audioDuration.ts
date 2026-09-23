/**
 * Exact narration length, measured by decoding the audio. MediaRecorder's WebM
 * carries no duration, so an HTMLAudioElement reports Infinity for it; decoding is
 * what gives the real length. When decodeAudioData rejects, the element's duration
 * is read instead: iOS WebKit plays `audio/mp4` blobs it cannot decode through the
 * Web Audio API.
 */

// Decoding resamples the whole file to the context's rate as Float32, so the rate
// sets the memory cost: 20 minutes of mono audio is ~230 MB at 48 kHz and ~38 MB
// here. The length is still exact to a fraction of a millisecond.
const DECODE_SAMPLE_RATE = 8000;

// Metadata for an in-memory blob loads in milliseconds when it loads at all. Some
// WebKit builds may never load media without a user gesture, and loadRecording waits
// on this promise, so give up and let the caller keep the recording's wall-clock
// duration.
const ELEMENT_METADATA_TIMEOUT_MS = 5_000;

/**
 * Attempts to determine audio duration via `HTMLAudioElement.duration`.
 * Used as a fallback when AudioContext decoding fails (e.g. iOS WebKit).
 * Rejects when the element has loaded no metadata after
 * `ELEMENT_METADATA_TIMEOUT_MS`.
 */
function getDurationFromAudioElement(audioBlob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio();
    const listeners = new AbortController();

    const settle = () => {
      clearTimeout(timer);
      listeners.abort();
      URL.revokeObjectURL(url);
    };

    const timer = setTimeout(() => {
      settle();
      reject(
        new Error(`HTMLAudioElement loaded no metadata within ${ELEMENT_METADATA_TIMEOUT_MS} ms`),
      );
    }, ELEMENT_METADATA_TIMEOUT_MS);

    audio.addEventListener(
      "loadedmetadata",
      () => {
        settle();
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          resolve(audio.duration);
        } else {
          reject(new Error("HTMLAudioElement reported invalid duration"));
        }
      },
      { signal: listeners.signal },
    );

    audio.addEventListener(
      "error",
      () => {
        settle();
        reject(new Error("HTMLAudioElement failed to load blob"));
      },
      { signal: listeners.signal },
    );

    audio.src = url;
    // Trigger metadata loading without playing
    audio.load();
  });
}

/**
 * Duration of `audioBlob` in seconds. Decodes on an OfflineAudioContext: it opens no
 * audio device and is not subject to the autoplay policy, unlike the page's shared
 * realtime context, which this used to create on load before any user gesture.
 */
export async function measureAudioDurationSeconds(audioBlob: Blob): Promise<number> {
  const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  try {
    return (await context.decodeAudioData(await audioBlob.arrayBuffer())).duration;
  } catch (decodeError) {
    console.warn(
      "AudioContext.decodeAudioData failed, falling back to HTMLAudioElement:",
      decodeError,
    );
    try {
      return await getDurationFromAudioElement(audioBlob);
    } catch (fallbackError) {
      console.error("Audio duration unavailable (all methods failed):", fallbackError);
      throw decodeError;
    }
  }
}
