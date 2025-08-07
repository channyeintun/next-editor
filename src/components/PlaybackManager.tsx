import React from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import AudioPlayer from './AudioPlayer';

/**
 * Component that manages synchronized playback between editor and audio
 */
const PlaybackManager: React.FC = () => {
  const { currentRecording } = useScrimbaContext();
  
  // Cast to access audioBlob - this is safe since recordings with audio will have this property
  const recordingWithAudio = currentRecording as { audioBlob?: Blob } | null;
  const audioBlob = recordingWithAudio?.audioBlob || null;

  return (
    <>
      {audioBlob && <AudioPlayer audioBlob={audioBlob} />}
    </>
  );
};

export default PlaybackManager;