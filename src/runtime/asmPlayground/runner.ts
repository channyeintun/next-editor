import type { PlaygroundLanguage } from "../playgroundLanguage";
import {
  AsmPlaygroundClient,
  AsmPlaygroundServiceError,
  pickAsmRunEntry,
  type AsmPlaygroundServiceErrorKind,
} from "./client";
import {
  asmRunConsoleLines,
  asmRunServiceErrorToConsoleLines,
  asmRunStartedConsoleLines,
} from "./console";
import { collectAsmPlaygroundFiles } from "./files";
import type { AsmPlaygroundRunResult } from "./types";

/**
 * x86-64 assembly lessons. Like Kite's and unlike the proxied languages,
 * **there is no service** and not even a compiler to load: the assembler and
 * the machine are TypeScript in `src/core/x86`, so Run assembles and executes
 * in this page and answers without a network round trip — no proxy, no rate
 * limit, and no lesson that breaks because a public playground went down. That
 * is also why cancelling disposes of the pending run instead of aborting a
 * request. It has no Format either, for the plainer reason that assembly has no
 * formatter to run.
 *
 * There is no linker here, so a run assembles `main.asm` alone (the client says
 * so plainly when several files exist and none is named that). After a run the
 * console also prints the registers the program changed, because an assembly
 * lesson is usually *about* the register file — and because those lines go
 * through the same console state as every other line, a recording captures them
 * and playback replays them with no live execution.
 */
export const ASM_PLAYGROUND: PlaygroundLanguage<
  AsmPlaygroundClient,
  AsmPlaygroundServiceErrorKind,
  AsmPlaygroundRunResult
> = {
  label: "asm",
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
    pickEntry: pickAsmRunEntry,
    execute: (client, files) => client.run({ files }),
    startedLines: asmRunStartedConsoleLines,
    resultLines: asmRunConsoleLines,
    serviceErrorLines: asmRunServiceErrorToConsoleLines,
  },
  format: null,
};
