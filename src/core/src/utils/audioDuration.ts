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

/**
 * Attempts to determine audio duration via `HTMLAudioElement.duration`.
 * Used as a fallback when AudioContext decoding fails (e.g. iOS WebKit).
 */
function getDurationFromAudioElement(audioBlob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio();

    const cleanup = () => URL.revokeObjectURL(url);

    audio.addEventListener(
      "loadedmetadata",
      () => {
        cleanup();
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          resolve(audio.duration);
        } else {
          reject(new Error("HTMLAudioElement reported invalid duration"));
        }
      },
      { once: true },
    );

    audio.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error("HTMLAudioElement failed to load blob"));
      },
      { once: true },
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
