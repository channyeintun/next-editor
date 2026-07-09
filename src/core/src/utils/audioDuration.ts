/**
 * Calculates exact duration from audio blob using FileReader and AudioContext.
 * This approach provides more accurate duration than HTML audio elements.
 *
 * Falls back to an HTMLAudioElement duration read when AudioContext.decodeAudioData
 * rejects — this covers iOS WebKit where `audio/mp4` blobs are playable but
 * cannot be decoded through the Web Audio API.
 */
import { getAudioContext } from "./audioContext";

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

export async function calculateDurationFromFileReader(audioBlob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = function (e) {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        if (!arrayBuffer) {
          reject(new Error("Failed to read audio blob"));
          return;
        }

        const audioContext = getAudioContext();

        audioContext.decodeAudioData(
          arrayBuffer,
          (buffer: AudioBuffer) => {
            const rawDuration = buffer.duration;
            resolve(rawDuration);
          },
          async (error: Error) => {
            // AudioContext.decodeAudioData can fail on iOS WebKit for codecs
            // that are supported for playback (e.g. audio/mp4) but not for
            // offline decoding. Fall back to HTMLAudioElement duration.
            console.warn(
              "AudioContext.decodeAudioData failed, falling back to HTMLAudioElement:",
              error,
            );
            try {
              const duration = await getDurationFromAudioElement(audioBlob);
              resolve(duration);
            } catch (fallbackError) {
              console.error("FileReader decode error (all methods failed):", fallbackError);
              reject(error);
            }
          },
        );
      } catch (error) {
        console.error("FileReader processing error:", error);
        reject(error);
      }
    };

    reader.onerror = function () {
      console.error("FileReader read error");
      reject(new Error("FileReader failed"));
    };

    reader.readAsArrayBuffer(audioBlob);
  });
}
