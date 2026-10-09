import type { PlaygroundLanguage } from "../playgroundLanguage";
import {
  GoPlaygroundClient,
  GoPlaygroundServiceError,
  type GoPlaygroundServiceErrorKind,
} from "./client";
import {
  goFormatResultToConsoleLines,
  goFormatServiceErrorToConsoleLines,
  goFormatStaleConsoleLines,
  goFormatStartedConsoleLines,
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "./console";
import { collectGoPlaygroundFiles } from "./files";
import type { GoPlaygroundRunResult } from "./types";

/**
 * Go lessons: Run (`go run`) and Format (`gofmt`) every .go file together,
 * remotely through the Go Playground proxy. Neither needs sign-in; the proxy
 * rate-limits signed-out learners by IP instead.
 */
export const GO_PLAYGROUND: PlaygroundLanguage<
  GoPlaygroundClient,
  GoPlaygroundServiceErrorKind,
  GoPlaygroundRunResult
> = {
  label: "go",
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
