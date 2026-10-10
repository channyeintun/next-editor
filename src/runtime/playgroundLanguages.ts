import type { WorkspaceExecutionKind } from "../types/lessonTypes";
import { ASM_PLAYGROUND } from "./asmPlayground/runner";
import { GO_PLAYGROUND } from "./goPlayground/runner";
import { HASKELL_PLAYGROUND } from "./haskellPlayground/runner";
import { KITE_PLAYGROUND } from "./kitePlayground/runner";
import { KOTLIN_PLAYGROUND } from "./kotlinPlayground/runner";
import type { PlaygroundLanguage } from "./playgroundLanguage";
import { RUST_PLAYGROUND } from "./rustPlayground/runner";
import { ZIG_PLAYGROUND } from "./zigPlayground/runner";

/** Every execution kind a Playground language runs: all of them but the WebContainer. */
export type PlaygroundExecutionKind = Exclude<WorkspaceExecutionKind, "webcontainer">;

/**
 * Every Playground language, by the execution kind that runs it, for a caller
 * that drives whichever one a lesson names through the same steps — the
 * studio's `runtime.run` engine — instead of one language through its own
 * runner panel. A `Record` over the kinds, so a Playground backend added to
 * `WorkspaceExecutionKind` fails the typecheck until it has a language here.
 *
 * The generics are erased: a lookup by kind cannot carry each language's own
 * client, error and result types. Each entry is still checked against its own
 * `PlaygroundLanguage<…>` where it is declared, and a caller only ever hands an
 * entry's `run` the client and result of that same entry.
 *
 * Importing this loads every language's client — the x86 machine among them,
 * through assembly's — so the editor never does: each runner panel imports only
 * its own language, which keeps the assembly chunk lazy for every other lesson.
 */
export const PLAYGROUND_LANGUAGES: Record<
  PlaygroundExecutionKind,
  PlaygroundLanguage<any, any, any>
> = {
  "go-playground": GO_PLAYGROUND,
  "kotlin-playground": KOTLIN_PLAYGROUND,
  "rust-playground": RUST_PLAYGROUND,
  "zig-playground": ZIG_PLAYGROUND,
  "haskell-playground": HASKELL_PLAYGROUND,
  "kite-playground": KITE_PLAYGROUND,
  "asm-playground": ASM_PLAYGROUND,
};
