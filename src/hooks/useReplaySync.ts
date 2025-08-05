import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../store';
import { updateCurrentTime, applySnapshot, endPlayback } from '../store/slices/replaySlice';

export const useReplaySync = () => {
  const dispatch = useDispatch();
  const intervalRef = useRef<number | null>(null);
  const { 
    isPlaying, 
    currentRecording, 
    currentTime, 
    playbackSpeed,
    currentSnapshotIndex 
  } = useSelector((state: RootState) => state.replay);

  useEffect(() => {
    if (isPlaying && currentRecording) {
      // Clear any existing interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      
      intervalRef.current = setInterval(() => {
        const newTime = currentTime + (50 * playbackSpeed); // Update every 50ms
        
        // Check if we've reached any new snapshots
        if (currentRecording.snapshots.length > currentSnapshotIndex) {
          for (let i = currentSnapshotIndex; i < currentRecording.snapshots.length; i++) {
            const snapshot = currentRecording.snapshots[i];
            if (snapshot.timestamp <= newTime) {
              dispatch(applySnapshot(snapshot));
            } else {
              break;
            }
          }
        }
        
        // Stop playback when we reach the end
        if (newTime >= currentRecording.duration) {
          dispatch(updateCurrentTime(currentRecording.duration));
          dispatch(endPlayback()); // Mark as ended when reaching the end
          clearInterval(intervalRef.current!);
        } else {
          dispatch(updateCurrentTime(newTime));
        }
      }, 50);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isPlaying, currentTime, playbackSpeed, currentRecording, currentSnapshotIndex, dispatch]);
};