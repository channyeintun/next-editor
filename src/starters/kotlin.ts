import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Kotlin lesson starter: a small multi-file console program that compiles
 * and runs remotely through the Kotlin Playground proxy on an explicit Run
 * action. No package.json, dev server, or WebContainer boot — the workspace
 * stays local until Run.
 */
export function createStarterKotlinWorkspace(): WorkspaceProject {
  const files = {
    "Main.kt": createWorkspaceFile(
      "Main.kt",
      `// Kotlin lesson workspace
//
// Press Run to compile every .kt file together on the Kotlin Playground
// (JVM) and print the program's output in the Kotlin Runner below.
// There is no network, filesystem, or stdin — everything happens in memory.

fun main() {
    println(greet("Kotlin"))

    // Explore the language: edit these and press Run again.
    val squares = (1..5).map { it * it }
    println("Squares: $squares")

    val user = User(name = "Ada", loginCount = 3)
    println(user.describe())
}
`,
    ),
    "Greeting.kt": createWorkspaceFile(
      "Greeting.kt",
      `// Every top-level .kt file in this workspace compiles into the same
// program, so Main.kt can call this function directly.

fun greet(name: String): String = "Hello, $name!"
`,
    ),
    "User.kt": createWorkspaceFile(
      "User.kt",
      `// Data classes get equals/hashCode/toString/copy for free.

data class User(val name: String, val loginCount: Int) {
    fun describe(): String =
        "$name has signed in $loginCount time" + if (loginCount == 1) "" else "s"
}
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Kotlin Lesson

1. Open \`Main.kt\` and press **Run** — the program compiles and runs on the
   Kotlin Playground (JVM) and its output appears in the Kotlin Runner.
2. Every top-level \`.kt\` file compiles together into one program, so
   functions and classes in sibling files are visible everywhere.
3. The sandbox has no network, filesystem, or stdin, and only the
   Kotlin/Java standard library is available.
`,
    ),
  };

  return {
    id: "kotlin-workspace",
    name: "Kotlin Lesson",
    lessonType: "kotlin",
    entryFilePath: "Main.kt",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
