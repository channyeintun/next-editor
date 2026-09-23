import { act, render } from "@testing-library/react";
import { useContext } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
  useWebContainerRuntimeSaveWorkspace,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions, useWorkspaceDirtyState } from "../hooks/useWorkspace";
import { createWorkspaceFile } from "../starters/shared";
import { WorkspaceStoreContext } from "../stores/workspaceStore";
import {
  isWorkspaceTextFile,
  type WorkspaceLessonType,
  type WorkspaceProject,
} from "../types/workspace";
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

/**
 * Starts the runtime on a container that holds the workspace project and has an
 * fs.watch, then drains the post-init reverse sync. `fireWatch` reports a file a
 * container process wrote.
 */
async function startWatchedRuntime() {
  const fakeFs = createFakeFs({});
  const { instance } = createFakeInstance(fakeFs);
  type WatchListener = (event: "rename" | "change", filename: string | Uint8Array) => void;
  const capturedWatch: { listener: WatchListener | null } = { listener: null };
  Object.assign(instance.fs, {
    watch: vi.fn<
      (path: string, options: unknown, listener: WatchListener) => { close: () => void }
    >((_path, _options, listener) => {
      capturedWatch.listener = listener;
      return { close: vi.fn<() => void>() };
    }),
  });
  const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
  vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

  const { runtime, workspace } = renderProviders();
  // The fake mount writes nothing, so seed the container with the mounted project.
  for (const [path, file] of Object.entries(workspace.getProject().files)) {
    if (isWorkspaceTextFile(file)) fakeFs.addFile(path, file.content);
  }

  await act(async () => {
    await runtime.startRuntime();
    await vi.advanceTimersByTimeAsync(200);
  });
  const fireWatch = capturedWatch.listener;
  if (!fireWatch) throw new Error("Expected the provider to register an fs.watch listener");

  return { fakeFs, instance, runtime, workspace, fireWatch };
}

