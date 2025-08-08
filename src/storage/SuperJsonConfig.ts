import superjson from 'superjson';

/**
 * Serializable Blob representation for SuperJSON
 */
interface SerializableBlob {
  data: string;
  type: string;
  [key: string]: any; // Index signature for JSONObject compatibility
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
        } as SerializableBlob & { __isSerializableBlob: true });
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  /**
   * Pre-process Recording object to convert Blobs
   */
  async prepareRecordingForSerialization(recording: any): Promise<any> {
    const prepared = { ...recording };
    
    if (recording.audioBlob instanceof Blob) {
      prepared.audioBlob = await this.blobToSerializable(recording.audioBlob);
    }
    
    return prepared;
  }
};

// Export configured superjson instance
export { superjson };