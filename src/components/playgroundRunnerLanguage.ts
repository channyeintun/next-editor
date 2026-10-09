import type { LucideIcon } from "lucide-react";
import type { PlaygroundClientBinding } from "../hooks/usePlaygroundRunner";
import type { PlaygroundFile } from "../runtime/playgroundFiles";
import type { WorkspaceProject } from "../types/workspace";

/**
 * What one Playground language brings to the runner dock that
 * PlaygroundRunnerPanel renders: its names, its client, its console lines and
 * whether it can format. Each `<Lang>PlaygroundRunnerPanel` module holds one as
 * a module-level constant — the client binding inside it has to be one.
 */
export interface PlaygroundRunnerLanguage<Client, ErrorKind extends string, RunResult> {
  /**
   * The console's XtermTerminal session id and its key in the recorded
   * `terminalScrollLines`. Recordings carry it, so it never changes.
   */
  scrollSurface: string;
  /** The dock's `data-studio-target`, where the studio's cursor goes before a run. */
  dockTargetId: string;
  runnerTab: { label: string; icon: LucideIcon };
  consoleTags: PlaygroundConsoleTags;
  client: PlaygroundClientBinding<Client, ErrorKind>;
  /** The sources Run and Format submit, read from the workspace at click time. */
  collectFiles: (project: Pick<WorkspaceProject, "files">) => PlaygroundFile[];
  run: PlaygroundRun<Client, ErrorKind, RunResult>;
  /** Null for a language with no formatter to call. */
  format: PlaygroundFormat<Client, ErrorKind> | null;
}

/** The tags a language's console module emits, which the dock colours. */
export interface PlaygroundConsoleTags {
  /** Matches only those tags, so a program's own bracketed output stays plain. */
  pattern: RegExp;
  /** The tag coloured as a warning rather than a success, where a language has one. */
  warningPrefix?: string;
}

/** A client failure, as the console builders take it ("aborted" never reaches them). */
type ServiceErrorKind<ErrorKind extends string> = Exclude<ErrorKind, "aborted"> | "unavailable";

export interface PlaygroundRun<Client, ErrorKind extends string, RunResult> {
  /** What the console header names while nothing is formatting. */
  commandLabel: string;
  /** The console line refusing sources the lesson cannot run, or null to run them. */
  rejectFiles?: (files: readonly PlaygroundFile[]) => string | null;
  execute: (client: Client, files: PlaygroundFile[]) => Promise<RunResult>;
  startedLines: (files: readonly PlaygroundFile[]) => string[];
  resultLines: (result: RunResult) => string[];
  serviceErrorLines: (kind: ServiceErrorKind<ErrorKind>, detail?: string) => string[];
}

export interface PlaygroundFormat<Client, ErrorKind extends string> {
  /** The Monaco language the document formatting provider registers for. */
  monacoLanguageId: string;
  providerDisplayName: string;
  /** What the console header names while formatting. */
  commandLabel: string;
  /** What the dock's status region says while formatting. */
  busyLabel: string;
  buttonTitle: string;
  /** What Format prints in a shared lesson this viewer cannot edit. */
  readOnlyLine: string;
  /** The console line refusing sources the formatter cannot take, or null to format them. */
  rejectFiles: (files: readonly PlaygroundFile[]) => string | null;
  /**
   * The line for an open model the collector never submits, printed instead of
   * the stale-edit lines (which would wrongly say the file changed).
   */
  unsubmittedModelLine?: string;
  /** Resolves with the submitted files, formatted; a client returns no other paths. */
  execute: (
    client: Client,
    files: PlaygroundFile[],
  ) => Promise<{ files: readonly PlaygroundFile[] }>;
  startedLines: (files: readonly PlaygroundFile[]) => string[];
  resultLines: (changedPaths: readonly string[]) => string[];
  staleLines: () => string[];
  serviceErrorLines: (kind: ServiceErrorKind<ErrorKind>, detail?: string) => string[];
}
