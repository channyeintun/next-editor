import { describe, expect, it } from "vite-plus/test";
import type { NarrationLoadFacts } from "../../core/src/machine/audioActor";
import {
  advanceStartIndicator,
  INITIAL_START_INDICATOR,
  LESSON_SHARE,
  narrationProgress,
  type StartIndicatorInputs,
  type StartIndicatorState,
} from "./lessonStartProgress";

const NOTHING: StartIndicatorInputs = {
  lessonLoading: false,
  autoplayPending: false,
  warmingUp: false,
  idleAtStart: false,
  playing: false,
  held: false,
  narration: null,
};

const loading = (
  readyState: number,
  bufferedAheadSeconds = 0,
  dataArrivals = 0,
): NarrationLoadFacts => ({ stage: "loading", readyState, bufferedAheadSeconds, dataArrivals });
const FLOWING: NarrationLoadFacts = {
  stage: "flowing",
  readyState: 4,
  bufferedAheadSeconds: 3,
  dataArrivals: 6,
};
const warming = (
  readyState: number,
  bufferedAheadSeconds = 0,
  dataArrivals = 0,
): NarrationLoadFacts => ({ stage: "warming", readyState, bufferedAheadSeconds, dataArrivals });
const WARMED: NarrationLoadFacts = {
  stage: "warmed",
  readyState: 4,
  bufferedAheadSeconds: 8,
  dataArrivals: 4,
};
const ABANDONED: NarrationLoadFacts = {
  stage: "abandoned",
  readyState: 0,
  bufferedAheadSeconds: 0,
  dataArrivals: 0,
};

/** Runs the indicator through a lesson's moments, each given as what differs from "nothing". */
const run = (
  steps: Array<Partial<StartIndicatorInputs>>,
  from: StartIndicatorState = INITIAL_START_INDICATOR,
) => {
  const states: StartIndicatorState[] = [];
  let state = from;
  for (const step of steps) {
    state = advanceStartIndicator(state, { ...NOTHING, ...step });
    states.push(state);
  }
  return states;
};

describe("narrationProgress", () => {
  it("counts each real step the element takes toward sound", () => {
    expect(narrationProgress(null)).toBe(0);
    expect(narrationProgress(loading(0))).toBe(0);
    expect(narrationProgress(loading(1))).toBe(0.75);
    expect(narrationProgress(loading(2))).toBe(0.85);
    expect(narrationProgress(loading(2, 0.5))).toBeCloseTo(0.9);
  });

  it("moves with each arrival of data before a step, and stays short of the step", () => {
    const arrivals = [0, 1, 2, 5, 20, 500].map((count) => narrationProgress(loading(0, 0, count)));

    expect(arrivals[0]).toBe(0);
    for (let index = 1; index < arrivals.length; index++) {
      expect(arrivals[index]).toBeGreaterThan(arrivals[index - 1]!);
    }
    // However much arrives, knowing the file's length takes the element saying so.
    expect(arrivals.at(-1)).toBeLessThan(0.75);
    expect(narrationProgress(loading(1, 0, 500))).toBeLessThan(0.85);
  });

  it("is short of the end however much has loaded, until sound plays", () => {
    expect(narrationProgress(loading(4, 600, 900))).toBe(0.95);
    expect(narrationProgress(FLOWING)).toBe(1);
    expect(narrationProgress(ABANDONED)).toBe(0);
  });

  it("counts a wait from what was still missing when it began", () => {
    // A hold mid-lesson: the length is known, the sound at the new place is not.
    expect(narrationProgress(loading(1), 1)).toBe(0);
    expect(narrationProgress(loading(1, 0, 3), 1)).toBeGreaterThan(0);
    expect(narrationProgress(loading(2), 1)).toBe(0.8);
    // The download fell behind the playhead: only what follows it is missing.
    expect(narrationProgress(loading(2), 2)).toBe(0);
    expect(narrationProgress(loading(2, 1), 2)).toBe(0.9);
    for (const start of [0, 1, 2] as const) {
      expect(narrationProgress(FLOWING, start)).toBe(1);
    }
  });
});

