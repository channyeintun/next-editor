import { useState, useRef, useCallback } from 'react';

interface UseAudioRecordingReturn {
  isRecordingAudio: boolean;
  audioBlob: Blob | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  error: string | null;
}

export const useAudioRecording = (): UseAudioRecordingReturn => {
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
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
        audioBitsPerSecond: 64000
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecordingAudio(true);
    } catch (err) {
      setError('Failed to start recording. Please check microphone permissions.');
      console.error('Error starting recording:', err);
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current && isRecordingAudio) {
        mediaRecorderRef.current.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm; codecs=opus' });
          setAudioBlob(audioBlob);
          setIsRecordingAudio(false);
          resolve(audioBlob);
        };

        mediaRecorderRef.current.stop();
      } else {
        resolve(null);
      }
    });
  }, [isRecordingAudio]);

  return {
    isRecordingAudio,
    audioBlob,
    startRecording,
    stopRecording,
    error,
  };
};