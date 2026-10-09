import type { PlaygroundLanguage } from "../playgroundLanguage";
import { isSinglePlaygroundFile, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import {
  ZigPlaygroundClient,
  ZigPlaygroundServiceError,
  type ZigPlaygroundServiceErrorKind,
} from "./client";
import {
  zigFormatResultToConsoleLines,
  zigFormatServiceErrorToConsoleLines,
  zigFormatStaleConsoleLines,
  zigFormatStartedConsoleLines,
  zigRunResultToConsoleLines,
  zigRunServiceErrorToConsoleLines,
  zigRunStartedConsoleLines,
} from "./console";
import { collectZigPlaygroundFiles } from "./files";
import type { ZigPlaygroundRunResult } from "./types";

const SINGLE_FILE_FORMAT_LINE = "[zig-fmt error] Zig lessons format a single main.zig file";

/**
 * Zig lessons: Run and Format (`zig fmt`) remotely through the Zig Playground
 * proxy, with no sign-in needed. The upstream compiles one root source file
 * from a single text body, so lessons run exactly one main.zig.
 */
export const ZIG_PLAYGROUND: PlaygroundLanguage<
  ZigPlaygroundClient,
  ZigPlaygroundServiceErrorKind,
  ZigPlaygroundRunResult
> = {
  label: "zig",
  client: {
    create: () => new ZigPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: ZigPlaygroundServiceError,
  },
  collectFiles: collectZigPlaygroundFiles,
  run: {
    commandLabel: "zig run main.zig",
    rejectFiles: (files) =>
      isSinglePlaygroundFile(files, PLAYGROUND_SOURCE_RULES.zig.entryPath)
        ? null
        : "[zig-run error] Zig lessons run a single main.zig file",
    execute: (client, files) => client.run(files),
    startedLines: zigRunStartedConsoleLines,
    resultLines: zigRunResultToConsoleLines,
    serviceErrorLines: zigRunServiceErrorToConsoleLines,
  },
  format: {
    monacoLanguageId: "zig",
    providerDisplayName: "zig fmt (Zig Playground)",
    commandLabel: "zig fmt main.zig",
    busyLabel: "main.zig is formatting",
    buttonTitle: "Format main.zig with zig fmt (Shift+Alt+F)",
    readOnlyLine: "[zig-fmt error] This shared lesson is read-only",
    rejectFiles: (files) =>
      isSinglePlaygroundFile(files, PLAYGROUND_SOURCE_RULES.zig.entryPath)
        ? null
        : SINGLE_FILE_FORMAT_LINE,
    // `.zon` files are Zig-highlighted (inferLanguageFromPath maps them), so
    // the provider fires for a build.zig.zon model that the collector never
    // submits. That is not a concurrent edit, so it gets the single-file
    // message rather than the stale one. Go and Rust need no such line: their
    // collectors cover their language's whole extension set.
    unsubmittedModelLine: SINGLE_FILE_FORMAT_LINE,
    execute: (client, files) => client.format(files),
    startedLines: zigFormatStartedConsoleLines,
    resultLines: (changedPaths) => zigFormatResultToConsoleLines(changedPaths.length > 0),
    staleLines: zigFormatStaleConsoleLines,
    serviceErrorLines: zigFormatServiceErrorToConsoleLines,
  },
};
