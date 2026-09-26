import { useSearchParams } from "react-router";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useLiveTime,
} from "../hooks/useNextEditorContext";
import { parseTimeParameter } from "../core/src/utils/chapters";
import "../App.css";

/**
 * Floating play button that appears in the center of the screen
 * when a recording is loaded and not currently playing.
 * Clicking it triggers playback of the recording.
 */
const FloatingPlayButton = () => {
  const { play } = useNextEditorActions();
  const { currentRecording, isPlaying, isRecording } = useNextEditorMetadata();
  const currentTime = useLiveTime();

  // A link to a moment (?t=) opens the lesson there, which is its start as far as this
  // button is concerned.
  const [searchParams] = useSearchParams();
  const linkStart = currentRecording
    ? Math.min(parseTimeParameter(searchParams.get("t")) ?? 0, currentRecording.duration)
    : 0;
  const atStart = currentTime === 0 || Math.abs(currentTime - linkStart) < 1;

  // Only show when there's a recording loaded, not currently playing or recording, and at its start
  const shouldShow = currentRecording && !isPlaying && !isRecording && atStart;

  if (!shouldShow) {
    return null;
  }

  return (
    <button
      type="button"
      className="floating-play-button"
      aria-label="Play recording"
      onClick={play}
    >
      <svg viewBox="0 0 256 256" className="zr-ce fill-white size-20" aria-hidden="true">
        <path
          d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"
          pathLength="100"
        ></path>
      </svg>
    </button>
  );
};

export default FloatingPlayButton;
