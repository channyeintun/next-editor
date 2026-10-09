import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Kotlin lesson, and its limits. */
export const KOTLIN_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Kotlin only. This lesson's Kotlin files compile and run remotely " +
    "on the Kotlin Playground (JVM target) when the user presses Run in the Kotlin " +
    "Runner panel — you cannot execute code yourself.",
  specifics:
    "Keep solutions within Kotlin Playground constraints (sandboxed execution, no " +
    "network access, no stdin, only the Kotlin/Java standard library, limited compute " +
    "time).",
};
