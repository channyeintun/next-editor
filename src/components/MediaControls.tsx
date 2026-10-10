import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import {
  Scissors,
  FileMusic,
  Mic,
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  X,
  Captions,
  Download,
  Keyboard,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useSelector } from "@xstate/store-react";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useNextEditorPlayback,
  useLiveTimeValue,
  useRecordingElapsedMs,
} from "../hooks/useNextEditorContext";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import ChaptersMenu, { CurrentChapterTitle } from "./ChaptersMenu";
import type { CaptionCue, RecordingChapter } from "../core/src/types";
import { resumeSharedAudioContext } from "../core/src/utils/audioContext";
import ReplayIcon from "./icon/Replay";
import RecordButton from "./mediaControls/RecordButton";
import RecordingTransportControls from "./mediaControls/RecordingTransportControls";
import RecordingOptionToggle from "./mediaControls/RecordingOptionToggle";
import CaptionsMenuButton from "./mediaControls/CaptionsMenuButton";
import PlaybackSpeedVolume from "./mediaControls/PlaybackSpeedVolume";
import PlayIcon from "./icon/Play";
import PauseIcon from "./icon/Pause";
import SettingIcon from "./icon/Setting";
import ProgressBar, { LIVE_PROGRESS_VARIABLE } from "./ProgressBar";
import Switch from "./Switch";
import type { Recording } from "../core/src";
import {
  cameraOverlayStore,
  selectCameraOverlayVisible,
  selectLivePreviewOn,
} from "../stores/cameraOverlayStore";
import { useCaptionStore } from "../hooks/useCaptionStore";
import { usePlaybackSettings } from "../hooks/usePlaybackSettings";
import { useRecordingSettings } from "../hooks/useRecordingSettings";
import { playbackSettingsStore } from "../stores/playbackSettingsStore";
import { recordingSettingsStore } from "../stores/recordingSettingsStore";
import { acquireDisplayStream, isScreenCaptureSupported } from "../utils/displayCapture";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import {
  isVoiceJoinedState,
  useOptionalCollaborationVoiceState,
} from "../contexts/CollaborationVoiceContext";
import { applyVoiceRecordingPolicy, isVoiceJoinedForRecording } from "../voice/recorderBridge";
import { canRecordInLiveRoom } from "../collaboration/recordingPolicy";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";
import LearnerVersionsMenu from "./LearnerVersionsMenu";
import RecordingEditPanel from "./RecordingEditPanel";
import MicrophoneCheck, { RecordingMicrophoneLevel } from "./MicrophoneCheck";
import PlayerShortcutsHelp, { PlayerShortcutFeedback } from "./PlayerShortcutsHelp";
import { usePlayerShortcuts } from "../hooks/usePlayerShortcuts";
import { describeCaptionGeneration, useCaptionGeneration } from "../hooks/useCaptionGeneration";
import { serializeCuesToVtt } from "../captions/serializeVtt";
import { selectCaptionTrack } from "../captions/captionTracks";
import { downloadBlob } from "../utils/downloadBlob";
import { discardRecordingDraftFor } from "../storage/recordingDrafts/recordingDraftJournal";

interface MediaControlsProps {
  recordMode?: boolean;
  positioning?: "fixed" | "relative" | "absolute" | "sticky";
  /**
   * Renders larger controls, intended for small embeds (e.g. a scaled-down demo
   * iframe) where the default compact controls become hard to read and tap.
   */
  large?: boolean;
  /** Whether this recording is being played as part of a playlist — controls
   *  whether the "Continue to Next" setting is shown. */
  playlistMode?: boolean;
  /** An edit made a new recording of the take (see RecordingEditPanel). */
  onRecordingEdited?: (recording: Recording) => void;
}

type RecordingAudioSourceOption = "microphone" | "external";

type ParsedCaptionFile = { cues: CaptionCue[]; language: string } | { error: string };

/**
 * A picked caption file's cues and language, or what to tell the viewer when it gives none.
 * Kept out of the component: the React Compiler cannot compile a function holding `import()`.
 */
