import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    expect(runCtaCopy("go run *.go")).toEqual({
      headline: "You haven't run this code yet.",
      actionLabel: "Run",
      detail: "Runs go run *.go. The output appears here.",
      showRunIcon: true,
    });
  });

  it("says why signing in is needed, and offers it as the action", () => {
    expect(signInCtaCopy("Haskell")).toMatchObject({
      actionLabel: "Sign in to run Haskell",
      detail:
        "Haskell runs on a server, not in your browser. Your code is saved before you sign in.",
      showRunIcon: false,
    });
  });

  it("offers runner settings as the action when the runner is off", () => {
    expect(runnerDisabledCtaCopy()).toMatchObject({
      headline: "The runner is turned off for this lesson.",
      actionLabel: "Open runner settings",
      showRunIcon: false,
    });
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
  it("renders the copy and runs the action when the button is pressed", () => {
    const onAction = vi.fn<() => void>();
    render(<RunnerConsoleCta {...runCtaCopy("cargo run")} onAction={onAction} />);

    expect(screen.getByText("You haven't run this code yet.")).toBeInTheDocument();
    expect(screen.getByText("Runs cargo run. The output appears here.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("labels the button for the sign-in and settings actions", () => {
    const { rerender } = render(<RunnerConsoleCta {...signInCtaCopy("Go")} onAction={() => {}} />);
    expect(screen.getByRole("button", { name: "Sign in to run Go" })).toBeInTheDocument();

    rerender(<RunnerConsoleCta {...runnerDisabledCtaCopy()} onAction={() => {}} />);
    expect(screen.getByRole("button", { name: "Open runner settings" })).toBeInTheDocument();
  });

  it("only the button takes pointer events, and the overlay paints above the terminal", () => {
    const { container } = render(
      <RunnerConsoleCta {...runCtaCopy("cargo run")} onAction={() => {}} />,
    );

    const overlay = container.firstElementChild;
    // The studio attention cursor and recorded mouse tracking both walk up from
    // document.elementFromPoint; a full-box hit target re-anchors both.
    expect(overlay).toHaveClass("pointer-events-none");
    expect(screen.getByRole("button")).toHaveClass("pointer-events-auto");
    // `.xterm` is position:relative with an opaque background, so an overlay
    // left at `z-index: auto` is painted underneath it.
    expect(overlay).toHaveClass("z-10");
  });

  it("carries no studio, tour, or cursor-replay hooks", () => {
    const { container } = render(<RunnerConsoleCta {...signInCtaCopy("Go")} onAction={() => {}} />);

    expect(container.querySelector("[data-studio-target]")).toBeNull();
    expect(container.querySelector("[data-tour]")).toBeNull();
    expect(container.querySelector("[data-cursor-replay-target]")).toBeNull();
  });
});
