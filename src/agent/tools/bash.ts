import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { WebContainer } from "@webcontainer/api";
import type { ToolContext } from "../types";
import {
  createWorkspaceTree,
  getOrBootSharedWebContainer,
  isWebContainerRuntimeSupported,
  readWorkspaceProject,
  syncWorkspaceProject,
} from "../../contexts/webContainerRuntimeSupport";
import { getProject, writeFile } from "./workspaceFs";
import type { WorkspaceProject } from "../../types/workspace";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LENGTH = 20_000;

const inputSchema = z.object({
  command: z.string().describe("Shell command to run (via `sh -c`)"),
  timeout: z.number().optional().describe("Timeout in milliseconds; defaults to 60000"),
});

// The bash tool reuses the same shared WebContainer singleton the Runtime panel
// mounts (getOrBootSharedWebContainer), so a command sees the files the user is
// actually looking at. This module-level state lets repeated bash calls in one
// agent turn skip re-mounting when nothing changed.
let mountedInstance: WebContainer | null = null;
let syncedProject: WorkspaceProject | null = null;

async function ensureMounted(instance: WebContainer, project: WorkspaceProject): Promise<void> {
  if (mountedInstance !== instance) {
    await instance.mount(createWorkspaceTree(project));
    mountedInstance = instance;
    syncedProject = project;
    return;
  }

  if (syncedProject !== project) {
    await syncWorkspaceProject(instance, syncedProject, project);
    syncedProject = project;
  }
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output;
  }

  const omitted = output.length - MAX_OUTPUT_LENGTH;
  return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n… output truncated (${omitted} more characters)`;
}

async function foldContainerChangesIntoStore(
  ctx: ToolContext,
  instance: WebContainer,
): Promise<void> {
  const currentProject = getProject(ctx.workspace);

  if (!currentProject) {
    return;
  }

  const containerProject = await readWorkspaceProject(instance, currentProject);

  for (const file of Object.values(containerProject.files)) {
    const existing = currentProject.files[file.path];

    if (!existing || existing.content !== file.content) {
      writeFile(ctx.workspace, file.path, file.content, file.encoding);
    }
  }
}

async function runCommand(
  ctx: ToolContext,
  command: string,
  timeout: number | undefined,
): Promise<string> {
  if (!isWebContainerRuntimeSupported()) {
    return (
      "The bash tool is unavailable: the sandboxed runtime requires a non-mobile browser with " +
      "cross-origin isolation enabled."
    );
  }

  if (ctx.signal.aborted) {
    return "Command aborted.";
  }

  // Registered up front so an abort fired while waiting on confirmation or a
  // container boot — both can take a while — is still observed.
  let aborted = false;
  let runningProcess: Awaited<ReturnType<WebContainer["spawn"]>> | null = null;
  const abortHandler = () => {
    aborted = true;
    runningProcess?.kill();
  };
  ctx.signal.addEventListener("abort", abortHandler);

  try {
    const approved = await ctx.requestConfirmation({ toolName: "bash", summary: command });

    if (aborted) {
      return "Command aborted.";
    }

    if (!approved) {
      return "Command declined by user; it did not run.";
    }

    const project = getProject(ctx.workspace);

    if (!project) {
      return "No workspace loaded.";
    }

    const instance = await getOrBootSharedWebContainer();

    if (aborted) {
      return "Command aborted.";
    }

    await ensureMounted(instance, project);

    if (aborted) {
      return "Command aborted.";
    }

    const process = await instance.spawn("sh", ["-c", command]);
    runningProcess = process;

    if (aborted) {
      process.kill();
    }

    let output = "";
    const reader = process.output.getReader();
    const readOutput = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        output += value;
      }
    })();

    const timeoutMs = timeout ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    const exitCode = await process.exit;
    clearTimeout(timeoutId);
    await readOutput;

    await foldContainerChangesIntoStore(ctx, instance);

    if (aborted) {
      return "Command aborted.";
    }

    const truncated = truncateOutput(output.trim());

    if (timedOut) {
      return `Command timed out after ${timeoutMs}ms.\n${truncated}`;
    }

    return `exit code ${exitCode}\n${truncated}`;
  } finally {
    ctx.signal.removeEventListener("abort", abortHandler);
  }
}

export function makeBashTool(ctx: ToolContext) {
  return tool({
    name: "bash",
    description:
      "Run a shell command inside a sandboxed in-browser runtime (WebContainer) rooted at the " +
      "workspace. Requires user confirmation before running and is unavailable on unsupported " +
      "browsers (e.g. mobile, or without cross-origin isolation).",
    inputSchema,
    execute: (input): Promise<string> => runCommand(ctx, input.command, input.timeout),
  });
}
