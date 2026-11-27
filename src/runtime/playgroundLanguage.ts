import type { PlaygroundFile } from "./playgroundFiles";
import type { WorkspaceProject } from "../types/workspace";

/**
 * What one Playground language is, independent of any UI: its client, the
 * sources it collects, and the console lines its Run and Format print. Each
 * `runtime/<lang>Playground/runner.ts` holds one as a module-level constant —
 * the client binding inside it has to be one — and the runner dock
 * (components/playgroundRunnerLanguage.ts) adds only what it needs to draw it.
 */
export interface PlaygroundLanguage<Client, ErrorKind extends string, RunResult> {
  /** The head of the language's console tags, as in `[go-run]`. */
  label: string;
  client: PlaygroundClientBinding<Client, ErrorKind>;
  /** The sources Run and Format submit, read from the workspace at click time. */
  collectFiles: (project: Pick<WorkspaceProject, "files">) => PlaygroundFile[];
  run: PlaygroundRun<Client, ErrorKind, RunResult>;
  /** Null for a language with no formatter to call. */
  format: PlaygroundFormat<Client, ErrorKind> | null;
}

/** A runtime client's typed error: every playground client throws one of these. */
export type PlaygroundServiceErrorClass<ErrorKind extends string> = abstract new (
  kind: ErrorKind,
  message: string,
) => Error & { readonly kind: ErrorKind };

export interface PlaygroundClientBinding<Client, ErrorKind extends string> {
  create: () => Client;
  /**
   * Ends whatever the client is doing: aborts the service request of a proxied language,
   * terminates Kite's busy compiler worker, or abandons assembly's sliced run (a generation bump
   * its machine checks between slices, since there is no request to abort).
   */
  stop: (client: Client) => void;
  /** Its errors carry their own kind; anything else it throws is reported as "unavailable". */
  ServiceError: PlaygroundServiceErrorClass<ErrorKind>;
}

/** A client failure, as the console builders take it ("aborted" never reaches them). */
type ServiceErrorKind<ErrorKind extends string> = Exclude<ErrorKind, "aborted"> | "unavailable";

export interface PlaygroundRun<Client, ErrorKind extends string, RunResult> {
  /** What the console header names while nothing is formatting. */
  commandLabel: string;
  /** The console line refusing sources the lesson cannot run, or null to run them. */
  rejectFiles?: (files: readonly PlaygroundFile[]) => string | null;
  /**
   * The file a run starts from, for a language whose client picks it instead of
   * a `rejectFiles` refusing up front: it throws the client's own "invalid-source"
   * error for sources it cannot resolve. The client calls it on every run; the
   * studio's fixture run, which never reaches a client, calls it so a workspace
   * the client would refuse fails there the same way.
   */
  pickEntry?: (files: readonly PlaygroundFile[]) => PlaygroundFile;
  execute: (client: Client, files: PlaygroundFile[]) => Promise<RunResult>;
  /**
   * Present for a language whose program talks to the learner while it runs:
   * it prints before it ends and can wait for a typed line. The dock then runs
   * it on a terminal and shows an input row while the program waits; a
   * language without it is one request and one answer.
   */
  interactive?: PlaygroundInteractiveRun<Client, RunResult>;
  startedLines: (files: readonly PlaygroundFile[]) => string[];
  /**
   * For an interactive language these begin with the program's output as
   * `splitOutputLines` splits it (playgroundConsole.ts), so the lines a
   * terminal showed while the program ran are the head of the lines that end it.
   */
  resultLines: (result: RunResult) => string[];
  /**
   * The lines the dock's status region reads its summary from, for a language
   * whose `resultLines` print more after the run's own ending (assembly's
   * registers); `resultLines` otherwise.
   */
  statusLines?: (result: RunResult) => string[];
  serviceErrorLines: (kind: ServiceErrorKind<ErrorKind>, detail?: string) => string[];
}

export interface PlaygroundInteractiveRun<Client, RunResult> {
  /** `execute`, on a terminal the program prints to and reads from as it runs. */
  execute: (
    client: Client,
    files: PlaygroundFile[],
    terminal: PlaygroundRunTerminal,
  ) => Promise<RunResult>;
}

/**
 * The longest line a terminal hands a program, in UTF-16 units. The dock's
 * input row stops there, and a runtime sizes the memory a line travels in
 * from it.
 */
export const PLAYGROUND_INPUT_LINE_MAX_LENGTH = 1000;

/**
 * What a running program is given in place of a keyboard and a screen. Whoever
 * drives the run supplies it: the runner dock, where the learner types, or the
 * studio, which types a lesson's pinned lines.
 */
export interface PlaygroundRunTerminal {
  /**
   * Everything the program has printed so far — the whole output each time,
   * not what is new, so a later call replaces what an earlier one showed. The
   * run's result still carries the final output; nothing is printed for it here.
   */
  print(output: string): void;
  /**
   * The program waits for a line. Resolves with it, without a line break, or
   * with null where there is no more input (the program then meets the end of
   * its input). A promise that never settles leaves the program waiting until
   * the run is stopped.
   */
  readLine(): Promise<string | null>;
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
