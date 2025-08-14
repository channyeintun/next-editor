import { useState, useRef, useCallback } from 'react';
import { calculateDurationFromFileReader } from '../utils/audioDuration';

export interface UseAudioRecordingReturn {
  isRecordingAudio: boolean;
  audioBlob: Blob | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
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

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && isRecordingAudio) {
        // Store the original onstop callback
        const mediaRecorder = mediaRecorderRef.current;
        const stream = mediaRecorder.stream as MediaStream;
        
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(track => track.stop());
          
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm; codecs=opus" });
          
          try {
            const recordingDuration = await calculateDurationFromFileReader(audioBlob);
            console.log('🎤 Audio recording stopped');
            console.log('🎤 Calculated exact duration:', recordingDuration, 'seconds');
            setAudioBlob(audioBlob);
            resolve(audioBlob);
          } catch (error) {
            console.error('Failed to calculate duration:', error);
            setAudioBlob(audioBlob);
            resolve(audioBlob);
          }
          
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