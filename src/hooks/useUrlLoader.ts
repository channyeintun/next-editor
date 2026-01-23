
import { useCallback, useState } from 'react';
import type { Recording, AudioPlaceholder } from '../core/src/types';
import { decodeBase64 } from '../core/src/utils/base64';
import { useNextEditorActions } from './useNextEditorContext';

export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  const { loadRecording } = useNextEditorActions();

  const isNextEditorUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      return pathname.endsWith('.ne');
    } catch {
      return false;
    }
  };

  const importNextEditorFile = useCallback(async (file: File) => {
    try {
      setIsLoading(true);
      if (file.name.endsWith('.ne')) {
        const text = await file.text();
        const trimmedText = text.trim();

        if (!trimmedText || trimmedText.length === 0) {
          throw new Error('File appears to be empty or corrupted');
        }

        // Relaxed validation: Allow whitespace/newlines and check general format
        // Strip whitespace for the check
        const stripped = trimmedText.replace(/\s/g, '');
        const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Pattern.test(stripped)) {
          throw new Error('File does not contain valid base64 data');
        }

        const binaryData = decodeBase64(stripped);
        const recordings = await decompressBinaryToRecordings(binaryData);

        if (recordings.length > 0) {
          loadRecording(recordings[0]);
        }
      }
    } catch (error) {
      console.error('Failed to import file:', error);
      alert(`Failed to import file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  }, [loadRecording]);

  const fetchNextEditorFile = useCallback(async (url: string) => {
    if (!isNextEditorUrl(url)) {
      throw new Error('URL does not point to a supported file (.ne)');
    }

    try {
      setIsLoading(true);

      // Use proxy if URL is cross-origin to avoid CORS issues
      let fetchUrl = url;
      try {
        const urlObj = new URL(url);
        if (urlObj.origin !== window.location.origin) {
          const isLocal = window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname.endsWith('.local');

          let proxyBase = 'https://mastodon.website';
          if (isLocal) {
            proxyBase = 'http://localhost:9003';
          } else if (window.location.hostname.includes('code.mastodon.website')) {
            // If we are on the subdomain, the proxy is on the main domain
            proxyBase = window.location.origin.replace('code.', '');
          }

          fetchUrl = `${proxyBase}/api/proxy?url=${encodeURIComponent(url)}`;
        }
      } catch (e) {
        console.warn('Failed to parse URL for proxy check:', e);
      }

      const response = await fetch(fetchUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      const blob = await response.blob();
      const file = new File([blob], url.split('/').pop() || 'recording', { type: blob.type });
      await importNextEditorFile(file);
    } catch (error) {
      console.error('Failed to load tutorial from URL:', error);
      alert(`Failed to load tutorial: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [importNextEditorFile]);

  // Helper functions from JsonStorage (still needed for .ne files)
  const decompressBinaryToRecordings = async (binaryData: Uint8Array) => {
    const pakoModule = await import('pako');
    const inflate = pakoModule.inflate || pakoModule.default;

    if (!inflate) {
      throw new Error('Storage configuration error: pako is not available');
    }
    const superjsonModule = await import('../storage/SuperJsonConfig');
    const superjson = superjsonModule.superjson || superjsonModule.default;

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

    if (!superjson || typeof superjson.parse !== 'function') {
      throw new Error('Storage configuration error: superjson is not available');
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
  };

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading
  };
};