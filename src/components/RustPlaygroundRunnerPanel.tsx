import { Cog } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import {
  RustPlaygroundClient,
  RustPlaygroundServiceError,
  type RustPlaygroundServiceErrorKind,
} from "../runtime/rustPlayground/client";
import {
  RUST_CONSOLE_TAG_PATTERN,
  rustFormatResultToConsoleLines,
  rustFormatServiceErrorToConsoleLines,
  rustFormatStaleConsoleLines,
  rustFormatStartedConsoleLines,
  rustRunResultToConsoleLines,
  rustRunServiceErrorToConsoleLines,
  rustRunStartedConsoleLines,
} from "../runtime/rustPlayground/console";
import { collectRustPlaygroundFiles } from "../runtime/rustPlayground/files";
import type { RustPlaygroundRunResult } from "../runtime/rustPlayground/types";
import { isSinglePlaygroundFile, PLAYGROUND_SOURCE_RULES } from "../runtime/playgroundFiles";
import { runnerDockTargetId } from "../studio/targets";

/**
 * Rust lessons: Run and Format (`rustfmt`) remotely through the Rust
 * Playground proxy, with no sign-in needed. The upstream compiles one crate
 * from a single source string, so lessons run exactly one main.rs.
 */
export const RUST_RUNNER: PlaygroundRunnerLanguage<
  RustPlaygroundClient,
  RustPlaygroundServiceErrorKind,
  RustPlaygroundRunResult
> = {
  scrollSurface: "rust-runner",
  dockTargetId: runnerDockTargetId("rust-runner"),
  runnerTab: { label: "Rust Runner", icon: Cog },
  consoleTags: { pattern: RUST_CONSOLE_TAG_PATTERN },
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

function RustPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={RUST_RUNNER} />;
}

export default RustPlaygroundRunnerPanel;
