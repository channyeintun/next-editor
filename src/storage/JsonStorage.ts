import type { Recording } from 'use-scrimba';
import { superjson, blobHelpers } from './SuperJsonConfig';
import { deflate, inflate } from 'pako';

interface StorageStats {
  count: number;
  totalSize: string;
  compressedSize?: string;
  compressionRatio?: string;
}

/**
 * JSON Storage Interface for use-scrimba
 * Provides export/import functionality for recordings as JSON files with compression
 */
export class JsonStorage {
  private localStorageKey = 'scrimba-recordings';

  /**
   * Compress JSON string using pako
   */
  private compressJson(jsonString: string): string {
    try {
      const compressed = deflate(jsonString, { level: 9 });
      // Convert to base64 for storage/transfer - handle large arrays efficiently
      const chunkSize = 8192;
      let result = '';
      for (let i = 0; i < compressed.length; i += chunkSize) {
        const chunk = compressed.slice(i, i + chunkSize);
        result += String.fromCharCode(...chunk);
      }
      return btoa(result);
    } catch (error) {
      throw new Error(`Compression failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Decompress base64-encoded compressed data using pako
   */
  private decompressJson(compressedData: string): string {
    try {
      // Convert from base64
      const binaryString = atob(compressedData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const decompressed = inflate(bytes, { to: 'string' });
      return decompressed;
    } catch (error) {
      throw new Error(`Decompression failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if data is compressed (base64 encoded compressed data vs regular JSON)
   */
  private isCompressed(data: string): boolean {
    // Quick check: JSON data should start with '{' or '['
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return false; // Definitely JSON
    }
    
    // Check if it's valid base64 and doesn't look like JSON
    try {
      // Valid base64 should not contain JSON-like characters at the start
      if (trimmed.match(/^[A-Za-z0-9+/]+=*$/)) {
        atob(data);
        return true; // Valid base64, likely compressed
      }
      return false;
    } catch {
      return false; // Not valid base64
    }
  }

  /**
   * Save recording to localStorage using SuperJSON with compression
   */
  async save(recording: Recording): Promise<void> {
    try {
      const existingRecordings = await this.load();
      
      // Prepare recording for SuperJSON serialization (handle Blobs)
      const preparedRecording = await blobHelpers.prepareRecordingForSerialization(recording);
      const updatedRecordings = [...existingRecordings.filter(r => r.id !== recording.id), preparedRecording];
      
      // Use SuperJSON for serialization then compress
      const serializedData = superjson.stringify(updatedRecordings);
      const compressedData = this.compressJson(serializedData);
      localStorage.setItem(this.localStorageKey, compressedData);
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
      // Check if data is compressed and decompress if needed
      let jsonString = stored;
      if (this.isCompressed(stored)) {
        try {
          jsonString = this.decompressJson(stored);
        } catch (error) {
          console.warn('Failed to decompress data, treating as uncompressed:', error);
          jsonString = stored; // Fallback to original data
        }
      }
      
      // Use SuperJSON for deserialization
      let recordings;
      try {
        recordings = superjson.parse(jsonString);
      } catch (error) {
        console.warn('SuperJSON parse failed, trying regular JSON:', error);
        try {
          recordings = JSON.parse(jsonString);
        } catch (jsonError) {
          console.warn('Both SuperJSON and JSON parsing failed:', jsonError);
          return [];
        }
      }
      const recordingsArray = Array.isArray(recordings) ? recordings : [];
      
      // Convert SerializableBlob back to Blob for each recording
      const processedRecordings = recordingsArray.map(recording => {
        if (recording.audioBlob && recording.audioBlob.__isSerializableBlob) {
          const { data, type } = recording.audioBlob;
          if (data && data !== 'BLOB_PLACEHOLDER') {
            const byteCharacters = atob(data);
            const byteArray = new Uint8Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
              byteArray[i] = byteCharacters.charCodeAt(i);
            }
            recording.audioBlob = new Blob([byteArray], { type });
          } else {
            // Remove invalid audioBlob
            delete recording.audioBlob;
          }
        }
        return recording;
      });
      
      return processedRecordings;
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
      
      // Prepare filtered recordings for SuperJSON serialization
      const preparedRecordings = await Promise.all(
        filtered.map(recording => blobHelpers.prepareRecordingForSerialization(recording))
      );
      const serializedData = superjson.stringify(preparedRecordings);
      const compressedData = this.compressJson(serializedData);
      localStorage.setItem(this.localStorageKey, compressedData);
    } catch (error) {
      throw new Error(`Failed to delete recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Export recording as compressed file download using SuperJSON + pako
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      // Prepare recording for SuperJSON export (handles Blob properly)
      const preparedRecording = await blobHelpers.prepareRecordingForSerialization(recording);
      const jsonString = superjson.stringify(preparedRecording);
      const compressedData = this.compressJson(jsonString);
      
      // Create blob with compressed data
      const blob = new Blob([compressedData], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      // Use .scrimba extension to indicate compressed format
      const baseFilename = filename?.replace(/\.json$/, '') || `recording-${recording.id}`;
      link.download = `${baseFilename}.scrimba`;
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
      // Prepare all recordings for SuperJSON export (handles Blobs properly)
      const preparedRecordings = await Promise.all(
        recordings.map(recording => blobHelpers.prepareRecordingForSerialization(recording))
      );
      const jsonString = superjson.stringify(preparedRecordings);
      const compressedData = this.compressJson(jsonString);
      
      // Create blob with compressed data
      const blob = new Blob([compressedData], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      // Use .scrimba extension to indicate compressed format
      const baseFilename = filename?.replace(/\.json$/, '') || `scrimba-recordings-${Date.now()}`;
      link.download = `${baseFilename}.scrimba`;
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
   * Import recordings from compressed or JSON file using SuperJSON + pako
   */
  importFromFile(): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.scrimba'; // Accept both formats
      
      input.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          reject(new Error('No file selected'));
          return;
        }
        
        try {
          const text = await file.text();
          let jsonString = text;
          let parsed: unknown;
          
          // Check if file is compressed (.scrimba extension or compressed data)
          const isScrimbaFile = file.name.endsWith('.scrimba');
          const isCompressedData = this.isCompressed(text);
          
          if (isScrimbaFile || isCompressedData) {
            // Decompress the data
            jsonString = this.decompressJson(text);
          }
          
          // Try SuperJSON first, then fall back to regular JSON for compatibility
          try {
            parsed = superjson.parse(jsonString);
          } catch {
            parsed = JSON.parse(jsonString); // Fallback for older exports
          }
          
          // Validate the imported data
          let recordings: Recording[];
          if (Array.isArray(parsed)) {
            recordings = parsed.filter(this.isValidRecording);
          } else if (this.isValidRecording(parsed)) {
            recordings = [parsed];
          } else {
            throw new Error('Invalid recording format');
          }
          
          // Load existing recordings using SuperJSON
          const existingRecordings = await this.load();
          const processedRecordings = [];
          
          // Process all recordings at once to avoid partial failures
          for (const recording of recordings) {
            const processedForStorage = await blobHelpers.prepareRecordingForSerialization(recording);
            existingRecordings.push(processedForStorage);
            processedRecordings.push(recording);
          }
          
          // Remove duplicates based on ID (imported recordings override existing ones)
          const uniqueRecordings = existingRecordings.reduce((acc, recording) => {
            const existingIndex = acc.findIndex(r => r.id === recording.id);
            if (existingIndex >= 0) {
              acc[existingIndex] = recording; // Replace existing
            } else {
              acc.push(recording); // Add new
            }
            return acc;
          }, [] as typeof existingRecordings);
          
          // Save all recordings at once
          const serializedData = superjson.stringify(uniqueRecordings);
          const compressedData = this.compressJson(serializedData);
          localStorage.setItem(this.localStorageKey, compressedData);
          
          resolve(processedRecordings);
        } catch (error) {
          reject(new Error(`Failed to import recordings: ${error instanceof Error ? error.message : 'Invalid file format'}`));
        }
      };
      
      input.click();
    });
  }

  /**
   * Validate if an object is a valid Recording
   */
  private isValidRecording(obj: unknown): obj is Recording {
    if (!obj || typeof obj !== 'object') {
      return false;
    }
    
    const record = obj as Record<string, unknown>;
    return (
      typeof record.id === 'string' &&
      typeof record.name === 'string' &&
      Array.isArray(record.snapshots) &&
      typeof record.duration === 'number' &&
      typeof record.createdAt === 'number'
    );
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
    
    // Calculate uncompressed size for comparison
    const preparedRecordings = await Promise.all(
      recordings.map(recording => blobHelpers.prepareRecordingForSerialization(recording))
    );
    const jsonString = superjson.stringify(preparedRecordings);
    const uncompressedSize = new Blob([jsonString]).size;
    
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
    const compressionRatio = uncompressedSize > 0 
      ? `${((1 - actualCompressedSize / uncompressedSize) * 100).toFixed(1)}%` 
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