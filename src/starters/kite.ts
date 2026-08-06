import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Kite lesson starter: a single-file console program.
 *
 * Unlike the Go, Kotlin and Rust starters, **nothing leaves the page**. `kitec`
 * is a Rust program — normally a native binary you install — and Rust builds for
 * WebAssembly too, so a Wasm build of that same compiler instantiates in the
 * browser and answers without a service: no proxy, no sign-in, no rate limit,
 * and no lesson that stops working because a public playground is down.
 *
 * A Kite module is a directory, so sibling `.kite` files belong to the same
 * program; a run compiles `main.kite`.
 */
export function createStarterKiteWorkspace(): WorkspaceProject {
  const files = {
    "main.kite": createWorkspaceFile(
      "main.kite",
      `// Kite lesson workspace
//
// Press Run to compile and run main.kite. This page loads a WebAssembly build
// of the Kite compiler, so nothing is sent anywhere. Press Format any time to
// lay the file out the one way.

struct User {
    name: str
    var logins: int
}

impl User {
    fn describe(self) -> str {
        let times = if self.logins == 1 { "time" } else { "times" }
        return "\\(self.name) has signed in \\(self.logins) \\(times)"
    }
}

/// A quotient, or a reason there is not one.
///
/// Every failure in Kite is a value. The compiler will not let the result be
/// read until the error has been checked — so the failure path is written on
/// the line where it happens rather than discovered later.
fn divide(a: int, b: int) -> (int, error) {
    if b == 0 {
        return _, errors.new("nothing divides by zero")
    }
    return a / b, nil
}

fn main() {
    let ada = User{ name: "Ada", logins: 3 }
    io.print(ada.describe())

    // Edit these and press Run again. A slice has no text form of its own —
    // \`int\`, \`float\`, \`bool\` and \`str\` render themselves and nothing else
    // does — so it is turned into one here rather than guessed at.
    let squares = map([1, 2, 3, 4, 5], |n: int| n * n)
    io.print("Squares: \\(join(map(squares, |n: int| "\\(n)"), ", "))")

    let (half, err) = divide(10, 2)
    if err != nil {
        io.error("failed: \\(err.message())")
        return
    }
    io.print("Ten halved is \\(half)")

    // Try moving this print above the check below and press Run: the
    // compiler refuses it, because on the failure path there is no value.
    let (bad, berr) = divide(1, 0)
    if berr != nil {
        io.print("As expected: \\(berr.message())")
    }
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Kite Lesson

1. Open \`main.kite\` and press **Run**. This page loads a WebAssembly build of
   the Kite compiler, so it runs here — nothing is sent to a server.
2. Press **Format** any time to lay the source out the one way. Kite has one
   layout and no options.
3. A Kite module is a *directory*: sibling \`.kite\` files are part of the same
   program, and a run compiles \`main.kite\`.

## Two things to try

**Read a value before checking its error.** Move \`io.print(half)\` above the
\`if err != nil\` and press Run. The compiler refuses it — on a failure path
there is no value at all, not a zero.

**Drop an error.** Call a function that returns an \`error\` on a line of its
own. That is rejected too: an error you never look at is the failure the
language exists to prevent.
`,
    ),
  };

  return {
    id: "kite-workspace",
    name: "Kite Lesson",
    lessonType: "kite",
    entryFilePath: "main.kite",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
