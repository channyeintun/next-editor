import type { PlaygroundLanguage } from "../playgroundLanguage";
import { isSinglePlaygroundFile, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import {
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceError,
  type HaskellPlaygroundServiceErrorKind,
} from "./client";
import {
  haskellRunResultToConsoleLines,
  haskellRunServiceErrorToConsoleLines,
  haskellRunStartedConsoleLines,
} from "./console";
import { collectHaskellPlaygroundFiles } from "./files";
import type { HaskellPlaygroundRunResult } from "./types";

/**
 * Haskell lessons: Run remotely through the play.haskell.org proxy, with no
 * sign-in needed. There is no Format, because the upstream service exposes a
 * single /submit route and no formatter endpoint. The upstream compiles one
 * module from a single source string, so lessons run exactly one Main.hs —
 * capital M, because GHC's diagnostics name the file Main.hs and the editor
 * file has to match what the errors point at.
 */
export const HASKELL_PLAYGROUND: PlaygroundLanguage<
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceErrorKind,
  HaskellPlaygroundRunResult
> = {
  label: "haskell",
  client: {
    create: () => new HaskellPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: HaskellPlaygroundServiceError,
  },
  collectFiles: collectHaskellPlaygroundFiles,
  run: {
    commandLabel: "runghc Main.hs",
    rejectFiles: (files) =>
      isSinglePlaygroundFile(files, PLAYGROUND_SOURCE_RULES.haskell.entryPath)
        ? null
        : "[haskell-run error] Haskell lessons run a single Main.hs file",
    execute: (client, files) => client.run(files),
    startedLines: haskellRunStartedConsoleLines,
    resultLines: haskellRunResultToConsoleLines,
    serviceErrorLines: haskellRunServiceErrorToConsoleLines,
  },
  format: null,
};
