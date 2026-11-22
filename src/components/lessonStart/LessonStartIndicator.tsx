import { useEffect, useState } from "react";
import { NextEditorActorContext } from "../../contexts/NextEditorActorContext";
import {
  useIsBuffering,
  useNextEditorActions,
  useNextEditorMetadata,
} from "../../hooks/useNextEditorContext";
import ProgressTriangle from "./ProgressTriangle";
import { advanceStartIndicator, INITIAL_START_INDICATOR } from "./lessonStartProgress";
import { useIsAtLessonStart } from "./useIsAtLessonStart";
import { useNarrationLoad } from "./useNarrationLoad";
import "./lessonStart.css";

/**
 * How long a wait for the narration must last before it is said, and before a hold
 * mid-lesson shows. A seek holds the lesson for a few milliseconds while the narration
 * moves to the new position, and a mark that blinks on every seek reads as something
 * broken.
 */
const WAIT_NOTICE_DELAY_MS = 500;

const BUTTON_SIZE = 80;
const MARK_SIZE = 40;

interface LessonStartIndicatorProps {
  /** The lesson's file is being fetched (the URL loader's `isLoading`). */
  lessonLoading: boolean;
  /** The last load failed, and its error covers the editor: nothing to play or to wait for. */
  loadFailed: boolean;
  /** Autoplay is asked for, so the lesson may start by itself once it has loaded. */
  autoplayWanted: boolean;
}

/** Whether a wait has lasted long enough to say so. Each wait counts its own delay. */
function useWaitHasLasted(waiting: boolean): boolean {
  const [lasted, setLasted] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLasted(true), WAIT_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setLasted(false);
    };
  }, [waiting]);

  return waiting && lasted;
}

/**
 * Whether autoplay may still start this lesson by itself. It decides as soon as the
 * lesson has loaded (useAutoplayOnLoad, an effect of the editor, which runs after this
 * component's own in the same pass), so by the next task it has started the lesson or
 * left it for a press.
 */
function useAutoplayPending(
  autoplayWanted: boolean,
  lessonLoading: boolean,
  recordingId: string | null,
): boolean {
  const [decidedFor, setDecidedFor] = useState<string | null>(null);
  // Each load is autoplay's to decide again, the same lesson loaded once more included.
  if (lessonLoading && decidedFor !== null) setDecidedFor(null);

  useEffect(() => {
    if (!autoplayWanted || lessonLoading || recordingId === null) return;
    const timer = setTimeout(() => setDecidedFor(recordingId), 0);
    return () => clearTimeout(timer);
  }, [autoplayWanted, lessonLoading, recordingId]);

  return autoplayWanted && (recordingId === null || decidedFor !== recordingId);
}

/**
 * The one thing a lesson shows while it gets ready: the play triangle in the middle of
 * it, with a border that is traced from its tip round to its tip again. The border
 * follows the lesson's file while it loads and closes into the filled triangle, which
 * is the play button. After Play it follows the narration until there is sound, on the
 * same triangle. A hold later in the lesson (a slow connection, a seek) is the same
 * trace on a small mark.
 *
 * The live region stays mounted and only its text changes: a screen reader announces
 * what a live region comes to say, and often says nothing for one inserted already
 * filled. It is a polite live region of its own, not a second `role="status"`: the
 * editor already keeps one for a lesson that is loading.
 */
export default function LessonStartIndicator({
  lessonLoading,
  loadFailed,
  autoplayWanted,
}: LessonStartIndicatorProps) {
  const { play } = useNextEditorActions();
  const { recordingId, isPlaying, isRecording } = useNextEditorMetadata((metadata) => ({
    recordingId: metadata.currentRecording?.id ?? null,
    isPlaying: metadata.isPlaying,
    isRecording: metadata.isRecording,
  }));
  // The machine readies a recording after the loader hands it over (it measures a
  // narration in memory): until then the lesson is still loading.
  const readying = NextEditorActorContext.useSelector((state) => state.matches("loading"));
  const isBuffering = useIsBuffering();
  const atStart = useIsAtLessonStart();
  const narration = useNarrationLoad();

  const loading = !loadFailed && (lessonLoading || readying);
  const autoplayPending = useAutoplayPending(autoplayWanted, loading, recordingId);
  const idleAtStart =
    !loading && !loadFailed && recordingId !== null && !isPlaying && !isRecording && atStart;

  // What is shown depends on what was shown before (a press on the play button is
  // answered on that button, a border never runs backward), so it is kept as state and
  // moved on as the lesson changes, during render: no frame shows the state before.
  const [indicator, setIndicator] = useState(INITIAL_START_INDICATOR);
  const next = advanceStartIndicator(indicator, {
    lessonLoading: loading,
    autoplayPending,
    idleAtStart,
    held: isPlaying && isBuffering,
    narration,
  });
  if (next !== indicator) setIndicator(next);

  const waitingForNarration = next.mode === "starting" || next.mode === "holding";
  const waitHasLasted = useWaitHasLasted(waitingForNarration);
  // The wait that follows Play shows at once, as the answer to the press; a hold
  // mid-lesson only once it has lasted. Either is announced only once it has lasted.
  const shown = next.mode !== "hidden" && (next.mode !== "holding" || waitHasLasted);
  // Pressable whenever a loaded lesson waits at its start, drawn filled or not.
  const pressable = shown && idleAtStart;

  return (
    <>
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {waitingForNarration && waitHasLasted ? "Loading narration" : ""}
      </div>
      <button
        type="button"
        className="lesson-start"
        data-shown={shown || undefined}
        data-shape={next.shape}
        data-pressable={pressable || undefined}
        // Progress to look at until the lesson can be played: then it is the play button.
        aria-label="Play recording"
        aria-hidden={!pressable}
        disabled={!pressable}
        onClick={play}
      >
        <ProgressTriangle
          size={next.shape === "mark" ? MARK_SIZE : BUTTON_SIZE}
          trace={next.trace}
          value={next.value}
          drift={next.drift}
          solid={next.solid}
        />
      </button>
    </>
  );
}
