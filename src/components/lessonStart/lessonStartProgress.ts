import type { NarrationLoadFacts } from "../../core/src/machine/audioActor";

// ============================================================================
// What the border round the play triangle shows, and when.
//
// One wait is one trace: the border is drawn from the triangle's tip, round it, back
// to the tip. It closes only when what it waited for is true (the lesson is loaded,
// the narration has sound), and it never runs backward on the way.
// ============================================================================

/** `HTMLMediaElement.readyState` steps a narration passes on its way to sound. */
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;

/**
 * How far the narration's element has got: nothing, its length known (metadata), or
 * sound at the playhead that it cannot yet play on from.
 */
export type NarrationLevel = 0 | 1 | 2;

/**
 * Where a wait stands once the element knows the file's length, once it has sound at
 * the playhead, and once it has buffered enough ahead, by how far the element had got
 * when the wait began.
 *
 * A wait that starts from nothing is nearly all spent before the first of these: the
 * browser reads the file's header and its end to learn the length, and the first sound
 * comes with them. A hold mid-lesson already knows the length and waits for sound at
 * a new place; one that has sound at the playhead waits only for what follows it.
 * Loaded sound never fills the border: only sound that plays closes it.
 */
const STEP_ENDS: Record<
  NarrationLevel,
  readonly [metadata: number, soundAtPlayhead: number, buffered: number]
> = {
  0: [0.75, 0.85, 0.95],
  1: [0, 0.8, 0.95],
  2: [0, 0, 0.9],
};

/**
 * Until a step is reached the only sign of life is data arriving. Each arrival takes
 * the border a share of what is left to the step, so it moves when the download does
 * and stops when it stalls, and stays short of the step however many arrive: the
 * arrivals say that data comes, not how much of it is needed.
 */
const ARRIVAL_SHARE = 0.2;
const ARRIVALS_REACH = 0.9;

/** Sound loaded past the playhead that counts as a full buffer. */
const BUFFERED_SECONDS = 1;

/**
 * The lesson file's share of a trace that goes on into the narration: one that is
 * loaded ahead of Play, or that autoplay plays. The file is small and the narration is
 * what a slow connection waits for.
 */
export const LESSON_SHARE = 0.3;

/**
 * How far the border may drift toward its next real step while it waits for it, so a
 * slow connection does not look stuck. It never reaches the step: that takes the step.
 */
const DRIFT_REACH = 0.9;

export interface StartIndicatorState {
  /**
   * `lesson`: a lesson is being fetched and readied. `warming`: it has loaded and can be
   * played, and the start of its narration is still loading ahead of Play. `ready`: it
   * waits at its start for Play, with nothing more to load first. `starting`: Play was
   * given and the narration is on its way. `holding`: the lesson is held for its
   * narration somewhere past its start. `hidden`: none of these.
   */
  mode: "hidden" | "lesson" | "warming" | "ready" | "starting" | "holding";
  /** Counts the traces: a new number is a new border, drawn from its start point again. */
  trace: number;
  /** How much of the border is traced, 0 to 1. It never falls within one trace. */
  value: number;
  /** Where the border may drift to while it waits; `value` when it waits for nothing. */
  drift: number;
  /** The big play button, or the small mark of a hold. Kept while it fades out. */
  shape: "button" | "mark";
  /** The triangle is filled: the lesson is ready to play. Kept while it fades out. */
  solid: boolean;
  /** Where the narration's part of this trace begins: 0, or after the lesson's share. */
  narrationFrom: number;
  /** How far the narration's element had got when its wait began. */
  narrationStart: NarrationLevel;
}

export interface StartIndicatorInputs {
  /** A lesson is being fetched or readied for playback. */
  lessonLoading: boolean;
  /** Autoplay may still start this lesson by itself once it has loaded. */
  autoplayPending: boolean;
  /**
   * The start of the narration is loaded ahead of Play: it is loading now, or it will
   * once the lesson that is being fetched has loaded.
   */
  warmingUp: boolean;
  /** A lesson is loaded and waits at its start for Play. */
  idleAtStart: boolean;
  /** The lesson plays, but is held until its narration has sound. */
  held: boolean;
  /** The narration player's latest word on the wait, if it has said anything. */
  narration: NarrationLoadFacts | null;
}

