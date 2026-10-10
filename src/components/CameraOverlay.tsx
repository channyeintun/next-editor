import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Move } from "lucide-react";
import { useSelector } from "@xstate/store-react";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { selectRecording } from "../core/src/useNextEditor";
import { allowedRecordingMediaUrl } from "../core/src/utils/mediaUrl";
import {
  cameraOverlayStore,
  selectCameraOverlayMinimized,
  selectCameraOverlayVisible,
  selectLivePreviewOn,
} from "../stores/cameraOverlayStore";
import {
  OVERLAY_HEIGHT,
  OVERLAY_RADIUS,
  OVERLAY_WIDTH,
  getDockSide,
  getMinimizedHandleTop,
} from "./cameraOverlay/overlayGeometry";
import { useCameraPreviewStream } from "./cameraOverlay/useCameraPreviewStream";
import { useDraggableOverlayPosition } from "./cameraOverlay/useDraggableOverlayPosition";
import { useTimelineSyncedVideo } from "./cameraOverlay/useTimelineSyncedVideo";

const CameraOverlay: React.FC = () => {
  const actorRef = NextEditorActorContext.useActorRef();
  const recording = NextEditorActorContext.useSelector(selectRecording);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVisible = useSelector(cameraOverlayStore, (s) => selectCameraOverlayVisible(s.context));
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const isMinimized = useSelector(cameraOverlayStore, (s) =>
    selectCameraOverlayMinimized(s.context),
  );
  // Switched on from this editor's player bar, with the camera for the next take.
  const isPreviewEnabled = useSelector(cameraOverlayStore, (s) =>
    selectLivePreviewOn(s.context, actorRef),
  );

  const cameraBlob = recording?.cameraBlob instanceof Blob ? recording.cameraBlob : null;
  // External camera video (sibling file or hosted URL) referenced by the recording. Preferred over
  // an inline blob so the browser range-streams the video instead of holding it all in memory.
  // Scheme-checked: the header this comes from is decoded with a bare type
  // assertion, so a hostile recording could otherwise point a <video src> at an
  // arbitrary scheme. Rejecting falls back to the inline blob or the live
  // preview, exactly as a recording with no external camera already does.
  const cameraUrl = allowedRecordingMediaUrl(recording?.cameraUrl);
  const cameraStartOffsetMs = recording?.cameraStartOffsetMs ?? 0;
  const cameraCuts = recording?.cameraCuts;
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

  // The hooks' effects run in this order, as when they were written out here: the preview's
  // stream is attached or detached before the recorded video takes the element over.
  const previewError = useCameraPreviewStream(videoRef, previewMode, isMinimized);
  const { position, handlePointerDown, handlePointerMove, handleDragEnd, moveToNextCorner } =
    useDraggableOverlayPosition();
  useTimelineSyncedVideo(videoRef, videoUrl, {
    cameraCuts,
    cameraStartOffsetMs,
    isVisible,
    isMinimized,
  });

  // Minimize and move-to-corner are pure viewer-side conveniences (independent of
  // recording/playback): a press on either control must not start a drag of the overlay.
  // Minimize then collapses to a side-docked handle.
  const handleControlPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };
  const handleMinimize = () => cameraOverlayStore.trigger.setMinimized({ minimized: true });
  const handleRestore = () => cameraOverlayStore.trigger.setMinimized({ minimized: false });

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
        className={`fixed top-0 z-44 flex h-14 w-7 cursor-pointer items-center justify-center bg-slate-950/90 text-white shadow-2xl shadow-black/50 transition-colors hover:bg-slate-800 ${
          dockSide === "left"
            ? "left-0 rounded-r-full border-2 border-l-0 border-white/70"
            : "right-0 rounded-l-full border-2 border-r-0 border-white/70"
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
      // The border is the frame: a bright hairline reads as a deliberate edge against the dark
      // editor, where the old dim border plus dark outer ring just blurred the card into it.
      className="group fixed left-0 top-0 z-999 cursor-grab touch-none overflow-hidden border-2 border-white/70 bg-slate-950 shadow-2xl shadow-black/50 active:cursor-grabbing"
      style={{
        width: OVERLAY_WIDTH,
        height: OVERLAY_HEIGHT,
        borderRadius: OVERLAY_RADIUS,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handleDragEnd}
      onLostPointerCapture={handleDragEnd}
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
        onPointerDown={handleControlPointerDown}
        onClick={moveToNextCorner}
        title="Move camera to next corner"
        aria-label="Move camera to next corner"
        className="absolute left-1/2 top-1.5 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-slate-950/60 text-white opacity-0 transition-opacity hover:bg-slate-900 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <Move size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        onPointerDown={handleControlPointerDown}
        onClick={handleMinimize}
        title="Minimize camera"
        aria-label="Minimize camera"
        className={`absolute top-1/2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-slate-950/60 text-white opacity-0 transition-opacity hover:bg-slate-900 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 ${
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
