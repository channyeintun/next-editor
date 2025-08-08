import React, { useRef } from 'react';
import type * as monaco from 'monaco-editor';
import { useScrimba } from 'use-scrimba';
import { useAudioRecording } from '../hooks/useAudioRecording';
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
  const audioRecording = useAudioRecording();
  
  const originalScrimbaHook = useScrimba({
    editorRef,
    audioRef,
    onRecordingStart: async () => {
      console.log('📹 Recording started');
      // Start audio recording when editor recording starts
      await audioRecording.startRecording();
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
    onError: (error: Error) => {
      console.error('🚨 Scrimba error:', error);
    },
    pauseOnUserInteraction: true,
  });

  // Create custom stopRecording function that handles audio
  const stopRecordingWithAudio = async () => {
    if (audioRecording.isRecordingAudio) {
      const audioBlob = await audioRecording.stopRecording();
      if (audioBlob) {
        originalScrimbaHook.stopRecording({ audioBlob });
      } else {
        originalScrimbaHook.stopRecording();
      }
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

