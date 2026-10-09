/**
 * How a playground runtime describes itself to the coding agent. Each
 * `<lang>Playground/agentStack.ts` owns its toolchain's facts (version, entry
 * file, API changes, limits) beside the client that runs it, so a playground
 * change edits its own runtime; agent/systemPrompt.ts only wraps the two parts
 * in the policy every playground shares.
 */
export interface PlaygroundAgentStack {
  /** What runs the lesson's code and how the user starts it; opens the paragraph. */
  lead: string;
  /** This toolchain's own constraints, placed after the shared no-runtime sentence. */
  specifics: string;
}
