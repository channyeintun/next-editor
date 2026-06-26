import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { selectIsPlaying, selectRecording } from "../core/src/useNextEditor";

export const CAMERA_OVERLAY_VISIBILITY_KEY = "next-editor-camera-overlay-visible";
export const CAMERA_OVERLAY_POSITION_KEY = "next-editor-camera-overlay-position";
export const CAMERA_OVERLAY_MINIMIZED_KEY = "next-editor-camera-overlay-minimized";
export const CAMERA_OVERLAY_VISIBILITY_EVENT = "next-editor-camera-overlay-visibility";
/** Dispatched by MediaControls when the camera capture toggle flips, to drive the live preview. */
export const CAMERA_OVERLAY_PREVIEW_EVENT = "next-editor-camera-overlay-preview";

const OVERLAY_SIZE = 192;
const EDGE_PADDING = 24;
const MEDIA_CONTROLS_CLEARANCE = 88;
const DRIFT_THRESHOLD_MS = 250;
const MINIMIZED_HANDLE_HEIGHT = 56;

/** Live-preview capture constraints; mirror the camera recorder so the framing matches. */
const CAMERA_PREVIEW_CONSTRAINTS = {
  width: { ideal: 480 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
} as const;

interface OverlayPosition {
  x: number;
  y: number;
}

function readStoredVisibility(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CAMERA_OVERLAY_VISIBILITY_KEY) !== "false";
}

