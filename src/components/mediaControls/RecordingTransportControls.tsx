import { useEffect, useState } from "react";
import { BookmarkPlus, Pause, Play, RotateCcw } from "lucide-react";
import {
  useNextEditorActions,
  useNextEditorMetadata,
  useRecordingChapterCount,
  useRecordingElapsedMs,
  useRetakeTargetTime,
} from "../../hooks/useNextEditorContext";
import { formatPlaybackTime } from "../../utils/formatPlaybackTime";

/** Marks a chapter where the take is now; a retake can also rewind to it. */
const AddChapterButton = ({ iconSize, className }: { iconSize: number; className: string }) => {
  const { addChapterMarker } = useNextEditorActions();
  const count = useRecordingChapterCount();
  const label =
    count === 0 ? "Mark a chapter here" : `Mark a chapter here (${count} marked so far)`;
  return (
    <button
      type="button"
      onClick={() => addChapterMarker()}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center text-slate-300 transition-colors hover:text-white pointer-events-auto ${className}`}
    >
      <BookmarkPlus size={iconSize} aria-hidden="true" />
    </button>
  );
};

/** How long a first click on Retake waits for the confirming second one. */
const RETAKE_CONFIRM_MS = 4_000;

/**
 * Rewinds the take to its last safe point (its start, or the last resume). Retaking
 * discards what was recorded since, so the first click only shows how much, and a
 * second click within a few seconds confirms.
 */
const RetakeButton = ({ iconSize, className }: { iconSize: number; className: string }) => {
  const { retakeRecording } = useNextEditorActions();
  const recordingTime = useRecordingElapsedMs();
  const targetTime = useRetakeTargetTime(recordingTime);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), RETAKE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const discarded = targetTime === null ? "" : formatPlaybackTime(recordingTime - targetTime);
  const label =
    targetTime === null
      ? "Nothing to retake yet"
      : armed
        ? `Discard the last ${discarded} and retake from ${formatPlaybackTime(targetTime)}`
        : `Retake from ${formatPlaybackTime(targetTime)} (the last resume)`;

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    retakeRecording();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={targetTime === null}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center gap-1.5 transition-colors pointer-events-auto disabled:cursor-not-allowed disabled:opacity-40 ${
        armed
          ? "rounded-full bg-amber-500/15 px-2 text-amber-200"
          : `text-slate-300 hover:text-white ${className}`
      }`}
    >
      <RotateCcw size={iconSize} aria-hidden="true" />
      {armed ? (
        <span className="whitespace-nowrap text-xs font-semibold">Discard {discarded}?</span>
      ) : null}
    </button>
  );
};

/** A running take's controls: pause or resume it, retake it, and mark a chapter. */
const RecordingTransportControls = ({
  iconSize,
  className,
}: {
  iconSize: number;
  className: string;
}) => {
  const { pauseRecording, resumeRecording } = useNextEditorActions();
  const { isRecordingPaused } = useNextEditorMetadata();
  return (
    <>
      <button
        type="button"
        onClick={isRecordingPaused ? resumeRecording : pauseRecording}
        aria-pressed={isRecordingPaused}
        aria-label={isRecordingPaused ? "Resume recording" : "Pause recording"}
        title={
          isRecordingPaused
            ? "Resume recording"
            : "Pause recording (edits you make while paused appear at once)"
        }
        className={`flex items-center justify-center text-slate-300 transition-colors hover:text-white pointer-events-auto ${className}`}
      >
        {isRecordingPaused ? (
          <Play size={iconSize} className="fill-current" aria-hidden="true" />
        ) : (
          <Pause size={iconSize} className="fill-current" aria-hidden="true" />
        )}
      </button>
      <RetakeButton iconSize={iconSize} className={className} />
      <AddChapterButton iconSize={iconSize} className={className} />
    </>
  );
};

export default RecordingTransportControls;