async function parseCaptionFile(file: File): Promise<ParsedCaptionFile> {
  // The parser yields zero cues for any file whose timestamp lines miss its
  // format — timestamps with no fractional part, a non-subtitle file picked
  // past the accept filter, a UTF-16 file that decodes as mojibake. A bare
  // return there meant "Import captions…" appeared to do nothing at all.
  let parseCaptions: typeof import("../captions/parseCaptions");
  let text: string;
  try {
    parseCaptions = await import("../captions/parseCaptions");
    text = await file.text();
  } catch {
    return { error: `Couldn't read "${file.name}" — try selecting it again.` };
  }

  const { detectAndParse, inferLanguageFromFilename } = parseCaptions;
  const cues = detectAndParse(file.name, text);
  if (cues.length === 0) {
    return { error: `No captions found in "${file.name}" — expected WebVTT or SRT.` };
  }

  return { cues, language: inferLanguageFromFilename(file.name) ?? "en" };
}

const toProgressPercent = (currentTime: number, duration: number) =>
  duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;

const PlaybackProgress = ({
  progressDuration,
  onSeek,
  chapters,
  large = false,
}: {
  progressDuration: number;
  onSeek: (time: number) => void;
  chapters?: readonly RecordingChapter[];
  large?: boolean;
}) => {
  const editorActor = NextEditorActorContext.useActorRef();
  const liveProgressRef = useRef<HTMLDivElement>(null);
  // The bar reads the time in whole seconds; the fill and thumb follow every tick through
  // a CSS variable written here, without a render per tick (as the cursor overlay moves).
  const currentTime = useLiveTimeValue((time) => Math.floor(time / 1000) * 1000);

  useLayoutEffect(() => {
    const element = liveProgressRef.current;
    if (!element) return;
    let shown = "";
    const show = (time: number) => {
      const next = `${Math.max(0, Math.min(toProgressPercent(time, progressDuration), 100))}%`;
      if (next === shown) return;
      shown = next;
      element.style.setProperty(LIVE_PROGRESS_VARIABLE, next);
    };
    show(editorActor.getSnapshot().context.timeline.currentTime);
    const subscription = editorActor.subscribe((snapshot) =>
      show(snapshot.context.timeline.currentTime),
    );
    return () => subscription.unsubscribe();
  }, [editorActor, progressDuration]);

  return (
    <div
      ref={liveProgressRef}
      className={`flex items-center pointer-events-auto ${
        large ? "flex-1 max-w-[75%] ml-1 mr-auto" : "flex-1 mx-1"
      }`}
    >
      <ProgressBar
        progress={toProgressPercent(currentTime, progressDuration)}
        duration={progressDuration}
        currentTime={currentTime}
        onSeek={onSeek}
        chapters={chapters}
        height={large ? "10px" : "2px"}
        hoverHeight={large ? "14px" : "6px"}
        backgroundColor="#475569"
        // The large bar is as tall as its thumb, so the fill's edge alone shows the position:
        // blue-300 keeps that edge at 4.2:1 against the track.
        progressColor={large ? "#93c5fd" : "#3b82f6"}
        className="w-full"
      />
    </div>
  );
};

const PlaybackTimer = ({
  isRecording,
  isRecordingPaused,
  currentRecording,
  progressDuration,
  large = false,
}: {
  isRecording: boolean;
  isRecordingPaused: boolean;
  currentRecording: Recording | null;
  progressDuration: number;
  large?: boolean;
}) => {
  // The timer shows whole seconds, so it re-renders once a second rather than every tick.
  const playbackSeconds = useLiveTimeValue((currentTime) =>
    Math.floor(
      (currentRecording ? Math.max(0, progressDuration - currentTime) : currentTime) / 1000,
    ),
  );
  // The take's recorded time, which stands still while it is paused.
  const recordingTime = useRecordingElapsedMs();
  const displayTime = isRecording ? recordingTime : playbackSeconds * 1000;

  return (
    <span
      className={`inline-flex items-center gap-2 text-slate-300 font-mono pointer-events-auto ${large ? "text-4xl" : "text-sm"}`}
    >
      {isRecording && isRecordingPaused ? (
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-sans text-[11px] font-semibold uppercase tracking-wide text-amber-300">
          Paused
        </span>
      ) : null}
      {isRecording ? formatPlaybackTime(displayTime) : `-${formatPlaybackTime(displayTime)}`}
    </span>
  );
};

