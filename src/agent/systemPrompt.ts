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
  return "The bash tool runs commands in a sandboxed in-browser Node.js-like runtime (WebContainer) with no access to the host machine. It may be unavailable on some devices (e.g., mobile)—if so, the tool will report that the runtime is unavailable.";
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
