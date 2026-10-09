import type { PlaygroundLanguage } from "../playgroundLanguage";
import {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceError,
  type KotlinPlaygroundServiceErrorKind,
} from "./client";
import {
  kotlinRunResultToConsoleLines,
  kotlinRunServiceErrorToConsoleLines,
  kotlinRunStartedConsoleLines,
} from "./console";
import { collectKotlinPlaygroundFiles } from "./files";
import type { KotlinPlaygroundRunResult } from "./types";

/**
 * Kotlin lessons: Run every .kt file remotely through the Kotlin Playground
 * proxy, with no sign-in needed. There is no Format, because the upstream
 * service has no formatter endpoint.
 */
export const KOTLIN_PLAYGROUND: PlaygroundLanguage<
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceErrorKind,
  KotlinPlaygroundRunResult
> = {
  label: "kotlin",
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
