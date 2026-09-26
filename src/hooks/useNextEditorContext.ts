import { useContext, useEffect, useState } from "react";
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
  selectRecordingClock,
  selectRecordingSafePoints,
  selectVolume,
} from "../core/src/useNextEditor";
import { findRetakeTarget } from "../core/src/machine/retake";
import { isRecordingClockPaused, readRecordingClock } from "../core/src/machine/recordingClock";

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

/**
 * The running take's recorded time in ms, refreshed every `intervalMs` while it runs.
 * It stands still while the take is paused, and is 0 outside a take.
 */
export const useRecordingElapsedMs = (intervalMs = 100): number => {
  const recordingClock = NextEditorActorContext.useSelector(selectRecordingClock, shallowEqual);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!recordingClock || isRecordingClockPaused(recordingClock.clock)) return;
    const tick = () => setNow(performance.now());
    // Read at once, so a resumed take does not show the reading from before its pause.
    tick();
    const interval = setInterval(tick, intervalMs);
    return () => clearInterval(interval);
  }, [recordingClock, intervalMs]);

  return recordingClock
    ? readRecordingClock(recordingClock.clock, recordingClock.startedAtPerf, now)
    : 0;
};

/**
 * Where a retake would rewind the running take to, in recorded time, or null when
 * there is nothing before now to rewind to (or no take).
 */
export const useRetakeTargetTime = (recordingTime: number): number | null => {
  const safePoints = NextEditorActorContext.useSelector(selectRecordingSafePoints);
  return safePoints ? (findRetakeTarget(safePoints, recordingTime)?.recordingTime ?? null) : null;
};
