import { Play } from "lucide-react";

/**
 * The empty-state call to action shared by every runner console — the seven
 * playground docks and the WebContainer runner tab. A console that has never
 * run is a black rectangle, and the Run button in the command bar above it is
 * small, far from where the eye lands, and easy to miss. This puts the same
 * action in the middle of the empty console, as a real button.
 *
 * The overlay itself stays `pointer-events-none` and only the button takes
 * hits, so the console keeps its own behaviour everywhere else: the studio
 * attention cursor (src/studio/driver.ts) and recorded mouse tracking
 * (mouseTrackingActor) both walk up from document.elementFromPoint to resolve a
 * cursor target, and a full-box overlay would re-anchor them. The button is
 * inside the dock, which carries `data-cursor-replay-target="runtime-dock"` in
 * both the record and replay phases, so a hover over it resolves to an id that
 * exists on both sides.
 *
 * It overlays the console, never sits in flow beside it: the dock content box
 * is a fixed h-72 and XtermTerminal fits itself to its container, so stealing
 * rows would change terminal.rows and desynchronise the recorded scrollLine
 * values that published lessons replay.
 *
 * `z-10` is load-bearing. XtermTerminal's `.xterm` child is position:relative
 * with an opaque background (src/index.css), so a positioned sibling left at
 * `z-index: auto` paints underneath it no matter where it sits in the tree.
 *
 * It carries no `data-studio-target`, `data-tour`, or `data-cursor-replay-target`
 * of its own: all three resolve by first match, so a second element answering to
 * an existing id would quietly steal the performer's click or the tour's step.
 */

export interface RunnerConsoleCtaCopy {
  /** One sentence: the state a blank console cannot convey. */
  headline: string;
  /** The button label — what pressing it does, in the learner's words. */
  actionLabel: string;
  /** One sentence under the button: what the action will do. */
  detail: string;
  /** A Run action gets the play glyph; sign-in and settings do not. */
  showRunIcon: boolean;
}

/**
 * `command` is the run command as the command bar spells it, e.g. "cargo run".
 * Always pass the run command, never a toolLabel that flips to the formatter —
 * this copy is only ever on screen before a run.
 */
export function runCtaCopy(command: string): RunnerConsoleCtaCopy {
  return {
    headline: "You haven't run this code yet.",
    actionLabel: "Run",
    detail: `Runs ${command}. The output appears here.`,
    showRunIcon: true,
  };
}

/** `language` is the human name: "Go", "Rust", "Zig", "Kotlin", "Haskell". */
export function signInCtaCopy(language: string): RunnerConsoleCtaCopy {
  return {
    headline: "Sign in to run this code.",
    actionLabel: `Sign in to run ${language}`,
    detail: `${language} runs on a server, not in your browser. Your code is saved before you sign in.`,
    showRunIcon: false,
  };
}

export function runnerDisabledCtaCopy(): RunnerConsoleCtaCopy {
  return {
    headline: "The runner is turned off for this lesson.",
    actionLabel: "Open runner settings",
    detail: "Turn it back on there to see the output here.",
    showRunIcon: false,
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
 *
 * The button this gate controls is a second way to fire the command bar's Run,
 * so it must never be live where that button is disabled.
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

interface RunnerConsoleCtaProps extends RunnerConsoleCtaCopy {
  onAction: () => void;
}

function RunnerConsoleCta({
  headline,
  actionLabel,
  detail,
  showRunIcon,
  onAction,
}: RunnerConsoleCtaProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex select-none flex-col items-center justify-center gap-3 px-6 text-center font-mono text-[13px]">
      <p className="text-slate-300">{headline}</p>
      <button
        type="button"
        onClick={onAction}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-md bg-[#173925] px-4 py-2 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#58d88d]"
      >
        {showRunIcon ? <Play size={14} strokeWidth={2.5} /> : null}
        {actionLabel}
      </button>
      <p className="max-w-md text-slate-400">{detail}</p>
    </div>
  );
}

export default RunnerConsoleCta;
