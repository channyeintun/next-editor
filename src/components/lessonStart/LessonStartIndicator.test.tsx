import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NarrationLoadFacts } from "../../core/src/machine/audioActor";
import LessonStartIndicator from "./LessonStartIndicator";

/** The lesson as the indicator reads it. Each test moves it on and renders again. */
const lesson = vi.hoisted(() => ({
  recordingId: null as string | null,
  isPlaying: false,
  isRecording: false,
  isBuffering: false,
  readying: false,
  atStart: true,
  narration: null as NarrationLoadFacts | null,
  /** The lesson's narration player: anything stands in for it, since both hooks are mocked. */
  hasNarrationPlayer: false,
  /** Whether the start of the narration is loaded ahead of Play (not for a viewer who saves data). */
  warmUpWanted: false,
  play: vi.fn<() => void>(),
}));

vi.mock("../../hooks/useNextEditorContext", () => ({
  useNextEditorActions: () => ({ play: lesson.play }),
  useNextEditorMetadata: (select: (metadata: unknown) => unknown) =>
    select({
      currentRecording: lesson.recordingId ? { id: lesson.recordingId } : null,
      isPlaying: lesson.isPlaying,
      isRecording: lesson.isRecording,
    }),
  useIsBuffering: () => lesson.isBuffering,
}));

vi.mock("../../contexts/NextEditorActorContext", () => ({
  NextEditorActorContext: {
    useSelector: (select: (state: unknown) => unknown) =>
      select({ matches: (value: string) => value === "loading" && lesson.readying }),
  },
}));

vi.mock("./useIsAtLessonStart", () => ({ useIsAtLessonStart: () => lesson.atStart }));
vi.mock("./useNarrationLoad", () => ({
  useNarrationLoad: () => lesson.narration,
  useNarrationPlayer: () => (lesson.hasNarrationPlayer ? {} : undefined),
}));
vi.mock("./useNarrationWarmUp", () => ({ useNarrationWarmUp: () => lesson.warmUpWanted }));

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(lesson, {
    recordingId: null,
    isPlaying: false,
    isRecording: false,
    isBuffering: false,
    readying: false,
    atStart: true,
    narration: null,
    hasNarrationPlayer: false,
    warmUpWanted: false,
  });
  lesson.play.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

const loading = (
  readyState: number,
  bufferedAheadSeconds = 0,
  dataArrivals = 0,
): NarrationLoadFacts => ({ stage: "loading", readyState, bufferedAheadSeconds, dataArrivals });
const FLOWING: NarrationLoadFacts = {
  stage: "flowing",
  readyState: 4,
  bufferedAheadSeconds: 2,
  dataArrivals: 5,
};

interface Props {
  lessonLoading?: boolean;
  loadFailed?: boolean;
  autoplayWanted?: boolean;
}

const element = (props: Props = {}) => (
  <LessonStartIndicator
    lessonLoading={props.lessonLoading ?? false}
    loadFailed={props.loadFailed ?? false}
    autoplayWanted={props.autoplayWanted ?? false}
  />
);

/** The triangle, shown or not. It is always in the page; `data-shown` says whether it is seen. */
const indicator = () => document.querySelector<HTMLButtonElement>(".lesson-start")!;
const isShown = () => indicator().hasAttribute("data-shown");
/** How much of the border is traced, 0 to 1. */
const traced = () =>
  Number(indicator().querySelector("svg")!.style.getPropertyValue("--trace-value"));
const isFilled = () => indicator().querySelector("svg")!.hasAttribute("data-solid");
/** The live region a screen reader listens to. It is always there; only its text changes. */
const announced = () => document.querySelector('[aria-live="polite"]')!.textContent;
const playButton = () => screen.queryByRole("button", { name: "Play recording" });