export const INITIAL_START_INDICATOR: StartIndicatorState = {
  mode: "hidden",
  trace: 0,
  value: 0,
  drift: 0,
  shape: "button",
  solid: false,
  narrationFrom: 0,
  narrationStart: 0,
};

const levelOf = (facts: NarrationLoadFacts | null): NarrationLevel => {
  if (!facts || facts.readyState < HAVE_METADATA) return 0;
  return facts.readyState < HAVE_CURRENT_DATA ? 1 : 2;
};

/**
 * How far a wait for the narration has got, 0 to 1, for a wait that began at `start`.
 * It is 1 only once sound plays.
 */
export function narrationProgress(
  facts: NarrationLoadFacts | null,
  start: NarrationLevel = 0,
): number {
  if (!facts) return 0;
  if (facts.stage === "flowing") return 1;
  const [metadata, soundAtPlayhead, buffered] = STEP_ENDS[start];
  const level = levelOf(facts);
  const arrived = ARRIVALS_REACH * (1 - (1 - ARRIVAL_SHARE) ** Math.max(facts.dataArrivals, 0));
  if (level === 2) {
    // Sound is loading: what has loaded past the playhead counts, and so does each
    // arrival of data, which is how the element says more of it has come.
    const filled = Math.min(Math.max(facts.bufferedAheadSeconds, 0) / BUFFERED_SECONDS, 1);
    return soundAtPlayhead + (buffered - soundAtPlayhead) * Math.max(filled, arrived);
  }
  const from = level === 0 ? 0 : metadata;
  const to = level === 0 ? metadata : soundAtPlayhead;
  return from + (to - from) * arrived;
}

/**
 * Where a narration wait may drift to: most of the way to what one more arrival of
 * data would bring. Every sign of life the element gives is such an arrival or a step
 * past it, so the next real value is never short of where the drift was heading.
 */
function narrationDrift(facts: NarrationLoadFacts | null, start: NarrationLevel): number {
  const now = narrationProgress(facts, start);
  if (facts?.stage === "flowing") return now;
  const next = narrationProgress(
    {
      stage: "loading",
      readyState: facts?.readyState ?? 0,
      bufferedAheadSeconds: facts?.bufferedAheadSeconds ?? 0,
      dataArrivals: (facts?.dataArrivals ?? 0) + 1,
    },
    start,
  );
  return now + (next - now) * DRIFT_REACH;
}

/**
 * Draws the narration's progress in its own part of the trace. Neither the value nor
 * the drift ever falls: a seek or a reload that takes the element a step back never
 * unwinds the border. A step the drift has already been heading past is not drawn
 * either, since the border may stand beyond it and would run back to it: it goes on
 * drifting until a step takes it further.
 */
function traceNarration(
  state: StartIndicatorState,
  facts: NarrationLoadFacts | null,
): StartIndicatorState {
  const place = (progress: number) => state.narrationFrom + (1 - state.narrationFrom) * progress;
  const reached = place(narrationProgress(facts, state.narrationStart));
  const value = reached > state.drift ? reached : state.value;
  const drift = Math.max(state.drift, value, place(narrationDrift(facts, state.narrationStart)));
  return { ...state, value, drift };
}

