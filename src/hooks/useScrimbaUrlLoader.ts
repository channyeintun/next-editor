import { useCallback, useState } from 'react';
import type { Recording } from '../use-scrimba/src';
import { useScrimbaContext } from './useScrimbaContext';
import { decodeDataFromCanvas } from '../use-scrimba/src/utils/steganography';

export const useScrimbaUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  const { loadRecording } = useScrimbaContext();

  const isScrimbaUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      return pathname.endsWith('.scrimba') || pathname.endsWith('.png');
    } catch {
      return false;
    }
  };

  const fetchScrimbaFile = useCallback(async (url: string) => {
    if (!isScrimbaUrl(url)) {
      throw new Error('URL does not point to a supported Scrimba file (.scrimba, .png)');
    }

    try {
      setIsLoading(true);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      const blob = await response.blob();

      if (url.toLowerCase().endsWith('.scrimba')) {
        const text = await blob.text();

        // Use the same decompression logic from JsonStorage
        const binaryData = base64ToBinary(text.trim());
        const recordings = await decompressBinaryToRecordings(binaryData);

        if (recordings.length > 0) {
          loadRecording(recordings[0]);
        }
      } else {
        // It's an image
        const imageUrl = URL.createObjectURL(blob);
        try {
          const recordings = await decodeImageToRecordings(imageUrl);
          if (recordings && recordings.length > 0) {
            loadRecording(recordings[0]);
          } else {
            throw new Error('No Scrimba data found in this image');
          }
        } finally {
          URL.revokeObjectURL(imageUrl);
        }
      }
    } catch (error) {
      console.error('Failed to load Scrimba tutorial from URL:', error);
      alert(`Failed to load Scrimba tutorial: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [loadRecording]);

  const decodeImageToRecordings = async (imageUrl: string): Promise<Recording[] | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const jsonData = decodeDataFromCanvas(canvas);
        if (jsonData) {
          try {
            const binaryData = base64ToBinary(jsonData.trim());
            const recordings = await decompressBinaryToRecordings(binaryData);
            resolve(recordings);
          } catch (err) {
            console.error('Failed to decompress recording from image:', err);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      };
      img.onerror = () => {
        console.error('Failed to load image for decoding');
        resolve(null);
      };
      img.src = imageUrl;
    });
  };

  // Helper functions from JsonStorage (duplicated for now)
  const base64ToBinary = (base64Data: string): Uint8Array => {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const decompressBinaryToRecordings = async (binaryData: Uint8Array) => {
    const { inflate } = await import('pako');
    const { superjson } = await import('../storage/SuperJsonConfig');

    let offset = 0;

    // Read header
    const magic = new TextDecoder().decode(binaryData.slice(offset, offset + 4));
    offset += 4;

    if (magic !== 'SCRM') {
      throw new Error('Invalid binary format: bad magic number');
    }

    const version = new Uint16Array(binaryData.slice(offset, offset + 2).buffer)[0];
    offset += 2;

    if (version !== 1) {
      throw new Error(`Unsupported binary format version: ${version}`);
    }

    const jsonLength = new Uint16Array(binaryData.slice(offset, offset + 2).buffer)[0];
    offset += 2;

    // Read and decompress JSON
    const compressedJson = binaryData.slice(offset, offset + jsonLength);
    offset += jsonLength;

    const jsonString = inflate(compressedJson, { to: 'string' });
    const recordings = superjson.parse(jsonString) as Recording[];

    // Read audio data and reconstruct blobs
    const audioDataStart = offset;
    const audioData = binaryData.slice(audioDataStart);

    return recordings.map(recording => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const audioPlaceholder = recording.audioBlob as any;

      if (audioPlaceholder && audioPlaceholder.__audio_offset !== undefined) {
        const audioOffset = audioPlaceholder.__audio_offset;
        const audioSize = audioPlaceholder.__audio_size;
        const audioType = audioPlaceholder.__audio_type;

        const audioBytes = audioData.slice(audioOffset, audioOffset + audioSize);
        recording.audioBlob = new Blob([audioBytes], { type: audioType });
      }

      return recording;
    });
  };

  return {
    fetchScrimbaFile,
    isScrimbaUrl,
    isLoading
  };
};