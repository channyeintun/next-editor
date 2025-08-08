import type { Recording } from 'use-scrimba';
import { superjson, blobHelpers } from './SuperJsonConfig';

/**
 * JSON Storage Interface for use-scrimba
 * Provides export/import functionality for recordings as JSON files
 */
export class JsonStorage {
  private localStorageKey = 'scrimba-recordings';

  /**
   * Save recording to localStorage using SuperJSON
   */
  async save(recording: Recording): Promise<void> {
    try {
      const existingRecordings = await this.load();
      
      // Prepare recording for SuperJSON serialization (handle Blobs)
      const preparedRecording = await blobHelpers.prepareRecordingForSerialization(recording);
      const updatedRecordings = [...existingRecordings.filter(r => r.id !== recording.id), preparedRecording];
      
      // Use SuperJSON for serialization
      const serializedData = superjson.stringify(updatedRecordings);
      localStorage.setItem(this.localStorageKey, serializedData);
    } catch (error) {
      throw new Error(`Failed to save recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load all recordings from localStorage using SuperJSON
   */
  async load(): Promise<Recording[]> {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      if (!stored) return [];
      
      // Use SuperJSON for deserialization
      const recordings = superjson.parse(stored);
      const recordingsArray = Array.isArray(recordings) ? recordings : [];
      
      // Convert SerializableBlob back to Blob for each recording
      const processedRecordings = recordingsArray.map(recording => {
        if (recording.audioBlob && recording.audioBlob.__isSerializableBlob) {
          const { data, type } = recording.audioBlob;
          if (data && data !== 'BLOB_PLACEHOLDER') {
            const byteCharacters = atob(data);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            const byteArray = new Uint8Array(byteNumbers);
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
      console.warn('Failed to load recordings from localStorage:', error);
      return [];
    }
  }

  /**
   * Delete recording from localStorage using SuperJSON
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
      localStorage.setItem(this.localStorageKey, serializedData);
    } catch (error) {
      throw new Error(`Failed to delete recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Export recording as JSON file download using SuperJSON
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      // Prepare recording for SuperJSON export (handles Blob properly)
      const preparedRecording = await blobHelpers.prepareRecordingForSerialization(recording);
      const jsonString = superjson.stringify(preparedRecording);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || `recording-${recording.id}.json`;
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
   * Export all recordings as JSON file download using SuperJSON
   */
  async exportAllAsFile(filename?: string): Promise<void> {
    try {
      const recordings = await this.load();
      // Prepare all recordings for SuperJSON export (handles Blobs properly)
      const preparedRecordings = await Promise.all(
        recordings.map(recording => blobHelpers.prepareRecordingForSerialization(recording))
      );
      const jsonString = superjson.stringify(preparedRecordings);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename || `scrimba-recordings-${Date.now()}.json`;
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
   * Import recordings from JSON file using SuperJSON
   */
  importFromFile(): Promise<Recording[]> {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      
      input.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          reject(new Error('No file selected'));
          return;
        }
        
        try {
          const text = await file.text();
          let parsed: any;
          
          // Try SuperJSON first, then fall back to regular JSON for compatibility
          try {
            parsed = superjson.parse(text);
          } catch {
            parsed = JSON.parse(text); // Fallback for older exports
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
          
          for (const recording of recordings) {
            // Process the recording for storage
            const processedForStorage = await blobHelpers.prepareRecordingForSerialization(recording);
            const updatedRecordings = [...existingRecordings.filter(r => r.id !== processedForStorage.id), processedForStorage];
            
            // Use SuperJSON for storage
            const serializedData = superjson.stringify(updatedRecordings);
            localStorage.setItem(this.localStorageKey, serializedData);
            
            // The processed recording already has the correct format for return
            processedRecordings.push(recording);
          }
          
          resolve(processedRecordings);
        } catch (error) {
          reject(new Error(`Failed to import recordings: ${error instanceof Error ? error.message : 'Invalid JSON format'}`));
        }
      };
      
      input.click();
    });
  }

  /**
   * Validate if an object is a valid Recording
   */
  private isValidRecording(obj: any): obj is Recording {
    return (
      obj &&
      typeof obj === 'object' &&
      typeof obj.id === 'string' &&
      typeof obj.name === 'string' &&
      Array.isArray(obj.snapshots) &&
      typeof obj.duration === 'number' &&
      typeof obj.createdAt === 'number'
    );
  }

  /**
   * Clear all recordings from localStorage
   */
  async clear(): Promise<void> {
    localStorage.removeItem(this.localStorageKey);
  }

  /**
   * Get storage statistics using SuperJSON
   */
  async getStats(): Promise<{ count: number; totalSize: string }> {
    const recordings = await this.load();
    
    // Prepare recordings for accurate size calculation
    const preparedRecordings = await Promise.all(
      recordings.map(recording => blobHelpers.prepareRecordingForSerialization(recording))
    );
    const jsonString = superjson.stringify(preparedRecordings);
    const sizeInBytes = new Blob([jsonString]).size;
    
    // Convert to human-readable format
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = sizeInBytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    const totalSize = `${size.toFixed(1)} ${units[unitIndex]}`;
    
    return {
      count: recordings.length,
      totalSize
    };
  }
}

export const createJsonStorage = () => new JsonStorage();