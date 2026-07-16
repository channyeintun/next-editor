import { beforeEach, describe, expect, it, vi } from "vitest";
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
  runSerializedWebContainerTask: vi.fn<
    (instance: WebContainer, task: () => Promise<unknown>) => Promise<unknown>
  >((_instance: WebContainer, task: () => Promise<unknown>) => task()),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("reconciles deletions and renames from the complete container snapshot", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([
      makeFile("index.html", "<html></html>"),
      makeFile("old.txt", "old"),
      makeFile("nested/remove.txt", "remove"),
    ]);
    const instance = makeFakeInstance(createFakeProcess(["renamed"], 0));
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([makeFile("index.html", "<html></html>"), makeFile("renamed.txt", "old")]),
    );

    await run(makeCtx(store))({ command: "mv old.txt renamed.txt && rm -rf nested" });

    const context = store.getSnapshot().context;
    if (!context.isInitialized) throw new Error("Expected initialized workspace");
    expect(Object.keys(context.project.files).sort()).toEqual(["index.html", "renamed.txt"]);
    expect(context.project.folders).not.toContain("nested");
    expect(context.savedSnapshot.project.files["old.txt"]).toBeDefined();
    expect(context.dirtyState.deletedFilePaths).toEqual(["nested/remove.txt", "old.txt"]);
    expect(context.dirtyState.addedFilePaths).toEqual(["renamed.txt"]);
  });

  it("preserves a concurrent editor edit while folding unrelated command changes", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "before")]);
    const deferredExit: { resolve: ((exitCode: number) => void) | null } = { resolve: null };
    const process = createFakeProcess(["done"], 0);
    Object.defineProperty(process, "exit", {
      value: new Promise<number>((resolve) => {
        deferredExit.resolve = resolve;
      }),
    });
    const instance = makeFakeInstance(process);
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(
      makeProject([
        makeFile("index.html", "changed by shell"),
        makeFile("generated.txt", "shell output"),
      ]),
    );

    const command = run(makeCtx(store))({ command: "generate-and-edit" });
    await vi.waitFor(() => expect(instance.spawn).toHaveBeenCalledTimes(1));
    store.trigger.updateFileContent({ path: "index.html", content: "newer editor edit" });
    deferredExit.resolve?.(0);
    await command;

    expect(getProject(store)?.files["index.html"].content).toBe("newer editor edit");
    expect(getProject(store)?.files["generated.txt"].content).toBe("shell output");
  });

  it("preserves an editor edit made during the final runtime scan", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "before")]);
    const instance = makeFakeInstance(createFakeProcess(["done"], 0));
    const deferredRead: {
      resolve: ((project: WorkspaceProject) => void) | null;
    } = { resolve: null };
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockImplementationOnce(
      () =>
        new Promise<WorkspaceProject>((resolve) => {
          deferredRead.resolve = resolve;
        }),
    );

    const command = run(makeCtx(store))({ command: "generate-and-edit" });
    await vi.waitFor(() => expect(support.readWorkspaceProject).toHaveBeenCalledTimes(1));
    store.trigger.updateFileContent({ path: "index.html", content: "latest editor edit" });
    deferredRead.resolve?.(
      makeProject([
        makeFile("index.html", "changed by shell"),
        makeFile("generated.txt", "shell output"),
      ]),
    );
    await command;

    expect(getProject(store)?.files["index.html"].content).toBe("latest editor edit");
    expect(getProject(store)?.files["generated.txt"].content).toBe("shell output");
  });

  it("retains bounded head and tail output with an exact omission count", async () => {
    support.isWebContainerRuntimeSupported.mockReturnValue(true);
    const store = makeStore([makeFile("index.html", "")]);
    const chunks = Array.from(
      { length: 100 },
      (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(995)}\n`,
    );
    const instance = makeFakeInstance(createFakeProcess(chunks, 0));
    support.getOrBootSharedWebContainer.mockResolvedValue(instance);
    support.readWorkspaceProject.mockResolvedValue(makeProject([makeFile("index.html", "")]));

    const result = await run(makeCtx(store))({ command: "noisy-command" });

    expect(result.length).toBeLessThan(20_200);
    expect(result).toContain("output truncated (80000 omitted characters)");
    expect(result).toContain("000:");
    expect(result).toContain("099:");
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
