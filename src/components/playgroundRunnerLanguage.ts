import type { LucideIcon } from "lucide-react";
import type { PlaygroundLanguage } from "../runtime/playgroundLanguage";

/**
 * What one Playground language brings to the runner dock that
 * PlaygroundRunnerPanel renders: the language itself
 * (runtime/<lang>Playground/runner.ts) plus the dock's names, tab and console
 * colours. Each `<Lang>PlaygroundRunnerPanel` module holds one as a
 * module-level constant — the client binding inside it has to be one.
 */
export interface PlaygroundRunnerLanguage<
  Client,
  ErrorKind extends string,
  RunResult,
> extends PlaygroundLanguage<Client, ErrorKind, RunResult> {
  /**
   * The console's XtermTerminal session id and its key in the recorded
   * `terminalScrollLines`. Recordings carry it, so it never changes.
   */
  scrollSurface: string;
  /** The dock's `data-studio-target`, where the studio's cursor goes before a run. */
  dockTargetId: string;
  runnerTab: { label: string; icon: LucideIcon };
  consoleTags: PlaygroundConsoleTags;
}

/** The tags a language's console module emits, which the dock colours. */
export interface PlaygroundConsoleTags {
  /** Matches only those tags, so a program's own bracketed output stays plain. */
  pattern: RegExp;
  /** The tag coloured as a warning rather than a success, where a language has one. */
  warningPrefix?: string;
}