function nextStartIndicator(
  prev: StartIndicatorState,
  inputs: StartIndicatorInputs,
): StartIndicatorState {
  if (inputs.lessonLoading) {
    const span = inputs.autoplayPending || inputs.warmingUp ? LESSON_SHARE : 1;
    // A load that follows one already shown as loaded (a retry, the next lesson) starts over.
    const continues = prev.mode === "lesson" && prev.value === 0;
    return {
      mode: "lesson",
      trace: continues ? prev.trace : prev.trace + 1,
      value: 0,
      drift: span * DRIFT_REACH,
      shape: "button",
      solid: false,
      narrationFrom: span < 1 ? span : 0,
      narrationStart: 0,
    };
  }

  if (inputs.idleAtStart) {
    // Loaded, and the start of its narration loads ahead of Play: the same trace goes
    // on into it, on a triangle that can already be pressed.
    if (inputs.warmingUp && prev.mode === "warming") {
      return traceNarration(prev, inputs.narration);
    }
    if (inputs.warmingUp && prev.mode === "lesson" && prev.narrationFrom > 0) {
      return traceNarration(
        {
          ...prev,
          mode: "warming",
          value: prev.narrationFrom,
          drift: prev.narrationFrom,
          narrationStart: levelOf(inputs.narration),
        },
        inputs.narration,
      );
    }
    // Loaded, and autoplay is about to take it on: its share is done, the trace is not.
    if (inputs.autoplayPending && prev.mode === "lesson" && prev.narrationFrom > 0) {
      return { ...prev, value: prev.narrationFrom, drift: prev.narrationFrom };
    }
    const opening = prev.mode === "lesson" || prev.mode === "warming";
    return {
      mode: "ready",
      // The lesson's own trace closes into the filled triangle; any other way here
      // (a pause, a seek back to the start) shows it filled at once.
      trace: opening || prev.mode === "ready" ? prev.trace : prev.trace + 1,
      value: 1,
      drift: 1,
      shape: "button",
      solid: true,
      narrationFrom: 0,
      narrationStart: 0,
    };
  }

  if (inputs.held) {
    const { narration } = inputs;
    if (prev.mode === "starting" || prev.mode === "holding") {
      return traceNarration(prev, narration);
    }
    // Play came while the narration was still loading ahead: the same download, and
    // the same trace, now waited for.
    if (prev.mode === "warming") {
      return traceNarration({ ...prev, mode: "starting" }, narration);
    }
    // Autoplay took the loaded lesson on: the same trace goes on into the narration.
    if (prev.mode === "lesson" && prev.narrationFrom > 0) {
      return traceNarration(
        {
          ...prev,
          mode: "starting",
          value: prev.narrationFrom,
          drift: prev.narrationFrom,
          narrationStart: levelOf(narration),
        },
        narration,
      );
    }
    // A wait of its own. One that follows the play button is drawn on it; one that comes
    // mid-lesson (a slow connection, a seek) is the small mark.
    const fromButton = prev.mode === "ready" || prev.mode === "lesson";
    return traceNarration(
      {
        mode: fromButton ? "starting" : "holding",
        trace: prev.trace + 1,
        value: 0,
        drift: 0,
        shape: fromButton ? "button" : "mark",
        solid: false,
        narrationFrom: 0,
        narrationStart: levelOf(narration),
      },
      narration,
    );
  }

  // Nothing to wait for. A wait that ended with sound closes its border as it fades;
  // one that ended without it (a pause, a narration given up on) fades as it stands.
  const waited = prev.mode === "starting" || prev.mode === "holding";
  // The loaded lesson was taken on (autoplay, or Play while its narration loaded ahead)
  // and nothing held it: it has no narration, or its sound was there at once. The
  // lesson plays, so its border closes too.
  const tookOn =
    prev.mode === "warming" ||
    (prev.mode === "lesson" && prev.narrationFrom > 0 && prev.value === prev.narrationFrom);
  const closes = tookOn || (waited && inputs.narration?.stage === "flowing");
  return {
    mode: "hidden",
    trace: prev.trace,
    value: closes ? 1 : prev.value,
    // Not back to the value: a border that had drifted on would run back as it fades.
    drift: closes ? 1 : prev.drift,
    shape: prev.shape,
    solid: prev.solid,
    narrationFrom: 0,
    narrationStart: 0,
  };
}

const sameState = (a: StartIndicatorState, b: StartIndicatorState) =>
  a.mode === b.mode &&
  a.trace === b.trace &&
  a.value === b.value &&
  a.drift === b.drift &&
  a.shape === b.shape &&
  a.solid === b.solid &&
  a.narrationFrom === b.narrationFrom &&
  a.narrationStart === b.narrationStart;

/**
 * The indicator's next state. Returns `prev` itself when nothing changed, so a caller
 * can store the result whenever it is a new object.
 */
export function advanceStartIndicator(
  prev: StartIndicatorState,
  inputs: StartIndicatorInputs,
): StartIndicatorState {
  const next = nextStartIndicator(prev, inputs);
  return sameState(prev, next) ? prev : next;
}