describe("WebContainerRuntimeProvider reverse sync", () => {
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

    // Vitest does not run the React Compiler, so `loadProject` is a fresh closure on every
    // `WorkspaceProvider` render here and a `vi.spyOn` captured before the reverse sync's own
    // render wouldn't observe the call the provider actually makes. Assert on the resulting
    // store state instead — the ground truth the fix is supposed to produce.
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

  // A reverse sync reads what the container already holds. Writing that back
  // is wasted work at best; when a container tool rewrites the file between our
  // read and the write-back, it replaces the tool's newer output.
  it("does not write a reverse-synced file back over a newer container write", async () => {
    const fakeFs = createFakeFs({});
    const { instance } = createFakeInstance(fakeFs);
    type WatchListener = (event: "rename" | "change", filename: string | Uint8Array) => void;
    const capturedWatch: { listener: WatchListener | null } = { listener: null };
    Object.assign(instance.fs, {
      watch: vi.fn<
        (path: string, options: unknown, listener: WatchListener) => { close: () => void }
      >((_path, _options, listener) => {
        capturedWatch.listener = listener;
        return { close: vi.fn<() => void>() };
      }),
    });
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);

    const { runtime, workspace } = renderProviders();
    // The fake mount writes nothing, so seed the container with the mounted project.
    for (const [path, file] of Object.entries(workspace.getProject().files)) {
      if (isWorkspaceTextFile(file)) fakeFs.addFile(path, file.content);
    }

    await act(async () => {
      await runtime.startRuntime();
      await vi.advanceTimersByTimeAsync(200);
    });
    const fireWatch = capturedWatch.listener;
    if (!fireWatch) throw new Error("Expected the provider to register an fs.watch listener");
    const writeFile = vi.mocked(instance.fs.writeFile);
    writeFile.mockClear();

    // A generator writes gen.ts, then rewrites it while the reverse sync is
    // reading it; the rewrite's watch event arrives a tick later.
    fakeFs.addFile("gen.ts", "v1");
    const readFile = vi.mocked(instance.fs.readFile);
    const readFromFakeFs = readFile.getMockImplementation()!;
    readFile.mockImplementation(async (path, encoding) => {
      const content = await readFromFakeFs(path, encoding);
      if (path === "gen.ts" && content === "v1") {
        fakeFs.addFile("gen.ts", "v2");
        setTimeout(() => fireWatch("change", "gen.ts"), 0);
      }
      return content;
    });
    fireWatch("rename", "gen.ts");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(writeFile.mock.calls.map(([path]) => path)).not.toContain("gen.ts");
    expect(await instance.fs.readFile("gen.ts", "utf-8")).toBe("v2");
    const genFile = workspace.getProject().files["gen.ts"];
    expect(isWorkspaceTextFile(genFile) ? genFile.content : null).toBe("v2");
  });

  // A live room turns the reverse sync off: the room's tree is the workspace and
  // the container only mirrors it. Importing a build output there made the next
  // room projection delete it from the container, since the forward sync removes
  // whatever the last synced project holds and the next one does not.
  it("keeps container output in the container while reverse sync is off", async () => {
    const { fakeFs, instance, runtime, workspace, fireWatch } = await startWatchedRuntime();
    const roomProject = workspace.getProject();

    runtime.setReverseSyncEnabled(false);
    fakeFs.addFile("dist/out.js", "built");
    fireWatch("rename", "dist/out.js");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(workspace.getProject().files["dist/out.js"]).toBeUndefined();

    // A collaborator creates b.js, and the room projects its tree into the store.
    act(() => {
      workspace.reconcileExternalProject({
        ...roomProject,
        files: { ...roomProject.files, "b.js": createWorkspaceFile("b.js", "b") },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const removedPaths = vi.mocked(instance.fs.rm).mock.calls.map(([path]) => path);
    expect(removedPaths).not.toContain("dist/out.js");
    expect(removedPaths).not.toContain("dist");
    expect(await instance.fs.readFile("dist/out.js", "utf-8")).toBe("built");
    expect(vi.mocked(instance.fs.writeFile).mock.calls.map(([path]) => path)).toContain("b.js");
  });

  it("imports container writes again once reverse sync is back on", async () => {
    const { fakeFs, runtime, workspace, fireWatch } = await startWatchedRuntime();

    runtime.setReverseSyncEnabled(false);
    fakeFs.addFile("dist/out.js", "built");
    fireWatch("rename", "dist/out.js");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    runtime.setReverseSyncEnabled(true);
    fireWatch("change", "dist/out.js");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(workspace.getProject().files["dist/out.js"]).toBeDefined();
  });

  it("drops a reverse read already in flight when reverse sync is turned off", async () => {
    const { fakeFs, instance, runtime, workspace, fireWatch } = await startWatchedRuntime();
    const readFile = vi.mocked(instance.fs.readFile);
    const readFromFakeFs = readFile.getMockImplementation()!;
    let releaseRead: (() => void) | null = null;
    readFile.mockImplementation(async (path, encoding) => {
      if (path === "dist/out.js") {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      return readFromFakeFs(path, encoding);
    });

    fakeFs.addFile("dist/out.js", "built");
    fireWatch("rename", "dist/out.js");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(releaseRead).not.toBeNull();

    runtime.setReverseSyncEnabled(false);
    await act(async () => {
      releaseRead?.();
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(workspace.getProject().files["dist/out.js"]).toBeUndefined();
  });
});

describe("WebContainerRuntimeProvider runner control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("crossOriginIsolated", true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // startRuntime (ambient start, opening the preview) joins a runner that is
  // still starting; rerunRunner (the Run button, run-on-save) replaces it.
  it("restarts a starting runner on rerun but not on start", async () => {
    const fakeFs = createFakeFs({ "index.html": "<main>Hello</main>" });
    const { instance } = createFakeInstance(fakeFs);
    const runners: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
    vi.mocked(instance.spawn).mockImplementation((async (_command: string, args: string[]) => {
      const isRunner = args.join(" ").includes("pnpm dev");
      // The dev server runs until killed and never reports server-ready here.
      let exitRunner: (code: number) => void = () => {};
      const exit = isRunner
        ? new Promise<number>((resolve) => {
            exitRunner = resolve;
          })
        : Promise.resolve(0);
      const kill = vi.fn<() => void>(() => exitRunner(143));
      if (isRunner) runners.push({ kill });
      return {
        output: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        input: new WritableStream(),
        exit,
        kill,
        resize: vi.fn<() => void>(),
      } as unknown as WebContainerProcess;
    }) as never);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    vi.mocked(getOrBootSharedWebContainer).mockResolvedValue(instance);
    const { runtime } = renderProviders(false);

    await act(async () => {
      await runtime.startRuntime();
    });
    expect(runners).toHaveLength(1);

    await act(async () => {
      await runtime.startRuntime();
    });
    expect(runners).toHaveLength(1);

    await act(async () => {
      void runtime.rerunRunner();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(runners).toHaveLength(2);
    expect(runners[0]?.kill).toHaveBeenCalled();
  });
});

describe("WebContainerRuntimeProvider subscriptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The provider re-renders on every runner output chunk. Its workspace
  // subscription and window listeners are made once per mount, not per render.
  it("keeps one workspace subscription and one set of window listeners across renders", () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const captured: { runtime: WebContainerRuntimeActions | null; subscribes: number } = {
      runtime: null,
      subscribes: 0,
    };

    function Capture() {
      const store = useContext(WorkspaceStoreContext);
      if (store && captured.subscribes === 0) {
        const subscribe = store.subscribe.bind(store);
        store.subscribe = ((...args: Parameters<typeof store.subscribe>) => {
          captured.subscribes += 1;
          return subscribe(...args);
        }) as typeof store.subscribe;
      }
      captured.runtime = useWebContainerRuntimeActions();
      return null;
    }

    render(
      <WorkspaceProvider>
        <WebContainerRuntimeProvider allowAmbientStart={false}>
          <Capture />
        </WebContainerRuntimeProvider>
      </WorkspaceProvider>,
    );
    const blurListeners = () =>
      addEventListener.mock.calls.filter(([type]) => type === "blur").length;
    const blurBefore = blurListeners();
    const subscribesBefore = captured.subscribes;

    for (const runCommand of ["pnpm dev --a", "pnpm dev --b", "pnpm dev --c"]) {
      act(() => captured.runtime?.updateRunnerConfig({ runCommand }));
    }

    expect(blurListeners()).toBe(blurBefore);
    expect(captured.subscribes).toBe(subscribesBefore);
  });
});

describe("WebContainerRuntimeProvider saveWorkspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("crossOriginIsolated", true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function startWithFailingWrites() {
    const fakeFs = createFakeFs({ "index.html": "<main>Hello</main>" });
    const { instance } = createFakeInstance(fakeFs);
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    const boot = vi.mocked(getOrBootSharedWebContainer);
    boot.mockReset();
    boot.mockResolvedValue(instance);

    const captured: {
      runtime: WebContainerRuntimeActions | null;
      workspace: WorkspaceActions | null;
      save: (() => Promise<void>) | null;
      errorMessage: string | null;
    } = { runtime: null, workspace: null, save: null, errorMessage: null };
    function Capture() {
      captured.runtime = useWebContainerRuntimeActions();
      captured.workspace = useWorkspaceActions();
      captured.save = useWebContainerRuntimeSaveWorkspace();
      captured.errorMessage = useWebContainerRuntimeMetadata().errorMessage;
      return null;
    }
    render(
      <WorkspaceProvider>
        <WebContainerRuntimeProvider allowAmbientStart={false}>
          <Capture />
        </WebContainerRuntimeProvider>
      </WorkspaceProvider>,
    );
    await act(async () => {
      await captured.runtime?.startRuntime();
      await vi.advanceTimersByTimeAsync(200);
    });

    boot.mockClear();

    // Writes hang until the test fails them, so a reset can land mid-write.
    const pendingWrites: Array<(error: Error) => void> = [];
    vi.mocked(instance.fs.writeFile).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          pendingWrites.push(reject);
        }),
    );
    const failWrites = async (error: Error) => {
      for (let round = 0; round < 5; round += 1) {
        for (const reject of pendingWrites.splice(0)) reject(error);
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    // A project-level change, so there is a file for the sync to write.
    act(() => captured.workspace?.createFile("notes.txt", "draft"));
    return { captured, failWrites, boot };
  }

  // Both callers (CodeEditor's Ctrl+S and replayed workspace snapshots) fire
  // and forget; the failure is reported in the runner console instead.
  it("reports a failed sync without rejecting", async () => {
    const { captured, failWrites } = await startWithFailingWrites();

    let saved: Promise<void> | undefined;
    await act(async () => {
      saved = captured.save?.();
      await failWrites(new Error("disk full"));
    });

    await expect(saved).resolves.toBeUndefined();
    expect(captured.errorMessage).toBe("disk full");
  });

  it("does not report a sync that a runtime reset abandoned", async () => {
    const { captured, failWrites } = await startWithFailingWrites();
    act(() => captured.runtime?.updateRunnerConfig({ runOnFileSave: false }));

    let saved: Promise<void> | undefined;
    await act(async () => {
      saved = captured.save?.();
      await vi.advanceTimersByTimeAsync(0);
      captured.runtime?.resetRuntime();
      await failWrites(new Error("container torn down"));
    });

    await expect(saved).resolves.toBeUndefined();
    expect(captured.errorMessage).toBeNull();
  });

  // runOnFileSave reruns the runner after a save; a save that straddled a
  // reset must not boot the runtime the reset just stopped.
  it("does not restart a runtime that was reset while the save synced", async () => {
    const { captured, failWrites, boot } = await startWithFailingWrites();

    let saved: Promise<void> | undefined;
    await act(async () => {
      saved = captured.save?.();
      await vi.advanceTimersByTimeAsync(0);
      captured.runtime?.resetRuntime();
      await failWrites(new Error("container torn down"));
    });

    await expect(saved).resolves.toBeUndefined();
    expect(boot).not.toHaveBeenCalled();
  });

  /** A runtime whose start failed: status "error" and no container to sync to. */
  async function renderAfterFailedStart() {
    const { getOrBootSharedWebContainer } = await import("./webContainerRuntimeSupport");
    const boot = vi.mocked(getOrBootSharedWebContainer);
    boot.mockReset();
    boot.mockRejectedValue(new Error("boot failed"));

    const captured: {
      runtime: WebContainerRuntimeActions | null;
      workspace: WorkspaceActions | null;
      save: (() => Promise<void>) | null;
      status: string | null;
    } = { runtime: null, workspace: null, save: null, status: null };
    function Capture() {
      captured.runtime = useWebContainerRuntimeActions();
      captured.workspace = useWorkspaceActions();
      captured.save = useWebContainerRuntimeSaveWorkspace();
      captured.status = useWebContainerRuntimeMetadata().status;
      return null;
    }
    render(
      <WorkspaceProvider>
        <WebContainerRuntimeProvider allowAmbientStart={false}>
          <Capture />
        </WebContainerRuntimeProvider>
      </WorkspaceProvider>,
    );
    await act(async () => {
      await captured.runtime?.startRuntime();
    });
    expect(captured.status).toBe("error");
    expect(boot).toHaveBeenCalledTimes(1);

    return { captured, boot };
  }

  function lessonProject(id: string, lessonType: WorkspaceLessonType): WorkspaceProject {
    const entryFilePath = lessonType === "go" ? "main.go" : "main.js";
    return {
      id,
      name: id,
      lessonType,
      entryFilePath,
      folders: [],
      files: { [entryFilePath]: createWorkspaceFile(entryFilePath, "") },
    };
  }

  // A replayed recording load saves in the same task as loadProject, before the
  // provider re-renders. The save must leave the switch to the project and
  // lesson-type effects rather than run the new project on the old settings.
  it.each([
    { switchTo: "a non-WebContainer lesson", project: lessonProject("go-workspace", "go") },
    { switchTo: "another project", project: lessonProject("other-project", "javascript") },
  ])("does not boot for a save in the same task as a switch to $switchTo", async ({ project }) => {
    const { captured, boot } = await renderAfterFailedStart();

    await act(async () => {
      captured.workspace?.loadProject(project, project.entryFilePath);
      void captured.save?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(boot).toHaveBeenCalledTimes(1);
  });

  // updateLessonType switches the lesson type under the same project id, so only
  // the store's lesson type, not the render ref, tells this save to stand down.
  it("does not boot for a save in the same task as a lesson-type switch under the same id", async () => {
    const { captured, boot } = await renderAfterFailedStart();

    await act(async () => {
      const workspace = captured.workspace;
      if (!workspace) throw new Error("Expected the workspace provider to render");
      const project = lessonProject(workspace.getProject().id, "go");
      workspace.loadProject(project, project.entryFilePath);
      void captured.save?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(boot).toHaveBeenCalledTimes(1);
  });
});
