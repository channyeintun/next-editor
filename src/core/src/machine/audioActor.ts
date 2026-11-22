import type { ActorRefFrom } from "xstate";
import { fromTypedCallback } from "./fromTypedCallback";
import { openMicrophone } from "./microphone";
import {
  RECORDER_TIMESLICE_MS,
  recorderErrorMessage,
  stopRecorderIfActive,
  syncRecorderPause,
  type RecorderControlEvent,
} from "./recorderControl";
import { AUDIO_MIME_TYPES, getSupportedRecorderMimeType } from "../utils/recorderMimeType";
import { isAllowedRecordingMediaUrl } from "../utils/mediaUrl";
import {
  normalizeNonNegativeTime,
  normalizePlaybackSpeed,
  normalizePlaybackVolume,
} from "./playbackValues";

/**
 * Dead zone for the periodic SYNC safety net. Reseeking an HTMLAudioElement is
 * audible (a brief gap), so routine ticks only correct gross drift.
 */
const AUDIO_SYNC_DRIFT_THRESHOLD_MS = 500;

/**
 * Dead zone for explicit repositioning (spawn/SEEK/PLAY) and for the re-anchor
 * on the element's `playing` event. Kept just large enough to skip redundant
 * micro-seeks; anything above ~50ms is within lip-sync perceptibility, so these
 * paths correct it exactly instead of letting it persist under the SYNC
 * threshold.
 */
const AUDIO_EXACT_SYNC_EPSILON_MS = 50;

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough data to play on from the current position. */
const HAVE_FUTURE_DATA = 3;

/**
 * How much of a streamed narration a warm-up asks the browser for before the first PLAY:
 * its metadata. The browser reads the file's header and its end (to learn the length),
 * then stops. In Chrome the header's request has by then brought the first seconds of
 * sound with it, so Play has sound at once for a fraction of the file: about 140 KB of
 * a 1.8 MB narration, measured. `auto` gives the same press, and downloads the rest of
 * the file whether or not the lesson is ever played. A browser that keeps no sound from
 * a metadata load fetches the first of it on Play, over a connection that is open.
 */
const WARM_UP_PRELOAD = "metadata";

/**
 * How far past the playhead a buffered range may start and still count as the one being
 * played: a seek lands a few milliseconds inside the range it asked for, or before it.
 */
const BUFFERED_RANGE_SLACK_SECONDS = 0.1;

/**
 * How long a streamed narration waits before each reload after its element fails, one
 * entry per attempt. A weak connection drops a download partway, and an element that
 * failed stays silent for the rest of the lesson unless it is loaded again. Once these
 * are used up the failure is reported; the next PLAY tries once more.
 */
const AUDIO_SOURCE_RETRY_DELAYS_MS = [1000, 2000, 4000];

// ============================================================================
// Audio Actor Types
// ============================================================================

export interface AudioRecordingInput {
  /** The microphone the author picked; the default one when absent or gone. */
  deviceId?: string;
}

/** Where the narration plays from. At least one of the two is present. */
export interface AudioPlaybackSource {
  /**
   * The narration in memory: a take that was just recorded, or a file the author
   * picked or imported. Played when there is no usable audioUrl.
   */
  blob?: Blob;
  /**
   * Where a published lesson's narration is stored. Takes precedence over the blob.
   * A web URL is streamed: the element downloads it as it plays, so a long narration
   * starts after its first seconds have arrived, not after the whole file.
   */
  audioUrl?: string;
}

export interface AudioPlaybackInput extends AudioPlaybackSource {
  /** Initial volume (0-1) */
  volume: number;
  /** Initial playback rate */
  playbackRate: number;
  /** Starting position in milliseconds */
  startPositionMs: number;
  /** Offset between the editor timeline origin and audio time 0. */
  startOffsetMs?: number;
}

/** What the machine sends the microphone recorder. */
export type AudioRecordingEvent = RecorderControlEvent;

