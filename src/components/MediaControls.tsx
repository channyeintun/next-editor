import React, { useState, useEffect, useCallback, memo, useRef } from "react";
import { Circle, Square, Plus, FileMusic, Mic, X } from "lucide-react";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
  useLiveTime,
} from "../hooks/useNextEditorContext";
import { getAudioContext, unlockAudioContext } from "../core/src/utils/audioContext";
import ReplayIcon from "./icon/Replay";
import IdleRecordButton from "./IdleRecordButton";
import PlayIcon from "./icon/Play";
import PauseIcon from "./icon/Pause";
import SettingIcon from "./icon/Setting";
import ProgressBar from "./ProgressBar";
import RecordingEditor from "./RecordingEditor";
import type { Recording } from "../core/src";

interface MediaControlsProps {
  onRecord?: () => void;
  onStopRecording?: () => void;
  onSaveToImage?: (file: File) => void;
  recordMode?: boolean;
  positioning?: "fixed" | "relative" | "absolute" | "sticky";
}

type RecordingAudioSourceOption = "microphone" | "external";

const formatTime = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const PlaybackProgress = memo(
  ({ progressDuration, onSeek }: { progressDuration: number; onSeek: (time: number) => void }) => {
    const currentTime = useLiveTime();
    return (
      <div className="flex-1 mx-1 flex items-center pointer-events-auto">
        <ProgressBar
          progress={
            progressDuration > 0 ? Math.min((currentTime / progressDuration) * 100, 100) : 0
          }
          duration={progressDuration}
          currentTime={currentTime}
          onSeek={onSeek}
          backgroundColor="#475569"
          progressColor="#3b82f6"
          className="w-full"
        />
      </div>
    );
  },
);

const PlaybackTimer = memo(
  ({
    isRecording,
    recordingTime,
    currentRecording,
    progressDuration,
  }: {
    isRecording: boolean;
    recordingTime: number;
    currentRecording: Recording | null;
    progressDuration: number;
  }) => {
    const currentTime = useLiveTime();
    const displayTime = isRecording
      ? recordingTime
      : currentRecording
        ? Math.max(0, progressDuration - currentTime)
        : currentTime;

    return (
      <span className="text-slate-400 text-sm font-mono pointer-events-auto">
        {isRecording ? formatTime(displayTime) : `-${formatTime(displayTime)}`}
      </span>
    );
  },
);

