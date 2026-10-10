import { act, render } from "@testing-library/react";
import type { WebContainer } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  useWebContainerWorkspaceSync,
  WEBCONTAINER_FILE_SYNC_WINDOW_MS,
  WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS,
  type WorkspaceSyncOptions,
} from "./useWebContainerWorkspaceSync";
import { readWorkspaceProject } from "../runtime/webcontainer/files";
import type { WorkspaceProject } from "../types/workspace";
import {
  flushPerformanceMetrics,
  resetPerformanceMetricsForTests,
} from "../utils/performanceMetrics";

// The reverse sync's container read, so a test controls what the container holds
// and when the read settles.
vi.mock("../runtime/webcontainer/files", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/webcontainer/files")>();
  return {
    ...actual,
    readWorkspaceProject: vi.fn<typeof actual.readWorkspaceProject>(),
  };
});

const project = {
  id: "project-1",
  name: "Project",
  lessonType: "react",
  entryFilePath: "index.html",
  folders: [],
  files: {
    "index.html": {
      path: "index.html",
      name: "index.html",
      language: "html",
      content: "<main>Hello</main>",
    },
  },
} satisfies WorkspaceProject;

/** A container project holding a file a container process wrote. */
function withGeneratedFile(content: string): WorkspaceProject {
  return {
    ...project,
    files: {
      ...project.files,
      "gen.ts": { path: "gen.ts", name: "gen.ts", language: "typescript", content },
    },
  };
}

function renderWorkspaceSyncHook(overrides: Partial<WorkspaceSyncOptions> = {}) {
  const options: WorkspaceSyncOptions = {
    getProject: () => project,
    getWorkspaceRevision: () => 0,
    reconcileExternalProject: vi.fn<WorkspaceSyncOptions["reconcileExternalProject"]>(),
    shouldReverseSync: () => true,
    getRuntimeGeneration: () => 0,
    isRuntimeGenerationActive: () => true,
    reportErrorFor: () => () => {},
    ...overrides,
  };

  // Captured via an object so control-flow analysis keeps the declared union type
  // at each access (a captured `let` reassigned inside the Harness closure narrows
  // to `never` after the non-null check).
  const captured: { hook: ReturnType<typeof useWebContainerWorkspaceSync> | null } = {
    hook: null,
  };

  function Harness() {
    captured.hook = useWebContainerWorkspaceSync(options);
    return null;
  }

  render(<Harness />);

  if (!captured.hook) {
    throw new Error("Expected workspace sync hook to render");
  }

  return captured.hook;
}

/** A container mounted with `project`; it has no fs.watch, so only explicit requests reverse sync. */
async function mountProject(hook: ReturnType<typeof useWebContainerWorkspaceSync>) {
  const instance = {
    mount: vi.fn<() => Promise<void>>(async () => {}),
    fs: {},
  } as unknown as WebContainer;
  await act(async () => {
    await hook.ensureProjectMounted({ instance, project });
  });
  return instance;
}

