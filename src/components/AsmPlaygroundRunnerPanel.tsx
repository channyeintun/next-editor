import { Cpu } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import {
  AsmPlaygroundClient,
  AsmPlaygroundServiceError,
  type AsmPlaygroundServiceErrorKind,
} from "../runtime/asmPlayground/client";
import {
  ASM_CONSOLE_TAG_PATTERN,
  asmRunConsoleLines,
  asmRunServiceErrorToConsoleLines,
  asmRunStartedConsoleLines,
} from "../runtime/asmPlayground/console";
import { collectAsmPlaygroundFiles } from "../runtime/asmPlayground/files";
import type { AsmPlaygroundRunResult } from "../runtime/asmPlayground/types";
import { STUDIO_ASM_DOCK_TARGET_ID } from "../studio/targets";

/**
 * x86-64 assembly lessons. Like Kite's and unlike the proxied languages,
 * **there is no service** and not even a compiler to load: the assembler and
 * the machine are TypeScript in `src/core/x86`, so Run assembles and executes
 * in this page and answers without a network round trip — no proxy, no sign-in
 * button, no rate limit, and no lesson that breaks because a public playground
 * went down. That is why assembly has no sign-in where the proxied languages
 * have one, and why cancelling disposes of the pending run instead of aborting
 * a request. It has no Format either, for the plainer reason that assembly has
 * no formatter to run.
 *
 * There is no linker here, so a run assembles `main.asm` alone (the client says
 * so plainly when several files exist and none is named that). After a run the
 * console also prints the registers the program changed, because an assembly
 * lesson is usually *about* the register file — and because those lines go
 * through the same console state as every other line, a recording captures them
 * and playback replays them with no live execution.
 *
 * CodeEditor loads this module lazily, so `src/core/x86` is fetched only for an
 * assembly lesson.
 */
export const ASM_RUNNER: PlaygroundRunnerLanguage<
  AsmPlaygroundClient,
  AsmPlaygroundServiceErrorKind,
  AsmPlaygroundRunResult
> = {
  scrollSurface: "asm-runner",
  dockTargetId: STUDIO_ASM_DOCK_TARGET_ID,
  runnerTab: { label: "Assembly Runner", icon: Cpu },
  consoleTags: { pattern: ASM_CONSOLE_TAG_PATTERN },
  signIn: null,
  client: {
    create: () => new AsmPlaygroundClient(),
    stop: (client) => client.dispose(),
    ServiceError: AsmPlaygroundServiceError,
  },
  collectFiles: collectAsmPlaygroundFiles,
  run: {
    commandLabel: "nasm -f elf64 main.asm && ld -o main main.o && ./main",
    // No rejectFiles: which file is the program is the client's call, so a
    // workspace it cannot resolve comes back as its own message rather than a
    // guess here.
    execute: (client, files) => client.run({ files }),
    startedLines: asmRunStartedConsoleLines,
    resultLines: asmRunConsoleLines,
    serviceErrorLines: asmRunServiceErrorToConsoleLines,
  },
  format: null,
};

function AsmPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={ASM_RUNNER} />;
}

export default AsmPlaygroundRunnerPanel;
