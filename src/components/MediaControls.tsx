import React, { useState, useEffect } from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';

interface MediaControlsProps {
  onRecord?: () => void;
  onStopRecording?: () => void;
}

const MediaControls: React.FC<MediaControlsProps> = ({ onRecord, onStopRecording }) => {
  const {
    isRecording,
    isPlaying,
    currentTime,
    recordingStartTime,
    playbackSpeed,
    currentRecording,
    startRecording,
    stopRecording,
    play,
    pause,
    seekTo,
    setPlaybackSpeed
  } = useScrimbaContext();

  const [showSettings, setShowSettings] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  // Update recording time every 100ms when recording
  useEffect(() => {
    let interval: number;
    if (isRecording && recordingStartTime !== null) {
      interval = setInterval(() => {
        setRecordingTime(Date.now() - recordingStartTime);
      }, 100);
    } else {
      setRecordingTime(0);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording, recordingStartTime]);

  const formatTime = (milliseconds: number): string => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleRecordToggle = () => {
    if (isRecording) {
      stopRecording();
      onStopRecording?.();
    } else {
      startRecording();
      onRecord?.();
    }
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseInt(event.target.value);
    seekTo(newTime);
  };

  const duration = currentRecording?.duration || 0;

  // Calculate the time to display
  const displayTime = isRecording 
    ? recordingTime 
    : (currentRecording ? duration - currentTime : currentTime);

  return (
    <div className="bg-slate-800 border-t border-slate-700 px-4 py-3">
      <div className="flex items-center gap-3 w-full">
        {/* Record button - always show */}
        <button
            onClick={handleRecordToggle}
            className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer relative before:absolute before:-inset-2 before:content-['']"
          >
            {isRecording ? (
              <div className="w-2 h-2 bg-red-500 rounded-sm"></div>
            ) : (
              <div className="w-2 h-2 bg-red-500 rounded-full"></div>
            )}
        </button>

        {/* Show playback controls only if recording exists and not currently recording */}
        {currentRecording && !isRecording && (
          <>
            {/* Play/Pause button */}
            <button
              onClick={handlePlayPause}
              className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer relative before:absolute before:-inset-2 before:content-['']"
            >
              <div className="w-3 flex items-center justify-center">
                {isPlaying ? (
                  <div className="flex gap-0.5">
                    <div className="w-0.5 h-3 bg-white"></div>
                    <div className="w-0.5 h-3 bg-white"></div>
                  </div>
                ) : (
                  <div className="w-0 h-0 border-l-[12px] border-l-white border-y-[6px] border-y-transparent"></div>
                )}
              </div>
            </button>

            {/* Progress bar */}
            <div className="flex-1 mx-1 flex items-center">
              <input
                type="range"
                min="0"
                max={duration}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-1 bg-slate-600 rounded appearance-none cursor-pointer hover:h-1.5 transition-all duration-150"
                style={{
                  background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${duration > 0 ? (currentTime / duration) * 100 : 0}%, #475569 ${duration > 0 ? (currentTime / duration) * 100 : 0}%, #475569 100%)`,
                  margin: '0'
                }}
              />
            </div>

            {/* Settings button */}
            <div className="relative">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer relative before:absolute before:-inset-2 before:content-['']"
              >
                <div className="w-4 h-4 flex flex-col justify-center gap-0.5">
                  <div className="w-full h-0.5 bg-slate-400"></div>
                  <div className="w-full h-0.5 bg-slate-400"></div>
                  <div className="w-full h-0.5 bg-slate-400"></div>
                </div>
              </button>

              {/* Settings Popup */}
              {showSettings && (
                <div className="absolute bottom-full right-0 mb-2 bg-white rounded-lg shadow-lg p-4 min-w-[200px] z-50">
                  <div className="text-gray-800">
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Speed
                      </label>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-500 min-w-[32px]">{playbackSpeed}x</span>
                        <input
                          type="range"
                          min="0.5"
                          max="2"
                          step="0.25"
                          value={playbackSpeed}
                          onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                          className="flex-1 h-1 bg-gray-300 rounded appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Time display - show only during recording or playback */}
        {(isRecording || currentRecording) && (
          <span className="text-slate-400 text-sm font-mono">
            {isRecording ? formatTime(displayTime) : `-${formatTime(displayTime)}`}
          </span>
        )}
      </div>
    </div>
  );
};

export default MediaControls;