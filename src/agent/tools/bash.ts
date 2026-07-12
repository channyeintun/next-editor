import type { WebContainer } from "@webcontainer/api";
import type { ToolContext, ToolExecuteResult, Tool } from "../types";
import {
  createWorkspaceTree,
  getOrBootSharedWebContainer,
  isWebContainerRuntimeSupported,
  readWorkspaceProject,
  syncWorkspaceProject,
} from "../../contexts/webContainerRuntimeSupport";
import { getProject, writeFile } from "./workspaceFs";
import type { WorkspaceProject } from "../../types/workspace";

export interface BashToolInput {
  command: string;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LENGTH = 20_000;

// The bash tool reuses the same shared WebContainer singleton the Runtime panel
// mounts (getOrBootSharedWebContainer), so a command sees the files the user is
// actually looking at. This module-level state lets repeated bash calls in one
// agent turn skip re-mounting when nothing changed, mirroring (in miniature)
// useWebContainerWorkspaceSync's own mount/sync tracking.
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

async function execute(input: BashToolInput, ctx: ToolContext): Promise<ToolExecuteResult> {
  if (!isWebContainerRuntimeSupported()) {
    return {
      content:
        "The bash tool is unavailable: the sandboxed runtime requires a non-mobile browser with " +
        "cross-origin isolation enabled.",
      is_error: true,
    };
  }

  if (ctx.signal.aborted) {
    return { content: "Command aborted.", is_error: true };
  }

  // Registered up front (not just around the spawn) so an abort fired while
  // waiting on confirmation or a container boot — both can take a while — is
  // still observed, instead of only aborts that land after the process starts.
  let aborted = false;
  let runningProcess: Awaited<ReturnType<WebContainer["spawn"]>> | null = null;
  const abortHandler = () => {
    aborted = true;
    runningProcess?.kill();
  };
  ctx.signal.addEventListener("abort", abortHandler);

  try {
    const approved = await ctx.requestConfirmation({
      toolName: "bash",
      summary: input.command,
    });

    if (aborted) {
      return { content: "Command aborted.", is_error: true };
    }

    if (!approved) {
      return { content: "Command declined by user; it did not run.", is_error: true };
    }

    const project = getProject(ctx.workspace);

    if (!project) {
      return { content: "No workspace loaded.", is_error: true };
    }

    const instance = await getOrBootSharedWebContainer();

    if (aborted) {
      return { content: "Command aborted.", is_error: true };
    }

    await ensureMounted(instance, project);

    if (aborted) {
      return { content: "Command aborted.", is_error: true };
    }

    const process = await instance.spawn("sh", ["-c", input.command]);
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

    const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
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
      return { content: "Command aborted.", is_error: true };
    }

    const truncated = truncateOutput(output.trim());

    if (timedOut) {
      return {
        content: `Command timed out after ${timeoutMs}ms.\n${truncated}`,
        is_error: true,
      };
    }

    return {
      content: `exit code ${exitCode}\n${truncated}`,
      is_error: exitCode !== 0,
    };
  } finally {
    ctx.signal.removeEventListener("abort", abortHandler);
  }
}

export const bashTool: Tool<BashToolInput> = {
  name: "bash",
  description:
    "Run a shell command inside a sandboxed in-browser runtime (WebContainer) rooted at the " +
    "workspace. Requires user confirmation before running and is unavailable on unsupported " +
    "browsers (e.g. mobile, or without cross-origin isolation).",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run (via `sh -c`)" },
      timeout: { type: "number", description: "Timeout in milliseconds; defaults to 60000" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  execute,
};
