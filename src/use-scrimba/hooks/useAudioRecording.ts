import { useState, useRef, useCallback } from 'react';
import { calculateDurationFromFileReader } from '../utils/audioDuration';

export interface UseAudioRecordingReturn {
  isRecordingAudio: boolean;
  audioBlob: Blob | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  error: string | null;
  getRecordingDuration: () => number | null;
  calculateExactDuration: (audioBlob: Blob) => Promise<number>;
}

/**
 * Hook for synchronized audio recording within the use-scrimba package
 * Ensures perfect synchronization with snapshot recording
 */
export const useAudioRecording = (): UseAudioRecordingReturn => {
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number | null>(null);

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
          sampleRate: 48000,
        }
      });

      const mimeType = "audio/webm; codecs=opus";
      const mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 48000,
        mimeType: mimeType,
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        
        try {
          const recordingDuration = await calculateDurationFromFileReader(audioBlob);
          console.log('🎤 Audio recording stopped');
          console.log('🎤 Calculated exact duration:', recordingDuration, 'seconds');
          setAudioBlob(audioBlob);
        } catch (error) {
          console.error('Failed to calculate duration:', error);
          setAudioBlob(audioBlob);
        }
        
        setIsRecordingAudio(false);
      };

      // Start recording
      mediaRecorder.start();
      setIsRecordingAudio(true);

      console.log('🎤 Audio recording started');
    } catch (err) {
      setError('Failed to start recording. Please check microphone permissions.');
      console.error('Error starting audio recording:', err);
      recordingStartTimeRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.stop();
    }
  }, [isRecordingAudio]);

  const getRecordingDuration = useCallback((): number | null => {
    // Duration is now calculated using FileReader for accuracy
    // This function is kept for backward compatibility
    return null;
  }, []);

  const calculateExactDuration = useCallback(async (audioBlob: Blob): Promise<number> => {
    return await calculateDurationFromFileReader(audioBlob);
  }, []);

  return {
    isRecordingAudio,
    audioBlob,
    startRecording,
    stopRecording,
    error,
    getRecordingDuration,
    calculateExactDuration,
  };
};