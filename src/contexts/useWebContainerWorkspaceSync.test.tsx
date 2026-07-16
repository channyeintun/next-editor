import { act, render } from "@testing-library/react";
import type { WebContainer } from "@webcontainer/api";
import { describe, expect, it, vi } from "vite-plus/test";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import type { WorkspaceProject } from "../types/workspace";

const project: WorkspaceProject = {
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
};

function renderWorkspaceSyncHook(options?: Parameters<typeof useWebContainerWorkspaceSync>[0]) {
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

describe("useWebContainerWorkspaceSync", () => {
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
    expect(hook.hasMountedProjectRef.current).toBe(false);
  });

  it("reports container-originated watch events but suppresses forward-sync echoes", async () => {
    const onExternalFileChange = vi.fn<(instance: WebContainer) => void>();
    const hook = renderWorkspaceSyncHook({ onExternalFileChange });

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
    expect(onExternalFileChange).toHaveBeenCalledTimes(1);
    expect(onExternalFileChange).toHaveBeenCalledWith(instance);

    // Dependency churn is never editor content.
    fireWatch("change", "node_modules/vite/package.json");
    fireWatch("rename", ".git/HEAD");
    expect(onExternalFileChange).toHaveBeenCalledTimes(1);

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
    fireWatch("change", "index.html");
    expect(onExternalFileChange).toHaveBeenCalledTimes(1);

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

    expect(hook.hasMountedProjectRef.current).toBe(true);
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
});
