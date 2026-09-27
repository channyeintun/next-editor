import { useEffect, useRef, useState, type RefObject } from "react";

/** Live-preview capture constraints; mirror the camera recorder so the framing matches. */
const CAMERA_PREVIEW_CONSTRAINTS = {
  width: { ideal: 480 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
} as const;

/**
 * Shows the live camera in `videoRef`'s <video> while `previewMode` is on. Returns whether the
 * camera could not be opened (no getUserMedia, or the viewer refused it).
 */
export function useCameraPreviewStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  previewMode: boolean,
  isMinimized: boolean,
): boolean {
  const previewStreamRef = useRef<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState(false);

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

  return previewError;
}
