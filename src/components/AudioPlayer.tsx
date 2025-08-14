import React from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

const AudioPlayer: React.FC = () => {
  // The useScrimba hook handles all audio synchronization and URL management automatically
  const { audioRef } = useScrimbaContext();
  
  return (
    <audio
      ref={audioRef}
      style={{ display: 'none' }} // Hidden audio element
    />
  );
};

export default AudioPlayer;