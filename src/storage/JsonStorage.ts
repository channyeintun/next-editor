import type { Recording } from '../core/src';
import { superjson } from './SuperJsonConfig';
import { deflate, inflate } from 'pako';
import { type AudioPlaceholder } from '../core/src/types';
import { encodeBase64, decodeBase64 } from '../core/src/utils/base64';

interface StorageStats {
  count: number;
  totalSize: string;
  compressedSize?: string;
  compressionRatio?: string;
}




/**
 * JSON Storage Interface for use-next-editor
 * Provides export/import functionality for recordings as JSON files with compression
 */
export class JsonStorage {
  private localStorageKey = 'next-editor-recordings';

  /**
   * Extract audio data from all recordings (helper for stats)
   */
  private async extractAllAudioData(recordings: Recording[]): Promise<{ recordingsWithPlaceholders: Recording[] }> {
    const recordingsWithPlaceholders = await Promise.all(
      recordings.map(async (recording) => {
        const { recordingWithPlaceholders } = await this.extractAudioData(recording);
        return recordingWithPlaceholders;
      })
    );
    return { recordingsWithPlaceholders };
  }

  /**
   * Extract audio blobs from recording and replace with placeholders
   */
  private async extractAudioData(recording: Recording): Promise<{ recordingWithPlaceholders: Recording; audioData: Uint8Array | null }> {
    if (!recording.audioBlob || !(recording.audioBlob instanceof Blob)) {
      return { recordingWithPlaceholders: recording, audioData: null };
    }

    // Convert blob to binary data
    const arrayBuffer = await recording.audioBlob.arrayBuffer();
    const audioData = new Uint8Array(arrayBuffer);

    // Create placeholder
    const placeholder: AudioPlaceholder = {
      __audio_offset: 0, // Will be set during concatenation
      __audio_size: audioData.length,
      __audio_type: recording.audioBlob.type
    };

    // Create recording with placeholder
    const recordingWithPlaceholders: Recording = {
      ...recording,
      audioBlob: placeholder
    };

    return { recordingWithPlaceholders, audioData };
  }

  /**
   * Compress recordings to binary format (JSON + audio concatenation)
   */
  private async compressRecordingsToBinary(recordings: Recording[]): Promise<Uint8Array> {
    const audioChunks: Uint8Array[] = [];
    let currentOffset = 0;

    // Process recordings and extract audio
    const recordingsWithPlaceholders = await Promise.all(
      recordings.map(async (recording) => {
        const { recordingWithPlaceholders, audioData } = await this.extractAudioData(recording);

        if (audioData) {
          // Update placeholder with actual offset
          const placeholder = recordingWithPlaceholders.audioBlob as AudioPlaceholder;
          placeholder.__audio_offset = currentOffset;
          audioChunks.push(audioData);
          currentOffset += audioData.length;
        }

        return recordingWithPlaceholders;
      })
    );

    // Serialize JSON without audio blobs
    const jsonString = superjson.stringify(recordingsWithPlaceholders);
    const compressedJson = deflate(jsonString, { level: 9 });

    // Create header - version 2 uses Uint32 for jsonLength (supports files > 65KB)
    const magic = new TextEncoder().encode('SCRM');
    const version = new Uint16Array([2]); // Version 2 uses Uint32 for jsonLength
    const jsonLength = new Uint32Array([compressedJson.length]);

    // Calculate total size: magic(4) + version(2) + jsonLength(4) + json + audio
    const audioDataSize = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const totalSize = 10 + compressedJson.length + audioDataSize;

    // Combine all data
    const result = new Uint8Array(totalSize);
    let offset = 0;

    // Write header
    result.set(magic, offset);
    offset += 4;
    result.set(new Uint8Array(version.buffer), offset);
    offset += 2;
    result.set(new Uint8Array(jsonLength.buffer), offset);
    offset += 4;

    // Write compressed JSON
    result.set(compressedJson, offset);
    offset += compressedJson.length;

    // Write audio data
    for (const audioChunk of audioChunks) {
      result.set(audioChunk, offset);
      offset += audioChunk.length;
    }

    return result;
  }

  /**
   * Decompress binary format back to recordings with audio blobs
   */
  private async decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
    let offset = 0;