describe("LessonStartIndicator", () => {
  it("shows nothing where there is no lesson", () => {
    render(element());
    wait(5_000);

    expect(isShown()).toBe(false);
    expect(playButton()).toBeNull();
    expect(announced()).toBe("");
  });

  it("traces the border while the lesson loads, as progress and not as a button", () => {
    render(element({ lessonLoading: true }));

    expect(isShown()).toBe(true);
    expect(traced()).toBe(0);
    expect(isFilled()).toBe(false);
    // Nothing to press yet, and nothing for a screen reader: the editor announces the load.
    expect(playButton()).toBeNull();
    expect(indicator()).toBeDisabled();
    expect(indicator()).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("closes the border into the play button once the lesson has loaded", () => {
    const { rerender } = render(element({ lessonLoading: true }));

    lesson.recordingId = "lesson-1";
    rerender(element());

    expect(traced()).toBe(1);
    expect(isFilled()).toBe(true);
    fireEvent.click(playButton()!);
    expect(lesson.play).toHaveBeenCalledTimes(1);
  });

  it("stays in loading while the machine readies the recording it was handed", () => {
    lesson.readying = true;
    const { rerender } = render(element());
    expect(isShown()).toBe(true);
    expect(playButton()).toBeNull();

    lesson.readying = false;
    lesson.recordingId = "lesson-1";
    rerender(element());
    expect(playButton()).not.toBeNull();
  });

  it("answers Play at once on the same triangle, and follows the narration to sound", () => {
    lesson.recordingId = "lesson-1";
    const { rerender } = render(element());
    const pressed = indicator();

    // Play: the lesson is held for its narration in the same breath.
    Object.assign(lesson, { isPlaying: true, isBuffering: true, narration: loading(0) });
    rerender(element());

    expect(indicator()).toBe(pressed);
    expect(isShown()).toBe(true);
    expect(isFilled()).toBe(false);
    expect(traced()).toBe(0);
    // It is progress again, not a button: Pause is on the player bar.
    expect(playButton()).toBeNull();

    // Data arrives: the border moves before the element knows anything about the file.
    lesson.narration = loading(0, 0, 2);
    rerender(element());
    expect(traced()).toBeGreaterThan(0);
    expect(traced()).toBeLessThan(0.75);

    lesson.narration = loading(1, 0, 2);
    rerender(element());
    expect(traced()).toBeGreaterThanOrEqual(0.75);

    lesson.narration = loading(2, 1, 3);
    rerender(element());
    expect(traced()).toBe(0.95);

    // Sound: the border closes as the triangle leaves.
    Object.assign(lesson, { isBuffering: false, atStart: false, narration: FLOWING });
    rerender(element());
    expect(traced()).toBe(1);
    expect(isShown()).toBe(false);
  });

  it("leaves at once when Play has sound from the first moment", () => {
    lesson.recordingId = "lesson-1";
    const { rerender } = render(element());

    Object.assign(lesson, { isPlaying: true, atStart: false });
    rerender(element());

    expect(isShown()).toBe(false);
    expect(announced()).toBe("");
  });

  it("says the narration is loading only once the wait has lasted", () => {
    lesson.recordingId = "lesson-1";
    const { rerender } = render(element());
    const region = document.querySelector('[aria-live="polite"]')!;

    Object.assign(lesson, { isPlaying: true, isBuffering: true, narration: loading(0) });
    rerender(element());
    wait(499);
    expect(announced()).toBe("");

    wait(1);
    // The region was there before the wait: one inserted already filled is often not read.
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(announced()).toBe("Loading narration");

    Object.assign(lesson, { isBuffering: false, atStart: false, narration: FLOWING });
    rerender(element());
    expect(announced()).toBe("");
  });

  describe("a hold mid-lesson", () => {
    const playingMidLesson = () => {
      lesson.recordingId = "lesson-1";
      Object.assign(lesson, { isPlaying: true, atStart: false });
      return render(element());
    };

    it("shows a small mark once it has lasted, not for the blink of a seek", () => {
      const { rerender } = playingMidLesson();

      Object.assign(lesson, { isBuffering: true, narration: loading(1) });
      rerender(element());
      wait(499);
      expect(isShown()).toBe(false);
      expect(announced()).toBe("");

      wait(1);
      expect(isShown()).toBe(true);
      expect(indicator()).toHaveAttribute("data-shape", "mark");
      expect(announced()).toBe("Loading narration");
      // It is something to look at, never something to press.
      expect(playButton()).toBeNull();
    });

    it("traces each hold from the start point, and counts each one's delay", () => {
      const { rerender } = playingMidLesson();

      Object.assign(lesson, { isBuffering: true, narration: loading(1) });
      rerender(element());
      wait(500);
      expect(traced()).toBe(0);
      lesson.narration = loading(2, 1);
      rerender(element());
      expect(traced()).toBeGreaterThan(0.9);

      Object.assign(lesson, { isBuffering: false, narration: FLOWING });
      rerender(element());
      expect(isShown()).toBe(false);

      Object.assign(lesson, { isBuffering: true, narration: loading(1) });
      rerender(element());
      expect(traced()).toBe(0);
      wait(499);
      expect(isShown()).toBe(false);
      wait(1);
      expect(isShown()).toBe(true);
    });

    it("is the mark, not the play button, when the hold comes at the lesson's start", () => {
      const { rerender } = playingMidLesson();

      // A seek back to 0:00 while it plays, and the narration there has to load again.
      Object.assign(lesson, { atStart: true, isBuffering: true, narration: loading(1) });
      rerender(element());
      expect(isShown()).toBe(false);

      wait(500);
      expect(indicator()).toHaveAttribute("data-shape", "mark");
    });
  });

  describe("with the narration loaded ahead of Play", () => {
    const warming = (readyState: number, dataArrivals = 0): NarrationLoadFacts => ({
      stage: "warming",
      readyState,
      bufferedAheadSeconds: 0,
      dataArrivals,
    });
    const WARMED: NarrationLoadFacts = {
      stage: "warmed",
      readyState: 4,
      bufferedAheadSeconds: 8,
      dataArrivals: 4,
    };

    it("goes on tracing after the lesson has loaded, and fills once Play has sound to give", () => {
      lesson.warmUpWanted = true;
      const { rerender } = render(element({ lessonLoading: true }));

      // Loaded: it can be played, but its border is still open while the narration loads.
      Object.assign(lesson, { recordingId: "lesson-1", hasNarrationPlayer: true });
      rerender(element());
      expect(playButton()).not.toBeNull();
      expect(isFilled()).toBe(false);
      expect(traced()).toBe(0.3);

      lesson.narration = warming(0, 3);
      rerender(element());
      expect(traced()).toBeGreaterThan(0.3);
      lesson.narration = warming(1, 3);
      rerender(element());
      expect(traced()).toBeGreaterThan(0.8);
      expect(isFilled()).toBe(false);

      lesson.narration = WARMED;
      rerender(element());
      expect(traced()).toBe(1);
      expect(isFilled()).toBe(true);
      // Nothing was waited for, so nothing is announced.
      wait(5_000);
      expect(announced()).toBe("");
    });

    it("can be pressed early, and follows the same border to sound", () => {
      lesson.warmUpWanted = true;
      const { rerender } = render(element({ lessonLoading: true }));
      Object.assign(lesson, {
        recordingId: "lesson-1",
        hasNarrationPlayer: true,
        narration: warming(0, 3),
      });
      rerender(element());
      const before = traced();

      fireEvent.click(playButton()!);
      expect(lesson.play).toHaveBeenCalledTimes(1);
      Object.assign(lesson, {
        isPlaying: true,
        isBuffering: true,
        narration: { ...warming(0, 3), stage: "loading" },
      });
      rerender(element());

      expect(isShown()).toBe(true);
      expect(playButton()).toBeNull();
      expect(traced()).toBe(before);

      Object.assign(lesson, { isBuffering: false, atStart: false, narration: FLOWING });
      rerender(element());
      expect(traced()).toBe(1);
      expect(isShown()).toBe(false);
    });

    it("is not filled for a lesson that loaded before its loading could show", () => {
      // A lesson fetched ahead is there at once: no loading was ever drawn for it.
      Object.assign(lesson, {
        warmUpWanted: true,
        recordingId: "lesson-1",
        hasNarrationPlayer: true,
      });
      const { rerender } = render(element());

      // It can be played, but its narration has yet to load: the border is open.
      expect(playButton()).not.toBeNull();
      expect(isFilled()).toBe(false);
      expect(traced()).toBe(0);

      lesson.narration = warming(0, 3);
      rerender(element());
      expect(traced()).toBeGreaterThan(0);
      expect(isFilled()).toBe(false);

      lesson.narration = WARMED;
      rerender(element());
      expect(traced()).toBe(1);
      expect(isFilled()).toBe(true);
    });

    it("fills at once for a lesson that has no narration to load", () => {
      lesson.warmUpWanted = true;
      const { rerender } = render(element({ lessonLoading: true }));

      lesson.recordingId = "lesson-1";
      rerender(element());

      expect(traced()).toBe(1);
      expect(isFilled()).toBe(true);
    });
  });

  describe("with autoplay", () => {
    it("carries one border from the lesson's file into the narration", () => {
      const { rerender } = render(element({ lessonLoading: true, autoplayWanted: true }));

      // Loaded: the file's part of the border is done, and autoplay takes the lesson on.
      lesson.recordingId = "lesson-1";
      rerender(element({ autoplayWanted: true }));
      expect(traced()).toBe(0.3);
      expect(isFilled()).toBe(false);

      Object.assign(lesson, { isPlaying: true, isBuffering: true, narration: loading(0) });
      rerender(element({ autoplayWanted: true }));
      expect(traced()).toBe(0.3);

      lesson.narration = loading(1);
      rerender(element({ autoplayWanted: true }));
      expect(traced()).toBeCloseTo(0.825);

      Object.assign(lesson, { isBuffering: false, atStart: false, narration: FLOWING });
      rerender(element({ autoplayWanted: true }));
      expect(traced()).toBe(1);
      expect(isShown()).toBe(false);
    });

    it("closes into the play button when autoplay leaves the lesson for a press", () => {
      const { rerender } = render(element({ lessonLoading: true, autoplayWanted: true }));

      lesson.recordingId = "lesson-1";
      rerender(element({ autoplayWanted: true }));
      expect(isFilled()).toBe(false);

      // The browser has not been given a gesture yet, so autoplay did not start it.
      wait(0);
      expect(traced()).toBe(1);
      expect(isFilled()).toBe(true);
      expect(playButton()).not.toBeNull();
    });
  });

  it("shows nothing over a failed load, and traces the retry from the start", () => {
    const { rerender } = render(element({ lessonLoading: true }));

    rerender(element({ loadFailed: true }));
    expect(isShown()).toBe(false);

    rerender(element({ lessonLoading: true }));
    expect(isShown()).toBe(true);
    expect(traced()).toBe(0);
  });
});
