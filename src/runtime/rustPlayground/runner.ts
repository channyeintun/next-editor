import type { PlaygroundLanguage } from "../playgroundLanguage";
import { isSinglePlaygroundFile, PLAYGROUND_SOURCE_RULES } from "../playgroundFiles";
import {
  RustPlaygroundClient,
  RustPlaygroundServiceError,
  type RustPlaygroundServiceErrorKind,
} from "./client";
import {
  rustFormatResultToConsoleLines,
  rustFormatServiceErrorToConsoleLines,
  rustFormatStaleConsoleLines,
  rustFormatStartedConsoleLines,
  rustRunResultToConsoleLines,
  rustRunServiceErrorToConsoleLines,
  rustRunStartedConsoleLines,
} from "./console";
import { collectRustPlaygroundFiles } from "./files";
import type { RustPlaygroundRunResult } from "./types";

/**
 * Rust lessons: Run and Format (`rustfmt`) remotely through the Rust
 * Playground proxy, with no sign-in needed. The upstream compiles one crate
 * from a single source string, so lessons run exactly one main.rs.
 */
export const RUST_PLAYGROUND: PlaygroundLanguage<
  RustPlaygroundClient,
  RustPlaygroundServiceErrorKind,
  RustPlaygroundRunResult
> = {
  label: "rust",
  client: {
    create: () => new RustPlaygroundClient(),
    stop: (client) => client.abort(),
    ServiceError: RustPlaygroundServiceError,
  },
  collectFiles: collectRustPlaygroundFiles,
  run: {
    commandLabel: "cargo run",
    rejectFiles: (files) =>
      isSinglePlaygroundFile(files, PLAYGROUND_SOURCE_RULES.rust.entryPath)
        ? null
        : "[rust-run error] Rust lessons run a single main.rs file",
    execute: (client, files) => client.run(files),
    startedLines: rustRunStartedConsoleLines,
    resultLines: rustRunResultToConsoleLines,
    serviceErrorLines: rustRunServiceErrorToConsoleLines,
  },
  format: {
    monacoLanguageId: "rust",
    providerDisplayName: "rustfmt (Rust Playground)",
    commandLabel: "rustfmt main.rs",
    busyLabel: "main.rs is formatting",
    buttonTitle: "Format main.rs with rustfmt (Shift+Alt+F)",
    readOnlyLine: "[rustfmt error] This shared lesson is read-only",
    rejectFiles: (files) =>
      isSinglePlaygroundFile(files, PLAYGROUND_SOURCE_RULES.rust.entryPath)
        ? null
        : "[rustfmt error] Rust lessons format a single main.rs file",
    execute: (client, files) => client.format(files),
    startedLines: rustFormatStartedConsoleLines,
    resultLines: (changedPaths) => rustFormatResultToConsoleLines(changedPaths.length > 0),
    staleLines: rustFormatStaleConsoleLines,
    serviceErrorLines: rustFormatServiceErrorToConsoleLines,
  },
};
