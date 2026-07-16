import { tool } from "@openrouter/agent";
import { z } from "zod";
import type { WebContainer } from "@webcontainer/api";
import type { ToolContext } from "../types";
import {
  createWorkspaceTree,
  getOrBootSharedWebContainer,
  isWebContainerRuntimeSupported,
  readWorkspaceProject,
  runSerializedWebContainerTask,
  syncWorkspaceProject,
} from "../../contexts/webContainerRuntimeSupport";
import { getProject } from "./workspaceFs";
import type { WorkspaceFile, WorkspaceProject } from "../../types/workspace";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_LENGTH = 20_000;
const OUTPUT_HEAD_LENGTH = Math.floor(MAX_OUTPUT_LENGTH / 2);
const OUTPUT_TAIL_LENGTH = MAX_OUTPUT_LENGTH - OUTPUT_HEAD_LENGTH;

const inputSchema = z.object({
  command: z.string().describe("Shell command to run (via `sh -c`)"),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe("Timeout in milliseconds; defaults to 60000 (maximum 300000)"),
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

class BoundedCommandOutput {
  private head = "";
  private tail = "";
  private totalLength = 0;

  append(chunk: string): void {
    this.totalLength += chunk.length;
    let remainder = chunk;

    if (this.head.length < OUTPUT_HEAD_LENGTH) {
      const headCapacity = OUTPUT_HEAD_LENGTH - this.head.length;
      this.head += remainder.slice(0, headCapacity);
      remainder = remainder.slice(headCapacity);
    }

    if (remainder) {
      if (remainder.length >= OUTPUT_TAIL_LENGTH) {
        this.tail = remainder.slice(-OUTPUT_TAIL_LENGTH);
      } else {
        const retainedTailLength = OUTPUT_TAIL_LENGTH - remainder.length;
        this.tail = `${this.tail.slice(-retainedTailLength)}${remainder}`;
      }
    }
  }

  toString(): string {
    const retained = `${this.head}${this.tail}`;

    if (this.totalLength <= retained.length) {
      return retained;
    }

    const omitted = this.totalLength - retained.length;
    return `${this.head}\n… output truncated (${omitted} omitted characters) …\n${this.tail}`;
  }
}

async function foldContainerChangesIntoStore(
  ctx: ToolContext,
  instance: WebContainer,
  commandBaseProject: WorkspaceProject,
): Promise<void> {
  const projectAtReadStart = getProject(ctx.workspace);

  if (!projectAtReadStart) {
    return;
  }

  const containerProject = await readWorkspaceProject(instance, projectAtReadStart);
  const currentProject = getProject(ctx.workspace);

  if (!currentProject || currentProject.id !== commandBaseProject.id) {
    // The user replaced the whole workspace while the command was running.
    // Its pending forward mount is authoritative; never leak old-project files
    // into the replacement.
    syncedProject = containerProject;
    return;
  }

  const nextFiles = { ...currentProject.files };
  const paths = new Set([
    ...Object.keys(commandBaseProject.files),
    ...Object.keys(containerProject.files),
  ]);

  for (const path of paths) {
    const beforeCommand = commandBaseProject.files[path];
    const afterCommand = containerProject.files[path];

    if (areFilesEqual(beforeCommand, afterCommand)) {
      continue;
    }

    // Preserve a concurrent editor mutation on the same path. Unrelated shell
    // additions/deletions still fold into the current project atomically.
    if (!areFilesEqual(currentProject.files[path], beforeCommand)) {
      continue;
    }

    if (afterCommand) {
      nextFiles[path] = afterCommand;
    } else {
      delete nextFiles[path];
    }
  }

  const nextFolders = mergeFolderChanges(
    commandBaseProject.folders,
    currentProject.folders,
    containerProject.folders,
  );
  ctx.workspace.trigger.reconcileExternalProject({
    project: { ...currentProject, files: nextFiles, folders: nextFolders },
  });
  syncedProject = containerProject;
}

function areFilesEqual(left: WorkspaceFile | undefined, right: WorkspaceFile | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.path === right.path &&
    left.name === right.name &&
    left.language === right.language &&
    left.content === right.content &&
    (left.encoding ?? "utf-8") === (right.encoding ?? "utf-8")
  );
}

function mergeFolderChanges(
  beforeCommand: string[],
  current: string[],
  afterCommand: string[],
): string[] {
  const beforeSet = new Set(beforeCommand);
  const currentSet = new Set(current);
  const afterSet = new Set(afterCommand);
  const merged = new Set(current);
  const paths = new Set([...beforeCommand, ...afterCommand]);

  for (const path of paths) {
    const existedBefore = beforeSet.has(path);
    const existsAfter = afterSet.has(path);

    if (existedBefore === existsAfter || currentSet.has(path) !== existedBefore) {
      continue;
    }

    if (existsAfter) {
      merged.add(path);
    } else {
      merged.delete(path);
    }
  }

  return Array.from(merged).sort((left, right) => left.localeCompare(right));
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

    return await runSerializedWebContainerTask(instance, async () => {
      await ensureMounted(instance, project);

      if (aborted) {
        return "Command aborted.";
      }

      const process = await instance.spawn("sh", ["-c", command]);
      runningProcess = process;

      if (aborted) {
        process.kill();
      }

      const output = new BoundedCommandOutput();
      const reader = process.output.getReader();
      const readOutput = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          output.append(value);
        }
      })();

      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1, Math.trunc(timeout ?? DEFAULT_TIMEOUT_MS)),
      );
      let timedOut = false;
      const timeoutId = setTimeout(() => {
        timedOut = true;
        process.kill();
      }, timeoutMs);

      let exitCode: number;
      try {
        exitCode = await process.exit;
      } finally {
        clearTimeout(timeoutId);
      }
      await readOutput;

      await foldContainerChangesIntoStore(ctx, instance, project);

      if (aborted) {
        return "Command aborted.";
      }

      const truncated = output.toString().trim();

      if (timedOut) {
        return `Command timed out after ${timeoutMs}ms.\n${truncated}`;
      }

      return `exit code ${exitCode}\n${truncated}`;
    });
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
