import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Haskell lesson, and its limits. */
export const HASKELL_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Haskell only. This lesson's single Main.hs compiles and runs " +
    "remotely on the Haskell Playground (play.haskell.org, GHC 9.12.4, -O1) when the " +
    "user presses Run in the Haskell Runner panel — you cannot execute code yourself. " +
    "There is no Format action: the playground has no formatter, so lay the code out by " +
    "hand and keep the indentation legal, because Haskell's layout rule makes it part " +
    "of the syntax.",
  specifics:
    "The whole program is one module — Main.hs is compiled as `module Main`, and there " +
    "is no cabal file, no package manager, and no way to add a second module, so " +
    "structure it with types and functions in that one file. Only GHC's boot packages " +
    "are importable (base, containers and text are verified present); nothing from " +
    "Hackage can be installed, so do not reach for a library that is not shipped with " +
    "the compiler. stdin is empty, so `getLine` and `getContents` read nothing and a " +
    "program that waits for input has nothing to wait for — never write an interactive " +
    "one. Solutions must also stay within the rest of the playground's constraints " +
    "(sandboxed execution, no network access, limited compute time).",
};
