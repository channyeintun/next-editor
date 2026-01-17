import { useState, useRef, useCallback } from 'react';
import { calculateDurationFromFileReader } from '../utils/audioDuration';

const getSupportedAudioMimeType = (): string => {
  const mimeTypes = [
    'audio/webm; codecs=opus',
    'audio/webm',
    'audio/mp4; codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg; codecs=opus',
    'audio/ogg',
    'audio/wav',
    'audio/mpeg'
  ];

  if (typeof MediaRecorder === 'undefined') {
    return '';
  }

  for (const mimeType of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return '';
};

export interface UseAudioRecordingReturn {
  isRecordingAudio: boolean;
  audioBlob: Blob | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
  calculateExactDuration: (audioBlob: Blob) => Promise<number>;
}

/**
 * Hook for synchronized audio recording within the use-next-editor package
 * Ensures perfect synchronization with frame recording
 */
export const useAudioRecording = (): UseAudioRecordingReturn => {
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);
  const mimeTypeRef = useRef<string>('');

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      recordingStartTimeRef.current = Date.now();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 16000,
        }
      });

      const mimeType = getSupportedAudioMimeType();
      if (!mimeType) {
        throw new Error('No supported audio MIME type found');
      }

      mimeTypeRef.current = mimeType;
      const mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 32000,
        mimeType: mimeType,
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Start recording
      mediaRecorder.start();
      setIsRecordingAudio(true);
    } catch (err) {
      setError('Failed to start recording. Please check microphone permissions.');
      console.error('Error starting audio recording:', err);
      recordingStartTimeRef.current = null;
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && isRecordingAudio) {
        // Store the original onstop callback
        const mediaRecorder = mediaRecorderRef.current;
        const stream = mediaRecorder.stream as MediaStream;

        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(track => track.stop());

          const audioBlob = new Blob(audioChunksRef.current, { type: mimeTypeRef.current });

          setAudioBlob(audioBlob);
          resolve(audioBlob);

          setIsRecordingAudio(false);
        };

        mediaRecorder.stop();
      } else {
        resolve(null);
      }
    });
  }, [isRecordingAudio]);


  const calculateExactDuration = useCallback(async (audioBlob: Blob): Promise<number> => {
    return await calculateDurationFromFileReader(audioBlob);
  }, []);

  return {
    isRecordingAudio,
    audioBlob,
    startRecording,
    stopRecording,
    error,
    calculateExactDuration,
  };
};