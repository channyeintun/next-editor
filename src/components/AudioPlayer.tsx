import React, { useRef, useEffect, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { updateCurrentTime } from '../store/slices/replaySlice';

interface AudioPlayerProps {
  audioBlob: Blob | null;
  isPlaying: boolean;
  currentTime: number;
  playbackSpeed: number;
  hasEnded: boolean;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({
  audioBlob,
  isPlaying,
  currentTime,
  playbackSpeed,
  hasEnded,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dispatch = useDispatch();
  
  // Create audio URL from blob
  useEffect(() => {
    if (audioBlob && audioRef.current) {
      const audioUrl = URL.createObjectURL(audioBlob);
      audioRef.current.src = audioUrl;
      
      return () => {
        URL.revokeObjectURL(audioUrl);
      };
    }
  }, [audioBlob]);
  
  // Control playback
  useEffect(() => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.play().catch(console.error);
      } else {
        audioRef.current.pause();
      }
    }
  }, [isPlaying]);
  
  // Set playback speed
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);
  
  // Seek to specific time
  useEffect(() => {
    if (audioRef.current && Math.abs(audioRef.current.currentTime - currentTime / 1000) > 0.5) {
      audioRef.current.currentTime = currentTime / 1000;
      // Only auto-play if we're seeking while actively playing (not if it has ended)
      if (isPlaying && !hasEnded && audioRef.current.paused) {
        audioRef.current.play().catch(console.error);
      }
    }
  }, [currentTime, isPlaying, hasEnded]);
  
  // Update current time during playback
  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      const currentTimeMs = audioRef.current.currentTime * 1000;
      dispatch(updateCurrentTime(currentTimeMs));
    }
  }, [dispatch]);

  // Handle when audio ends
  const handleAudioEnded = useCallback(() => {
    // Don't dispatch anything here - let the useReplaySync hook handle it
  }, []);
  
  return (
    <audio
      ref={audioRef}
      onTimeUpdate={handleTimeUpdate}
      onEnded={handleAudioEnded}
      onLoadedMetadata={() => {
        // Audio metadata loaded
      }}
      style={{ display: 'none' }} // Hidden audio element
    />
  );
};

export default AudioPlayer;