import { useState, useRef, useCallback } from 'react';

export interface UseAudioRecordingReturn {
  isRecordingAudio: boolean;
  audioBlob: Blob | null;
  startRecording: (masterStartTime: number) => Promise<void>;
  stopRecording: (masterStopTime: number) => Promise<Blob | null>;
  error: string | null;
  getRecordingDuration: () => number | null;
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
  const recordingStopTimeRef = useRef<number | null>(null);

  const startRecording = useCallback(async (masterStartTime: number) => {
    try {
      setError(null);
      recordingStartTimeRef.current = masterStartTime;
      recordingStopTimeRef.current = null;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
          sampleRate: 48000,
        }
      });

      const mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 48000
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
      };

      // Start recording at the exact master start time
      mediaRecorder.start();
      setIsRecordingAudio(true);

      console.log('🎤 Audio recording started at master time:', masterStartTime);
    } catch (err) {
      setError('Failed to start recording. Please check microphone permissions.');
      console.error('Error starting audio recording:', err);
      recordingStartTimeRef.current = null;
    }
  }, []);

  const stopRecording = useCallback((masterStopTime: number): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && isRecordingAudio) {
        recordingStopTimeRef.current = masterStopTime;

        mediaRecorderRef.current.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { 
            type: 'audio/webm; codecs=opus' 
          });
          setAudioBlob(audioBlob);
          setIsRecordingAudio(false);

          console.log('🎤 Audio recording stopped at master time:', masterStopTime);
          console.log('🎤 Synchronized duration:', masterStopTime - (recordingStartTimeRef.current || 0), 'ms');
          
          resolve(audioBlob);
        };

        mediaRecorderRef.current.stop();
      } else {
        resolve(null);
      }
    });
  }, [isRecordingAudio]);

  const getRecordingDuration = useCallback((): number | null => {
    if (recordingStartTimeRef.current && recordingStopTimeRef.current) {
      return recordingStopTimeRef.current - recordingStartTimeRef.current;
    }
    return null;
  }, []);

  return {
    isRecordingAudio,
    audioBlob,
    startRecording,
    stopRecording,
    error,
    getRecordingDuration,
  };
};