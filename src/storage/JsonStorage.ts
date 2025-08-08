import type { StorageProvider, Recording } from 'use-scrimba';

/**
 * JSON Storage Interface for use-scrimba
 * Provides export/import functionality for recordings as JSON files
 */
export class JsonStorage implements StorageProvider {
  private localStorageKey = 'scrimba-recordings';

  /**
   * Save recording to localStorage
   */
  async save(recording: Recording): Promise<void> {
    try {
      const existingRecordings = await this.load();
      
      // Convert recording to serializable format
      const serializableRecording = await this.recordingToSerializable(recording);
      const updatedRecordings = [...existingRecordings.filter(r => r.id !== recording.id), serializableRecording];
      
      localStorage.setItem(this.localStorageKey, JSON.stringify(updatedRecordings));
    } catch (error) {
      throw new Error(`Failed to save recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load all recordings from localStorage
   */
  async load(): Promise<Recording[]> {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      if (!stored) return [];
      
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      
      // Convert serializable format back to Recording objects with Blobs
      const recordings = await Promise.all(
        parsed.map(item => this.serializableToRecording(item))
      );
      
      return recordings;
    } catch (error) {
      console.warn('Failed to load recordings from localStorage:', error);
      return [];
    }
  }

  /**
   * Delete recording from localStorage
   */
  async delete(id: string): Promise<void> {
    try {
      const recordings = await this.load();
      const filtered = recordings.filter(r => r.id !== id);
      localStorage.setItem(this.localStorageKey, JSON.stringify(filtered));
    } catch (error) {
      throw new Error(`Failed to delete recording: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Export recording as JSON file download
   */
  async exportAsFile(recording: Recording, filename?: string): Promise<void> {
    try {
      // Convert recording to serializable format (handles Blob properly)
      const serializableRecording = await this.recordingToSerializable(recording);
      const jsonString = JSON.stringify(serializableRecording, null, 2);
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
   * Export all recordings as JSON file download
   */
  async exportAllAsFile(filename?: string): Promise<void> {
    try {
      const recordings = await this.load();
      // Convert all recordings to serializable format (handles Blobs properly)
      const serializableRecordings = await Promise.all(
        recordings.map(recording => this.recordingToSerializable(recording))
      );
      const jsonString = JSON.stringify(serializableRecordings, null, 2);
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
   * Import recordings from JSON file
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
          const parsed = JSON.parse(text);
          
          // Validate the imported data
          let recordings: Recording[];
          if (Array.isArray(parsed)) {
            recordings = parsed.filter(this.isValidRecording);
          } else if (this.isValidRecording(parsed)) {
            recordings = [parsed];
          } else {
            throw new Error('Invalid recording format');
          }
          
          // Handle imported recordings - they might already be in serialized format
          const existingStoredRecordings = localStorage.getItem(this.localStorageKey);
          const existingParsed = existingStoredRecordings ? JSON.parse(existingStoredRecordings) : [];
          const existingRecordings = Array.isArray(existingParsed) ? existingParsed : [];
          
          const processedRecordings = [];
          
          for (const recording of recordings) {
            // Process the recording for storage
            const processedForStorage = await this.processImportedRecording(recording);
            const updatedRecordings = [...existingRecordings.filter(r => r.id !== processedForStorage.id), processedForStorage];
            localStorage.setItem(this.localStorageKey, JSON.stringify(updatedRecordings));
            
            // Convert back to Recording with Blob for return value
            const processedForReturn = await this.serializableToRecording(processedForStorage);
            processedRecordings.push(processedForReturn);
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
   * Convert Recording with Blob to serializable format
   */
  private async recordingToSerializable(recording: Recording): Promise<any> {
    const serializable: any = { ...recording };
    
    if (recording.audioBlob) {
      // Convert Blob to base64 string
      serializable.audioData = await this.blobToBase64(recording.audioBlob);
      serializable.audioType = recording.audioBlob.type;
      delete serializable.audioBlob; // Remove non-serializable Blob
    }
    
    return serializable;
  }

  /**
   * Convert serializable format back to Recording with Blob
   */
  private async serializableToRecording(serializable: any): Promise<Recording> {
    const recording: Recording = { ...serializable };
    
    if (serializable.audioData && serializable.audioType) {
      // Convert base64 string back to Blob
      recording.audioBlob = this.base64ToBlob(serializable.audioData, serializable.audioType);
      delete (recording as any).audioData; // Remove serialized data
      delete (recording as any).audioType; // Remove type info
    }
    
    return recording;
  }

  /**
   * Convert Blob to base64 string
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:audio/webm;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Convert base64 string to Blob
   */
  private base64ToBlob(base64: string, type: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type });
  }

  /**
   * Process imported recording to handle different formats
   */
  private async processImportedRecording(importedRecording: any): Promise<any> {
    // If it already has audioData/audioType (serialized format), use it directly
    if (importedRecording.audioData && importedRecording.audioType) {
      return importedRecording; // Already in serializable format
    }
    
    // If it has audioBlob (but it's likely just JSON data), remove it
    if (importedRecording.audioBlob) {
      const cleanRecording = { ...importedRecording };
      delete cleanRecording.audioBlob; // Remove invalid audioBlob data
      return cleanRecording;
    }
    
    // If it's a regular Recording with a real Blob, convert it
    if (importedRecording.audioBlob instanceof Blob) {
      return await this.recordingToSerializable(importedRecording);
    }
    
    // No audio data, return as-is
    return importedRecording;
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{ count: number; totalSize: string }> {
    const recordings = await this.load();
    const jsonString = JSON.stringify(recordings);
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