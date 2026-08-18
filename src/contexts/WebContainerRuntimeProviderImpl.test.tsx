import { act, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProviderImpl";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { useWebContainerRuntimeActions } from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions, useWorkspaceDirtyState } from "../hooks/useWorkspace";
import { isWorkspaceTextFile } from "../types/workspace";
import type { WorkspaceActions, WorkspaceDirtyState } from "./WorkspaceContext";
import type { WebContainerRuntimeActions } from "./WebContainerRuntimeContext";

vi.mock("./webContainerRuntimeSupport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webContainerRuntimeSupport")>();
  return {
    ...actual,
    getOrBootSharedWebContainer: vi.fn<() => Promise<WebContainer>>(),
  };
});

interface DirEntry {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

function dirEntry(name: string, kind: "file" | "directory"): DirEntry {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

/**
 * A minimal in-memory filesystem for the fake `WebContainer` — enough to satisfy
 * `readWorkspaceProject`'s `fs.readdir(..., { withFileTypes: true })` / `fs.readFile` walk.
 * `files` maps a runtime-relative path (no leading `.`/`/`) to its text contents; `addFile`
 * lets a test simulate a file appearing mid-test (e.g. right after an install command exits).
 */
function createFakeFs(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles));

  const readdir = vi.fn<(path: string, opts?: { withFileTypes?: boolean }) => Promise<DirEntry[]>>(
    async (path) => {
      const prefix = path === "." ? "" : `${path}/`;
      const seen = new Map<string, "file" | "directory">();

      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash === -1) {
          seen.set(rest, "file");
        } else {
          const dirName = rest.slice(0, slash);
          if (!seen.has(dirName)) seen.set(dirName, "directory");
        }
      }

      return Array.from(seen.entries()).map(([name, kind]) => dirEntry(name, kind));
    },
  );

  const readFile = vi.fn<(path: string, encoding?: string) => Promise<string>>(async (path) => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  });

  return {
    fs: {
      readdir,
      readFile,
      mkdir: vi.fn<() => Promise<void>>(async () => {}),
      writeFile: vi.fn<(path: string, content: string | Uint8Array) => Promise<void>>(
        async (path, content) => {
          files.set(
            path,
            typeof content === "string" ? content : new TextDecoder().decode(content),
          );
        },
      ),
      rm: vi.fn<(path: string, options?: { recursive?: boolean }) => Promise<void>>(
        async (path, options) => {
          files.delete(path);
          if (options?.recursive) {
            for (const filePath of files.keys()) {
              if (filePath.startsWith(`${path}/`)) files.delete(filePath);
            }
          }
        },
      ),
    } as unknown as WebContainer["fs"],
    addFile: (path: string, content: string) => {
      files.set(path, content);
    },
  };
}

function createFakeInstance(fakeFs: ReturnType<typeof createFakeFs>) {
  const listeners = new Map<string, (...args: unknown[]) => void>();

  const instance = {
    on: vi.fn<(event: string, handler: (...args: unknown[]) => void) => () => void>(
      (event, handler) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
      },
    ),
    mount: vi.fn<() => Promise<void>>(async () => {}),
    spawn: vi.fn<() => Promise<WebContainerProcess>>(async () => ({
      output: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      input: new WritableStream(),
      exit: Promise.resolve(0),
      kill: vi.fn<() => void>(),
      resize: vi.fn<() => void>(),
    })),
    fs: fakeFs.fs,
  } as unknown as WebContainer;

  return { instance, listeners };
}

interface Harness {
  runtime: WebContainerRuntimeActions | null;
  workspace: WorkspaceActions | null;
  dirty: WorkspaceDirtyState | null;
}

