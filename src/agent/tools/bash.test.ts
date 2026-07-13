import { describe, expect, it, vi } from "vitest";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { createWorkspaceStore, type StoredWorkspaceSnapshot } from "../../stores/workspaceStore";
import {
  collectWorkspaceFolders,
  type WorkspaceFile,
  type WorkspaceProject,
} from "../../types/workspace";
import type { ToolContext } from "../types";
import { getProject } from "./workspaceFs";

const support = vi.hoisted(() => ({
  isWebContainerRuntimeSupported: vi.fn<() => boolean>(),
  getOrBootSharedWebContainer: vi.fn<() => Promise<WebContainer>>(),
  readWorkspaceProject: vi.fn<() => Promise<WorkspaceProject>>(),
  syncWorkspaceProject: vi.fn<() => Promise<void>>(),
  createWorkspaceTree: vi.fn<() => object>(() => ({})),
}));

vi.mock("../../contexts/webContainerRuntimeSupport", () => support);

const { makeBashTool } = await import("./bash");

function makeFile(path: string, content: string): WorkspaceFile {
  return { path, name: path.split("/").pop() ?? path, language: "plaintext", content };
}

function makeProject(files: WorkspaceFile[]): WorkspaceProject {
  const fileMap = Object.fromEntries(files.map((file) => [file.path, file]));
  return {
    id: "test",
    name: "Test",
    lessonType: "html-css",
    entryFilePath: "index.html",
    folders: collectWorkspaceFolders(Object.keys(fileMap)),
    files: fileMap,
  };
}

function makeStore(files: WorkspaceFile[]) {
  return createWorkspaceStore({
    activeFilePath: files[0]?.path ?? "index.html",
    project: makeProject(files),
  } as StoredWorkspaceSnapshot);
}

function makeCtx(
  store: ReturnType<typeof makeStore>,
  requestConfirmation: () => Promise<boolean> = async () => true,
): ToolContext {
  return { workspace: store, signal: new AbortController().signal, requestConfirmation };
}

function createFakeProcess(outputChunks: string[], exitCode: number): WebContainerProcess {
  const output = new ReadableStream<string>({
    start(controller) {
      for (const chunk of outputChunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return {
    output,
    exit: Promise.resolve(exitCode),
    kill: vi.fn<() => void>(),
    input: new WritableStream(),
    resize: vi.fn<() => void>(),
  } as unknown as WebContainerProcess;
}

function makeFakeInstance(process: WebContainerProcess): WebContainer {
  return {
    spawn: vi.fn<() => Promise<WebContainerProcess>>().mockResolvedValue(process),
    mount: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as WebContainer;
}

const run = (ctx: ToolContext) => makeBashTool(ctx).function.execute;

describe("bash tool", () => {
  it("reports unavailable when the runtime is unsupported", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(false);
    const result = await run(makeCtx(makeStore([makeFile("index.html", "")])))({ command: "ls" });
    expect(result).toContain("unavailable");
  });

  it("does not run a declined command", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "")]);
    const result = await run(makeCtx(store, async () => false))({ command: "rm -rf /" });
    expect(result).toContain("declined");
    expect(support.getOrBootSharedWebContainer).not.toHaveBeenCalled();
  });

  it("runs an approved command and folds container changes back into the store", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "<html></html>")]);
    const instance = makeFakeInstance(createFakeProcess(["hello from container"], 0));
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([makeFile("index.html", "<html></html>"), makeFile("generated.txt", "new file")]),
    );

    const result = await run(makeCtx(store))({ command: "touch generated.txt" });

    expect(result).toContain("exit code 0");
    expect(result).toContain("hello from container");
    expect(getProject(store)?.files["generated.txt"]?.content).toBe("new file");
  });

  it("surfaces a non-zero exit code", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "")]);
    const instance = makeFakeInstance(createFakeProcess([""], 1));
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(makeProject([makeFile("index.html", "")]));

    const result = await run(makeCtx(store))({ command: "false" });
    expect(result).toContain("exit code 1");
  });
});
