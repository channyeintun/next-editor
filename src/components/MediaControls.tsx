import React, { useState, useEffect, useRef } from "react";
import {
  Circle,
  Square,
  Plus,
  FileMusic,
  Mic,
  Video,
  VideoOff,
  X,
  Captions,
  Check,
} from "lucide-react";
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
import type { Recording } from "../core/src";
import {
  CAMERA_OVERLAY_PREVIEW_EVENT,
  CAMERA_OVERLAY_VISIBILITY_EVENT,
  CAMERA_OVERLAY_VISIBILITY_KEY,
} from "./CameraOverlay";
import { useCaptionStore, useCaptionStoreTrigger } from "../hooks/useCaptionStore";

interface MediaControlsProps {
  onRecord?: () => void;
  onStopRecording?: () => void;
  onSaveToImage?: (file: File) => void;
  recordMode?: boolean;
  positioning?: "fixed" | "relative" | "absolute" | "sticky";
  /**
   * Renders larger controls, intended for small embeds (e.g. a scaled-down demo
   * iframe) where the default compact controls become hard to read and tap.
   */
  large?: boolean;
}

type RecordingAudioSourceOption = "microphone" | "external";

const formatTime = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const readCameraOverlayVisibility = (): boolean => {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CAMERA_OVERLAY_VISIBILITY_KEY) !== "false";
};

const PlaybackProgress = ({
  progressDuration,
  onSeek,
  large = false,
}: {
  progressDuration: number;
  onSeek: (time: number) => void;
  large?: boolean;
}) => {
  const currentTime = useLiveTime();
  return (
    <div
      className={`flex items-center pointer-events-auto ${
        large ? "flex-1 max-w-[75%] ml-1 mr-auto" : "flex-1 mx-1"
      }`}
    >
      <ProgressBar
        progress={progressDuration > 0 ? Math.min((currentTime / progressDuration) * 100, 100) : 0}
        duration={progressDuration}
        currentTime={currentTime}
        onSeek={onSeek}
        height={large ? "10px" : "2px"}
        hoverHeight={large ? "14px" : "6px"}
        backgroundColor="#475569"
        progressColor="#3b82f6"
        className="w-full"
      />
    </div>
  );
};

const PlaybackTimer = ({
  isRecording,
  recordingTime,
  currentRecording,
  progressDuration,
  large = false,
}: {
  isRecording: boolean;
  recordingTime: number;
  currentRecording: Recording | null;
  progressDuration: number;
  large?: boolean;
}) => {
  const currentTime = useLiveTime();
  const displayTime = isRecording
    ? recordingTime
    : currentRecording
      ? Math.max(0, progressDuration - currentTime)
      : currentTime;

  return (
    <span
      className={`text-slate-400 font-mono pointer-events-auto ${large ? "text-4xl" : "text-sm"}`}
    >
      {isRecording ? formatTime(displayTime) : `-${formatTime(displayTime)}`}
    </span>
  );
};