function renderProviders(allowAmbientStart = true) {
  const captured: Harness = { runtime: null, workspace: null, dirty: null };

  function Capture() {
    captured.runtime = useWebContainerRuntimeActions();
    captured.workspace = useWorkspaceActions();
    captured.dirty = useWorkspaceDirtyState();
    return null;
  }

  render(
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={allowAmbientStart}>
        <Capture />
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>,
  );

  if (!captured.runtime || !captured.workspace || !captured.dirty) {
    throw new Error("Expected providers to render");
  }

  return captured as {
    runtime: WebContainerRuntimeActions;
    workspace: WorkspaceActions;
    dirty: WorkspaceDirtyState;
  };
}

describe("WebContainerRuntimeProviderImpl reverse sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // isWebContainerRuntimeSupported() gates the runtime on cross-origin isolation.
    vi.stubGlobal("crossOriginIsolated", true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("suppresses ambient startup while preserving explicit runtime.start", async () => {
    const fakeFs = createFakeFs({ "index.html": "<main>Hello</main>" });
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    const boot = vi.mocked(getOrBootSharedWebContainer);
    boot.mockReset();
    boot.mockResolvedValue(instance);

    const { runtime } = renderProviders(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(boot).not.toHaveBeenCalled();

    await act(async () => {
      await runtime.startRuntime();
    });
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it("syncs a lock file created by the init command without any terminal session existing", async () => {
    const fakeFs = createFakeFs({
      "index.html": "<main>Hello</main>",
    });
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    // Simulate the installer writing a lock file the instant the init command's process
    // resolves — before `startRuntime` returns, and long before any terminal session exists.
    const spawnMock = vi.mocked(instance.spawn);
    spawnMock.mockImplementation(async () => {
      fakeFs.addFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
      return {
        output: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        input: new WritableStream(),
        exit: Promise.resolve(0),
        kill: vi.fn<() => void>(),
        resize: vi.fn<() => void>(),
      } as unknown as WebContainerProcess;
    });

    const { runtime, workspace } = renderProviders();

    await act(async () => {
      await runtime.startRuntime();
    });

    // requestReverseSync debounces 150ms after the init command resolves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    // `loadProject` is redefined every `WorkspaceProvider` render (a fresh closure over the
    // store ref each time), so a `vi.spyOn` captured before the reverse sync's own render
    // wouldn't observe the call the provider actually makes internally. Assert on the
    // resulting store state instead — the ground truth the fix is supposed to produce.
    const project = workspace.getProject();
    expect(project.files["pnpm-lock.yaml"]).toBeDefined();
  });

  // `hasRunInitCommandRef` only flips after the init command finishes, so it could
  // not dedupe callers arriving during it. Five entry points call prepareRuntime
  // and only startRuntime checks the busy status — sendTerminalInput fires once
  // per keystroke — so clicking Terminal (or typing) during `pnpm install` used to
  // spawn a second install against the same node_modules.
  it("runs the init command once when several entry points race it", async () => {
    const fakeFs = createFakeFs({ "index.html": "<main>Hello</main>" });
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const spawned: string[] = [];
    let releaseInstall: (() => void) | null = null;
    const installStarted = new Promise<void>((resolveStarted) => {
      vi.mocked(instance.spawn).mockImplementation((async (command: string, args: string[]) => {
        const line = [command, ...(args ?? [])].join(" ");
        spawned.push(line);
        const exit =
          spawned.filter((entry) => entry === line).length === 1 && line.includes("install")
            ? new Promise<number>((resolveExit) => {
                releaseInstall = () => resolveExit(0);
                resolveStarted();
              })
            : Promise.resolve(0);
        return {
          output: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          input: new WritableStream(),
          exit,
          kill: vi.fn<() => void>(),
          resize: vi.fn<() => void>(),
        } as unknown as WebContainerProcess;
      }) as never);
    });

    const { runtime } = renderProviders();

    await act(async () => {
      void runtime.startRuntime();
      await installStarted;

      // Arrives while the install is still in flight — the exact window the
      // boolean flag could not cover. Drain microtasks and timers so it gets all
      // the way past boot/mount/sync to the init-command check before the first
      // install is allowed to finish; otherwise the flag wins the race by luck
      // and the test proves nothing.
      void runtime.startTerminalSession();
      for (let i = 0; i < 50; i += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }

      releaseInstall?.();
      await vi.advanceTimersByTimeAsync(200);
    });

    const installs = spawned.filter((line) => line.includes("install"));
    expect(installs).toHaveLength(1);
  });

  it("still fires reverse sync on terminal output (regression)", async () => {
    const fakeFs = createFakeFs({
      "index.html": "<main>Hello</main>",
    });
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const { runtime, workspace } = renderProviders();

    await act(async () => {
      await runtime.startTerminalSession();
    });

    // A lock file appears after the terminal session starts (simulating output from a
    // manually-run install command); writing terminal input (Enter) is what the provider wires
    // to the existing `onTerminalOutput` → `requestReverseSync` regression path.
    fakeFs.addFile("package-lock.json", "{}\n");

    await act(async () => {
      await runtime.sendTerminalInput("ls\n");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const project = workspace.getProject();
    expect(project.files["package-lock.json"]).toBeDefined();
  });

  it("reverse syncs a file reported by fs.watch without any terminal output", async () => {
    const fakeFs = createFakeFs({
      "index.html": "<main>Hello</main>",
    });
    const { instance } = createFakeInstance(fakeFs);

    // The default fake fs has no `watch`; add one so the provider runs in
    // watcher mode (which also gates off the terminal-output heuristic).
    type WatchListener = (event: "rename" | "change", filename: string | Uint8Array) => void;
    const capturedWatch: { listener: WatchListener | null } = { listener: null };
    Object.assign(instance.fs, {
      watch: vi.fn<
        (path: string, options: unknown, listener: WatchListener) => { close: () => void }
      >((_path, _options, listener) => {
        capturedWatch.listener = listener;
        return { close: vi.fn<() => void>() };
      }),
      mkdir: vi.fn<() => Promise<void>>(async () => {}),
      rm: vi.fn<() => Promise<void>>(async () => {}),
      writeFile: vi.fn<() => Promise<void>>(async () => {}),
    });

    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const { runtime, workspace } = renderProviders();

    await act(async () => {
      await runtime.startRuntime();
    });

    // Drain the post-init reverse sync so the watcher event below is the only
    // pending trigger.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    if (!capturedWatch.listener) {
      throw new Error("Expected the provider to register an fs.watch listener");
    }
    const fireWatch = capturedWatch.listener;

    // A container process (e.g. an Express route handler) writes a file. No
    // terminal output accompanies it — only the watcher can see it.
    fakeFs.addFile("server/data.json", '{"visits":1}');
    fireWatch("rename", "server/data.json");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const project = workspace.getProject();
    expect(project.files["server/data.json"]).toBeDefined();
  });

  it("requeues a stale reverse read and preserves a newer editor edit and saved baseline", async () => {
    const fakeFs = createFakeFs({});
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);
    const harness = renderProviders();
    const initialProject = harness.workspace.getProject();
    const entryPath = initialProject.entryFilePath;
    const entryFile = initialProject.files[entryPath];
    if (!isWorkspaceTextFile(entryFile)) throw new Error("Expected a text entry file");
    fakeFs.addFile(entryPath, entryFile.content);

    let releaseStaleRead: ((content: string) => void) | null = null;
    vi.mocked(instance.fs.readFile).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseStaleRead = resolve;
        }),
    );

    await act(async () => {
      await harness.runtime.startRuntime();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(instance.fs.readFile).toHaveBeenCalledTimes(1);

    act(() => {
      harness.workspace.updateFileContent(entryPath, "newer editor content");
    });

    await act(async () => {
      releaseStaleRead?.("stale runtime content");
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(harness.workspace.getProject().files[entryPath].content).toBe("newer editor content");
    expect(harness.dirty.hasUnsavedChanges).toBe(true);
    expect(harness.dirty.modifiedFilePaths).toEqual([entryPath]);
  });
});
