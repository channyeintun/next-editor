import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Rust lesson starter: a single-file console program that compiles and
 * runs remotely through the Rust Playground proxy on an explicit Run action
 * (stable channel, 2024 edition, debug profile). The upstream compiles one
 * crate from one source string, so the whole lesson lives in main.rs — use
 * inline `mod` blocks for structure. No package.json, dev server, or
 * WebContainer boot — the workspace stays local until Run.
 */
export function createStarterRustWorkspace(): WorkspaceProject {
  const files = {
    "main.rs": createWorkspaceFile(
      "main.rs",
      `// Rust lesson workspace
//
// Press Run to compile main.rs on the Rust Playground (stable, 2024
// edition) and print the program's output in the Rust Runner below.
// Press Format any time to run rustfmt. There is no network, filesystem,
// or stdin — everything happens in memory.
//
// The whole lesson lives in this one file. Use inline modules to keep
// larger programs organized, like the \`greetings\` module here.

mod greetings {
    pub fn greet(name: &str) -> String {
        format!("Hello, {name}!")
    }
}

#[derive(Debug)]
struct User {
    name: String,
    login_count: u32,
}

impl User {
    fn describe(&self) -> String {
        let times = if self.login_count == 1 { "time" } else { "times" };
        format!("{} has signed in {} {times}", self.name, self.login_count)
    }
}

fn main() {
    println!("{}", greetings::greet("Rust"));

    // Explore the language: edit these and press Run again.
    let squares: Vec<u32> = (1..=5).map(|n| n * n).collect();
    println!("Squares: {squares:?}");

    let user = User { name: String::from("Ada"), login_count: 3 };
    println!("{}", user.describe());
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Rust Lesson

1. Open \`main.rs\` and press **Run** — the program compiles on the Rust
   Playground (stable channel, 2024 edition) and its output appears in the
   Rust Runner.
2. Press **Format** any time — it runs rustfmt on \`main.rs\`.
3. The whole lesson lives in \`main.rs\`; use inline \`mod\` blocks to
   structure larger programs.
4. The sandbox has no network, filesystem, or stdin, and programs that run
   too long are stopped.
`,
    ),
  };

  return {
    id: "rust-workspace",
    name: "Rust Lesson",
    lessonType: "rust",
    entryFilePath: "main.rs",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