    // Read header
    const magic = new TextDecoder().decode(binaryData.slice(offset, offset + 4));
    offset += 4;

    if (magic !== 'SCRM') {
      throw new Error('Invalid binary format: bad magic number');
    }

    const version = new Uint16Array(binaryData.slice(offset, offset + 2).buffer)[0];
    offset += 2;

    if (version !== 2) {
      throw new Error(`Unsupported binary format version: ${version}. Legacy Version 1 is no longer supported.`);
    }

    // Version 2: Uint32 for jsonLength (supports larger files)
    const jsonLength = new Uint32Array(binaryData.slice(offset, offset + 4).buffer)[0];
    offset += 4;

    if (jsonLength === 0 || jsonLength > binaryData.length - offset) {
      throw new Error(`Invalid JSON length: ${jsonLength}, remaining data: ${binaryData.length - offset}`);
    }

    // Read and decompress JSON
    const compressedJson = binaryData.slice(offset, offset + jsonLength);
    offset += jsonLength;

    const jsonString = inflate(compressedJson, { to: 'string' });

    if (!jsonString || typeof jsonString !== 'string') {
      throw new Error('Failed to decompress JSON data - inflate returned invalid result');
    }

    const recordings = superjson.parse(jsonString) as Recording[];

    // Read audio data and reconstruct blobs
    const audioDataStart = offset;
    const audioData = binaryData.slice(audioDataStart);

