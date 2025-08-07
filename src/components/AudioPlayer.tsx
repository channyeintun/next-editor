import React, { useEffect } from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

interface AudioPlayerProps {
  audioBlob: Blob | null;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioBlob }) => {
  // The useScrimba hook now handles all audio synchronization automatically
  // We just use the audioRef from context
  const { audioRef } = useScrimbaContext();
  
  // Set up the audio blob when it changes
  useEffect(() => {
    if (audioRef.current && audioBlob) {
      const audioUrl = URL.createObjectURL(audioBlob);
      audioRef.current.src = audioUrl;
      
      return () => {
        URL.revokeObjectURL(audioUrl);
      };
    }
  }, [audioRef, audioBlob]);
  
  return (
    <audio
      ref={audioRef}
      style={{ display: 'none' }} // Hidden audio element
    />
  );
};

export default AudioPlayer;