async function advanceTimers(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useWebContainerWorkspaceSync", () => {
  beforeEach(() => {
    resetPerformanceMetricsForTests();
    // By default the container holds exactly the workspace project.
    vi.mocked(readWorkspaceProject)
      .mockReset()
      .mockImplementation(async (_instance, currentProject) => currentProject);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPerformanceMetricsForTests();
  });

  it("coalesces each path to its latest value within the file-sync window", async () => {
    vi.useFakeTimers();
    const hook = renderWorkspaceSyncHook();
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {
        watch: vi.fn<() => { close: () => void }>(() => ({ close: vi.fn<() => void>() })),
        writeFile: vi.fn<() => Promise<void>>(async () => {}),
      },
    } as unknown as WebContainer;
    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    const first = hook.queueFileSync({
      instance,
      file: { ...project.files["index.html"], content: "first" },
    });
    const latest = hook.queueFileSync({
      instance,
      file: { ...project.files["index.html"], content: "latest" },
    });
    expect(instance.fs.writeFile).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WEBCONTAINER_FILE_SYNC_WINDOW_MS);
      await Promise.all([first, latest]);
    });
    expect(instance.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(instance.fs.writeFile).toHaveBeenCalledWith("index.html", "latest");
  });

  it("flushes a pending file value immediately at an explicit boundary", async () => {
    vi.useFakeTimers();
    const hook = renderWorkspaceSyncHook();
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {
        watch: vi.fn<() => { close: () => void }>(() => ({ close: vi.fn<() => void>() })),
        writeFile: vi.fn<() => Promise<void>>(async () => {}),
      },
    } as unknown as WebContainer;
    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    const queued = hook.queueFileSync({
      instance,
      file: { ...project.files["index.html"], content: "save now" },
    });
    await act(async () => {
      await hook.flushWorkspaceSync({ instance });
      await queued;
    });
    expect(instance.fs.writeFile).toHaveBeenCalledTimes(1);
    expect(instance.fs.writeFile).toHaveBeenCalledWith("index.html", "save now");

    await vi.advanceTimersByTimeAsync(WEBCONTAINER_FILE_SYNC_WINDOW_MS);
    expect(instance.fs.writeFile).toHaveBeenCalledTimes(1);
  });

  it("does not mark a project mounted when reset wins the mount race", async () => {
    const hook = renderWorkspaceSyncHook();
    const deferredMount: { resolve: (() => void) | null } = { resolve: null };
    const instance = {
      mount: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            deferredMount.resolve = resolve;
          }),
      ),
    } as unknown as WebContainer;

    const mountPromise = hook.ensureProjectMounted({
      instance,
      project,
    });

    // The shared WebContainer mutex starts the mount on its next microtask.
    // Let that queued callback capture its resolver before reset wins the
    // in-flight operation; otherwise the test attempts to resolve `null` and
    // waits forever on a mount that it never released.
    await act(async () => {
      await Promise.resolve();
    });

    hook.resetWorkspaceSync();

    await act(async () => {
      deferredMount.resolve?.();
      await mountPromise;
    });

    expect(instance.mount).toHaveBeenCalledTimes(1);
    expect(hook.isProjectMounted()).toBe(false);
  });

  it("reverse syncs container-originated watch events but suppresses forward-sync echoes", async () => {
    vi.useFakeTimers();
    const hook = renderWorkspaceSyncHook();

    type WatchListener = (event: "rename" | "change", filename: string | Uint8Array) => void;
    const watchClose = vi.fn<() => void>();
    const capturedWatch: { listener: WatchListener | null } = { listener: null };
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {
        watch: vi.fn<
          (path: string, options: unknown, listener: WatchListener) => { close: () => void }
        >((_path, _options, listener) => {
          capturedWatch.listener = listener;
          return { close: watchClose };
        }),
        mkdir: vi.fn<() => Promise<void>>(async () => {}),
        rm: vi.fn<() => Promise<void>>(async () => {}),
        writeFile: vi.fn<() => Promise<void>>(async () => {}),
      },
    } as unknown as WebContainer;

    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    expect(instance.fs.watch).toHaveBeenCalledWith(".", { recursive: true }, expect.any(Function));
    expect(hook.isFsWatchActive()).toBe(true);

    if (!capturedWatch.listener) {
      throw new Error("Expected fs.watch listener to be registered");
    }
    const fireWatch = capturedWatch.listener;

    // A file written by a container process must schedule a reverse sync.
    fireWatch("rename", "server/data.json");
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);
    expect(readWorkspaceProject).toHaveBeenCalledWith(instance, project);

    // Dependency churn is never editor content.
    fireWatch("change", "node_modules/vite/package.json");
    fireWatch("rename", ".git/HEAD");
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);

    // A forward sync writing index.html must not echo back as an external change.
    const nextProject: WorkspaceProject = {
      ...project,
      files: {
        "index.html": {
          ...project.files["index.html"],
          content: "<main>Updated</main>",
        },
      },
    };

    await act(async () => {
      await hook.queueProjectSync({ instance, project: nextProject });
    });

    expect(instance.fs.writeFile).toHaveBeenCalledWith("index.html", "<main>Updated</main>");
    expect(flushPerformanceMetrics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "webcontainer.project_sync",
          dimensions: { outcome: "success" },
          count: 1,
        }),
        expect.objectContaining({
          name: "webcontainer.fs_mutations",
          dimensions: { outcome: "success" },
          sum: 1,
        }),
      ]),
    );
    fireWatch("change", "index.html");
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);

    // Resetting tears the watcher down.
    hook.resetWorkspaceSync();
    expect(watchClose).toHaveBeenCalledTimes(1);
    expect(hook.isFsWatchActive()).toBe(false);
  });

  it("stays inactive without breaking mount when fs.watch is unavailable", async () => {
    const hook = renderWorkspaceSyncHook();
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {},
    } as unknown as WebContainer;

    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    expect(hook.isProjectMounted()).toBe(true);
    expect(hook.isFsWatchActive()).toBe(false);
  });

  it("serializes reverse filesystem reads behind forward writes", async () => {
    const deferredWrite: { resolve: (() => void) | null } = { resolve: null };
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {
        watch: vi.fn<() => { close: () => void }>(() => ({ close: vi.fn<() => void>() })),
        mkdir: vi.fn<() => Promise<void>>(async () => {}),
        rm: vi.fn<() => Promise<void>>(async () => {}),
        writeFile: vi.fn<() => Promise<void>>(
          () =>
            new Promise<void>((resolve) => {
              deferredWrite.resolve = resolve;
            }),
        ),
      },
    } as unknown as WebContainer;
    const hook = renderWorkspaceSyncHook();

    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    const nextProject: WorkspaceProject = {
      ...project,
      files: {
        "index.html": {
          ...project.files["index.html"],
          content: "<main>newer editor content</main>",
        },
      },
    };
    const forwardSync = hook.queueProjectSync({ instance, project: nextProject });
    const readTask = vi.fn<() => Promise<string>>(async () => "runtime snapshot");
    const reverseRead = hook.runSerializedRuntimeTask({ instance, task: readTask });

    await act(async () => {
      await Promise.resolve();
    });
    expect(readTask).not.toHaveBeenCalled();

    await act(async () => {
      deferredWrite.resolve?.();
      await forwardSync;
      await expect(reverseRead).resolves.toBe("runtime snapshot");
    });
    expect(readTask).toHaveBeenCalledTimes(1);
  });

  it("invalidates an in-flight serialized read when the workspace resets", async () => {
    const deferredRead: { resolve: ((value: string) => void) | null } = { resolve: null };
    const instance = {
      mount: vi.fn<() => Promise<void>>(async () => {}),
      fs: {},
    } as unknown as WebContainer;
    const hook = renderWorkspaceSyncHook();

    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });

    const reverseRead = hook.runSerializedRuntimeTask({
      instance,
      task: () =>
        new Promise<string>((resolve) => {
          deferredRead.resolve = resolve;
        }),
    });
    await act(async () => {
      await Promise.resolve();
    });

    hook.resetWorkspaceSync();
    await act(async () => {
      deferredRead.resolve?.("stale snapshot");
      await expect(reverseRead).resolves.toBeUndefined();
    });
  });
  it("coalesces reverse-sync requests inside the debounce window into one read", async () => {
    vi.useFakeTimers();
    const containerProject = withGeneratedFile("export const answer = 42;");
    vi.mocked(readWorkspaceProject).mockResolvedValue(containerProject);
    const reconcileExternalProject = vi.fn<WorkspaceSyncOptions["reconcileExternalProject"]>();
    const hook = renderWorkspaceSyncHook({ reconcileExternalProject });
    const instance = await mountProject(hook);

    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS - 1);
    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS - 1);
    expect(readWorkspaceProject).not.toHaveBeenCalled();

    await advanceTimers(1);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);
    expect(reconcileExternalProject).toHaveBeenCalledTimes(1);
    expect(reconcileExternalProject).toHaveBeenCalledWith(containerProject);
  });

  it("drops a read that a newer request superseded", async () => {
    vi.useFakeTimers();
    const staleProject = withGeneratedFile("stale");
    const latestProject = withGeneratedFile("latest");
    const firstRead: { resolve: ((project: WorkspaceProject) => void) | null } = { resolve: null };
    vi.mocked(readWorkspaceProject)
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceProject>((resolve) => {
            firstRead.resolve = resolve;
          }),
      )
      .mockResolvedValueOnce(latestProject);
    const reconcileExternalProject = vi.fn<WorkspaceSyncOptions["reconcileExternalProject"]>();
    const hook = renderWorkspaceSyncHook({ reconcileExternalProject });
    const instance = await mountProject(hook);

    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);

    // A newer request arrives while the first read is still in flight.
    hook.requestReverseSync(instance, 0);
    await act(async () => {
      firstRead.resolve?.(staleProject);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reconcileExternalProject).not.toHaveBeenCalled();

    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(2);
    expect(reconcileExternalProject).toHaveBeenCalledTimes(1);
    expect(reconcileExternalProject).toHaveBeenCalledWith(latestProject);
  });

  it("reads the container again when the workspace changed during the read", async () => {
    vi.useFakeTimers();
    const containerProject = withGeneratedFile("generated");
    const revision = { current: 0 };
    vi.mocked(readWorkspaceProject)
      .mockImplementationOnce(async () => {
        // An editor edit lands while the recursive read is in flight.
        revision.current += 1;
        return withGeneratedFile("read before the edit converged");
      })
      .mockResolvedValueOnce(containerProject);
    const reconcileExternalProject = vi.fn<WorkspaceSyncOptions["reconcileExternalProject"]>();
    const hook = renderWorkspaceSyncHook({
      getWorkspaceRevision: () => revision.current,
      reconcileExternalProject,
    });
    const instance = await mountProject(hook);

    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);
    expect(reconcileExternalProject).not.toHaveBeenCalled();

    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(2);
    expect(reconcileExternalProject).toHaveBeenCalledTimes(1);
    expect(reconcileExternalProject).toHaveBeenCalledWith(containerProject);
  });

  it("cancels a pending reverse sync and ignores requests while it is off", async () => {
    vi.useFakeTimers();
    const hook = renderWorkspaceSyncHook();
    const instance = await mountProject(hook);

    hook.requestReverseSync(instance, 0);
    hook.setReverseSyncEnabled(false);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).not.toHaveBeenCalled();

    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).not.toHaveBeenCalled();

    hook.setReverseSyncEnabled(true);
    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending reverse sync and drops a read in flight on reset", async () => {
    vi.useFakeTimers();
    const shouldReverseSync = vi.fn<() => boolean>(() => true);
    const reconcileExternalProject = vi.fn<WorkspaceSyncOptions["reconcileExternalProject"]>();
    const hook = renderWorkspaceSyncHook({ shouldReverseSync, reconcileExternalProject });
    const instance = await mountProject(hook);

    hook.requestReverseSync(instance, 0);
    hook.resetWorkspaceSync();
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(shouldReverseSync).not.toHaveBeenCalled();

    const inFlightRead: { resolve: ((project: WorkspaceProject) => void) | null } = {
      resolve: null,
    };
    vi.mocked(readWorkspaceProject).mockImplementationOnce(
      () =>
        new Promise<WorkspaceProject>((resolve) => {
          inFlightRead.resolve = resolve;
        }),
    );
    await act(async () => {
      await hook.ensureProjectMounted({ instance, project });
    });
    hook.requestReverseSync(instance, 0);
    await advanceTimers(WEBCONTAINER_REVERSE_SYNC_DEBOUNCE_MS);
    expect(readWorkspaceProject).toHaveBeenCalledTimes(1);

    hook.resetWorkspaceSync();
    await act(async () => {
      inFlightRead.resolve?.(withGeneratedFile("from the previous runtime"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reconcileExternalProject).not.toHaveBeenCalled();
  });
});
