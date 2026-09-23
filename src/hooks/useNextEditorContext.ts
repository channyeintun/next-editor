import { useContext } from "react";
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
  selectLiveTime,
  selectNextEditorMetadata,
  selectPlaybackSpeed,
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
export const useNextEditorMetadata = (): NextEditorMetadata =>
  NextEditorActorContext.useSelector(selectNextEditorMetadata, shallowEqual);

/**
 * Hook to access the editor actor and the playback settings (speed, volume, timeline length).
 * These change on user action or as a stream grows, so a component using this does NOT
 * re-render on machine ticks; the playhead is `useLiveTime`.
 */
export const useNextEditorPlayback = (): NextEditorPlayback => {
  const actorRef = NextEditorActorContext.useActorRef();
  const playbackSpeed = NextEditorActorContext.useSelector(selectPlaybackSpeed);
  const volume = NextEditorActorContext.useSelector(selectVolume);
  const duration = NextEditorActorContext.useSelector(selectDuration);

  return {
    editorActor: actorRef,
    playbackSpeed,
    volume,
    durationMs: duration,
  };
};

/**
 * Hook to access live playback time with high frequency.
 * Only the component using this hook will re-render on every tick.
 */
export const useLiveTime = () => {
  return NextEditorActorContext.useSelector(selectLiveTime);
};