export type AudioPlaybackEvent =
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "SEEK"; timeMs: number }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "SET_PLAYBACK_RATE"; rate: number }
  | { type: "SYNC"; timeMs: number }
  /**
   * The timeline stopped to wait for this narration (the answer to
   * AUDIO_PLAYBACK_STALLED). The element keeps loading; PLAY counts on from here.
   */
  | { type: "HOLD" }
  /**
   * Load the start of the narration now, before anyone plays it, so that Play has sound
   * at once (see `warmNarration`). Asked once per player; ignored once it has played.
   */
  | { type: "WARM" }
  /** The recording's narration is now this one. Ignored when it is what already plays. */
  | ({ type: "SET_SOURCE" } & AudioPlaybackSource);

export type AudioRecordingEmit =
  | {
      type: "AUDIO_RECORDING_STARTED";
      mediaRecorder: MediaRecorder;
      mimeType: string;
      startedAtMs: number;
      startedAtPerf: number;
    }
  | { type: "AUDIO_RECORDING_STOPPED"; blob: Blob }
  | { type: "AUDIO_RECORDING_ERROR"; error: string };

export type AudioPlaybackEmit =
  | { type: "AUDIO_PLAYBACK_READY"; durationMs: number }
  | { type: "AUDIO_PLAYBACK_FINISHED" }
  | { type: "AUDIO_PLAYBACK_ERROR"; error: string }
  /** Asked to play, but the next stretch of sound has not arrived (or is being reloaded). */
  | { type: "AUDIO_PLAYBACK_STALLED" }
  /** No longer stalled: sound is flowing, or the narration ended or was given up on. */
  | { type: "AUDIO_PLAYBACK_RESUMED" };

/**
 * How the narration's loading is going, for whoever draws it. The player only reports
 * what its element says; what share of the wait each step stands for is the drawer's.
 */
export interface NarrationLoadFacts {
  /**
   * Before the first PLAY, when the player was asked to warm up: `warming` while the
   * start of the narration loads with nobody waiting for it, then `warmed` once it has
   * got as far as it will before PLAY (it can play, or the browser loads no more
   * unasked, or the load failed and PLAY will try again).
   *
   * While the lesson plays: `loading` while it waits for sound. The wait ends `flowing`
   * when the sound it waited for plays, and `abandoned` when it ends without it: the
   * narration could not be loaded, the browser refused to play it, or it has no sound
   * at this moment.
   */
  stage: "warming" | "warmed" | "loading" | "flowing" | "abandoned";
  /** The element's `readyState`, 0 (nothing) to 4 (enough to play through). */
  readyState: number;
  /** Seconds of sound loaded from the playhead on. */
  bufferedAheadSeconds: number;
  /**
   * How many times the element has said data arrived (`progress`) since this warm-up or
   * wait began (a wait that takes over a running warm-up counts on from it).
   * It is the only sign of life before the first `readyState` step, which a narration
   * on a slow connection takes seconds to reach: the browser reads the file's header
   * and its end before it knows the length. It says the download moves, not how far.
   */
  dataArrivals: number;
}

/**
 * Emitted (`.on("NARRATION_LOAD")`) through a warm-up and from the start of each wait
 * to its end, so the parent machine has nothing to store or forward: it holds the
 * lesson on STALLED and RESUMED alone. The end of a wait is emitted before RESUMED is
 * sent.
 */
export type NarrationLoadEmitted = { type: "NARRATION_LOAD" } & NarrationLoadFacts;

// ============================================================================
// Audio Recording Actor
// ============================================================================

/**
 * Audio recording actor - manages MediaRecorder lifecycle
 */
export const audioRecordingActor = fromTypedCallback<
  AudioRecordingEvent,
  AudioRecordingInput,
  AudioRecordingEmit
