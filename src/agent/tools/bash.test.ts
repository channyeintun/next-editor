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

const { bashTool } = await import("./bash");

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
  signal = new AbortController().signal,
): ToolContext {
  return { workspace: store, signal, requestConfirmation: async () => true };
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

function createAbortableFakeProcess(): WebContainerProcess {
  let resolveExit: (code: number) => void = () => {};
  let controllerRef!: ReadableStreamDefaultController<string>;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const output = new ReadableStream<string>({
    start(controller) {
      controllerRef = controller;
    },
  });

  return {
    output,
    exit,
    kill: vi.fn<() => void>(() => {
      controllerRef.close();
      resolveExit(-1);
    }),
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

describe("bashTool", () => {
  it("reports unavailable without prompting or booting a container when unsupported", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(false);
    const store = makeStore([makeFile("index.html", "<html></html>")]);
    const requestConfirmation = vi.fn<() => Promise<boolean>>();

    const result = await bashTool.execute(
      { command: "echo hi" },
      { workspace: store, signal: new AbortController().signal, requestConfirmation },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("unavailable");
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(support.getOrBootSharedWebContainer).not.toHaveBeenCalled();
  });

  it("does not run the command when the user declines confirmation", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "<html></html>")]);

    const result = await bashTool.execute(
      { command: "rm -rf /" },
      {
        workspace: store,
        signal: new AbortController().signal,
        requestConfirmation: async () => false,
      },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("declined");
    expect(support.getOrBootSharedWebContainer).not.toHaveBeenCalled();
  });

  it("runs the command, reports exit code + output, and folds new container files into the store", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const process = createFakeProcess(["hello from container"], 0);
    const instance = makeFakeInstance(process);
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([makeFile("index.html", "<html></html>"), makeFile("generated.txt", "new file")]),
    );

    const store = makeStore([makeFile("index.html", "<html></html>")]);
    const result = await bashTool.execute({ command: "touch generated.txt" }, makeCtx(store));

    expect(result.is_error).toBe(false);
    expect(result.content).toContain("exit code 0");
    expect(result.content).toContain("hello from container");
    expect(getProject(store)?.files["generated.txt"]?.content).toBe("new file");
  });

  it("marks the result as an error when the process exits non-zero", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const process = createFakeProcess(["boom"], 1);
    const instance = makeFakeInstance(process);
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([makeFile("index.html", "<html></html>")]),
    );

    const store = makeStore([makeFile("index.html", "<html></html>")]);
    const result = await bashTool.execute({ command: "false" }, makeCtx(store));

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exit code 1");
  });

  it("kills the process and reports abort when the signal fires mid-command", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const process = createAbortableFakeProcess();
    const instance = makeFakeInstance(process);
    const controller = new AbortController();
    // Fire the abort right as the process spawns — the realistic "Stop was
    // clicked while the command was already running" case — rather than
    // during the earlier confirmation/boot awaits, which bash.ts short-circuits
    // before ever spawning (covered by the aborted-signal check at the top).
    instance.spawn = vi.fn<() => Promise<WebContainerProcess>>().mockImplementation(async () => {
      controller.abort();
      return process;
    });
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([makeFile("index.html", "<html></html>")]),
    );

    const store = makeStore([makeFile("index.html", "<html></html>")]);

    const result = await bashTool.execute(
      { command: "sleep 1000" },
      makeCtx(store, controller.signal),
    );

    expect(process.kill).toHaveBeenCalled();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("aborted");
  });

  it("short-circuits without ever spawning when the signal aborts during confirmation", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const instance = makeFakeInstance(createFakeProcess([], 0));
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);

    const store = makeStore([makeFile("index.html", "<html></html>")]);
    const controller = new AbortController();
    const requestConfirmation = () =>
      new Promise<boolean>((resolve) => {
        controller.abort();
        resolve(true);
      });

    const result = await bashTool.execute(
      { command: "sleep 1000" },
      { workspace: store, signal: controller.signal, requestConfirmation },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("aborted");
    expect(instance.spawn).not.toHaveBeenCalled();
  });
});
