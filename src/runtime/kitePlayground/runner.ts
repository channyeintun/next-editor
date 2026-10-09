import type { PlaygroundLanguage } from "../playgroundLanguage";
import {
  KitePlaygroundClient,
  KitePlaygroundServiceError,
  type KitePlaygroundServiceErrorKind,
} from "./client";
import {
  kiteFormatResultToConsoleLines,
  kiteFormatServiceErrorToConsoleLines,
  kiteFormatStaleConsoleLines,
  kiteFormatStartedConsoleLines,
  kiteRunResultToConsoleLines,
  kiteRunServiceErrorToConsoleLines,
  kiteRunStartedConsoleLines,
} from "./console";
import { collectKitePlaygroundFiles } from "./files";
import type { KitePlaygroundRunResult } from "./types";

/**
 * Kite lessons, where **there is no service**. `kitec` is a Rust program,
 * normally a native binary, and Rust builds for WebAssembly too — so Run and
 * Format instantiate a Wasm build of that same compiler in a worker of this page
 * (kept between runs, so only the first Run pays for the load) and answer
 * without a network round trip: no proxy, no rate limit, and no lesson that
 * breaks because a public playground is down. That is also why cancelling
 * terminates a busy compiler worker instead of aborting a request — the only way
 * to stop a program that never returns.
 *
 * A Kite module is a directory, so every `.kite` file in the workspace is part
 * of the same program: Format touches all of them, and a run compiles
 * `main.kite` (the client says so plainly when several files exist and none is
 * named that).
 */
export const KITE_PLAYGROUND: PlaygroundLanguage<
  KitePlaygroundClient,
  KitePlaygroundServiceErrorKind,
  KitePlaygroundRunResult
> = {
  label: "kite",
  client: {
    create: () => new KitePlaygroundClient(),
    stop: (client) => client.dispose(),
    ServiceError: KitePlaygroundServiceError,
  },
  collectFiles: collectKitePlaygroundFiles,
  run: {
    commandLabel: "kitec run main.kite",
    // No rejectFiles: which file is the program is the client's call, so a
    // workspace the compiler cannot resolve comes back as its own message
    // rather than a guess here.
    execute: (client, files) => client.run({ files }),
    startedLines: kiteRunStartedConsoleLines,
    resultLines: kiteRunResultToConsoleLines,
    serviceErrorLines: kiteRunServiceErrorToConsoleLines,
  },
  format: {
    // `.kite` files carry the first-party `kite` language id registered by
    // monaco/kiteLanguage.ts. This used to register against `rust`, because
    // that is the grammar Kite borrowed before it had one of its own.
    monacoLanguageId: "kite",
    providerDisplayName: "kitec fmt (Kite)",
    commandLabel: "kitec fmt main.kite",
    busyLabel: "main.kite is formatting",
    buttonTitle: "Format main.kite with kitec fmt (Shift+Alt+F)",
    readOnlyLine: "[kitefmt error] This shared lesson is read-only",
    rejectFiles: (files) =>
      files.length === 0 ? "[kitefmt error] Add a .kite file to format this lesson" : null,
    execute: (client, files) => client.format({ files }),
    startedLines: kiteFormatStartedConsoleLines,
    resultLines: (changedPaths) => kiteFormatResultToConsoleLines(changedPaths.length > 0),
    staleLines: kiteFormatStaleConsoleLines,
    serviceErrorLines: kiteFormatServiceErrorToConsoleLines,
  },
};