>(({ sendBack, receive, input }) => {
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";
  let disposed = false;
  let starting = false;
  let stopRequested = false;
  // The take's pause state, which can arrive before the recorder has started.
  // MediaRecorder writes nothing while paused, so the narration stays as long as the
  // take's recorded time, which skips the same pauses.
  let paused = false;

  const cleanupStream = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  };

  const startRecording = async () => {
    if (starting || stopRequested || mediaRecorder) {
      return;
    }

    starting = true;

    try {
      stream = await openMicrophone(input);

      if (disposed || stopRequested) {
        cleanupStream();
        return;
      }

      mimeType = getSupportedRecorderMimeType(AUDIO_MIME_TYPES);
      if (!mimeType) {
        cleanupStream();
        if (!disposed && !stopRequested) {
          sendBack({
            type: "AUDIO_RECORDING_ERROR",
            error: "No supported audio MIME type found",
          });
        }
        return;
      }

      mediaRecorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 32000,
        mimeType,
      });

      chunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        if (!disposed) {
          sendBack({ type: "AUDIO_RECORDING_STOPPED", blob });
        }

        cleanupStream();
      };

      mediaRecorder.onstart = () => {
        if (!disposed && !stopRequested && mediaRecorder) {
          const startedAtMs = Date.now();
          const startedAtPerfMs = performance.now();
          sendBack({
            type: "AUDIO_RECORDING_STARTED",
            mediaRecorder,
            mimeType,
            startedAtMs,
            startedAtPerf: startedAtPerfMs,
          });
          syncRecorderPause(mediaRecorder, paused);
        }
      };

      mediaRecorder.onerror = (event: Event) => {
        if (disposed || stopRequested) return;
        sendBack({
          type: "AUDIO_RECORDING_ERROR",
          error: recorderErrorMessage(event, "Audio recording error"),
        });
      };

      mediaRecorder.start(RECORDER_TIMESLICE_MS);
    } catch (error) {
      cleanupStream();
      if (!disposed && !stopRequested) {
        sendBack({
          type: "AUDIO_RECORDING_ERROR",
          error: error instanceof Error ? error.message : "Failed to start recording",
        });
      }
    } finally {
      starting = false;
    }
  };

  const stopRecording = () => {
    stopRequested = true;
    stopRecorderIfActive(mediaRecorder);
  };

  receive((event) => {
    switch (event.type) {
      case "START":
        startRecording();
        break;
      case "STOP":
        stopRecording();
        break;
      case "PAUSE":
        paused = true;
        syncRecorderPause(mediaRecorder, paused);
        break;
      case "RESUME":
        paused = false;
        syncRecorderPause(mediaRecorder, paused);
        break;
    }
  });

  return () => {
    disposed = true;
    stopRequested = true;
    stopRecorderIfActive(mediaRecorder);
    cleanupStream();
  };
});

// ============================================================================
// Audio Playback Actor
// ============================================================================

/** What the element is loaded from: a URL that passed the scheme check, or the blob. */
type LoadedAudioSource = { url: string; blob?: undefined } | { url?: undefined; blob: Blob };

/**
 * The recording's audioUrl is decoded from the `.ne` header with no runtime validation,
 * so it is scheme-checked before it reaches `src`. A rejected URL falls through to the
 * blob, the same path a recording with no external audio takes.
 */
const resolveAudioSource = ({ audioUrl, blob }: AudioPlaybackSource): LoadedAudioSource | null => {
  if (isAllowedRecordingMediaUrl(audioUrl)) return { url: audioUrl };
  return blob ? { blob } : null;
};

/**
 * Audio playback actor — plays recording audio through a native HTMLAudioElement, synchronized to the
 * editor timeline. By bypassing Web Audio API decoding, startup is instant.
 * Pitch is preserved across playback-rate changes (native time-stretching).
 *
 * Sync model: the machine's timeline (rAF wall clock) is the master. The machine
 * reports timeline positions via SEEK (explicit) and SYNC (every ~250ms while
 * playing). Between reports the target is extrapolated at the playback rate, so
 * the re-anchor on the element's `playing` event — which fires only after
 * `play()`'s real startup latency — can seek to where the timeline actually is
 * by then, instead of freezing in the startup lag forever. PLAY restarts the
 * count where PAUSE froze it.
 *
 * Buffering: a narration that is streamed from its URL can run out of data. The actor
 * says so (AUDIO_PLAYBACK_STALLED, then AUDIO_PLAYBACK_RESUMED) and leaves the answer
 * to its parent. A replay stops its timeline and sends HOLD, so the lesson waits for
 * the sound instead of running on without it; a take ignores both and nothing changes
 * for it. How each wait is going is emitted beside that (NARRATION_LOAD), for whoever
 * draws it: the parent hears nothing of it.
 *
 * Warming up: a streamed narration loads nothing until PLAY, unless the player is asked
 * to warm up (WARM). Then the start of it loads ahead, so that Play has sound at once,
 * and how that goes is emitted the same way. A warm-up holds nothing and reloads
 * nothing: one that fails is left for the first PLAY, which has every reload to spend.
 */
