import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Kite lesson, and its limits. */
export const KITE_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Kite only. This lesson's .kite files compile and run entirely in " +
    "this page — the Kite compiler itself is built to WebAssembly, so there is no " +
    "service, no sign-in, and no network round trip — when the user presses Run or " +
    "Format in the Kite Runner panel; you cannot execute code yourself.",
  specifics:
    "A Kite module is a directory, so every .kite file beside the entry belongs to the " +
    "same program and a run compiles main.kite. Kite targets WasmGC and has no package " +
    "ecosystem here: keep solutions to the language and its std/ modules.",
};
