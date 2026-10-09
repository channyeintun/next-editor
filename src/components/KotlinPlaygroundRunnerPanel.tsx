import { Hexagon } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceError,
  type KotlinPlaygroundServiceErrorKind,
} from "../runtime/kotlinPlayground/client";
import {
  KOTLIN_CONSOLE_TAG_PATTERN,
  kotlinRunResultToConsoleLines,
  kotlinRunServiceErrorToConsoleLines,
  kotlinRunStartedConsoleLines,
} from "../runtime/kotlinPlayground/console";
import { collectKotlinPlaygroundFiles } from "../runtime/kotlinPlayground/files";
import type { KotlinPlaygroundRunResult } from "../runtime/kotlinPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/**
 * Kotlin lessons: Run every .kt file remotely through the Kotlin Playground
 * proxy, with no sign-in needed. There is no Format, because the upstream
 * service has no formatter endpoint.
 */
export const KOTLIN_RUNNER: PlaygroundRunnerLanguage<
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceErrorKind,
  KotlinPlaygroundRunResult
> = {
  scrollSurface: "kotlin-runner",
  dockTargetId: runnerDockTargetId("kotlin-runner"),
  runnerTab: { label: "Kotlin Runner", icon: Hexagon },
  consoleTags: { pattern: KOTLIN_CONSOLE_TAG_PATTERN, warningPrefix: "[kotlin-warn" },
  client: {
    create: () => new KotlinPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: KotlinPlaygroundServiceError,
  },
  collectFiles: collectKotlinPlaygroundFiles,
  run: {
    commandLabel: "kotlin *.kt",
    rejectFiles: (files) =>
      files.length === 0 ? "[kotlin-run error] Add at least one .kt file to run this lesson" : null,
    execute: (client, files) => client.run(files),
    startedLines: (files) => kotlinRunStartedConsoleLines(files.map((file) => file.path)),
    resultLines: kotlinRunResultToConsoleLines,
    serviceErrorLines: kotlinRunServiceErrorToConsoleLines,
  },
  format: null,
};

function KotlinPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={KOTLIN_RUNNER} />;
}

export default KotlinPlaygroundRunnerPanel;