    return recordings.map(recording => {
      const audioPlaceholder = recording.audioBlob as AudioPlaceholder | undefined;

      if (audioPlaceholder && (audioPlaceholder as AudioPlaceholder).__audio_offset !== undefined) {
        const audioOffset = audioPlaceholder.__audio_offset;
        const audioSize = audioPlaceholder.__audio_size;
        const audioType = audioPlaceholder.__audio_type;

        const audioBytes = audioData.slice(audioOffset, audioOffset + audioSize);
        recording.audioBlob = new Blob([audioBytes], { type: audioType });
      }

      return recording;
    });
  }




  /**
   * Convert binary data to base64 for storage using Wasm acceleration
   */
  private binaryToBase64(binaryData: Uint8Array): string {
    return encodeBase64(binaryData);
  }

  /**
   * Convert base64 to binary data using Wasm acceleration
   */
  private base64ToBinary(base64Data: string): Uint8Array {
    return decodeBase64(base64Data);
  }


  /**
   * Save recording to localStorage using new binary format (JSON + audio concatenation)
   */
  async save(recording: Recording): Promise<void> {
    try {
      const existingRecordings = await this.load();
      const updatedRecordings = [...existingRecordings.filter(r => r.id !== recording.id), recording];

      // Use new binary format that separates JSON and audio data
      const binaryData = await this.compressRecordingsToBinary(updatedRecordings);
      const base64Data = this.binaryToBase64(binaryData);
      localStorage.setItem(this.localStorageKey, base64Data);
    } catch (error) {
      console.error('JsonStorage: Failed to save recording:', error);
      throw new Error(`Failed to save recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load all recordings from localStorage using SuperJSON with decompression
   */
  async load(): Promise<Recording[]> {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      if (!stored) return [];

      const binaryData = this.base64ToBinary(stored);
      return await this.decompressBinaryToRecordings(binaryData);
    } catch (error) {
      console.error('Failed to load recordings from localStorage:', error);
      return [];
    }
  }


  /**
   * Delete recording from localStorage using SuperJSON with compression
   */
  async delete(id: string): Promise<void> {
    try {
      const recordings = await this.load();
      const filtered = recordings.filter(r => r.id !== id);

      // Save using new binary format
      const binaryData = await this.compressRecordingsToBinary(filtered);
      const base64Data = this.binaryToBase64(binaryData);
      localStorage.setItem(this.localStorageKey, base64Data);
    } catch (error) {
      throw new Error(`Failed to delete recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Export recording as compressed file download using SuperJSON + pako
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      // Use new binary format for export
      const binaryData = await this.compressRecordingsToBinary([recording]);
      const base64Data = this.binaryToBase64(binaryData);

      // Create blob with base64 data (will be decoded on import)
      const blob = new Blob([base64Data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      // Use .ne extension to indicate new binary format
      const baseFilename = filename?.replace(/\.json$/, '') || `recording-${recording.id}`;
      link.download = `${baseFilename}.ne`;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      throw new Error(`Failed to export recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Export all recordings as compressed file download using SuperJSON + pako
   */
  async exportAllAsFile(filename?: string): Promise<void> {
    try {
      const recordings = await this.load();
      // Use new binary format for export
      const binaryData = await this.compressRecordingsToBinary(recordings);
      const base64Data = this.binaryToBase64(binaryData);

      // Create blob with base64 data (will be decoded on import)
      const blob = new Blob([base64Data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      // Use .ne extension to indicate new binary format
      const baseFilename = filename?.replace(/\.json$/, '') || `next-editor-recordings-${Date.now()}`;
      link.download = `${baseFilename}.ne`;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      throw new Error(`Failed to export recordings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Import recordings from .ne or .png format file
   */
  importFromFile(): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ne';

      input.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          reject(new Error('No file selected'));
          return;
        }

        try {

          // Read file as text and validate it's not empty/undefined
          const text = await file.text();
          const trimmedText = text.trim();
          if (!trimmedText || trimmedText.length === 0) {
            reject(new Error('File appears to be empty or corrupted'));
            return;
          }

          // Relaxed validation: Allow whitespace/newlines and check general format
          // Strip whitespace for the check
          const stripped = trimmedText.replace(/\s/g, '');
          const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
          if (!base64Pattern.test(stripped)) {
            console.error('Import validation failed. Start of text:', trimmedText.substring(0, 50));
            reject(new Error('File does not contain valid base64 data'));
            return;
          }

          const binaryData = this.base64ToBinary(stripped);


          const importedRecordings = await this.decompressBinaryToRecordings(binaryData);

          // Validate imported recordings
          if (!Array.isArray(importedRecordings) || importedRecordings.length === 0) {
            reject(new Error('No valid recordings found in file'));
            return;
          }

          // Don't save to localStorage to avoid quota issues with large files
          // Just return the imported recordings for immediate use
          resolve(importedRecordings);
        } catch (error) {
          console.error('Import error details:', error);
          const errorMessage = error instanceof Error ? error.message : 'Invalid file format';
          reject(new Error(`Failed to import recordings: ${errorMessage}`));
        }
      };

      input.click();
    });
  }


  /**
   * Clear all recordings from localStorage
   */
  async clear(): Promise<void> {
    localStorage.removeItem(this.localStorageKey);
  }

  /**
   * Get storage statistics using SuperJSON with compression info
   */
  async getStats(): Promise<StorageStats> {
    const recordings = await this.load();

    if (recordings.length === 0) {
      return { count: 0, totalSize: '0 B', compressedSize: '0 B', compressionRatio: '0%' };
    }

    // Get actual compressed size from localStorage
    const stored = localStorage.getItem(this.localStorageKey);
    const actualCompressedSize = stored ? new Blob([stored]).size : 0;

    // Calculate what the size would be without compression
    // (simulate old base64 + JSON format for fair comparison)
    const { recordingsWithPlaceholders } = await this.extractAllAudioData(recordings);
    const jsonString = superjson.stringify(recordingsWithPlaceholders);
    const jsonSize = new Blob([jsonString]).size;
    const audioSize = recordings.reduce((total, recording) => {
      const blob = recording.audioBlob;
      return total + (blob instanceof Blob ? blob.size : 0);
    }, 0);

    // Simulate old format: JSON + base64 audio (33% overhead) + base64 storage (33% overhead)
    const simulatedOldFormatSize = Math.round((jsonSize + audioSize * 1.33) * 1.33);

    // Convert to human-readable format
    const formatSize = (bytes: number): string => {
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let unitIndex = 0;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }

      return `${size.toFixed(1)} ${units[unitIndex]}`;
    };

    const compressedSize = formatSize(actualCompressedSize);
    const compressionRatio = simulatedOldFormatSize > 0
      ? `${((1 - actualCompressedSize / simulatedOldFormatSize) * 100).toFixed(1)}%`
      : '0%';

    return {
      count: recordings.length,
      totalSize: compressedSize, // Show compressed size as the main size
      compressedSize,
      compressionRatio
    };
  }
}

export const createJsonStorage = () => new JsonStorage();