const MediaControls: React.FC<MediaControlsProps> = memo(
  ({ onRecord, onStopRecording, recordMode = true, positioning = "fixed" }) => {
    const {
      startRecording,
      stopRecording,
      clearRecording,
      play,
      pause,
      seekTo,
      setPlaybackSpeed,
      setVolume,
      loadRecording,
    } = useNextEditorActions();

    const { isRecording, isPlaying, currentRecording, hasEnded, recordingStartTime } =
      useNextEditorMetadata();

    const { playbackSpeed, volume, duration: actualDuration } = useNextEditorPlayback();

    const [showSettings, setShowSettings] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [showRecordingEditor, setShowRecordingEditor] = useState(false);
    const [recordingAudioSource, setRecordingAudioSource] =
      useState<RecordingAudioSourceOption>("microphone");
    const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
    const audioFileInputRef = useRef<HTMLInputElement>(null);

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

    const handlePlayPause = useCallback(() => {
      // Aggressive Safari Wake: Resume context directly in the click handler
      const ctx = getAudioContext();
      unlockAudioContext(ctx);
      ctx.resume().catch(() => {});

      if (isPlaying) {
        pause();
      } else {
        play();
      }
    }, [isPlaying, pause, play]);

    const handleSeek = useCallback(
      (targetTime: number) => {
        // Aggressive Safari Wake: Resume context or ensure it's awake during seek
        const ctx = getAudioContext();
        unlockAudioContext(ctx);
        ctx.resume().catch(() => {});

        seekTo(targetTime);
      },
      [seekTo],
    );

    const handleVolumeChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseFloat(event.target.value);
        setVolume(newVolume);
      },
      [setVolume],
    );

    const handleSaveRecording = useCallback(
      async (editedRecording: Recording) => {
        try {
          loadRecording(editedRecording);
          setShowRecordingEditor(false);
        } catch (error) {
          console.error("Save failed:", error);
        }
      },
      [loadRecording],
    );

    const handleCancelExport = useCallback(() => {
      setShowRecordingEditor(false);
    }, []);

    const handleSelectMicrophoneAudio = useCallback(() => {
      setRecordingAudioSource("microphone");
    }, []);

    const handleSelectExternalAudio = useCallback(() => {
      setRecordingAudioSource("external");
      if (!selectedAudioFile) {
        audioFileInputRef.current?.click();
      }
    }, [selectedAudioFile]);

    const handleAudioFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;

      if (!file) {
        return;
      }

      setSelectedAudioFile(file);
      setRecordingAudioSource("external");
      event.target.value = "";
    }, []);

    const handleClearSelectedAudio = useCallback(() => {
      setSelectedAudioFile(null);
      setRecordingAudioSource("microphone");
    }, []);

    const handleRecordButtonClick = useCallback(() => {
      if (isRecording) {
        stopRecording();
        onStopRecording?.();
        return;
      }

      if (currentRecording) {
        clearRecording();
        return;
      }

      if (recordingAudioSource === "external") {
        if (!selectedAudioFile) {
          audioFileInputRef.current?.click();
          return;
        }

        startRecording({ audioBlob: selectedAudioFile });
        onRecord?.();
        return;
      }

      startRecording();
      onRecord?.();
    }, [
      clearRecording,
      currentRecording,
      isRecording,
      onRecord,
      onStopRecording,
      recordingAudioSource,
      selectedAudioFile,
      startRecording,
      stopRecording,
    ]);

    const duration = currentRecording?.duration || 0;
    const progressDuration = actualDuration > 0 ? actualDuration * 1000 : duration;
    const showAudioSourceControls = recordMode && !isRecording && !currentRecording && !isPlaying;

    if (!recordMode && !currentRecording && !isRecording) {
      return null;
    }

    return (
      <div className={`${positioning} bottom-0 left-0 z-45 w-full px-4 py-3 pointer-events-none`}>
        <div className="flex items-center gap-3 w-full min-h-8">
          {recordMode && (
            <button
              onClick={handleRecordButtonClick}
              disabled={isPlaying}
              className={`flex items-center justify-center transition-colors relative pointer-events-auto ${isPlaying ? "opacity-50 cursor-not-allowed" : "hover:opacity-80 cursor-pointer"}`}
              title={
                isRecording
                  ? "Stop Recording"
                  : currentRecording
                    ? "New Recording"
                    : "Start Recording"
              }
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
                <IdleRecordButton />
              )}
            </button>
          )}

          {showAudioSourceControls ? (
            <div className="flex min-w-0 items-center gap-2 pointer-events-auto">
              <div className="inline-flex h-7 overflow-hidden rounded-full border border-slate-700 bg-slate-900/90 p-0.5 text-xs font-semibold text-slate-400 shadow-sm">
                <button
                  type="button"
                  onClick={handleSelectMicrophoneAudio}
                  aria-pressed={recordingAudioSource === "microphone"}
                  title="Use microphone"
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 transition-colors ${
                    recordingAudioSource === "microphone"
                      ? "bg-slate-100 text-slate-950"
                      : "hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <Mic size={13} aria-hidden="true" />
                  <span className="hidden sm:inline">Mic</span>
                </button>
                <button
                  type="button"
                  onClick={handleSelectExternalAudio}
                  aria-pressed={recordingAudioSource === "external"}
                  title="Use audio file"
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 transition-colors ${
                    recordingAudioSource === "external"
                      ? "bg-pinata-cyan text-slate-950"
                      : "hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <FileMusic size={13} aria-hidden="true" />
                  <span className="hidden sm:inline">File</span>
                </button>
              </div>
              {recordingAudioSource === "external" && selectedAudioFile ? (
                <div
                  className="hidden max-w-48 items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/90 px-2.5 py-1 text-xs font-medium text-slate-300 shadow-sm sm:inline-flex"
                  title={selectedAudioFile.name}
                >
                  <span className="truncate">{selectedAudioFile.name}</span>
                  <button
                    type="button"
                    onClick={handleClearSelectedAudio}
                    aria-label="Clear selected audio file"
                    className="shrink-0 rounded-full text-slate-500 transition-colors hover:text-white"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <input
                ref={audioFileInputRef}
                type="file"
                accept="audio/*,.webm,.ogg,.mp3,.wav,.m4a,.mp4,.aac"
                className="sr-only"
                onChange={handleAudioFileChange}
              />
            </div>
          ) : null}

          {currentRecording && !isRecording && (
            <>
              <button
                onClick={handlePlayPause}
                className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer w-6 pointer-events-auto"
              >
                {isPlaying ? <PauseIcon /> : hasEnded ? <ReplayIcon /> : <PlayIcon />}
              </button>

              <PlaybackProgress progressDuration={progressDuration} onSeek={handleSeek} />

              <div className="relative pointer-events-auto">
                <button
                  onClick={() => setShowSettings((prev) => !prev)}
                  className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer"
                >
                  <SettingIcon />
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 z-46 mb-2 min-w-50 rounded-lg bg-white p-4 shadow-lg">
                    <div className="text-gray-800">
                      <div className="mb-3">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Speed
                        </label>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500 min-w-8">{playbackSpeed}x</span>
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
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Volume
                        </label>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500 min-w-8">
                            {Math.round(volume * 100)}
                          </span>
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
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {(isRecording || currentRecording) && (
            <PlaybackTimer
              isRecording={isRecording}
              recordingTime={recordingTime}
              currentRecording={currentRecording}
              progressDuration={progressDuration}
            />
          )}
        </div>

        {currentRecording && (
          <div className="pointer-events-auto">
            <RecordingEditor
              recording={currentRecording}
              isVisible={showRecordingEditor}
              mode="edit"
              onSave={handleSaveRecording}
              onCancel={handleCancelExport}
            />
          </div>
        )}
      </div>
    );
  },
);

export default MediaControls;
