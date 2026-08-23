/**
 * The empty-state call to action shared by every runner console — the seven
 * playground docks and the WebContainer runner tab. A console that has never
 * run is a black rectangle: the Run button above it is the only thing that
 * changes that, and until now nothing on screen said so.
 *
 * Deliberately not interactive. A second control that runs (or signs in) would
 * duplicate the awaited saveProject() that has to precede the full-page OAuth
 * navigation, and `pointer-events-none` keeps the overlay out of
 * document.elementFromPoint — which both the studio attention cursor
 * (src/studio/driver.ts) and recorded mouse tracking (mouseTrackingActor) walk
 * up from to resolve a cursor target. An overlay that swallowed those hits
 * would silently re-anchor replayed cursor coordinates.
 *
 * It overlays the console, never sits in flow beside it: the dock content box
 * is a fixed h-72 and XtermTerminal fits itself to its container, so stealing
 * rows would change terminal.rows and desynchronise the recorded scrollLine
 * values that published lessons replay.
 *
 * `z-10` is load-bearing. XtermTerminal's `.xterm` child is position:relative
 * with an opaque background (src/index.css), so a positioned sibling left at
 * `z-index: auto` paints underneath it no matter where it sits in the tree.
 */

export interface RunnerConsoleCtaCopy {
  /** One sentence: the state a blank console cannot convey. */
  headline: string;
  /** One sentence: the action to take, and what it produces. */
  body: string;
}

/**
 * `action` completes "Click the Run button above to ___", e.g. "start cargo
 * run". Always pass the run command, never a toolLabel that flips to the
 * formatter — this copy is only ever on screen before a run.
 */
export function runCtaCopy(action: string): RunnerConsoleCtaCopy {
  return {
    headline: "You haven't run this code yet.",
    body: `Click the Run button above to ${action}. The output appears here.`,
  };
}

/** `language` is the human name: "Go", "Rust", "Zig", "Kotlin", "Haskell". */
export function signInCtaCopy(language: string): RunnerConsoleCtaCopy {
  return {
    headline: "Sign in to run this code.",
    body: `${language} runs on a server, not in your browser. Your code is saved before you sign in.`,
  };
}

export function runnerDisabledCtaCopy(): RunnerConsoleCtaCopy {
  return {
    headline: "The runner is turned off for this lesson.",
    body: "Click the gear button above to open runner settings and turn it back on.",
  };
}

export interface LessonPlaybackState {
  isPlaybackSnapshotActive: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  hasEnded: boolean;
}

/**
 * True while the console on screen belongs to a lesson replay rather than to
 * the learner's own workspace — the whole of it, not just the playing part.
 *
 * `isPlaybackSnapshotActive` alone is the trap: it tracks `playback: "playing"`,
 * so pausing, scrubbing while paused, or reaching the end flips it false while
 * the live store's consoleLines are still empty (a replay only ever writes the
 * playback snapshot). A CTA keyed on it alone therefore blinks on every pause
 * and paints "You haven't run this code yet." across a lesson the viewer just
 * watched. A recording that is loaded but never played sits in `playback.ready`
 * — all four flags false — which is exactly when the CTA should show.
 */
export function isLessonPlaybackShowing(state: LessonPlaybackState): boolean {
  return state.isPlaybackSnapshotActive || state.isPlaying || state.isPaused || state.hasEnded;
}

/**
 * The visibility rule for the seven playground docks, in one place so seven
 * copies cannot drift. Callers must pass the length of `effectiveConsoleLines`
 * and never the raw store `consoleLines`: during playback the recorded lines
 * arrive in a separate snapshot field while the raw array stays empty for the
 * whole replay, so a CTA keyed on the store would sit on top of replayed
 * program output. `isAuthLoading` is omitted by the two in-page runners (Kite,
 * x86-64), which run locally and have no sign-in gate.
 */
export function shouldShowPlaygroundRunnerCta(
  options: LessonPlaybackState & {
    isAuthLoading?: boolean;
    consoleLineCount: number;
  },
): boolean {
  return (
    !isLessonPlaybackShowing(options) && !options.isAuthLoading && options.consoleLineCount === 0
  );
}

function RunnerConsoleCta({ headline, body }: RunnerConsoleCtaCopy) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex select-none flex-col items-center justify-center gap-1.5 px-6 text-center font-mono text-[13px]">
      <p className="text-slate-300">{headline}</p>
      <p className="max-w-md text-slate-400">{body}</p>
    </div>
  );
}

export default RunnerConsoleCta;
