import React, { useRef, useState } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from 'use-scrimba';
import { ScrimbaContext } from './ScrimbaContext';

interface ScrimbaProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that makes useScrimba functionality available to all child components
 * This replaces Redux state management with the useScrimba hook
 */
export const ScrimbaProvider: React.FC<ScrimbaProviderProps> = ({ children }) => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const originalScrimbaHook = useScrimba({
    editorRef,
    audioRef,
    onRecordingStart: async () => {
      console.log('📹 Recording started');
      // Start audio recording when editor recording starts
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        
        // Reset audio chunks
        audioChunksRef.current = [];
        
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        
        mediaRecorder.onstop = () => {
          // Stop all tracks to release microphone
          stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        setIsRecordingAudio(true);
        
      } catch (error) {
        console.error('Failed to start audio recording:', error);
      }
    },
    onRecordingStop: (recording) => {
      console.log('⏹️ Recording stopped', recording);
    },
    onPlaybackStart: () => {
      console.log('▶️ Playback started');
    },
    onPlaybackPause: () => {
      console.log('⏸️ Playback paused');
    },
  });

  // Create custom stopRecording function that handles audio
  const stopRecordingWithAudio = () => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.onstop = () => {
        // Create audio blob and attach to recording
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        originalScrimbaHook.stopRecording({ audioBlob });
      };
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    } else {
      originalScrimbaHook.stopRecording();
    }
  };

  // Create enhanced scrimba hook with audio-aware stopRecording
  const scrimbaHook = {
    ...originalScrimbaHook,
    stopRecording: stopRecordingWithAudio
  };

  return (
    <ScrimbaContext value={{ ...scrimbaHook, editorRef, audioRef }}>
      {children}
    </ScrimbaContext>
  );
};

