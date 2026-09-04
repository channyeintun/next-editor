import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../types/workspace";
import {
  buildSystemPrompt,
  MAX_SESSION_MEMORY_FILE_CHARS,
  MAX_SESSION_MEMORY_TOTAL_CHARS,
} from "./systemPrompt";

function makeProject(): WorkspaceProject {
  return {
    id: "test",
    name: "Test",
    lessonType: "react",
    entryFilePath: "src/App.tsx",
    folders: ["src"],
    files: {
      "src/App.tsx": {
        path: "src/App.tsx",
        name: "App.tsx",
        language: "typescript",
        content: "export default function App() {}",
      },
    },
  };
}

function makeGoProject(): WorkspaceProject {
  return {
    id: "test-go",
    name: "Test Go",
    lessonType: "go",
    entryFilePath: "main.go",
    folders: [],
    files: {
      "main.go": {
        path: "main.go",
        name: "main.go",
        language: "go",
        content: "package main",
      },
    },
  };
}

describe("buildSystemPrompt", () => {
  it("states the WebContainer-supported stack and forbids other runtimes", () => {
    const prompt = buildSystemPrompt(makeProject(), { toolNames: ["read"], hasBash: true });

    expect(prompt).toContain("HTML, CSS, JavaScript, TypeScript, Node.js");
    expect(prompt).toContain("WebContainer");
    // A couple of the explicitly out-of-scope runtimes must be named so the model
    // doesn't reach for them.
    expect(prompt).toContain("Python");
    expect(prompt).toContain("native binaries");
  });

  it("describes the Go Playground stack for go lessons without WebContainer guidance", () => {
    const prompt = buildSystemPrompt(makeGoProject(), {
      toolNames: ["read", "edit"],
      hasBash: false,
    });

    expect(prompt).toContain("Supported stack: Go only");
    expect(prompt).toContain("Go Playground");
    expect(prompt).toContain("you cannot execute code yourself");
    expect(prompt).toContain("Lesson type: go");
    expect(prompt).not.toContain("WebContainer");
    expect(prompt).not.toContain("Node.js ecosystem");
  });

  // Every Playground language needs its own branch: without one the lesson
  // falls through to the WebContainer stack and the agent is told the lesson's
  // own language is an off-limits runtime.
  it.each([
    ["go", "main.go", "Supported stack: Go only"],
    ["kotlin", "Main.kt", "Supported stack: Kotlin only"],
    ["rust", "main.rs", "Supported stack: Rust only"],
    ["kite", "main.kite", "Supported stack: Kite only"],
    ["zig", "main.zig", "Supported stack: Zig only"],
    ["haskell", "Main.hs", "Supported stack: Haskell only"],
    ["asm", "main.asm", "Supported stack: x86-64 assembly only"],
  ] as const)(
    "describes the %s Playground stack, never the WebContainer one",
    (lessonType, entryFilePath, expectedStack) => {
      const prompt = buildSystemPrompt(
        {
          id: `test-${lessonType}`,
          name: `Test ${lessonType}`,
          lessonType,
          entryFilePath,
          folders: [],
          files: {
            [entryFilePath]: {
              path: entryFilePath,
              name: entryFilePath,
              language: lessonType,
              content: "",
            },
          },
        },
        { toolNames: ["read", "edit"], hasBash: false },
      );

      expect(prompt).toContain(expectedStack);
      expect(prompt).toContain("you cannot execute code yourself");
      expect(prompt).toContain(`Lesson type: ${lessonType}`);
      expect(prompt).not.toContain("WebContainer");
      expect(prompt).not.toContain("Node.js ecosystem");
    },
  );

  // kite-web runs in the WebContainer, so it never reaches a playground branch.
  // It used to fall through to the generic stack paragraph, which calls the
  // supported stack JS/TS "only" and never mentions the .kite sources the
  // lesson is actually written in.
  it("describes the Kite toolchain for kite-web lessons, keeping the WebContainer framing", () => {
    const prompt = buildSystemPrompt(
      {
        id: "test-kite-web",
        name: "Test Kite web",
        lessonType: "kite-web",
        entryFilePath: "src/main.kite",
        folders: ["src"],
        files: {
          "src/main.kite": {
            path: "src/main.kite",
            name: "main.kite",
            language: "kite",
            content: "",
          },
        },
      },
      // No bash, so the pnpm rule can only come from the stack paragraph.
      { toolNames: ["read", "edit"], hasBash: false },
    );

    expect(prompt).toContain("vite-plugin-kite");
    expect(prompt).toContain(".kite");
    expect(prompt).toContain("Use pnpm exclusively");
    // Still a WebContainer lesson: unlike the playground branches above, the
    // dev server and preview framing must stay.
    expect(prompt).toContain("WebContainer");
    expect(prompt).not.toContain("JS/TS libraries and frameworks only");
    expect(prompt).not.toContain("Keep every solution within the web/Node.js ecosystem");
  });

  it("lists the enabled tools and workspace context", () => {
    const prompt = buildSystemPrompt(makeProject(), {
      toolNames: ["read", "edit"],
      hasBash: false,
    });

    expect(prompt).toContain("- read");
    expect(prompt).toContain("- edit");
    expect(prompt).toContain("Lesson type: react");
    expect(prompt).toContain("Entry file: src/App.tsx");
    expect(prompt).toContain("src/App.tsx");
  });

  it("omits the bash note when bash is disabled", () => {
    const withBash = buildSystemPrompt(makeProject(), { toolNames: ["bash"], hasBash: true });
    const withoutBash = buildSystemPrompt(makeProject(), { toolNames: [], hasBash: false });

    expect(withBash).toContain("Bash/WebContainer safety rules (strict)");
    expect(withBash).toContain("The bash tool runs in");
    expect(withoutBash).not.toContain("Bash/WebContainer safety rules (strict)");
    expect(withoutBash).not.toContain("The bash tool runs in");
  });

  it("strictly constrains bash to safe, bounded WebContainer commands", () => {
    const prompt = buildSystemPrompt(makeProject(), { toolNames: ["bash"], hasBash: true });

    expect(prompt).toContain("Run only short, bounded, foreground commands");
    expect(prompt).toContain("Never start background processes");
    expect(prompt).toContain("Never start persistent or watch-mode processes");
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("repo-wide typechecks");
    expect(prompt).toContain("full test suites");
    expect(prompt).toContain("Use pnpm exclusively");
    expect(prompt).toContain("Never use npm, npx, yarn, bun");
    expect(prompt).toContain("Do not pipe, redirect, or wrap a dev-server/watch command");
    expect(prompt).toContain("process cancellation is best-effort");
    expect(prompt).toContain("Stop, kill, or a timeout may not promptly settle");
  });

  it("directs runtime debugging through the read-only observation tools", () => {
    const prompt = buildSystemPrompt(makeProject(), {
      toolNames: ["runtime_diagnostics", "inspect_preview", "capture_preview"],
      hasBash: true,
    });

    expect(prompt).toContain("Use runtime_diagnostics");
    expect(prompt).toContain("Use inspect_preview");
    expect(prompt).toContain("Use capture_preview");
    expect(prompt).toContain("untrusted project data");
    expect(prompt).toContain("These tools are read-only");
    expect(prompt).toContain("do not support clicking, typing");
  });

  it("bounds root session-memory files before adding them to model instructions", () => {
    const project = makeProject();
    project.files["AGENTS.md"] = {
      path: "AGENTS.md",
      name: "AGENTS.md",
      language: "markdown",
      content: `${"A".repeat(MAX_SESSION_MEMORY_FILE_CHARS + 1_000)}AGENTS_TAIL`,
    };
    project.files["CLAUDE.md"] = {
      path: "CLAUDE.md",
      name: "CLAUDE.md",
      language: "markdown",
      content: `${"C".repeat(MAX_SESSION_MEMORY_FILE_CHARS + 1_000)}CLAUDE_TAIL`,
    };

    const prompt = buildSystemPrompt(project, { toolNames: ["read"], hasBash: false });
    const agentsContent = prompt.match(/<AGENTS\.md>\n([\s\S]*?)\n<\/AGENTS\.md>/)?.[1] ?? "";
    const claudeContent = prompt.match(/<CLAUDE\.md>\n([\s\S]*?)\n<\/CLAUDE\.md>/)?.[1] ?? "";

    expect(agentsContent.length).toBeLessThanOrEqual(MAX_SESSION_MEMORY_FILE_CHARS);
    expect(claudeContent.length).toBeLessThanOrEqual(MAX_SESSION_MEMORY_FILE_CHARS);
    expect(agentsContent.length + claudeContent.length).toBeLessThanOrEqual(
      MAX_SESSION_MEMORY_TOTAL_CHARS,
    );
    expect(prompt).toContain("Session memory truncated to fit the prompt budget.");
    expect(prompt).not.toContain("AGENTS_TAIL");
    expect(prompt).not.toContain("CLAUDE_TAIL");
  });
});
