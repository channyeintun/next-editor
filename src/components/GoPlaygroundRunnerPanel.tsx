import { Diamond } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import {
  GoPlaygroundClient,
  GoPlaygroundServiceError,
  type GoPlaygroundServiceErrorKind,
} from "../runtime/goPlayground/client";
import {
  GO_CONSOLE_TAG_PATTERN,
  goFormatResultToConsoleLines,
  goFormatServiceErrorToConsoleLines,
  goFormatStaleConsoleLines,
  goFormatStartedConsoleLines,
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "../runtime/goPlayground/console";
import { collectGoPlaygroundFiles } from "../runtime/goPlayground/files";
import type { GoPlaygroundRunResult } from "../runtime/goPlayground/types";
import { STUDIO_GO_DOCK_TARGET_ID } from "../studio/targets";

/**
 * Go lessons: Run (`go run`) and Format (`gofmt`) every .go file together,
 * remotely through the Go Playground proxy. Neither needs sign-in; the proxy
 * rate-limits signed-out learners by IP instead.
 */
export const GO_RUNNER: PlaygroundRunnerLanguage<
  GoPlaygroundClient,
  GoPlaygroundServiceErrorKind,
  GoPlaygroundRunResult
> = {
  scrollSurface: "go-runner",
  dockTargetId: STUDIO_GO_DOCK_TARGET_ID,
  runnerTab: { label: "Go Runner", icon: Diamond },
  consoleTags: { pattern: GO_CONSOLE_TAG_PATTERN, warningPrefix: "[go-vet" },
  client: {
    create: () => new GoPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: GoPlaygroundServiceError,
  },
  collectFiles: collectGoPlaygroundFiles,
  run: {
    commandLabel: "go run *.go",
    rejectFiles: (files) =>
      files.length === 0 ? "[go-run error] Add at least one .go file to run this lesson" : null,
    execute: (client, files) => client.run(files),
    startedLines: (files) => goRunStartedConsoleLines(files.map((file) => file.path)),
    resultLines: goRunResultToConsoleLines,
    serviceErrorLines: goRunServiceErrorToConsoleLines,
  },
  format: {
    monacoLanguageId: "go",
    providerDisplayName: "gofmt (Go Playground)",
    commandLabel: "gofmt *.go",
    busyLabel: "Go files are formatting",
    buttonTitle: "Format every Go file with gofmt (Shift+Alt+F)",
    readOnlyLine: "[gofmt error] This shared lesson is read-only",
    rejectFiles: (files) =>
      files.length === 0 ? "[gofmt error] Add at least one .go file to format this lesson" : null,
    execute: (client, files) => client.format(files),
    startedLines: (files) => goFormatStartedConsoleLines(files.map((file) => file.path)),
    resultLines: goFormatResultToConsoleLines,
    staleLines: goFormatStaleConsoleLines,
    serviceErrorLines: goFormatServiceErrorToConsoleLines,
  },
};

function GoPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={GO_RUNNER} />;
}

export default GoPlaygroundRunnerPanel;
