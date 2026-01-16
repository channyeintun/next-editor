import superjson from 'superjson';
import type { Recording } from '../core/src';

/**
 * Serializable Blob representation for SuperJSON
 * Extends Record to satisfy JSONValue constraint
 */
interface SerializableBlob extends Record<string, string | boolean> {
  data: string;
  type: string;
  __isSerializableBlob: boolean;
}

/**
 * Custom Blob transformer for SuperJSON
 * Note: This handles pre-converted base64 data, async conversion handled at storage level
 */
superjson.registerCustom<SerializableBlob, SerializableBlob>(
  {
    isApplicable: (v): v is SerializableBlob =>
      v &&
      typeof v === 'object' &&
      'data' in v &&
      'type' in v &&
      '__isSerializableBlob' in v,
    serialize: (serializableBlob) => serializableBlob,
    deserialize: (serializableBlob) => {
      // Return the serializable blob as-is, conversion happens at usage level
      return serializableBlob;
    },
  },
  'SerializableBlob'
);

/**
 * Helper functions for Blob conversion
 */
export const blobHelpers = {
  /**
   * Convert Blob to SerializableBlob
   */
  async blobToSerializable(blob: Blob): Promise<SerializableBlob> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve({
          data: base64,
          type: blob.type,
          __isSerializableBlob: true
        } as SerializableBlob);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  /**
   * Pre-process Recording object to convert Blobs
   */
  async prepareRecordingForSerialization(recording: Recording): Promise<Recording> {
    const prepared = { ...recording };

    if (recording.audioBlob instanceof Blob) {
      // Replace Blob with SerializableBlob for JSON compatibility
      const serialized = await this.blobToSerializable(recording.audioBlob);
      // TypeScript workaround: we're replacing the Blob with SerializableBlob
      delete (prepared as { audioBlob?: unknown }).audioBlob;
      (prepared as { audioBlob?: SerializableBlob }).audioBlob = serialized;
    }

    return prepared;
  }
};

// Export configured superjson instance
export { superjson };