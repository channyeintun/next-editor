import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Rust lesson, and its limits. */
export const RUST_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Rust only. This lesson's single main.rs compiles and runs remotely " +
    "on the Rust Playground (stable channel, 2024 edition, debug profile) when the user " +
    "presses Run or Format in the Rust Runner panel — you cannot execute code yourself.",
  specifics:
    "The whole program lives in main.rs (use inline `mod` blocks for structure), and " +
    "solutions must stay within Rust Playground constraints (sandboxed execution, no " +
    "network access, no stdin, standard library plus the playground's built-in crates, " +
    "limited compute time).",
};
