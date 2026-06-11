/**
 * Calculates exact duration from audio blob using FileReader and AudioContext
 * This approach provides more accurate duration than HTML audio elements
 */
import { getAudioContext } from "./audioContext";

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
          (error: Error) => {
            console.error("FileReader decode error:", error);
            reject(error);
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
