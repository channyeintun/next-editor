import { useEffect, type RefObject } from "react";
import { NextEditorActorContext } from "../../contexts/NextEditorActorContext";
import { selectIsPlaying } from "../../core/src/useNextEditor";
import { mapRecordingTimeToMediaTime, type MediaSpan } from "../../core/src/utils/mediaSpans";

const DRIFT_THRESHOLD_MS = 250;
/**
 * Dead zone for the one-shot re-anchor on the element's `playing` event.
 * `video.play()` delivers its first frame tens/hundreds of ms after the
 * timeline starts, and the rAF loop's DRIFT_THRESHOLD_MS dead zone would
 * otherwise preserve that startup lag for the whole playback.
 */
const START_SYNC_EPSILON_MS = 50;

/**
 * Drives the recorded camera in `videoRef`'s <video> from the playback timeline, once
 * `videoUrl` is set.
 */
export function useTimelineSyncedVideo(
  videoRef: RefObject<HTMLVideoElement | null>,
  videoUrl: string | null,
  {
    cameraCuts,
    cameraStartOffsetMs,
    isVisible,
    isMinimized,
  }: {
    cameraCuts: readonly MediaSpan[] | undefined;
    cameraStartOffsetMs: number;
    isVisible: boolean;
    isMinimized: boolean;
  },
): void {
  const actorRef = NextEditorActorContext.useActorRef();
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);

  // Drive the <video> from the playback timeline. Mirrors CursorComponent: read
  // `timeline.currentTime` directly from the actor snapshot inside a rAF loop so
  // playback sync never forces a React re-render. While paused, subscribe
  // imperatively so scrubbing still updates the visible frame.
  //
  // `isVisible` and `isMinimized` are dependencies because the <video> unmounts when the overlay is
  // hidden or minimized; the effect must re-run to rebind to (and resume playing) the fresh element
  // when it remounts, otherwise toggling visibility mid-playback leaves a frozen, detached video.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;

    // Drop any leftover live-preview stream so the recorded blob `src` actually drives the element.
    video.srcObject = null;

    // The camera starts a beat after the recording origin (getUserMedia warmup), so shift the
    // timeline back by that offset to keep the face video aligned with audio/typing. A
    // retake left the stretch it discarded in the file, so step over those first.
    const cameraTimeAt = (currentTime: number) =>
      Math.max(
        0,
        (cameraCuts?.length ? mapRecordingTimeToMediaTime(currentTime, cameraCuts) : currentTime) -
          cameraStartOffsetMs,
      );

    const applyTimeline = () => {
      const { currentTime, speed } = actorRef.getSnapshot().context.timeline;
      video.playbackRate = speed;
      const targetMs = cameraTimeAt(currentTime);
      if (
        Number.isFinite(targetMs) &&
        Math.abs(video.currentTime * 1000 - targetMs) > DRIFT_THRESHOLD_MS
      ) {
        video.currentTime = targetMs / 1000;
      }
    };

    if (!isPlaying) {
      video.pause();
      applyTimeline();
      const subscription = actorRef.subscribe(() => {
        if (selectIsPlaying(actorRef.getSnapshot())) return;
        applyTimeline();
      });
      return () => {
        subscription.unsubscribe();
      };
    }

    applyTimeline();

    // Re-anchor once frames are actually flowing. The seek this triggers refires
    // `playing`, but the residual drift is then just the seek latency, which
    // lands inside the epsilon and terminates the cycle.
    const handlePlaying = () => {
      const { currentTime } = actorRef.getSnapshot().context.timeline;
      const targetMs = cameraTimeAt(currentTime);
      if (
        Number.isFinite(targetMs) &&
        Math.abs(video.currentTime * 1000 - targetMs) > START_SYNC_EPSILON_MS
      ) {
        video.currentTime = targetMs / 1000;
      }
    };
    video.addEventListener("playing", handlePlaying);
    void video.play().catch(() => {});

    let animationFrameId = 0;
    const syncVideo = () => {
      applyTimeline();
      animationFrameId = requestAnimationFrame(syncVideo);
    };
    animationFrameId = requestAnimationFrame(syncVideo);

    return () => {
      video.removeEventListener("playing", handlePlaying);
      cancelAnimationFrame(animationFrameId);
    };
  }, [actorRef, cameraCuts, cameraStartOffsetMs, isMinimized, isVisible, isPlaying, videoUrl]);
}
