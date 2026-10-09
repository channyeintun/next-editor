import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Go lesson, and its limits. */
export const GO_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Go only. This lesson's Go files compile and run remotely on the " +
    "Go Playground when the user presses Run or Format in the Go Runner panel — you " +
    "cannot execute code yourself.",
  specifics:
    "Keep solutions within Go Playground constraints (sandboxed execution, no network " +
    "access, limited compute time).",
};