function readStoredMinimized(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(CAMERA_OVERLAY_MINIMIZED_KEY) === "true";
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

/** The screen edge the minimized handle docks to, based on which half the overlay sits in. */
function getDockSide(position: OverlayPosition): "left" | "right" {
  if (typeof window === "undefined") return "right";
  return position.x + OVERLAY_SIZE / 2 < window.innerWidth / 2 ? "left" : "right";
}

/** Vertical offset for the minimized handle, centered on the overlay and clamped to the viewport. */
function getMinimizedHandleTop(position: OverlayPosition): number {
  const centeredTop = position.y + OVERLAY_SIZE / 2 - MINIMIZED_HANDLE_HEIGHT / 2;
  if (typeof window === "undefined") return Math.max(centeredTop, EDGE_PADDING);
  return Math.min(
    Math.max(centeredTop, EDGE_PADDING),
    window.innerHeight - MINIMIZED_HANDLE_HEIGHT - EDGE_PADDING,
  );
}

const CameraOverlay: React.FC = () => {
  const actorRef = NextEditorActorContext.useActorRef();
  const recording = NextEditorActorContext.useSelector(selectRecording);
  const isPlaying = NextEditorActorContext.useSelector(selectIsPlaying);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dragOffsetRef = useRef<OverlayPosition>({ x: 0, y: 0 });
  const previewStreamRef = useRef<MediaStream | null>(null);
  const [isVisible, setIsVisible] = useState(readStoredVisibility);
  const [position, setPosition] = useState(readStoredPosition);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(readStoredMinimized);
  const [isPreviewEnabled, setIsPreviewEnabled] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const cameraBlob = recording?.cameraBlob instanceof Blob ? recording.cameraBlob : null;
  // External camera video (sibling file or hosted URL) referenced by the recording. Preferred over
  // an inline blob so the browser range-streams the video instead of holding it all in memory.
  const cameraUrl = recording?.cameraUrl ?? null;
  const cameraStartOffsetMs = recording?.cameraStartOffsetMs ?? 0;
  // Live preview takes over whenever the camera toggle is on and there is no recorded camera to
  // replay (i.e. idle or actively recording). During playback, the loaded recording wins and
  // replays either the external video URL (loaded/imported recordings) or the in-memory camera
  // blob (just-recorded or IndexedDB-restored recordings).
  const previewMode = isPreviewEnabled && !cameraBlob && !cameraUrl;

  useEffect(() => {
    // External video: use the URL directly. Its lifecycle is owned elsewhere (a hosted URL, or an
    // imported object URL tracked in cameraVideoUrl.ts), so do not revoke it here.
    if (cameraUrl) {
      setVideoUrl(cameraUrl);
      return;
    }

    if (!cameraBlob) {
      setVideoUrl(null);
      return;
    }

    // In-memory camera blob (a just-recorded session or an IndexedDB-restored recording): wrap it
    // in an object URL for the <video>, and revoke it when the blob changes or the overlay unmounts.
    const nextUrl = URL.createObjectURL(cameraBlob);
    setVideoUrl(nextUrl);

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [cameraBlob, cameraUrl]);

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
    const handlePreviewToggle = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.enabled !== "boolean") {
        return;
      }

      setIsPreviewEnabled(event.detail.enabled);
    };

    window.addEventListener(CAMERA_OVERLAY_PREVIEW_EVENT, handlePreviewToggle);
    return () => {
      window.removeEventListener(CAMERA_OVERLAY_PREVIEW_EVENT, handlePreviewToggle);
    };
  }, []);

  // Acquire a live camera stream while in preview mode. The stream is kept in a ref so it survives
  // minimize/restore (the <video> unmounts when minimized) without re-prompting for the camera.
  useEffect(() => {
    if (!previewMode) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setPreviewError(true);
      return;
    }

    const video = videoRef.current;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: CAMERA_PREVIEW_CONSTRAINTS, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        previewStreamRef.current = stream;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewError(true);
      });

    return () => {
      cancelled = true;
      previewStreamRef.current?.getTracks().forEach((track) => track.stop());
      previewStreamRef.current = null;
      if (video) video.srcObject = null;
      setPreviewError(false);
    };
  }, [previewMode]);

  // Reattach the live stream to the <video> when it remounts (e.g. after restoring from minimized).
  useEffect(() => {
    if (!previewMode || isMinimized) return;
    const video = videoRef.current;
    if (video && previewStreamRef.current && video.srcObject !== previewStreamRef.current) {
      video.srcObject = previewStreamRef.current;
      void video.play().catch(() => {});
    }
  }, [previewMode, isMinimized]);

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
    window.localStorage.setItem(CAMERA_OVERLAY_MINIMIZED_KEY, String(isMinimized));
  }, [isMinimized]);

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

    const applyTimeline = () => {
      const { currentTime, speed } = actorRef.getSnapshot().context.timeline;
      video.playbackRate = speed;
      // The camera starts a beat after the recording origin (getUserMedia warmup), so shift the
      // timeline back by that offset to keep the face video aligned with audio/typing.
      const targetMs = Math.max(0, currentTime - cameraStartOffsetMs);
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
    void video.play().catch(() => {});

    let animationFrameId = 0;
    const syncVideo = () => {
      applyTimeline();
      animationFrameId = requestAnimationFrame(syncVideo);
    };
    animationFrameId = requestAnimationFrame(syncVideo);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [actorRef, cameraStartOffsetMs, isMinimized, isVisible, isPlaying, videoUrl]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    setPosition(
      clampPosition({
        x: event.clientX - dragOffsetRef.current.x,
        y: event.clientY - dragOffsetRef.current.y,
      }),
    );
  };

  // Minimize is a pure viewer-side convenience (independent of recording/playback): stop the
  // pointer from starting a drag, then collapse to a side-docked handle.
  const handleMinimizePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const handleMinimize = () => setIsMinimized(true);
  const handleRestore = () => setIsMinimized(false);

  const showPlayback = Boolean(cameraBlob || cameraUrl) && Boolean(videoUrl) && isVisible;
  const showPreview = previewMode && !previewError;
  if (!showPlayback && !showPreview) {
    return null;
  }

  const dockSide = getDockSide(position);

  if (isMinimized) {
    return (
      <button
        type="button"
        onClick={handleRestore}
        title="Show camera"
        aria-label="Show camera"
        className={`fixed top-0 z-44 flex h-14 w-7 cursor-pointer items-center justify-center bg-slate-950/90 text-white shadow-2xl shadow-slate-950/40 ring-2 ring-black/20 transition-colors hover:bg-slate-800 ${
          dockSide === "left"
            ? "left-0 rounded-r-full border border-l-0 border-white/25"
            : "right-0 rounded-l-full border border-r-0 border-white/25"
        }`}
        style={{ transform: `translateY(${getMinimizedHandleTop(position)}px)` }}
      >
        {dockSide === "left" ? (
          <ChevronRight size={18} aria-hidden="true" />
        ) : (
          <ChevronLeft size={18} aria-hidden="true" />
        )}
      </button>
    );
  }

  return (
    <div
      className="group fixed left-0 top-0 z-44 size-48 cursor-grab touch-none overflow-hidden rounded-full border border-white/25 bg-slate-950 shadow-2xl shadow-slate-950/40 ring-2 ring-black/20 active:cursor-grabbing"
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
    >
      <video
        ref={videoRef}
        src={showPlayback ? (videoUrl ?? undefined) : undefined}
        muted
        autoPlay={showPreview}
        playsInline
        preload="auto"
        // Mirror the self-facing camera horizontally so the overlay reads like a mirror
        // (matching the recorder's expectation) instead of the reversed "how others see you" view.
        className="object-cover size-full -scale-x-100"
        aria-label={showPreview ? "Live camera preview" : "Camera recording"}
      />
      <button
        type="button"
        onPointerDown={handleMinimizePointerDown}
        onClick={handleMinimize}
        title="Minimize camera"
        aria-label="Minimize camera"
        className={`absolute top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-slate-950/60 text-white opacity-0 transition-opacity hover:bg-slate-900 group-hover:opacity-100 ${
          dockSide === "left" ? "left-1.5" : "right-1.5"
        }`}
      >
        {dockSide === "left" ? (
          <ChevronLeft size={18} aria-hidden="true" />
        ) : (
          <ChevronRight size={18} aria-hidden="true" />
        )}
      </button>
    </div>
  );
};

export default CameraOverlay;
