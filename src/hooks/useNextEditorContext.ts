import { useContext, useMemo } from "react";
import { shallowEqual } from "@xstate/react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import {
  NextEditorActionsContext,
  type NextEditorActions,
  type NextEditorMetadata,
  type NextEditorPlayback,
} from "../contexts/NextEditorContext";
import {
  selectDuration,
  selectHasEnded,
  selectIsPaused,
  selectIsPlaying,
  selectIsRecording,
  selectIsRecordingAudio,
  selectLiveCursor,
  selectLiveTime,
  selectPlaybackSpeed,
  selectRecording,
  selectRecordingStartTime,
  selectTimelineActor,
  selectUsesPlaybackModel,
  selectVolume,
} from "../core/src/useNextEditor";

/**
 * Hook to access stable actions, refs, and storage methods.
 * Component using this will NOT re-render on machine ticks.
 */
export const useNextEditorActions = (): NextEditorActions => {
  const context = useContext(NextEditorActionsContext);
  if (!context) {
    throw new Error("useNextEditorActions must be used within a NextEditorProvider");
  }
  return context;
};

/**
 * Hook to access metadata/flags (isRecording, isPlaying, etc.).
 * Component using this will re-render when recording/playback state transitions.
 */
export const useNextEditorMetadata = (): NextEditorMetadata => {
  const isRecording = NextEditorActorContext.useSelector(selectIsRecording);
  const isRecordingAudio = NextEditorActorContext.useSelector(selectIsRecordingAudio);
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);
  const isPaused = NextEditorActorContext.useSelector(selectIsPaused);
  const hasEnded = NextEditorActorContext.useSelector(selectHasEnded);
  const usesPlaybackModel = NextEditorActorContext.useSelector(selectUsesPlaybackModel);
  const currentRecording = NextEditorActorContext.useSelector(selectRecording, shallowEqual);
  const recordingStartTime = NextEditorActorContext.useSelector(selectRecordingStartTime);

  return useMemo(
    () => ({
      isRecording,
      isRecordingAudio,
      isPlaying,
      isPaused,
      hasEnded,
      usesPlaybackModel,
      currentRecording,
      recordingStartTime,
    }),
    [
      isRecording,
      isRecordingAudio,
      isPlaying,
      isPaused,
      hasEnded,
      usesPlaybackModel,
      currentRecording,
      recordingStartTime,
    ],
  );
};

/**
 * Hook to access high-frequency playback state refs (volume, duration).
 * Component using this will NOT re-render on machine ticks.
 */
export const useNextEditorPlayback = (): NextEditorPlayback => {
  const actorRef = NextEditorActorContext.useActorRef();
  const timelineActor = NextEditorActorContext.useSelector(selectTimelineActor);
  const playbackSpeed = NextEditorActorContext.useSelector(selectPlaybackSpeed);
  const volume = NextEditorActorContext.useSelector(selectVolume);
  const duration = NextEditorActorContext.useSelector(selectDuration);

  return useMemo(
    () => ({
      timelineActor,
      editorActor: actorRef,
      playbackSpeed,
      volume,
      duration: duration / 1000,
    }),
    [timelineActor, actorRef, playbackSpeed, volume, duration],
  );
};

/**
 * Hook to access live playback time with high frequency.
 * Only the component using this hook will re-render on every tick.
 */
export const useLiveTime = () => {
  return NextEditorActorContext.useSelector(selectLiveTime);
};

/**
 * Hook to access live cursor position with high frequency.
 * Only the component using this hook will re-render on cursor movement.
 */
export const useLiveCursor = () => {
  return NextEditorActorContext.useSelector(selectLiveCursor, shallowEqual);
};
