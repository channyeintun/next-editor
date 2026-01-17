import React, { useState, useEffect } from 'react';
import { Circle, Square, Plus } from 'lucide-react';
import { useNextEditorContext } from '../hooks/useNextEditorContext';
import { getAudioContext, unlockAudioContext } from '../core/src/utils/audioContext';
import ReplayIcon from './icon/Replay';
import PlayIcon from './icon/Play';
import PauseIcon from './icon/Pause';
import SettingIcon from './icon/Setting';
import ProgressBar from './ProgressBar';
import RecordingEditor from './RecordingEditor';
import type { Recording } from '../core/src';

interface MediaControlsProps {
  onRecord?: () => void;
  onStopRecording?: () => void;
  onSaveToImage?: (file: File) => void;
  recordMode?: boolean;
  positioning?: 'fixed' | 'relative' | 'absolute' | 'sticky';
}

const MediaControls: React.FC<MediaControlsProps> = ({
  onRecord,
  onStopRecording,
  recordMode = true,
  positioning = 'fixed'
}) => {
  const {
    isRecording,
    isPlaying,
    currentTime,
    recordingStartTime,
    playbackSpeed,
    currentRecording,
    startRecording,
    stopRecording,
    clearRecording,
    play,
    pause,
    seekTo,
    setPlaybackSpeed,
    hasEnded,
    volume,
    setVolume,
    actualDuration,
    loadRecording,
  } = useNextEditorContext();

  const [showSettings, setShowSettings] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [showRecordingEditor, setShowRecordingEditor] = useState(false);

  // Update recording time every 100ms when recording
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
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
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };



  const handlePlayPause = () => {
    // Aggressive Safari Wake: Resume context directly in the click handler
    const ctx = getAudioContext();
    unlockAudioContext(ctx);
    ctx.resume().catch(() => { });

    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleSeek = (targetTime: number) => {
    // Aggressive Safari Wake: Resume context or ensure it's awake during seek
    const ctx = getAudioContext();
    unlockAudioContext(ctx);
    ctx.resume().catch(() => { });

    seekTo(targetTime);
  };

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(event.target.value);
    setVolume(newVolume);
  };

  const handleEditClick = () => {
    if (currentRecording) {
      setShowRecordingEditor(true);
    }
  };

  const handleSaveRecording = async (editedRecording: Recording) => {
    try {
      loadRecording(editedRecording);
      setShowRecordingEditor(false);
    } catch (error) {
      console.error('Save failed:', error);
    }
  };

  const handleCancelExport = () => {
    setShowRecordingEditor(false);
  };

  const duration = currentRecording?.duration || 0;
  const progressDuration = actualDuration > 0 ? actualDuration * 1000 : duration;

  const displayTime = isRecording
    ? recordingTime
    : (currentRecording ? Math.max(0, progressDuration - currentTime) : currentTime);

  return (
    <div className={`${positioning} bottom-0 left-0 w-full px-4 py-3 z-50`}>
      <div className="flex items-center gap-3 w-full h-6">
        {recordMode && (
          <button
            onClick={() => {
              if (isRecording) {
                stopRecording();
                onStopRecording?.();
              } else if (currentRecording) {
                clearRecording();
              } else {
                startRecording();
                onRecord?.();
              }
            }}
            disabled={isPlaying}
            className={`flex items-center justify-center transition-colors relative ${isPlaying ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80 cursor-pointer'}`}
            title={isRecording ? "Stop Recording" : (currentRecording ? "New Recording" : "Start Recording")}
          >
            {isRecording ? (
              <Square size={14} className="fill-red-500 text-red-500 animate-pulse" />
            ) : currentRecording ? (
              <div className="relative">
                <Circle size={14} className="fill-red-500 text-red-500" />
                <div className="absolute -top-1 -right-1.5 bg-[#202732] rounded-full p-[0.5px]">
                  <Plus size={10} className="text-red-500 stroke-[3px]" />
                </div>
              </div>
            ) : (
              <Circle size={14} className="fill-red-500 text-red-500" />
            )}
          </button>
        )}

        {currentRecording && !isRecording && (
          <>
            <button onClick={handlePlayPause} className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer w-6">
              {isPlaying ? <PauseIcon /> : (hasEnded ? <ReplayIcon /> : <PlayIcon />)}
            </button>

            <div className="flex-1 mx-1 flex items-center">
              <ProgressBar
                progress={progressDuration > 0 ? Math.min((currentTime / progressDuration) * 100, 100) : 0}
                duration={progressDuration}
                currentTime={currentTime}
                onSeek={handleSeek}
                backgroundColor="#475569"
                progressColor="#3b82f6"
                className="w-full"
              />
            </div>

            <div className="relative">
              <button
                onClick={() => setShowSettings(prev => !prev)}
                className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer"
              >
                <SettingIcon />
              </button>

              {showSettings && (
                <div className="absolute bottom-full right-0 mb-2 bg-white rounded-lg shadow-lg p-4 min-w-[200px] z-50">
                  <div className="text-gray-800">
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Speed</label>
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
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Volume</label>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-500 min-w-[32px]">{Math.round(volume * 100)}</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.1"
                          value={volume}
                          onChange={handleVolumeChange}
                          className="flex-1 h-1 bg-gray-300 rounded appearance-none cursor-pointer"
                        />
                      </div>
                    </div>
                    {recordMode && (
                      <div className="pt-3 border-t">
                        <button
                          onClick={handleEditClick}
                          className="w-full px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors text-sm mb-2"
                        >
                          Edit JSON
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {(isRecording || currentRecording) && (
          <span className="text-slate-400 text-sm font-mono">
            {isRecording ? formatTime(displayTime) : `-${formatTime(displayTime)}`}
          </span>
        )}
      </div>

      {currentRecording && (
        <RecordingEditor
          recording={currentRecording}
          isVisible={showRecordingEditor}
          mode="edit"
          onSave={handleSaveRecording}
          onCancel={handleCancelExport}
        />
      )}
    </div>
  );
};

export default MediaControls;