import { describe, expect, it } from "vitest";
import type { WorkspaceProject } from "../types/workspace";
import { buildSystemPrompt } from "./systemPrompt";

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
});