const MediaControls: React.FC<MediaControlsProps> = ({
  onRecord,
  onStopRecording,
  recordMode = true,
  positioning = "fixed",
  large = false,
}) => {
  const {
    startRecording,
    stopRecording,
    clearRecording,
    play,
    pause,
    seekTo,
    setPlaybackSpeed,
    setVolume,
    addCaptionTrack,
  } = useNextEditorActions();

  const { isRecording, isPlaying, currentRecording, hasEnded, recordingStartTime } =
    useNextEditorMetadata();

  const { playbackSpeed, volume, duration: actualDuration } = useNextEditorPlayback();

  const { enabled: captionsEnabled, language: captionLanguage } = useCaptionStore();
  const captionTrigger = useCaptionStoreTrigger();
  const [showSettings, setShowSettings] = useState(false);
  const [showCaptionMenu, setShowCaptionMenu] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingAudioSource, setRecordingAudioSource] =
    useState<RecordingAudioSourceOption>("microphone");
  const [enableCameraForNextRecording, setEnableCameraForNextRecording] = useState(false);
  const [isCameraSupported, setIsCameraSupported] = useState(false);
  const [isCameraOverlayVisible, setIsCameraOverlayVisible] = useState(readCameraOverlayVisibility);
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const captionFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsCameraSupported(Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);

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

  const handlePlayPause = () => {
    // Aggressive Safari Wake: Resume context directly in the click handler
    const ctx = getAudioContext();
    unlockAudioContext(ctx);
    ctx.resume().catch(() => {});

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
    ctx.resume().catch(() => {});

    seekTo(targetTime);
  };

  const handleVolumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(event.target.value);
    setVolume(newVolume);
  };

  const handleSelectMicrophoneAudio = () => {
    setRecordingAudioSource("microphone");
  };

  const handleSelectExternalAudio = () => {
    setRecordingAudioSource("external");
    if (!selectedAudioFile) {
      audioFileInputRef.current?.click();
    }
  };

  const handleAudioFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;

    if (!file) {
      return;
    }

    setSelectedAudioFile(file);
    setRecordingAudioSource("external");
    event.target.value = "";
  };

  const handleClearSelectedAudio = () => {
    setSelectedAudioFile(null);
    setRecordingAudioSource("microphone");
  };

  const handleCaptionFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";

    const { detectAndParse, inferLanguageFromFilename } = await import("../captions/parseCaptions");
    const text = await file.text();
    const cues = detectAndParse(file.name, text);
    if (cues.length === 0) return;

    const language = inferLanguageFromFilename(file.name) ?? "en";
    addCaptionTrack({
      id: `${language}-${Date.now()}`,
      language,
      label: language.toUpperCase(),
      cues,
      default: !currentRecording?.captions?.length,
    });
  };

  const handleToggleCameraForNextRecording = () => {
    setEnableCameraForNextRecording((current) => {
      const next = !current;
      // Drive the live camera preview overlay (independent of recording start/stop).
      window.dispatchEvent(
        new CustomEvent(CAMERA_OVERLAY_PREVIEW_EVENT, { detail: { enabled: next } }),
      );
      return next;
    });
  };

  const handleToggleCameraOverlay = () => {
    setIsCameraOverlayVisible((current) => {
      const next = !current;
      window.localStorage.setItem(CAMERA_OVERLAY_VISIBILITY_KEY, String(next));
      window.dispatchEvent(
        new CustomEvent(CAMERA_OVERLAY_VISIBILITY_EVENT, { detail: { visible: next } }),
      );
      return next;
    });
  };

  const handleRecordButtonClick = () => {
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

      startRecording({
        audioBlob: selectedAudioFile,
        enableCamera: enableCameraForNextRecording,
      });
      onRecord?.();
      return;
    }

    startRecording({ enableCamera: enableCameraForNextRecording });
    onRecord?.();
  };

  const duration = currentRecording?.duration || 0;
  const progressDuration = actualDuration > 0 ? actualDuration * 1000 : duration;
  const showAudioSourceControls = recordMode && !isRecording && !currentRecording && !isPlaying;
  // Camera may be an in-memory blob (just recorded / IndexedDB-restored) or an external video URL
  // (imported file or hosted sibling). Either means the recording has camera to show/hide.
  const hasCameraRecording =
    currentRecording?.cameraBlob instanceof Blob || Boolean(currentRecording?.cameraUrl);
  const captionTracks = currentRecording?.captions;
  const hasCaptionTracks = captionTracks && captionTracks.length > 0;
  const hasMultipleCaptionTracks = captionTracks && captionTracks.length > 1;

  // Size tokens — scale the controls up for small embeds when `large` is set.
  const containerPadding = large ? "px-10 py-8" : "px-4 py-3";
  const rowSizing = large ? "gap-8 min-h-20" : "gap-3 min-h-8";
  const transportButtonWidth = large ? "w-[72px]" : "w-6";
  const transportIconSize = large ? 72 : 24;
  const controlIconSize = large ? 52 : 16;
  const recordIconSize = large ? 44 : 14;
  const recordPlusSize = large ? 30 : 10;

  if (!recordMode && !currentRecording && !isRecording) {
    return null;
  }

  return (
    <div
      className={`${positioning} bottom-0 left-0 z-45 w-full ${containerPadding} pointer-events-none`}
    >
      <div className={`flex items-center w-full ${rowSizing}`}>
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
              <Square size={recordIconSize} className="fill-red-500 text-red-500 animate-pulse" />
            ) : currentRecording ? (
              <div className="relative">
                <Circle size={recordIconSize} className="fill-red-500 text-red-500" />
                <div className="absolute -top-1 -right-1.5 bg-[#202732] rounded-full p-[0.5px]">
                  <Plus size={recordPlusSize} className="text-red-500 stroke-[3px]" />
                </div>
              </div>
            ) : (
              <IdleRecordButton size={recordIconSize} />
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
              accept="audio/*,.webm,.ogg,.opus,.mp3,.wav,.m4a,.mp4,.aac"
              className="sr-only"
              onChange={handleAudioFileChange}
            />
            <input
              ref={captionFileInputRef}
              type="file"
              accept=".vtt,.srt,text/vtt,application/x-subrip"
              className="sr-only"
              onChange={handleCaptionFileChange}
            />
            {isCameraSupported ? (
              <button
                type="button"
                onClick={handleToggleCameraForNextRecording}
                aria-pressed={enableCameraForNextRecording}
                title={enableCameraForNextRecording ? "Record camera" : "Do not record camera"}
                className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold shadow-sm transition-colors ${
                  enableCameraForNextRecording
                    ? "border-pinata-cyan bg-pinata-cyan text-slate-950"
                    : "border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800 hover:text-white"
                }`}
              >
                {enableCameraForNextRecording ? (
                  <Video size={13} aria-hidden="true" />
                ) : (
                  <VideoOff size={13} aria-hidden="true" />
                )}
                <span className="hidden sm:inline">Camera</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {currentRecording && !isRecording && (
          <>
            <button
              onClick={handlePlayPause}
              className={`flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer pointer-events-auto ${transportButtonWidth}`}
            >
              {isPlaying ? (
                <PauseIcon size={transportIconSize} />
              ) : hasEnded ? (
                <ReplayIcon size={transportIconSize} />
              ) : (
                <PlayIcon size={transportIconSize} />
              )}
            </button>

            <PlaybackProgress
              progressDuration={progressDuration}
              onSeek={handleSeek}
              large={large}
            />

            {hasCameraRecording ? (
              <button
                type="button"
                onClick={handleToggleCameraOverlay}
                aria-pressed={isCameraOverlayVisible}
                title={isCameraOverlayVisible ? "Hide camera" : "Show camera"}
                className={`flex items-center justify-center text-slate-300 transition-colors hover:text-white pointer-events-auto ${transportButtonWidth}`}
              >
                {isCameraOverlayVisible ? (
                  <Video size={controlIconSize} aria-hidden="true" />
                ) : (
                  <VideoOff size={controlIconSize} aria-hidden="true" />
                )}
              </button>
            ) : null}

            {hasCaptionTracks ? (
              <div className="relative pointer-events-auto">
                <button
                  type="button"
                  onClick={() => {
                    if (hasMultipleCaptionTracks) {
                      setShowCaptionMenu((prev) => !prev);
                    } else {
                      captionTrigger.toggleEnabled();
                    }
                  }}
                  aria-pressed={captionsEnabled}
                  title={captionsEnabled ? "Hide captions" : "Show captions"}
                  className={`flex items-center justify-center transition-colors hover:text-white ${
                    captionsEnabled ? "text-white" : "text-slate-500"
                  } ${transportButtonWidth}`}
                >
                  <Captions size={controlIconSize} aria-hidden="true" />
                </button>

                {showCaptionMenu && hasMultipleCaptionTracks && (
                  <div className="absolute bottom-full right-0 z-46 mb-2 min-w-40 rounded-lg bg-white py-1 shadow-lg">
                    {captionTracks.map((track) => {
                      const isSelected =
                        captionsEnabled &&
                        (captionLanguage === track.language || (!captionLanguage && track.default));
                      return (
                        <button
                          key={track.id}
                          type="button"
                          onClick={() => {
                            captionTrigger.setLanguage({ language: track.language });
                            if (!captionsEnabled) captionTrigger.toggleEnabled();
                            setShowCaptionMenu(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-gray-100 ${
                            isSelected ? "font-semibold text-gray-900" : "font-normal text-gray-700"
                          }`}
                        >
                          <span className="w-4">
                            {isSelected ? <Check size={14} aria-hidden="true" /> : null}
                          </span>
                          {track.label || track.language}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            <div className="relative pointer-events-auto">
              <button
                onClick={() => setShowSettings((prev) => !prev)}
                className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer"
              >
                <SettingIcon size={controlIconSize} />
              </button>

              {showSettings && (
                <div className="absolute bottom-full right-0 z-46 mb-2 min-w-50 rounded-lg bg-white p-4 shadow-lg">
                  <div className="text-gray-800">
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Speed</label>
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
                      <label className="block text-sm font-medium text-gray-700 mb-2">Volume</label>
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
                    <div className="border-t border-gray-200 pt-3">
                      <button
                        type="button"
                        onClick={() => captionFileInputRef.current?.click()}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
                      >
                        <Captions size={14} aria-hidden="true" />
                        Import captions…
                      </button>
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
            large={large}
          />
        )}
      </div>
    </div>
  );
};

export default MediaControls;
