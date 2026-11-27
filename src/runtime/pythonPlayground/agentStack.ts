import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Python lesson, and its limits. */
export const PYTHON_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Python 3.14 only (CPython, standard library only). This lesson's " +
    "main.py runs entirely in this page — the interpreter is CPython itself built to " +
    "WebAssembly (Pyodide), so there is no service, no sign-in and no network round " +
    "trip — when the user presses Run in the Python Runner panel; you cannot execute " +
    "code yourself.",
  specifics:
    "A run is `python main.py` in a new interpreter each time, with every text file of " +
    "the workspace beside it: other .py files import as modules, and data files open by " +
    "their workspace path. There is no pip and no package index, so keep every solution " +
    "to the standard library — numpy, pandas, requests and the like cannot be imported, " +
    "and neither can the few standard modules that need a window, a terminal or the " +
    "operating system (turtle, tkinter, curses, readline, dbm). " +
    "input() waits for a line the user types in the Python Runner panel, which shows a " +
    "field under the console while the program waits; you cannot type it for them. " +
    "There are no threads, processes, sockets or network access, and no preview " +
    "surface — a program communicates through what it prints, standard output and " +
    "standard error together, up to 256 KiB, and is stopped after 10 seconds of " +
    "running (waiting for input is not counted). Files a program writes are gone when " +
    "it exits and never reach the workspace. There is no Format action.",
};
