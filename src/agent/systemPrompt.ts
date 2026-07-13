import type { WorkspaceProject } from "../types/workspace";

export interface SystemPromptOptions {
  toolNames: string[];
  hasBash: boolean;
}

function buildIntroduction(): string {
  return "You are an expert coding assistant embedded in a browser-based lesson editor. You read, write, search, and edit files in the user's in-browser workspace to help them build, debug, and iterate on lessons. Work collaboratively to understand their intent and provide clear explanations for your changes.";
}

function buildSupportedStack(): string {
  return (
    "Supported stack: HTML, CSS, JavaScript, TypeScript, Node.js, and JS/TS libraries " +
    "and frameworks only. The workspace runs in an in-browser WebContainer, which only " +
    "executes web and Node.js technologies — so do not introduce other languages or " +
    "runtimes (Python, Ruby, Go, Rust, PHP, Java, native binaries, system packages, etc.), " +
    "and do not suggest tooling that depends on them. Keep every solution within the web/" +
    "Node.js ecosystem."
  );
}

function buildPathConventions(): string {
  return "All file paths are workspace-relative with no leading slash and forward slashes only (e.g., src/App.tsx, index.html, components/Button.tsx). There is no OS file system—only the workspace files listed below.";
}

function buildToolList(toolNames: string[]): string {
  const toolLines = toolNames.map((name) => `- ${name}`);
  return `Enabled tools:\n${toolLines.join("\n")}`;
}

function buildBashNote(): string {
  return [
    "Bash/WebContainer safety rules (strict):",
    "- The bash tool runs in a resource-constrained, sandboxed in-browser WebContainer, not a normal host shell. It has no host access, supports only Node.js/web tooling, and may be unavailable on mobile or without cross-origin isolation.",
    "- Run only short, bounded, foreground commands that are expected to exit promptly. Never start background processes or use &, nohup, disown, job control, or similar techniques.",
    "- Never start persistent or watch-mode processes, including dev servers, preview servers, file watchers, or interactive programs. The editor already owns the workspace dev server.",
    "- Never run broad or resource-heavy commands such as npm run build, pnpm build, full-project builds, repo-wide typechecks, or full test suites. Prefer file tools and narrow inspection; run a targeted check only when it is clearly necessary and guaranteed to terminate.",
    "- Use pnpm exclusively for package operations and scripts. Never use npm, npx, yarn, bun, or another package manager, and do not install packages unless the user explicitly asks.",
    "- Do not pipe, redirect, or wrap a dev-server/watch command to capture its output; the pipeline can remain open indefinitely. When WebContainer runtime, preview, or dev-server errors are present in the conversation, diagnose those errors directly instead of launching another server or build.",
    "- WebContainer process cancellation is best-effort: Stop, kill, or a timeout may not promptly settle a blocked process through the browser API. Never rely on cancellation to make a potentially hanging command safe. If a useful check might stay alive, do not run it; explain the limitation and continue with file-based reasoning.",
  ].join("\n");
}

function buildFileTree(project: WorkspaceProject): string {
  const paths = Object.keys(project.files).sort((a, b) => a.localeCompare(b));
  const displayPaths = paths.length > 200 ? paths.slice(0, 200) : paths;
  const remaining = paths.length - displayPaths.length;

  const treeLines = displayPaths.map((path) => `- ${path}`);
  if (remaining > 0) {
    treeLines.push(`- (… and ${remaining} more files)`);
  }

  return treeLines.join("\n");
}

function buildWorkspaceContext(project: WorkspaceProject): string {
  const lessonTypeInfo = `Lesson type: ${project.lessonType}`;
  const entryFileInfo = `Entry file: ${project.entryFilePath}`;
  const fileTreeInfo = `Files:\n${buildFileTree(project)}`;

  return [lessonTypeInfo, entryFileInfo, fileTreeInfo].join("\n\n");
}

export function buildSystemPrompt(project: WorkspaceProject, options: SystemPromptOptions): string {
  const sections: string[] = [
    buildIntroduction(),
    buildSupportedStack(),
    buildPathConventions(),
    buildToolList(options.toolNames),
  ];

  if (options.hasBash) {
    sections.push(buildBashNote());
  }

  sections.push(buildWorkspaceContext(project));

  return sections.join("\n\n");
}