const MediaControls: React.FC<MediaControlsProps> = ({
  recordMode = true,
  positioning = "fixed",
  large = false,
  playlistMode = false,
  onRecordingEdited,
}) => {
  const { startRecording, stopRecording, clearRecording, play, pause, seekTo, addCaptionTrack } =
    useNextEditorActions();

  const { isRecording, isRecordingPaused, isPlaying, currentRecording, hasEnded } =
    useNextEditorMetadata();
  const collaboration = useOptionalCollaboration();
  const voiceState = useOptionalCollaborationVoiceState();
  const isVoiceJoined = isVoiceJoinedState(voiceState);
  const effectiveRecordMode = canRecordInLiveRoom(
    recordMode,
    Boolean(collaboration?.provider),
    collaboration?.isHost ?? false,
  );

  const { durationMs: timelineDurationMs, editorActor } = useNextEditorPlayback();

  const captionPreference = useCaptionStore();
  const { autoplay, continueToNext, characterShortcuts } = usePlaybackSettings();
  const { screenRecordingEnabled, microphoneDeviceId } = useRecordingSettings();
  const [showSettings, setShowSettings] = useState(false);
  // Kept here rather than in CaptionsMenuButton, which unmounts while no lesson with captions
  // is loaded; the menu is as it was left when the button comes back.
  const [showCaptionMenu, setShowCaptionMenu] = useState(false);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const captionGeneration = useCaptionGeneration();
  const playerShortcuts = usePlayerShortcuts();
  const [recordingAudioSource, setRecordingAudioSource] =
    useState<RecordingAudioSourceOption>("microphone");
  // The overlay shows the camera live while it is switched on for the next take.
  const enableCameraForNextRecording = useSelector(cameraOverlayStore, (s) =>
    selectLivePreviewOn(s.context, editorActor),
  );
  const [isCameraSupported, setIsCameraSupported] = useState(false);
  const [isScreenSupported, setIsScreenSupported] = useState(false);
  const isCameraOverlayVisible = useSelector(cameraOverlayStore, (s) =>
    selectCameraOverlayVisible(s.context),
  );
  const [selectedAudioFile, setSelectedAudioFile] = useState<File | null>(null);
  const [captionImportError, setCaptionImportError] = useState<string | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const captionFileInputRef = useRef<HTMLInputElement>(null);
  // Where "Keyboard shortcuts" leaves focus before its menu closes, so the help has an opener.
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setIsCameraSupported(Boolean(navigator.mediaDevices?.getUserMedia));
    setIsScreenSupported(isScreenCaptureSupported());
  }, []);

  // The camera switch belongs to this player bar and goes with it, as its own state did.
  useEffect(
    () => () => cameraOverlayStore.trigger.stopLivePreview({ editor: editorActor }),
    [editorActor],
  );

  useEffect(() => {
    if (isRecording && collaboration?.provider && !collaboration.isHost) {
      void stopRecording();
    }
  }, [collaboration?.isHost, collaboration?.provider, isRecording, stopRecording]);

  const handlePlayPause = () => {
    // Resume inside the click, which is the gesture the autoplay policy looks for.
    resumeSharedAudioContext();

    if (isPlaying) {
      pause();
    } else {
      play();
    }
  };

  const handleSeek = (targetTime: number) => {
    resumeSharedAudioContext();

    seekTo(targetTime);
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
    setCaptionImportError(null);
    // Read before parsing awaits: the track belongs to the lesson the viewer picked it for.
    const recordingId = currentRecording?.id;
    if (!recordingId) return;

    const parsed = await parseCaptionFile(file);
    if ("error" in parsed) {
      setCaptionImportError(parsed.error);
      return;
    }

    const { cues, language } = parsed;
    addCaptionTrack(recordingId, {
      id: `${language}-${Date.now()}`,
      language,
      label: language.toUpperCase(),
      cues,
      default: !currentRecording?.captions?.length,
    });
  };

  const handleToggleCameraForNextRecording = () => {
    // Also drives the live camera preview overlay (independent of recording start/stop).
    cameraOverlayStore.trigger.toggleLivePreview({ editor: editorActor });
  };

  const handleToggleCameraOverlay = () => {
    cameraOverlayStore.trigger.toggleVisible();
  };

  const handleRecordButtonClick = async () => {
    if (isRecording) {
      await stopRecording();
      return;
    }

    if (currentRecording) {
      // Starting over is the author's word that the take is done with: its draft goes too.
      void discardRecordingDraftFor(currentRecording.id);
      clearRecording();
      return;
    }

    if (!effectiveRecordMode) return;

    // External audio with no file picked yet: open the picker and bail — no capture, no session.
    // Kept above the gDM await so we never open the surface picker just to prompt for an audio file.
    if (recordingAudioSource === "external" && !selectedAudioFile) {
      audioFileInputRef.current?.click();
      return;
    }

    // gDM must be the FIRST await (transient-activation constraint, §2.1). A dismissed picker
    // (NotAllowedError) is non-fatal: the session recording is the primary artifact, so we record
    // without screen capture rather than aborting the take.
    let screenStream: MediaStream | undefined;
    if (screenRecordingEnabled && isScreenSupported) {
      try {
        screenStream = applyVoiceRecordingPolicy(
          await acquireDisplayStream(!isVoiceJoinedForRecording()),
        );
      } catch (error) {
        console.warn("Screen capture not started; recording without it:", error);
      }
    }

    if (recordingAudioSource === "external") {
      startRecording({
        audioBlob: selectedAudioFile ?? undefined,
        enableCamera: enableCameraForNextRecording,
        screenStream,
      });
    } else {
      startRecording({
        enableCamera: enableCameraForNextRecording,
        screenStream,
        microphoneDeviceId: microphoneDeviceId ?? undefined,
      });
    }
  };

  const duration = currentRecording?.duration || 0;
  const progressDuration = timelineDurationMs > 0 ? timelineDurationMs : duration;
  const showAudioSourceControls =
    effectiveRecordMode && !isRecording && !currentRecording && !isPlaying;
  // Camera may be an in-memory blob (just recorded / IndexedDB-restored) or an external video URL
  // (imported file or hosted sibling). Either means the recording has camera to show/hide.
  const hasCameraRecording =
    currentRecording?.cameraBlob instanceof Blob || Boolean(currentRecording?.cameraUrl);
  const captionTracks = currentRecording?.captions;
  const hasCaptionTracks = captionTracks && captionTracks.length > 0;
  const hasNarration = Boolean(currentRecording?.audioBlob || currentRecording?.audioUrl);
  // Until a cut reaches the narration, its audio runs on the old clock.
  const isNarrationBeingEdited = Boolean(currentRecording?.pendingAudioEdit);
  const isGeneratingCaptions = captionGeneration.state.status === "running";
  // The track the viewer would see: the one they picked, their language, the default, or the first.
  const activeCaptionTrack = selectCaptionTrack(captionTracks, captionPreference);

  const handleDownloadCaptions = () => {
    if (!activeCaptionTrack || !currentRecording) return;
    downloadBlob(
      new Blob([serializeCuesToVtt(activeCaptionTrack.cues)], { type: "text/vtt" }),
      `${currentRecording.name || "recording"}.${activeCaptionTrack.language}.vtt`,
    );
  };

  // Size tokens — scale the controls up for small embeds when `large` is set.
  const containerPadding = large ? "px-10 py-8" : "px-4 py-1";
  const containerHeight = large ? "" : "max-h-10";
  const rowSizing = large ? "gap-8 min-h-20" : "gap-3 min-h-8";
  const transportButtonWidth = large ? "w-[72px]" : "w-6";
  const transportIconSize = large ? 72 : 24;
  const controlIconSize = large ? 52 : 16;
  const recordIconSize = large ? 44 : 14;
  const recordPlusSize = large ? 30 : 10;

  if (!effectiveRecordMode && !currentRecording && !isRecording) {
    return null;
  }

  return (
    <div
      className={`${positioning} bottom-0 left-0 z-101 w-full border-t border-[#0f131a] bg-[#11141c] ${containerPadding} ${containerHeight} pointer-events-none`}
    >
      {/* Caption file picker — kept outside the record-only controls so "Import captions…"
          works once a recording is loaded (when the audio-source row is no longer rendered).
          Only ever opened by click(), so out of layout and the tab order: an sr-only input
          was a Tab stop whose focus ring was clipped away. */}
      <input
        ref={captionFileInputRef}
        type="file"
        accept=".vtt,.srt,text/vtt,application/x-subrip"
        className="hidden"
        onChange={(event) => void handleCaptionFileChange(event)}
      />
      <PlayerShortcutFeedback feedback={playerShortcuts.feedback} />
      {playerShortcuts.helpOpen ? (
        <PlayerShortcutsHelp onClose={playerShortcuts.closeHelp} />
      ) : null}
      {showEditPanel && currentRecording && !isRecording && effectiveRecordMode ? (
        <RecordingEditPanel
          recording={currentRecording}
          onClose={() => setShowEditPanel(false)}
          onApplied={(edited) => onRecordingEdited?.(edited)}
        />
      ) : null}
      <div className={`flex items-center w-full ${rowSizing}`}>
        {effectiveRecordMode && (
          <RecordButton
            isRecording={isRecording}
            isRecordingPaused={isRecordingPaused}
            hasRecording={Boolean(currentRecording)}
            disabled={isPlaying}
            iconSize={recordIconSize}
            plusSize={recordPlusSize}
            onClick={handleRecordButtonClick}
          />
        )}

        {effectiveRecordMode && isRecording ? (
          <RecordingTransportControls iconSize={controlIconSize} className={transportButtonWidth} />
        ) : null}

        {showAudioSourceControls ? (
          <div className="flex min-w-0 items-center gap-2 pointer-events-auto">
            <div className="inline-flex h-7 overflow-hidden rounded-full border border-slate-700 bg-slate-900/90 p-0.5 text-xs font-semibold text-slate-400 shadow-sm">
              <button
                data-tour="mic"
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
                data-tour="audio-file"
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
            {recordingAudioSource === "microphone" ? <MicrophoneCheck /> : null}
            {isVoiceJoined ? (
              <span
                className="hidden items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 shadow-sm sm:inline-flex"
                title="Remote collaborators' voice plays in this tab, so tab audio is excluded from recordings while voice chat is active. Your microphone narration is still recorded."
              >
                Tab audio off while in voice chat
              </span>
            ) : null}
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
              // Opened by click() from the File button and the record button, like the
              // caption picker: no Tab stop of its own.
              className="hidden"
              onChange={handleAudioFileChange}
            />
            {isCameraSupported ? (
              <RecordingOptionToggle
                tour="camera"
                label="Camera"
                on={enableCameraForNextRecording}
                onToggle={handleToggleCameraForNextRecording}
                icon={{ on: Video, off: VideoOff }}
                title={{ on: "Record camera", off: "Do not record camera" }}
              />
            ) : null}
            {isScreenSupported ? (
              <RecordingOptionToggle
                tour="screen"
                label="Screen"
                on={screenRecordingEnabled}
                onToggle={() =>
                  recordingSettingsStore.trigger.setScreenRecordingEnabled({
                    enabled: !screenRecordingEnabled,
                  })
                }
                icon={{ on: Monitor, off: MonitorOff }}
                title={{
                  on: "Also screen-record (saved locally only, never uploaded)",
                  off: "Do not screen-record",
                }}
              />
            ) : null}
          </div>
        ) : null}

        {currentRecording && !isRecording && (
          <>
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause" : hasEnded ? "Replay" : "Play"}
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
              chapters={currentRecording.chapters}
              large={large}
            />

            <ChaptersMenu
              recording={currentRecording}
              editable={effectiveRecordMode}
              iconSize={controlIconSize}
              buttonClassName={transportButtonWidth}
            />

            {hasCameraRecording ? (
              <button
                type="button"
                onClick={handleToggleCameraOverlay}
                aria-pressed={isCameraOverlayVisible}
                // One name in both states; aria-pressed and the icon say which.
                title="Camera"
                className={`flex items-center justify-center text-slate-300 transition-colors hover:text-white pointer-events-auto ${transportButtonWidth}`}
              >
                {isCameraOverlayVisible ? (
                  <Video size={controlIconSize} aria-hidden="true" />
                ) : (
                  <VideoOff size={controlIconSize} aria-hidden="true" />
                )}
              </button>
            ) : null}

            <LearnerVersionsMenu
              recordingId={currentRecording.id}
              iconSize={controlIconSize}
              buttonClassName={transportButtonWidth}
            />

            {effectiveRecordMode ? (
              <button
                type="button"
                onClick={() => setShowEditPanel((open) => !open)}
                // A take whose narration is still being cut is edited once that is done.
                disabled={Boolean(currentRecording.pendingAudioEdit)}
                aria-expanded={showEditPanel}
                title="Cut or mute stretches of this recording"
                className={`flex items-center justify-center transition-colors pointer-events-auto disabled:opacity-40 ${
                  showEditPanel ? "text-white" : "text-slate-300 hover:text-white"
                } ${transportButtonWidth}`}
              >
                <Scissors size={controlIconSize} aria-hidden="true" />
              </button>
            ) : null}

            {hasCaptionTracks ? (
              <CaptionsMenuButton
                tracks={captionTracks}
                menuOpen={showCaptionMenu}
                setMenuOpen={setShowCaptionMenu}
                iconSize={controlIconSize}
                className={transportButtonWidth}
              />
            ) : null}

            {isGeneratingCaptions ? (
              // Captioning carries on with the settings closed; this says it is.
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                // Named for what it shows: a bare "40%" says nothing on its own.
                aria-label={describeCaptionGeneration(captionGeneration.state)}
                title={describeCaptionGeneration(captionGeneration.state)}
                className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-400 pointer-events-auto"
              >
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                {captionGeneration.state.status === "running" && captionGeneration.state.progress
                  ? `${Math.round(captionGeneration.state.progress.fraction * 100)}%`
                  : ""}
              </button>
            ) : null}

            <div className="relative pointer-events-auto">
              <button
                ref={settingsButtonRef}
                type="button"
                onClick={() => setShowSettings((prev) => !prev)}
                aria-label="Settings"
                aria-expanded={showSettings}
                title="Settings"
                className="flex items-center justify-center transition-colors hover:opacity-80 cursor-pointer"
              >
                <SettingIcon size={controlIconSize} />
              </button>

              {showSettings && (
                <div className="absolute bottom-full right-0 z-46 mb-2 min-w-50 rounded-lg border border-slate-700 bg-[#151821] p-4 shadow-[0_18px_40px_rgba(2,6,23,0.45)]">
                  <div className="text-slate-100">
                    {(!effectiveRecordMode || playlistMode) && (
                      <div className="mb-3 border-b border-slate-700 pb-3">
                        {playlistMode && (
                          <Switch
                            checked={continueToNext}
                            onChange={(checked) =>
                              playbackSettingsStore.trigger.setContinueToNext({
                                continueToNext: checked,
                              })
                            }
                            label="Continue to Next"
                          />
                        )}
                        {!effectiveRecordMode && (
                          <Switch
                            checked={autoplay}
                            onChange={(checked) =>
                              playbackSettingsStore.trigger.setAutoplay({ autoplay: checked })
                            }
                            label="Autoplay"
                          />
                        )}
                      </div>
                    )}
                    <PlaybackSpeedVolume />
                    <div className="border-t border-slate-700 pt-3">
                      <button
                        type="button"
                        onClick={() => captionFileInputRef.current?.click()}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
                      >
                        <Captions size={14} aria-hidden="true" />
                        Import captions…
                      </button>
                      {/* Alerts: they come after the picker closes, with focus left on the
                          button, and are inserted (not changed in place) on each failure. */}
                      {captionImportError && (
                        <p role="alert" className="px-2 pt-2 text-xs text-red-400">
                          {captionImportError}
                        </p>
                      )}
                      {effectiveRecordMode && hasNarration ? (
                        isGeneratingCaptions ? (
                          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-slate-300">
                            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                            <span className="flex-1">
                              {describeCaptionGeneration(captionGeneration.state)}
                            </span>
                            <button
                              type="button"
                              onClick={captionGeneration.cancel}
                              className="font-medium text-slate-400 hover:text-white"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void captionGeneration.start(currentRecording)}
                            disabled={isNarrationBeingEdited}
                            title="Transcribe the narration on this device; the audio never leaves your browser"
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            <Sparkles size={14} aria-hidden="true" />
                            Generate captions
                          </button>
                        )
                      ) : null}
                      {captionGeneration.state.status === "failed" ? (
                        <p role="alert" className="px-2 pt-1 text-xs text-red-400">
                          {describeCaptionGeneration(captionGeneration.state)}
                        </p>
                      ) : null}
                      {effectiveRecordMode && activeCaptionTrack ? (
                        <button
                          type="button"
                          onClick={handleDownloadCaptions}
                          title="Save these captions as WebVTT, to correct and import again"
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
                        >
                          <Download size={14} aria-hidden="true" />
                          Download captions (.vtt)
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-3 border-t border-slate-700 pt-3">
                      <Switch
                        checked={characterShortcuts}
                        onChange={(enabled) =>
                          playbackSettingsStore.trigger.setCharacterShortcuts({ enabled })
                        }
                        label="Single-key shortcuts"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          // This button unmounts with the menu; without a hand-off focus
                          // would fall to <body>. The help returns focus to Settings on close.
                          settingsButtonRef.current?.focus();
                          setShowSettings(false);
                          playerShortcuts.openHelp();
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
                      >
                        <Keyboard size={14} aria-hidden="true" />
                        Keyboard shortcuts
                        <kbd className="ml-auto rounded border border-slate-600 px-1 font-mono text-[11px] text-slate-400">
                          ?
                        </kbd>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {!isRecording && currentRecording?.chapters?.length ? (
          <CurrentChapterTitle chapters={currentRecording.chapters} large={large} />
        ) : null}

        {isRecording ? <RecordingMicrophoneLevel /> : null}

        {(isRecording || currentRecording) && (
          <PlaybackTimer
            isRecording={isRecording}
            isRecordingPaused={isRecordingPaused}
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
