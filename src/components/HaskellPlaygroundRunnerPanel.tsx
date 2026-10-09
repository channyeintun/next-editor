import { SquareFunction } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import {
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceError,
  type HaskellPlaygroundServiceErrorKind,
} from "../runtime/haskellPlayground/client";
import {
  HASKELL_CONSOLE_TAG_PATTERN,
  haskellRunResultToConsoleLines,
  haskellRunServiceErrorToConsoleLines,
  haskellRunStartedConsoleLines,
} from "../runtime/haskellPlayground/console";
import { collectHaskellPlaygroundFiles } from "../runtime/haskellPlayground/files";
import type { HaskellPlaygroundRunResult } from "../runtime/haskellPlayground/types";
import { isSinglePlaygroundFile, PLAYGROUND_SOURCE_RULES } from "../runtime/playgroundFiles";
import { runnerDockTargetId } from "../studio/targets";

/**
 * Haskell lessons: Run remotely through the play.haskell.org proxy, with no
 * sign-in needed. There is no Format, because the upstream service exposes a
 * single /submit route and no formatter endpoint. The upstream compiles one
 * module from a single source string, so lessons run exactly one Main.hs —
 * capital M, because GHC's diagnostics name the file Main.hs and the editor
 * file has to match what the errors point at.
 */
export const HASKELL_RUNNER: PlaygroundRunnerLanguage<
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceErrorKind,
  HaskellPlaygroundRunResult
> = {
  scrollSurface: "haskell-runner",
  dockTargetId: runnerDockTargetId("haskell-runner"),
  runnerTab: { label: "Haskell Runner", icon: SquareFunction },
  // GHC warns far more readily than it errors, so — as in the Kotlin console —
  // the [haskell-warn] tag gets its own color rather than reading as a success
  // line.
  consoleTags: { pattern: HASKELL_CONSOLE_TAG_PATTERN, warningPrefix: "[haskell-warn" },
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

function HaskellPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={HASKELL_RUNNER} />;
}

export default HaskellPlaygroundRunnerPanel;
