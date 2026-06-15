import React, { useCallback, useEffect, useRef, useState } from "react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import {
  selectIsPlaying,
  selectLiveTime,
  selectPlaybackSpeed,
  selectRecording,
} from "../core/src/useNextEditor";

export const CAMERA_OVERLAY_VISIBILITY_KEY = "next-editor-camera-overlay-visible";
export const CAMERA_OVERLAY_POSITION_KEY = "next-editor-camera-overlay-position";
export const CAMERA_OVERLAY_VISIBILITY_EVENT = "next-editor-camera-overlay-visibility";

const OVERLAY_SIZE = 192;
const EDGE_PADDING = 24;
const MEDIA_CONTROLS_CLEARANCE = 88;
const DRIFT_THRESHOLD_MS = 250;

interface OverlayPosition {
  x: number;
  y: number;
}

function readStoredVisibility(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CAMERA_OVERLAY_VISIBILITY_KEY) !== "false";
}

function getDefaultPosition(): OverlayPosition {
  if (typeof window === "undefined") {
    return { x: EDGE_PADDING, y: EDGE_PADDING };
  }

  return {
    x: window.innerWidth - OVERLAY_SIZE - EDGE_PADDING,
    y: window.innerHeight - OVERLAY_SIZE - MEDIA_CONTROLS_CLEARANCE,
  };
}

function clampPosition(position: OverlayPosition): OverlayPosition {
  if (typeof window === "undefined") return position;

  return {
    x: Math.min(
      Math.max(position.x, EDGE_PADDING),
      window.innerWidth - OVERLAY_SIZE - EDGE_PADDING,
    ),
    y: Math.min(
      Math.max(position.y, EDGE_PADDING),
      window.innerHeight - OVERLAY_SIZE - MEDIA_CONTROLS_CLEARANCE,
    ),
  };
}

function readStoredPosition(): OverlayPosition {
  if (typeof window === "undefined") return getDefaultPosition();

  const rawPosition = window.localStorage.getItem(CAMERA_OVERLAY_POSITION_KEY);
  if (!rawPosition) return getDefaultPosition();

  try {
    const parsed = JSON.parse(rawPosition) as Partial<OverlayPosition>;
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return clampPosition({ x: parsed.x, y: parsed.y });
    }
  } catch {
    return getDefaultPosition();
  }

  return getDefaultPosition();
}

const CameraOverlay: React.FC = () => {
  const actorRef = NextEditorActorContext.useActorRef();
  const recording = NextEditorActorContext.useSelector(selectRecording);
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);
  const currentTime = NextEditorActorContext.useSelector(selectLiveTime);
  const playbackSpeed = NextEditorActorContext.useSelector(selectPlaybackSpeed);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragOffsetRef = useRef<OverlayPosition>({ x: 0, y: 0 });
  const [isVisible, setIsVisible] = useState(readStoredVisibility);
  const [position, setPosition] = useState(readStoredPosition);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const cameraBlob = recording?.cameraBlob instanceof Blob ? recording.cameraBlob : null;

  useEffect(() => {
    if (!cameraBlob) {
      setVideoUrl(null);
      return;
    }

    const nextUrl = URL.createObjectURL(cameraBlob);
    setVideoUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [cameraBlob]);

  useEffect(() => {
    const handleVisibilityChange = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.visible !== "boolean") {
        return;
      }

      setIsVisible(event.detail.visible);
    };

    window.addEventListener(CAMERA_OVERLAY_VISIBILITY_EVENT, handleVisibilityChange);
    return () => {
      window.removeEventListener(CAMERA_OVERLAY_VISIBILITY_EVENT, handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => clampPosition(current));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CAMERA_OVERLAY_POSITION_KEY, JSON.stringify(position));
  }, [position]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl) return;

    video.playbackRate = playbackSpeed;

    const targetSeconds = currentTime / 1000;
    if (Number.isFinite(targetSeconds)) {
      const driftMs = Math.abs(video.currentTime * 1000 - currentTime);
      if (driftMs > DRIFT_THRESHOLD_MS) {
        video.currentTime = targetSeconds;
      }
    }

    if (isPlaying) {
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [currentTime, isPlaying, playbackSpeed, videoUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoUrl || !isPlaying) return;

    let animationFrameId = 0;

    const syncVideo = () => {
      const snapshot = actorRef.getSnapshot();
      const targetMs = snapshot.context.timeline.currentTime;
      const driftMs = Math.abs(video.currentTime * 1000 - targetMs);

      video.playbackRate = snapshot.context.timeline.speed;
      if (driftMs > DRIFT_THRESHOLD_MS) {
        video.currentTime = targetMs / 1000;
      }

      animationFrameId = requestAnimationFrame(syncVideo);
    };

    syncVideo();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [actorRef, isPlaying, videoUrl]);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragOffsetRef.current = {
        x: event.clientX - position.x,
        y: event.clientY - position.y,
      };
    },
    [position],
  );

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    setPosition(
      clampPosition({
        x: event.clientX - dragOffsetRef.current.x,
        y: event.clientY - dragOffsetRef.current.y,
      }),
    );
  }, []);

  if (!cameraBlob || !videoUrl || !isVisible) {
    return null;
  }

  return (
    <div
      className="fixed left-0 top-0 z-44 size-48 cursor-grab touch-none overflow-hidden rounded-full border border-white/25 bg-slate-950 shadow-2xl shadow-slate-950/40 ring-2 ring-black/20 active:cursor-grabbing"
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      <video
        ref={videoRef}
        src={videoUrl}
        muted
        playsInline
        preload="auto"
        className="object-cover size-full"
        aria-label="Camera recording"
      />
    </div>
  );
};

export default CameraOverlay;
