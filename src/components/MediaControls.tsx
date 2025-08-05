import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../store';
import { play, pause, stop, seekTo, setPlaybackSpeed } from '../store/slices/replaySlice';

interface MediaControlsProps {
  onRecord?: () => void;
  onStopRecording?: () => void;
}

const MediaControls: React.FC<MediaControlsProps> = ({ onRecord, onStopRecording }) => {
  const dispatch = useDispatch();
  const { isRecording } = useSelector((state: RootState) => state.recording);
  const { 
    isPlaying, 
    currentTime, 
    playbackSpeed,
    currentRecording 
  } = useSelector((state: RootState) => state.replay);

  const formatTime = (milliseconds: number): string => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handlePlay = () => {
    dispatch(play());
  };

  const handlePause = () => {
    dispatch(pause());
  };

  const handleStop = () => {
    dispatch(stop());
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseInt(event.target.value);
    dispatch(seekTo(newTime));
  };

  const handleSpeedChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newSpeed = parseFloat(event.target.value);
    dispatch(setPlaybackSpeed(newSpeed));
  };

  const duration = currentRecording?.duration || 0;

  return (
    <div className="p-5 bg-gray-800 rounded-lg">
      <div className="mb-4">
        {!isRecording ? (
          <button 
            onClick={onRecord}
            className="px-6 py-3 text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-md font-medium transition-colors"
            disabled={isPlaying}
          >
            🔴 Start Recording
          </button>
        ) : (
          <button 
            onClick={onStopRecording}
            className="px-6 py-3 text-white bg-gray-600 hover:bg-gray-700 rounded-md font-medium transition-colors"
          >
            ⏹️ Stop Recording
          </button>
        )}
      </div>

      {currentRecording && (
        <div className="flex flex-col gap-4">
          <div className="flex gap-3">
            <button 
              onClick={handleStop} 
              disabled={isRecording}
              className="w-12 h-12 text-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-full flex items-center justify-center transition-colors"
            >
              ⏹️
            </button>
            
            {isPlaying ? (
              <button 
                onClick={handlePause} 
                disabled={isRecording}
                className="w-12 h-12 text-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-full flex items-center justify-center transition-colors"
              >
                ⏸️
              </button>
            ) : (
              <button 
                onClick={handlePlay} 
                disabled={isRecording}
                className="w-12 h-12 text-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-full flex items-center justify-center transition-colors"
              >
                ▶️
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            <span className="text-gray-300 font-mono text-sm min-w-[40px] text-center">
              {formatTime(currentTime)}
            </span>
            
            <input
              type="range"
              min="0"
              max={duration}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-2 bg-gray-600 rounded-sm outline-none slider"
              disabled={isRecording}
            />
            
            <span className="text-gray-300 font-mono text-sm min-w-[40px] text-center">
              {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="speed-select" className="text-gray-300">Speed:</label>
            <select
              id="speed-select"
              value={playbackSpeed}
              onChange={handleSpeedChange}
              disabled={isRecording}
              className="px-3 py-1 border border-gray-600 rounded bg-gray-700 text-gray-300 disabled:bg-gray-600 disabled:cursor-not-allowed"
            >
              <option value={0.5}>0.5x</option>
              <option value={0.75}>0.75x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
};

export default MediaControls;