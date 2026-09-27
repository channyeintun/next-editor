import { useEffect, useRef } from "react";
import type { Recording } from "../core/src";
import { selectLiveTime, type EditorActorRef } from "../core/src/useNextEditor";
import { resumeSharedAudioContext } from "../core/src/utils/audioContext";

// Initial value for the once-per-load guard below. A sentinel (not
// undefined) because `recordingUrl` is legitimately undefined on ?url= and
// drag-drop surfaces — an undefined-initialized ref would compare equal to it
// and block autoplay before it ever fired once.
const AUTOPLAY_NOT_FIRED = Symbol("autoplay-not-fired");

interface AutoplayOnLoadOptions {
  readOnly: boolean;
  recordingLoading: boolean;
  loadError: string | null;
  currentRecording: Recording | null;
  /** The persisted Autoplay setting. */
  autoplay: boolean;
  /** A one-shot force-autoplay from the playlist auto-advance flow. */
  autoplayOverride: boolean;
  isPlaying: boolean;
  recordingUrl: string | undefined;
  editorActor: EditorActorRef;
  play: () => void;
  /**
   * Where each recording was opened (useLinkedStartTime, ?t=): autoplay only starts a
   * lesson that is still at its opening moment, so it plays from a linked moment too.
   */
  getLinkedStart: (recordingId: string) => number;
}

/**
 * Starts playback once a read-only recording has finished loading, when either the
 * persisted Autoplay setting or a one-shot playlist override requests it. Fires once
 * per recording load (once per mount on surfaces where recordingUrl is undefined —
 * ?url= and drag-drop).
 */
export function useAutoplayOnLoad({
  readOnly,
  recordingLoading,
  loadError,
  currentRecording,
  autoplay,
  autoplayOverride,
  isPlaying,
  recordingUrl,
  editorActor,
  play,
  getLinkedStart,
}: AutoplayOnLoadOptions): void {
  const autoplayedForRef = useRef<string | undefined | typeof AUTOPLAY_NOT_FIRED>(
    AUTOPLAY_NOT_FIRED,
  );

  useEffect(() => {
    if (!readOnly || recordingLoading || loadError || !currentRecording || !editorActor) {
      return;
    }
    if (!(autoplay || autoplayOverride) || isPlaying) {
      return;
    }
    if (autoplayedForRef.current === recordingUrl) {
      return;
    }
    if (selectLiveTime(editorActor.getSnapshot()) !== getLinkedStart(currentRecording.id)) {
      return;
    }

    const ctx = resumeSharedAudioContext();

    // play() drives the replay machine, not a media element, so the browser's
    // autoplay policy can't block it — starting an audio-bearing recording with a
    // still-suspended AudioContext (cold load, no user gesture yet) would replay
    // the visuals silently. Skip instead and leave FloatingPlayButton as the entry
    // point. The playlist auto-advance override is exempt: it's only ever set by an
    // in-session navigation, after a play gesture already unlocked the context.
    const hasAudio = Boolean(currentRecording.audioBlob || currentRecording.audioUrl);
    if (!autoplayOverride && hasAudio && ctx.state !== "running") {
      return;
    }

    autoplayedForRef.current = recordingUrl;
    play();
  }, [
    readOnly,
    recordingLoading,
    loadError,
    currentRecording,
    autoplay,
    autoplayOverride,
    isPlaying,
    recordingUrl,
    editorActor,
    play,
  ]);
}