export const audioPlaybackActor = fromTypedCallback<
  AudioPlaybackEvent,
  AudioPlaybackInput,
  AudioPlaybackEmit,
  NarrationLoadEmitted
>(({ sendBack, receive, emit, input }) => {
  let disposed = false;
  const startOffsetMs = normalizeNonNegativeTime(input.startOffsetMs ?? 0);
  let requestedPlay = false;
  // The narration has been asked to play at least once: from then on it loads as it plays.
  let playedOnce = false;
  // The parent stopped its timeline to wait for the narration (HOLD), until the next PLAY.
  let held = false;
  // Warming up (WARM): asked for, and running, which is loading with nobody waiting.
  let warmRequested = false;
  let warming = false;
  // The warm-up's own load has begun (`loadstart`): what the element says from here on
  // is about that load, not about the one it had put off before.
  let warmLoadStarted = false;
  // Timeline position last reported by the machine, and when it was reported.
  let lastKnownTimelineMs = normalizeNonNegativeTime(input.startPositionMs);
  let lastKnownAtPerf = performance.now();

  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preservesPitch = true;

  let loadedSource: LoadedAudioSource | null = null;
  let currentObjectUrl: string | null = null;
  // A web URL the element downloads as it plays. A blob, or a `blob:` URL, is already here.
  let streamed = false;
  // Reloads of a streamed narration after its element failed: the one waiting to run,
  // and how many ran since sound last flowed.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failedLoads = 0;

  const releaseObjectUrl = () => {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  };

  const cancelRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const loadSource = (source: LoadedAudioSource) => {
    cancelRetry();
    failedLoads = 0;
    releaseObjectUrl();
    loadedSource = source;
    streamed = source.url !== undefined && !/^blob:/i.test(source.url);
    // Nothing plays the narration before PLAY, and a download started by itself would
    // share the connection with the code editor's chunk. A warm-up (WARM, which the app
    // sends once that chunk is in) or PLAY lifts this.
    if (streamed && !requestedPlay) audio.preload = "none";
    if (source.url !== undefined) {
      audio.src = source.url;
    } else {
      currentObjectUrl = URL.createObjectURL(source.blob);
      audio.src = currentObjectUrl;
    }
  };

  const initialSource = resolveAudioSource(input);
  if (initialSource) loadSource(initialSource);

  audio.volume = normalizePlaybackVolume(input.volume);
  audio.playbackRate = normalizePlaybackSpeed(input.playbackRate);

  const setKnownTimelineTime = (timeMs: number) => {
    lastKnownTimelineMs = normalizeNonNegativeTime(timeMs, lastKnownTimelineMs);
    lastKnownAtPerf = performance.now();
  };

  /** Where the machine's timeline is right now, extrapolated while it runs. */
  const currentTargetMs = () => {
    const elapsed =
      requestedPlay && !held ? (performance.now() - lastKnownAtPerf) * audio.playbackRate : 0;
    return lastKnownTimelineMs + elapsed;
  };

  const targetSeconds = () => Math.max(0, currentTargetMs() - startOffsetMs) / 1000;

  const applyTargetTime = (driftThresholdMs: number) => {
    const targetSec = targetSeconds();
    if (Math.abs(audio.currentTime - targetSec) > driftThresholdMs / 1000) {
      audio.currentTime = targetSec;
    }
  };

  // Seek immediately on spawn if needed
  applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);

  // Whether the narration was asked to play and cannot: its next stretch has not
  // arrived, or the element failed and is waiting to be loaded again. An element that is
  // paused (a blocked play()), has ended, or failed for good is not waiting for anything.
  const isStarved = () => {
    if (!requestedPlay) return false;
    if (retryTimer !== null) return true;
    return !audio.paused && !audio.ended && !audio.error && audio.readyState < HAVE_FUTURE_DATA;
  };

  /** Seconds of sound loaded from the playhead on: the range it is in, or one just ahead. */
  const bufferedAheadSeconds = () => {
    const { buffered, currentTime } = audio;
    for (let index = 0; index < buffered.length; index++) {
      const end = buffered.end(index);
      if (
        buffered.start(index) <= currentTime + BUFFERED_RANGE_SLACK_SECONDS &&
        end > currentTime
      ) {
        return end - currentTime;
      }
    }
    return 0;
  };

  // `progress` events the element has raised in the warm-up or wait that is running.
  let dataArrivals = 0;
  // PLAY came while a warm-up ran: the wait that follows is the same download.
  let warmUpBecomesWait = false;
  const emitNarrationLoad = (stage: NarrationLoadFacts["stage"]) => {
    emit({
      type: "NARRATION_LOAD",
      stage,
      readyState: audio.readyState,
      bufferedAheadSeconds: bufferedAheadSeconds(),
      dataArrivals,
    });
  };

  // Whether the sound the lesson waited for is playing. A wait also ends when there is
  // nothing left to wait for: an element that failed for good, was refused, or has ended.
  const isSoundFlowing = () =>
    !audio.paused && !audio.ended && !audio.error && audio.readyState >= HAVE_FUTURE_DATA;

  let reportedStarved = false;
  const reportStarvation = () => {
    if (disposed) return;
    const starved = isStarved();
    if (starved === reportedStarved) return;
    reportedStarved = starved;
    if (starved && !warmUpBecomesWait) dataArrivals = 0;
    // The facts first: whoever draws the wait knows how it ended before the hold does.
    emitNarrationLoad(starved ? "loading" : isSoundFlowing() ? "flowing" : "abandoned");
    sendBack({ type: starved ? "AUDIO_PLAYBACK_STALLED" : "AUDIO_PLAYBACK_RESUMED" });
  };

  // Each step the element takes toward sound while the lesson waits for it, or while
  // it is warmed up.
  const reportLoadStep = () => {
    if (disposed) return;
    if (reportedStarved) emitNarrationLoad("loading");
    else if (warming) emitNarrationLoad("warming");
  };
  audio.onloadedmetadata = reportLoadStep;
  audio.onloadeddata = reportLoadStep;
  audio.onprogress = () => {
    if (reportedStarved || warming) dataArrivals++;
    reportLoadStep();
  };

  // The warm-up has got as far as it will before PLAY: the narration can play from
  // here, or the browser has stopped loading on its own account (a phone loads nothing
  // it was not asked to play), or the load failed.
  const settleWarmUp = () => {
    if (disposed || !warming) return;
    warming = false;
    emitNarrationLoad("warmed");
  };
  audio.onloadstart = () => {
    if (warming) warmLoadStarted = true;
  };
  // A browser also says `suspend` when it puts a load off until it is asked for, which
  // is how every streamed narration starts out: only the warm-up's own load counts.
  audio.onsuspend = () => {
    if (warmLoadStarted) settleWarmUp();
  };

  audio.onwaiting = reportStarvation;
  audio.onpause = reportStarvation;
  // A second sign that sound is flowing, for a browser that skips `playing` after a stall.
  audio.ontimeupdate = reportStarvation;

  audio.onplaying = () => {
    if (disposed) return;
    // Sound is actually flowing now — `play()` resolved some tens/hundreds of ms
    // after the timeline started, and the audio began from the pre-latency seek
    // position. Re-anchor to the extrapolated timeline so that startup lag does
    // not persist below the SYNC dead zone for the rest of playback. The seek
    // this triggers refires `playing`, but the residual drift is then just the
    // seek latency, which lands inside the epsilon and terminates the cycle.
    // A held timeline did not move meanwhile, so there is nothing to catch up with.
    applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
    failedLoads = 0;
    reportStarvation();
  };

  // MediaRecorder WebM, our own exported `.weba` narration included, reports
  // duration = Infinity at loadedmetadata and canplay (crbug 642012). Chrome
  // fires durationchange with the real length once the demuxer reaches the end.
  // An unknown length used to go out as 0, which finalized the take at 1ms, and
  // canplay refires after every stall or seek. Report only known, changed values.
  let lastReportedDurationMs = -1;
  const reportDuration = () => {
    if (disposed) return;
    const seconds = audio.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const durationMs = seconds * 1000;
    if (durationMs === lastReportedDurationMs) return;
    lastReportedDurationMs = durationMs;
    sendBack({ type: "AUDIO_PLAYBACK_READY", durationMs });
  };
  audio.oncanplay = () => {
    reportDuration();
    reportStarvation();
    settleWarmUp();
  };
  audio.ondurationchange = reportDuration;

  audio.onended = () => {
    if (disposed) return;
    sendBack({ type: "AUDIO_PLAYBACK_FINISHED" });
    reportStarvation();
  };

  // An autoplay block rejects `play()` without raising a media error, so `onerror` never
  // sees it. Swallowing it let a selected-file take record against silent narration that
  // never ends. Report it once: SYNC keeps retrying `play()` while playback is requested.
  // AbortError (a pause() or src change interrupting play) is routine and stays ignored.
  let blockedReported = false;
  const playAudio = () => {
    // From here on the element may load ahead of the playhead, through pauses too.
    if (streamed) audio.preload = "auto";
    audio.play().catch((error: unknown) => {
      if (disposed) return;
      // A refused play() leaves the element paused: it is not waiting for data.
      reportStarvation();
      if (blockedReported) return;
      if ((error as { name?: unknown } | null)?.name !== "NotAllowedError") return;
      blockedReported = true;
      sendBack({
        type: "AUDIO_PLAYBACK_ERROR",
        error: "Audio playback was blocked by the browser's autoplay policy",
      });
    });
  };

  /** Loads the same source again from the start and puts it back where the timeline is. */
  const reloadSource = () => {
    audio.load();
    audio.currentTime = targetSeconds();
    // Not once the audio has ended: see PLAY.
    if (requestedPlay && !audio.ended) playAudio();
  };

  /**
   * Loads the start of the narration with nobody waiting for it. One in memory has
   * nothing to fetch and plays as soon as it is asked to.
   */
  const beginWarmUp = () => {
    if (!streamed) {
      warming = false;
      emitNarrationLoad("warmed");
      return;
    }
    warming = true;
    warmLoadStarted = false;
    dataArrivals = 0;
    // Start the load over, then lift `preload`, which the element reads when the load
    // begins. In that order nothing is fetched twice (lifting it first starts the load
    // that was put off, and starting over then drops it), and what the put-off load had
    // still to say (its `suspend`) is dropped with it.
    reloadSource();
    audio.preload = WARM_UP_PRELOAD;
    emitNarrationLoad("warming");
  };

  audio.onerror = () => {
    if (disposed) return;
    // Only warmed up so far: nobody waits for it, so it is not loaded again now. The
    // first PLAY does that, with every reload still to spend.
    if (streamed && !playedOnce) {
      settleWarmUp();
      return;
    }
    const retryDelayMs = streamed ? AUDIO_SOURCE_RETRY_DELAYS_MS[failedLoads] : undefined;
    if (retryDelayMs === undefined) {
      sendBack({ type: "AUDIO_PLAYBACK_ERROR", error: "Audio playback error" });
      reportStarvation();
      return;
    }
    failedLoads++;
    cancelRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      reloadSource();
      reportStarvation();
    }, retryDelayMs);
    reportStarvation();
  };

  receive((event) => {
    if (disposed) return;

    switch (event.type) {
      case "PLAY": {
        // Restart the count from now. A resume can come without a SEEK (a selected-file
        // take's RESUME_RECORDING sends only PLAY, and so does the end of a HOLD), and the
        // time spent paused or held must not be extrapolated.
        setKnownTimelineTime(currentTargetMs());
        const startsPlayback = !requestedPlay;
        requestedPlay = true;
        playedOnce = true;
        held = false;
        // A warm-up still running becomes the wait itself: the same download, waited for.
        warmUpBecomesWait = warming;
        warming = false;
        // A narration that was given up on gets another try when the viewer plays again:
        // one load, not the whole series (`failedLoads` stays spent until sound flows), so
        // a narration that can never be loaded costs each Play one failed request and no
        // more. Only a PLAY that starts playback asks for it. The one that ends a hold
        // does not (giving up is what ended it), nor does a repeated one (a recording
        // still streaming in sends a PLAY with every chunk): either would hold the lesson
        // again and again, for as long as the narration cannot be loaded.
        if (startsPlayback && streamed && audio.error && retryTimer === null) audio.load();
        // Exact re-align at (re)start: a pause can leave the element a few
        // hundred ms off the timeline, and letting that ride under the SYNC
        // dead zone would accumulate more lag with every play/pause cycle.
        applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
        // Per the HTML spec, play() on an ended element seeks to 0 first. The audio can end
        // just before the timeline does (it runs slightly ahead, or is slightly shorter), and
        // a resume then would replay the lesson's opening. Any real reposition (a backward
        // SEEK, or a seek above the dead zone) clears `ended` synchronously, and a play()
        // the autoplay policy blocked leaves it false, so those resumes still happen.
        if (!audio.ended) playAudio();
        reportStarvation();
        // Overtaken with sound already there: the warm-up is over without a wait.
        if (warmUpBecomesWait && !reportedStarved) emitNarrationLoad("warmed");
        warmUpBecomesWait = false;
        break;
      }
      case "WARM":
        if (warmRequested) break;
        warmRequested = true;
        if (!playedOnce) beginWarmUp();
        break;
      case "PAUSE":
        // Freeze extrapolation at the current target before clearing the flag.
        setKnownTimelineTime(currentTargetMs());
        requestedPlay = false;
        held = false;
        // Nothing waits for a paused narration; the next PLAY reports afresh.
        reportedStarved = false;
        audio.pause();
        break;
      case "HOLD":
        // Freeze at this player's own count of the timeline, as PAUSE does. The parent's
        // copy of the time is as old as its last TICK, and a hidden tab draws no frames
        // and so sends none: a hold from that copy wound the narration back to the moment
        // the tab was hidden. The timeline reports where it stopped, and SYNC brings it.
        setKnownTimelineTime(currentTargetMs());
        held = true;
        // The element is waiting for data anyway, so this is the moment to line it up
        // exactly: the PLAY that ends the hold then has nothing left to seek.
        applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
        break;
      case "SEEK":
        // Explicit repositioning is exact — even a sub-500ms nudge must move the audio.
        setKnownTimelineTime(event.timeMs);
        applyTargetTime(AUDIO_EXACT_SYNC_EPSILON_MS);
        break;
      case "SYNC":
        setKnownTimelineTime(event.timeMs);
        applyTargetTime(AUDIO_SYNC_DRIFT_THRESHOLD_MS);
        // Not once the audio has ended: see PLAY.
        if (requestedPlay && audio.paused && !audio.ended) {
          playAudio();
        }
        break;
      case "SET_VOLUME":
        audio.volume = normalizePlaybackVolume(event.volume, audio.volume);
        break;
      case "SET_PLAYBACK_RATE":
        // Re-anchor with the old rate first so the elapsed-time extrapolation
        // never applies the new rate to the interval before the change.
        setKnownTimelineTime(currentTargetMs());
        audio.playbackRate = normalizePlaybackSpeed(event.rate, audio.playbackRate);
        break;
      case "SET_SOURCE": {
        const source = resolveAudioSource(event);
        if (!source || (source.url === loadedSource?.url && source.blob === loadedSource?.blob)) {
          break;
        }
        // A new `src` starts the element over: put it back where the timeline is.
        loadSource(source);
        audio.currentTime = targetSeconds();
        // A narration that was to be warmed up is warmed up from where it is now.
        if (warmRequested && !playedOnce) beginWarmUp();
        // Not once the audio has ended: see PLAY.
        if (requestedPlay && !audio.ended) playAudio();
        reportStarvation();
        break;
      }
    }
  });

  return () => {
    disposed = true;
    cancelRetry();
    audio.pause();
    // Removing `src` alone leaves the element downloading: only load() ends its fetch.
    // A streamed narration left running would share a slow connection with the next
    // lesson's files, and with its narration.
    audio.removeAttribute("src");
    audio.load();
    releaseObjectUrl();
  };
});

/**
 * Asks a lesson's narration player to load the start of its narration before anyone
 * plays it, so that Play has sound at once. The caller decides when (the editor is on
 * screen, the viewer has not asked to save data); the player decides what there is to
 * load, never spends its reloads on it, and reports it as NARRATION_LOAD facts
 * (`warming`, then `warmed`).
 */
export function warmNarration(player: ActorRefFrom<typeof audioPlaybackActor>): void {
  if (player.getSnapshot().status === "active") player.send({ type: "WARM" });
}
