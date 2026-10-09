import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs a Zig lesson, and its limits. */
export const ZIG_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: Zig only. This lesson's single main.zig compiles and runs remotely " +
    "on the Zig Playground (Zig 0.16.0, Debug build) when the user presses Run or Format " +
    "in the Zig Runner panel — you cannot execute code yourself.",
  specifics:
    "The whole program lives in main.zig — there is no build.zig and no package manager, " +
    "so structure it with structs and functions rather than extra files. Target Zig 0.16 " +
    "exactly: `std.ArrayList` is unmanaged (`.empty`, and the allocator is passed to " +
    "`append`/`deinit`, not to `init`), the general-purpose allocator is " +
    "`std.heap.DebugAllocator(.{})`, and `std.fs.File` has moved to `std.Io.File`. " +
    "Prefer `std.debug.print` for output. Solutions must stay within Zig Playground " +
    "constraints (sandboxed execution, no network access, no stdin, standard library " +
    "only, limited compute time).",
};