describe("advanceStartIndicator", () => {
  it("traces the lesson's file and closes into the play button once it has loaded", () => {
    const [fetching, stillFetching, loaded] = run([
      { lessonLoading: true },
      { lessonLoading: true },
      { idleAtStart: true },
    ]);

    expect(fetching).toMatchObject({ mode: "lesson", value: 0, solid: false, shape: "button" });
    // It drifts toward the end while it waits, and never gets there by itself.
    expect(fetching!.drift).toBeGreaterThan(0);
    expect(fetching!.drift).toBeLessThan(1);
    expect(stillFetching).toBe(fetching);

    // The same trace closes: the border is not drawn again for the button.
    expect(loaded).toMatchObject({ mode: "ready", value: 1, drift: 1, solid: true });
    expect(loaded!.trace).toBe(fetching!.trace);
  });

  it("starts a border of its own for each load", () => {
    const [first, , second] = run([
      { lessonLoading: true },
      { idleAtStart: true },
      { lessonLoading: true },
    ]);

    expect(second).toMatchObject({ mode: "lesson", value: 0, solid: false });
    expect(second!.trace).toBe(first!.trace + 1);
  });

  it("answers Play on the play button with a border for the narration", () => {
    const [, , pressed, arriving, metadata, sound, buffered] = run([
      { lessonLoading: true },
      { idleAtStart: true },
      { held: true, narration: loading(0) },
      { held: true, narration: loading(0, 0, 3) },
      { held: true, narration: loading(1, 0, 3) },
      { held: true, narration: loading(2, 0, 3) },
      { held: true, narration: loading(2, 1, 4) },
    ]);

    // A new border, from the start point, on the button that was pressed.
    expect(pressed).toMatchObject({ mode: "starting", value: 0, solid: false, shape: "button" });
    expect(pressed!.drift).toBeGreaterThan(0);
    expect(arriving!.value).toBeGreaterThan(0);
    expect(arriving!.value).toBeLessThan(0.75);
    expect(metadata!.value).toBeGreaterThanOrEqual(0.75);
    expect(sound!.value).toBeGreaterThanOrEqual(0.85);
    expect(sound!.value).toBeLessThan(0.95);
    expect(buffered!.value).toBe(0.95);
    for (const state of [pressed, arriving, metadata, sound, buffered]) {
      expect(state!.trace).toBe(pressed!.trace);
      // Loaded sound is not played sound: the border stays open.
      expect(state!.value).toBeLessThan(1);
      expect(state!.drift).toBeGreaterThanOrEqual(state!.value);
      expect(state!.drift).toBeLessThan(1);
    }
  });

  it("closes the border when the sound it waited for plays", () => {
    const states = run([
      { idleAtStart: true },
      { held: true, narration: loading(0) },
      { narration: FLOWING },
    ]);

    expect(states.at(-1)).toMatchObject({ mode: "hidden", value: 1, shape: "button" });
  });

  it("leaves the border open when the wait ends without sound", () => {
    const pressed = run([
      { idleAtStart: true },
      { held: true, narration: loading(0) },
      { held: true, narration: loading(1) },
    ]).at(-1)!;

    // The narration could not be loaded, and the lesson plays on without it.
    const [givenUp] = run([{ narration: ABANDONED }], pressed);
    expect(givenUp).toMatchObject({ mode: "hidden", value: 0.75 });

    // The viewer paused instead of waiting: back to the play button, filled.
    const [paused] = run([{ idleAtStart: true, narration: loading(1) }], pressed);
    expect(paused).toMatchObject({ mode: "ready", value: 1, solid: true });
    expect(paused!.trace).toBe(pressed.trace + 1);
  });

  it("never runs the border backward when the element steps back", () => {
    const states = run([
      { idleAtStart: true },
      { held: true, narration: loading(0) },
      { held: true, narration: loading(2, 0.6) },
      // A reload after a failed download starts the element over.
      { held: true, narration: loading(0) },
      { held: true, narration: loading(1) },
    ]);

    const [, , ahead, reloading, again] = states;
    expect(ahead!.value).toBeCloseTo(0.91);
    expect(reloading!.value).toBe(ahead!.value);
    expect(again!.value).toBe(ahead!.value);
    expect(again!.trace).toBe(ahead!.trace);
  });

  describe("with the narration loaded ahead of Play", () => {
    it("carries one border from the lesson's file through the narration into the play button", () => {
      const [fetching, loaded, arriving, metadata, ready] = run([
        { lessonLoading: true, warmingUp: true },
        // Loaded, and the narration's player has not said anything yet.
        { idleAtStart: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 3) },
        { idleAtStart: true, warmingUp: true, narration: warming(1, 0, 3) },
        { idleAtStart: true, narration: WARMED },
      ]);

      // The file has the first part of the border, and stops where its part ends.
      expect(fetching!.drift).toBeLessThan(LESSON_SHARE);
      expect(loaded).toMatchObject({ mode: "warming", value: LESSON_SHARE, solid: false });
      expect(arriving!.value).toBeGreaterThan(LESSON_SHARE);
      expect(metadata!.value).toBeGreaterThanOrEqual(LESSON_SHARE + (1 - LESSON_SHARE) * 0.75);
      // However much has loaded, it is the player's word that closes the border.
      expect(metadata!.value).toBeLessThan(1);
      expect(ready).toMatchObject({ mode: "ready", value: 1, solid: true });
      for (const state of [loaded, arriving, metadata, ready]) {
        expect(state!.trace).toBe(fetching!.trace);
        expect(state!.shape).toBe("button");
      }
    });

    it("goes on with the same border when Play is pressed before it has loaded", () => {
      const [fetching, , early, pressed, further, playing] = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 3) },
        // The same download, now waited for: what had arrived still counts.
        { held: true, narration: loading(0, 0, 3) },
        { held: true, narration: loading(1, 0, 4) },
        { narration: FLOWING },
      ]);

      expect(pressed).toMatchObject({ mode: "starting", value: early!.value });
      expect(pressed!.drift).toBeGreaterThanOrEqual(early!.drift);
      expect(further!.value).toBeGreaterThan(pressed!.value);
      expect(playing).toMatchObject({ mode: "hidden", value: 1 });
      for (const state of [pressed, further, playing]) {
        expect(state!.trace).toBe(fetching!.trace);
      }
    });

    it("closes the border when Play has sound though the warm-up was not done", () => {
      const states = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(2, 0.4, 5) },
        // Playing, and nothing holds it.
        { playing: true },
      ]);

      expect(states.at(-1)).toMatchObject({ mode: "hidden", value: 1, drift: 1 });
    });

    it("fades with its border open when the viewer leaves the start instead of playing", () => {
      const [, waiting, left] = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 1) },
        // Scrubbed away from the start: nothing plays, and nothing was waited for.
        { warmingUp: true, narration: warming(0, 0, 2) },
      ]);

      expect(left).toMatchObject({ mode: "hidden", value: waiting!.value, solid: false });
      expect(left!.value).toBeLessThan(1);
    });

    it("closes into the play button for a lesson with no narration to load", () => {
      const [fetching, loaded] = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true },
      ]);

      expect(loaded).toMatchObject({ mode: "ready", value: 1, solid: true });
      expect(loaded!.trace).toBe(fetching!.trace);
    });

    it("goes on showing the narration loading when the viewer leaves the start and comes back", () => {
      const [, , left, back, ready] = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 1) },
        // Scrubbed away from the start, and back, while the narration still loads.
        { warmingUp: true, narration: warming(0, 0, 2) },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 3) },
        { idleAtStart: true, narration: WARMED },
      ]);

      // Not filled: Play would still have to wait. A border of its own, for the narration.
      expect(back).toMatchObject({ mode: "warming", solid: false, shape: "button" });
      expect(back!.trace).toBe(left!.trace + 1);
      expect(back!.value).toBeGreaterThan(0);
      expect(back!.value).toBeLessThan(1);
      expect(ready).toMatchObject({ mode: "ready", value: 1, solid: true });
      expect(ready!.trace).toBe(back!.trace);
    });

    it("draws the narration loading for a lesson that was there before its loading showed", () => {
      // A lesson fetched ahead loads in a few milliseconds: the first thing drawn is a
      // lesson that can be played, whose narration has not been asked to load yet.
      const [loaded, asked, arriving, ready] = run([
        { idleAtStart: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(0) },
        { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 3) },
        { idleAtStart: true, narration: WARMED },
      ]);

      // Not the filled triangle: Play would have nothing to give yet.
      expect(loaded).toMatchObject({ mode: "warming", value: 0, solid: false, shape: "button" });
      expect(loaded!.drift).toBeGreaterThan(0);
      expect(asked!.trace).toBe(loaded!.trace);
      expect(arriving!.value).toBeGreaterThan(0);
      expect(ready).toMatchObject({ mode: "ready", value: 1, solid: true });
      expect(ready!.trace).toBe(loaded!.trace);
    });

    it("does not take the filled triangle back when a narration is warmed up again", () => {
      const [, , ready, again] = run([
        { lessonLoading: true, warmingUp: true },
        { idleAtStart: true, warmingUp: true, narration: warming(1, 0, 3) },
        { idleAtStart: true, narration: WARMED },
        // The narration was found under another name and is warmed up from there.
        { idleAtStart: true, warmingUp: true, narration: warming(0) },
      ]);

      expect(again).toBe(ready);
    });

    it("keeps to one border when autoplay takes the lesson on meanwhile", () => {
      const [fetching, loaded, started] = run([
        { lessonLoading: true, warmingUp: true, autoplayPending: true },
        { idleAtStart: true, warmingUp: true, autoplayPending: true },
        { held: true, narration: loading(0) },
      ]);

      expect(loaded).toMatchObject({ mode: "warming", value: LESSON_SHARE });
      expect(started).toMatchObject({ mode: "starting", value: LESSON_SHARE });
      expect(started!.trace).toBe(fetching!.trace);
    });
  });

  describe("with autoplay", () => {
    it("carries one border from the lesson's file on into the narration", () => {
      const [fetching, loaded, started, metadata, playing] = run([
        { lessonLoading: true, autoplayPending: true },
        { idleAtStart: true, autoplayPending: true },
        { held: true, narration: loading(0) },
        { held: true, narration: loading(1) },
        { narration: FLOWING },
      ]);

      // The file has the first part of the border, and stops where its part ends.
      expect(fetching!.drift).toBeLessThan(LESSON_SHARE);
      expect(loaded).toMatchObject({ mode: "lesson", value: LESSON_SHARE, solid: false });
      expect(started).toMatchObject({ mode: "starting", value: LESSON_SHARE });
      expect(metadata!.value).toBeCloseTo(LESSON_SHARE + (1 - LESSON_SHARE) * 0.75);
      expect(playing).toMatchObject({ mode: "hidden", value: 1 });
      for (const state of [loaded, started, metadata, playing]) {
        expect(state!.trace).toBe(fetching!.trace);
      }
    });

    it("closes the border when autoplay starts a lesson that nothing holds", () => {
      // No narration, or one whose sound was there at once: the lesson simply plays.
      const [fetching, , playing] = run([
        { lessonLoading: true, autoplayPending: true },
        { idleAtStart: true, autoplayPending: true },
        { playing: true },
      ]);

      expect(playing).toMatchObject({ mode: "hidden", value: 1, drift: 1 });
      expect(playing!.trace).toBe(fetching!.trace);
    });

    it("closes into the play button when autoplay leaves the lesson for a press", () => {
      const [fetching, , left] = run([
        { lessonLoading: true, autoplayPending: true },
        { idleAtStart: true, autoplayPending: true },
        { idleAtStart: true },
      ]);

      expect(left).toMatchObject({ mode: "ready", value: 1, solid: true });
      expect(left!.trace).toBe(fetching!.trace);
    });
  });

  describe("for a hold mid-lesson", () => {
    it("draws a small mark from the start point, whatever the element already has", () => {
      // The narration's length is known long since: the wait is for the sound alone.
      const [held, sound, playing] = run([
        { held: true, narration: loading(1) },
        { held: true, narration: loading(2, 0.5) },
        { narration: FLOWING },
      ]);

      expect(held).toMatchObject({ mode: "holding", shape: "mark", value: 0, solid: false });
      expect(sound!.value).toBeGreaterThan(0);
      expect(sound!.value).toBeLessThan(1);
      expect(playing).toMatchObject({ mode: "hidden", shape: "mark", value: 1 });
    });

    it("is a new border for each hold", () => {
      const [first, , second] = run([
        { held: true, narration: loading(1) },
        { narration: FLOWING },
        { held: true, narration: loading(1) },
      ]);

      expect(second).toMatchObject({ mode: "holding", value: 0 });
      expect(second!.trace).toBe(first!.trace + 1);
    });

    it("shows the play button filled when the viewer seeks back to the start", () => {
      const states = run([
        { held: true, narration: loading(1) },
        { narration: FLOWING },
        { idleAtStart: true },
      ]);

      expect(states.at(-1)).toMatchObject({
        mode: "ready",
        shape: "button",
        value: 1,
        solid: true,
      });
    });
  });

  describe("what is painted", () => {
    // The border drifts on from its value toward `drift` between real steps, so where
    // it stands on screen is anywhere between the two.
    it("drifts toward what one more arrival of data would bring, and no further", () => {
      const starts = [loading(0), loading(0, 0, 4), loading(1, 0, 4), loading(2, 0.2, 5)];
      for (const facts of starts) {
        const [, waiting] = run([{ idleAtStart: true }, { held: true, narration: facts }]);
        const [oneMore] = run(
          [{ held: true, narration: { ...facts, dataArrivals: facts.dataArrivals + 1 } }],
          waiting,
        );

        expect(waiting!.drift).toBeGreaterThan(waiting!.value);
        // The next sign of life lands at or past where the drift was heading.
        expect(oneMore!.value).toBeGreaterThanOrEqual(waiting!.drift);
      }
    });

    it("does not draw a step the drift has already headed past", () => {
      // The download fell behind mid-lesson: sound at the playhead, none after it.
      const [waiting, short, further] = run([
        { held: true, narration: loading(2, 0, 3) },
        // More is buffered, but less than the border may already show.
        { held: true, narration: loading(2, 0.45, 3) },
        { held: true, narration: loading(2, 0.7, 4) },
      ]);

      expect(waiting!.drift).toBeGreaterThan(waiting!.value);
      expect(short!.value).toBe(waiting!.value);
      expect(short!.drift).toBeGreaterThanOrEqual(waiting!.drift);
      expect(further!.value).toBeGreaterThan(short!.drift);
    });

    it("never lowers where the border is heading when the element steps back", () => {
      const [, , ahead, reloading] = run([
        { idleAtStart: true },
        { held: true, narration: loading(0) },
        { held: true, narration: loading(1, 0, 6) },
        // A reload after a failed download starts the element over.
        { held: true, narration: loading(0) },
      ]);

      expect(reloading!.value).toBe(ahead!.value);
      expect(reloading!.drift).toBe(ahead!.drift);
    });

    it("keeps where the border was heading while a wait without sound fades", () => {
      const [, , waiting, givenUp] = run([
        { idleAtStart: true },
        { held: true, narration: loading(0) },
        { held: true, narration: loading(0, 0, 2) },
        { narration: ABANDONED },
      ]);

      expect(givenUp).toMatchObject({ mode: "hidden", value: waiting!.value });
      expect(givenUp!.drift).toBe(waiting!.drift);
    });
  });

  it("hands back the same state while nothing changes", () => {
    const moments: Array<Partial<StartIndicatorInputs>> = [
      {},
      { lessonLoading: true },
      { lessonLoading: true, autoplayPending: true },
      { idleAtStart: true, autoplayPending: true },
      { idleAtStart: true },
      { lessonLoading: true, warmingUp: true },
      { idleAtStart: true, warmingUp: true },
      { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 2) },
      { idleAtStart: true, warmingUp: true, narration: warming(2, 0.3, 4) },
      { idleAtStart: true, narration: WARMED },
      { lessonLoading: true, warmingUp: true },
      { idleAtStart: true, warmingUp: true, narration: warming(0, 0, 2) },
      { playing: true, narration: WARMED },
      { playing: true, held: true, narration: loading(1) },
      { held: true, narration: loading(1, 0, 4) },
      { held: true, narration: loading(2, 0.3, 5) },
      { narration: FLOWING },
      { narration: ABANDONED },
    ];
    let state = INITIAL_START_INDICATOR;
    for (const moment of moments) {
      state = advanceStartIndicator(state, { ...NOTHING, ...moment });
      // A caller stores every new object, so a second pass must not make another.
      expect(advanceStartIndicator(state, { ...NOTHING, ...moment })).toBe(state);
    }
  });
});
