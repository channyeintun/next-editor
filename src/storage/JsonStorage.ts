import type { Recording } from "../core/src";
import {
  createIndexedDBRecordingStore,
  type StoredRecordingEntry,
  type StoredRecordingMetadata,
} from "./IndexedDBRecordingStore";
import {
  compressRecordingsToBinary,
  decodeBase64ToRecordings,
  decompressBinaryToRecordings,
  encodeRecordingsToBase64,
  normalizeRecording,
} from "./recordingCodecClient";

interface StorageStats {
  count: number;
  totalSize: string;
  compressedSize?: string;
  compressionRatio?: string;
}

/**
 * JSON Storage Interface for use-next-editor
 * Provides IndexedDB persistence plus export/import support for recordings.
 */
export class JsonStorage {
  private indexedDBStore = createIndexedDBRecordingStore();

  private formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  private hasAudioPayload(recording: Recording): boolean {
    const audioBlob = recording.audioBlob;

    if (audioBlob instanceof Blob) {
      return audioBlob.size > 0;
    }

    return (
      !!audioBlob &&
      typeof audioBlob === "object" &&
      "__audio_size" in audioBlob &&
      typeof audioBlob.__audio_size === "number" &&
      audioBlob.__audio_size > 0
    );
  }

  private createStoredMetadata(recording: Recording, payloadSize: number): StoredRecordingMetadata {
    return {
      id: recording.id,
      name: recording.name,
      version: recording.version,
      duration: recording.duration,
      createdAt: recording.createdAt,
      updatedAt: Date.now(),
      hasAudio: this.hasAudioPayload(recording),
      payloadSize,
    };
  }

  private async createStoredEntry(recording: Recording): Promise<StoredRecordingEntry> {
    const normalizedRecording = normalizeRecording(recording);
    const binaryData = await compressRecordingsToBinary([normalizedRecording]);

    return {
      metadata: this.createStoredMetadata(normalizedRecording, binaryData.byteLength),
      binaryData,
    };
  }

  private async decodeStoredEntry(entry: StoredRecordingEntry): Promise<Recording> {
    const recordings = await decompressBinaryToRecordings(entry.binaryData);

    if (recordings.length !== 1) {
      throw new Error(
        `Expected one recording payload for ${entry.metadata.id}, received ${recordings.length}`,
      );
    }

    return normalizeRecording(recordings[0]);
  }

  private async loadIndexedDBRecordings(): Promise<Recording[]> {
    const entries = await this.indexedDBStore.getAllEntries();
    return Promise.all(entries.map((entry) => this.decodeStoredEntry(entry)));
  }

  /**
   * Save a recording as an individual IndexedDB entry.
   */
  async save(recording: Recording): Promise<void> {
    try {
      const entry = await this.createStoredEntry(recording);
      await this.indexedDBStore.put(entry);
    } catch (error) {
      console.error("JsonStorage: Failed to save recording:", error);
      throw new Error(
        `Failed to save recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Load all recordings from IndexedDB.
   */
  async load(): Promise<Recording[]> {
    try {
      if (!(await this.indexedDBStore.hasEntries())) {
        return [];
      }

      return await this.loadIndexedDBRecordings();
    } catch (error) {
      console.error("Failed to load recordings from IndexedDB:", error);
      return [];
    }
  }

  /**
   * Delete one recording without rebuilding the entire archive.
   */
  async delete(id: string): Promise<void> {
    try {
      await this.indexedDBStore.delete(id);
    } catch (error) {
      throw new Error(
        `Failed to delete recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Export recording as compressed file download using SuperJSON + pako
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      const base64Data = await encodeRecordingsToBase64([recording]);

      // Create blob with base64 data (will be decoded on import)
      const blob = new Blob([base64Data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      // Use .ne extension to indicate new binary format
      const baseFilename = filename?.replace(/\.json$/, "") || `recording-${recording.id}`;
      link.download = `${baseFilename}.ne`;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      throw new Error(
        `Failed to export recording: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Export all recordings as compressed file download using SuperJSON + pako
   */
  async exportAllAsFile(filename?: string): Promise<void> {
    try {
      const recordings = await this.load();
      const base64Data = await encodeRecordingsToBase64(recordings);

      // Create blob with base64 data (will be decoded on import)
      const blob = new Blob([base64Data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = url;
      // Use .ne extension to indicate new binary format
      const baseFilename =
        filename?.replace(/\.json$/, "") || `next-editor-recordings-${Date.now()}`;
      link.download = `${baseFilename}.ne`;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      throw new Error(
        `Failed to export recordings: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Import recordings from .ne or .png format file
   */
  importFromFile(): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".ne";

      input.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          reject(new Error("No file selected"));
          return;
        }

        try {
          // Read file as text and validate it's not empty/undefined
          const text = await file.text();
          const trimmedText = text.trim();
          if (!trimmedText || trimmedText.length === 0) {
            reject(new Error("File appears to be empty or corrupted"));
            return;
          }

          // Relaxed validation: Allow whitespace/newlines and check general format
          // Strip whitespace for the check
          const stripped = trimmedText.replace(/\s/g, "");
          const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
          if (!base64Pattern.test(stripped)) {
            console.error("Import validation failed. Start of text:", trimmedText.substring(0, 50));
            reject(new Error("File does not contain valid base64 data"));
            return;
          }

          const importedRecordings = await decodeBase64ToRecordings(stripped);

          // Validate imported recordings
          if (!Array.isArray(importedRecordings) || importedRecordings.length === 0) {
            reject(new Error("No valid recordings found in file"));
            return;
          }

          // Don't save to localStorage to avoid quota issues with large files
          // Just return the imported recordings for immediate use
          resolve(importedRecordings);
        } catch (error) {
          console.error("Import error details:", error);
          const errorMessage = error instanceof Error ? error.message : "Invalid file format";
          reject(new Error(`Failed to import recordings: ${errorMessage}`));
        }
      };

      input.click();
    });
  }

  /**
   * Clear all recordings from IndexedDB.
   */
  async clear(): Promise<void> {
    await this.indexedDBStore.clear();
  }

  /**
   * Get storage statistics from IndexedDB metadata.
   */
  async getStats(): Promise<StorageStats> {
    try {
      const storedMetadata = await this.indexedDBStore.listMetadata();

      if (storedMetadata.length === 0) {
        return {
          count: 0,
          totalSize: "0 B",
          compressedSize: "0 B",
          compressionRatio: "0%",
        };
      }

      const totalCompressedSize = storedMetadata.reduce(
        (total, metadata) => total + metadata.payloadSize,
        0,
      );

      return {
        count: storedMetadata.length,
        totalSize: this.formatSize(totalCompressedSize),
        compressedSize: this.formatSize(totalCompressedSize),
        compressionRatio: "N/A",
      };
    } catch (error) {
      console.error("Failed to read recording stats from IndexedDB:", error);
      return {
        count: 0,
        totalSize: "0 B",
        compressedSize: "0 B",
        compressionRatio: "0%",
      };
    }
  }
}

export const createJsonStorage = () => new JsonStorage();
