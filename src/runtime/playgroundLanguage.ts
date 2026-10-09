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
