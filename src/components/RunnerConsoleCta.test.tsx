import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RunnerConsoleCta, {
  isLessonPlaybackShowing,
  runCtaCopy,
  runnerDisabledCtaCopy,
  shouldShowPlaygroundRunnerCta,
  signInCtaCopy,
} from "./RunnerConsoleCta";

const NO_PLAYBACK = {
  isPlaybackSnapshotActive: false,
  isPlaying: false,
  isPaused: false,
  hasEnded: false,
} as const;

describe("runner console CTA copy", () => {
  it("names the run command in the run copy", () => {
    expect(runCtaCopy("start go run *.go")).toEqual({
      headline: "You haven't run this code yet.",
      body: "Click the Run button above to start go run *.go. The output appears here.",
    });
  });

  it("says why signing in is needed", () => {
    expect(signInCtaCopy("Haskell").body).toBe(
      "Haskell runs on a server, not in your browser. Your code is saved before you sign in.",
    );
  });

  it("points at runner settings when the runner is off", () => {
    expect(runnerDisabledCtaCopy().headline).toBe("The runner is turned off for this lesson.");
  });
});

describe("isLessonPlaybackShowing", () => {
  it("is false for a recording that is loaded but never played", () => {
    // `playback.ready` — the state a published lesson sits in until the viewer
    // presses play. This is the case the CTA exists for.
    expect(isLessonPlaybackShowing(NO_PLAYBACK)).toBe(false);
  });

  it.each([
    ["playing", { ...NO_PLAYBACK, isPlaybackSnapshotActive: true, isPlaying: true }],
    ["paused", { ...NO_PLAYBACK, isPaused: true }],
    ["ended", { ...NO_PLAYBACK, hasEnded: true }],
    // A lesson with no recorded runtime snapshot still replays.
    ["playing without a runtime snapshot", { ...NO_PLAYBACK, isPlaying: true }],
  ])("is true while a lesson is %s", (_label, state) => {
    expect(isLessonPlaybackShowing(state)).toBe(true);
  });
});

describe("shouldShowPlaygroundRunnerCta", () => {
  it("shows for an empty, live, authenticated console", () => {
    expect(
      shouldShowPlaygroundRunnerCta({
        ...NO_PLAYBACK,
        isAuthLoading: false,
        consoleLineCount: 0,
      }),
    ).toBe(true);
  });

  it("stays hidden for the whole of a recorded playback", () => {
    // The recorded console is empty for the entire pre-run stretch of a lesson
    // and Run is disabled there, so emptiness alone must never be enough.
    expect(
      shouldShowPlaygroundRunnerCta({
        ...NO_PLAYBACK,
        isPlaybackSnapshotActive: true,
        isPlaying: true,
        isAuthLoading: false,
        consoleLineCount: 0,
      }),
    ).toBe(false);
  });

  it.each([
    ["paused", { isPaused: true }],
    ["ended", { hasEnded: true }],
  ])("stays hidden when a lesson replay is %s", (_label, playback) => {
    // Pausing drops isPlaybackSnapshotActive and the live console lines are
    // empty for the whole replay, so these two flags are the only thing keeping
    // the CTA off a lesson the viewer just watched.
    expect(
      shouldShowPlaygroundRunnerCta({
        ...NO_PLAYBACK,
        ...playback,
        isAuthLoading: false,
        consoleLineCount: 0,
      }),
    ).toBe(false);
  });

  it("stays hidden while auth is still loading, because Run is disabled there", () => {
    expect(
      shouldShowPlaygroundRunnerCta({
        ...NO_PLAYBACK,
        isAuthLoading: true,
        consoleLineCount: 0,
      }),
    ).toBe(false);
  });

  it("stays hidden once the console has any output", () => {
    expect(
      shouldShowPlaygroundRunnerCta({
        ...NO_PLAYBACK,
        isAuthLoading: false,
        consoleLineCount: 1,
      }),
    ).toBe(false);
  });

  it("treats omitted auth state as loaded, for the in-page runners", () => {
    expect(shouldShowPlaygroundRunnerCta({ ...NO_PLAYBACK, consoleLineCount: 0 })).toBe(true);
  });
});

describe("RunnerConsoleCta", () => {
  it("renders both lines, takes no pointer events, and paints above the terminal", () => {
    const { container } = render(<RunnerConsoleCta {...runCtaCopy("start cargo run")} />);

    expect(screen.getByText("You haven't run this code yet.")).toBeInTheDocument();
    expect(
      screen.getByText("Click the Run button above to start cargo run. The output appears here."),
    ).toBeInTheDocument();

    const overlay = container.firstElementChild;
    // The studio attention cursor and recorded mouse tracking both walk up from
    // document.elementFromPoint; a hit-testable overlay re-anchors both.
    expect(overlay).toHaveClass("pointer-events-none");
    // `.xterm` is position:relative with an opaque background, so an overlay
    // left at `z-index: auto` is painted underneath it.
    expect(overlay).toHaveClass("z-10");
  });

  it("carries no studio, tour, or cursor-replay hooks", () => {
    const { container } = render(<RunnerConsoleCta {...signInCtaCopy("Go")} />);

    expect(container.querySelector("[data-studio-target]")).toBeNull();
    expect(container.querySelector("[data-tour]")).toBeNull();
    expect(container.querySelector("[data-cursor-replay-target]")).toBeNull();
  });
});
