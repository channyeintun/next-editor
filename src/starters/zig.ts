import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Zig lesson starter: a single-file console program that compiles and
 * runs remotely through the Zig Playground proxy on an explicit Run action
 * (Zig 0.16.0, Debug build). The upstream compiles one root source file from
 * one text body, so the whole lesson lives in main.zig — Zig has no way to
 * import a sibling file that the sandbox would accept, so structure comes
 * from structs and functions instead. No package.json, dev server, or
 * WebContainer boot — the workspace stays local until Run.
 *
 * The program below is verified against Zig 0.16.0: it compiles, it is
 * already `zig fmt` clean (so the starter never opens with a Format diff
 * waiting), and it prints the output quoted in its own comments. That matters
 * more for Zig than for the other starters, because 0.16 moved the APIs a
 * beginner reaches for first — `std.ArrayList` is unmanaged now, taking the
 * allocator per call, and `std.fs.File` became `std.Io.File`.
 */
export function createStarterZigWorkspace(): WorkspaceProject {
  const files = {
    "main.zig": createWorkspaceFile(
      "main.zig",
      `// Zig lesson workspace
//
// Press Run to compile main.zig on the Zig Playground (0.16.0) and print
// the program's output in the Zig Runner below. Press Format any time to
// run \`zig fmt\`. There is no network, filesystem, or stdin — everything
// happens in memory.
//
// The whole lesson lives in this one file. Zig has no \`import\` for local
// files here, so use structs and functions to keep larger programs tidy.

const std = @import("std");

// A struct is a type. Functions inside it that take the struct are methods.
const User = struct {
    name: []const u8,
    login_count: u32,

    fn describe(self: User) void {
        const times = if (self.login_count == 1) "time" else "times";
        std.debug.print("{s} has signed in {d} {s}\\n", .{ self.name, self.login_count, times });
    }
};

// \`!\` means this function can return an error instead of a value.
fn firstEven(numbers: []const u32) !u32 {
    for (numbers) |n| {
        if (n % 2 == 0) return n;
    }
    return error.NoEvenNumber;
}

pub fn main() !void {
    // Zig never allocates behind your back. When you want heap memory, you
    // ask an allocator for it, and you say when to give it back.
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // A growable list. \`defer\` runs when main ends, so the memory is freed
    // even if something fails in between.
    var squares: std.ArrayList(u32) = .empty;
    defer squares.deinit(allocator);

    for (1..6) |i| {
        const n: u32 = @intCast(i);
        try squares.append(allocator, n * n);
    }

    std.debug.print("Squares: {any}\\n", .{squares.items});

    const user = User{ .name = "Ada", .login_count = 3 };
    user.describe();

    // \`catch\` handles the error case right where it happens.
    const even = firstEven(squares.items) catch 0;
    std.debug.print("First even square: {d}\\n", .{even});
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Zig Lesson

1. Open \`main.zig\` and press **Run** — the program compiles on the Zig
   Playground (Zig 0.16.0) and its output appears in the Zig Runner.
2. Press **Format** any time — it runs \`zig fmt\` on \`main.zig\`.
3. The whole lesson lives in \`main.zig\`. There is no \`build.zig\` and no
   package manager here, so structure larger programs with structs and
   functions in this one file.
4. The sandbox has no network, filesystem, or stdin, and programs that run
   too long are stopped.

## Two things that surprise newcomers

- \`std.debug.print\` writes to **stderr**, not stdout. The runner shows both
  in one stream, so it looks the same here — but it is worth knowing.
- Zig has no hidden memory allocation. Anything that needs heap memory takes
  an \`allocator\` argument, and you decide when to free it. \`defer\` is how you
  make sure that happens.
`,
    ),
  };

  return {
    id: "zig-workspace",
    name: "Zig Lesson",
    lessonType: "zig",
    entryFilePath: "main.zig",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
