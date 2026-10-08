import { asmRunConsoleLines } from "../runtime/asmPlayground/console";
import { goRunResultToConsoleLines } from "../runtime/goPlayground/console";
import { haskellRunResultToConsoleLines } from "../runtime/haskellPlayground/console";
import { kiteRunResultToConsoleLines } from "../runtime/kitePlayground/console";
import { kotlinRunResultToConsoleLines } from "../runtime/kotlinPlayground/console";
import { rustRunResultToConsoleLines } from "../runtime/rustPlayground/console";
import { zigRunResultToConsoleLines } from "../runtime/zigPlayground/console";
import type { StudioPlaygroundRuntime } from "./plan";

/**
 * The console lines a Playground lesson's pinned run prints after its header
 * line — the program's output plus whatever the runner adds around it (vet and
 * compiler warnings first, stderr, an assembly lesson's registers, the exit
 * line) — built by the same console builders the fixture run uses
 * (playgroundRuntime's `runFixtureResult`). Pure: no client is loaded, so the
 * Director CLI can check `console.point` targets against it.
 */
export function fixtureRunConsoleLines(runtime: StudioPlaygroundRuntime): string[] {
  switch (runtime.kind) {
    case "go-playground":
      return goRunResultToConsoleLines(runtime.fixture.result);
    case "kotlin-playground":
      return kotlinRunResultToConsoleLines(runtime.fixture.result);
    case "rust-playground":
      return rustRunResultToConsoleLines(runtime.fixture.result);
    case "zig-playground":
      return zigRunResultToConsoleLines(runtime.fixture.result);
    case "haskell-playground":
      return haskellRunResultToConsoleLines(runtime.fixture.result);
    case "kite-playground":
      return kiteRunResultToConsoleLines(runtime.fixture.result);
    case "asm-playground":
      return asmRunConsoleLines(runtime.fixture.result);
  }
}

/** A line as the console shows it: a tab advances to the next 8-column stop. */
export function expandConsoleTabs(line: string): string {
  let shown = "";
  for (const character of line) {
    shown += character === "\t" ? " ".repeat(8 - (shown.length % 8)) : character;
  }
  return shown;
}
