import { act, cleanup, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import {
  getOrBootSharedWebContainer,
  holdSharedWebContainer,
  teardownSharedWebContainer,
} from "../runtime/webcontainer/sharedContainer";
import { useWebContainerRuntimeActions } from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { createWorkspaceFile } from "../starters/shared";
import type { WorkspaceActions } from "../stores/workspaceActions";
import type { WorkspaceProject } from "../types/workspace";
import type { WebContainerRuntimeActions } from "./WebContainerRuntimeContext";

// Only the boot is faked: the shared container's lifetime is the real one.
const bootWebContainer = vi.hoisted(() => vi.fn<() => Promise<WebContainer>>());

vi.mock("@webcontainer/api", () => ({ WebContainer: { boot: bootWebContainer } }));

function createStandInWebContainer() {
  return {
    setPreviewScript: vi.fn<(script: string) => Promise<void>>(async () => {}),
    teardown: vi.fn<() => void>(),
    on: vi.fn<() => () => void>(() => () => {}),
    mount: vi.fn<() => Promise<void>>(async () => {}),
  };
}

type StandInWebContainer = ReturnType<typeof createStandInWebContainer>;

/** Holds the next boot open; the returned function lands it with an instance. */
function deferNextBoot(): (instance: StandInWebContainer) => void {
  let land: ((instance: WebContainer) => void) | null = null;
  bootWebContainer.mockReturnValueOnce(
    new Promise((resolve) => {
      land = resolve;
    }),
  );
  return (instance) => land?.(instance as unknown as WebContainer);
}

function nodeProject(id: string, files: Record<string, string>): WorkspaceProject {
  return {
    id,
    name: id,
    lessonType: "javascript",
    entryFilePath: "main.js",
    folders: [],
    files: Object.fromEntries(
      Object.entries({ "main.js": "", ...files }).map(([path, content]) => [
        path,
        createWorkspaceFile(path, content),
      ]),
    ),
  };
}

async function renderEditor({ runner = false } = {}) {
  let runtime: WebContainerRuntimeActions | null = null;
  let workspace: WorkspaceActions | null = null;

  function Capture() {
    runtime = useWebContainerRuntimeActions();
    workspace = useWorkspaceActions();
    return null;
  }

  const view = render(
    <WorkspaceProvider>
      <WebContainerRuntimeProvider allowAmbientStart={false}>
        <Capture />
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>,
  );

  const getRuntime = () => {
    if (!runtime) {
      throw new Error("Expected the runtime provider to render");
    }
    return runtime;
  };

  // No install and, unless asked, no runner: once the boot lands, starting only
  // mounts the project.
  await act(async () => {
    getRuntime().updateRunnerConfig(
      runner ? { initCommand: "" } : { enabled: false, initCommand: "" },
    );
  });

  /** Starts the runtime and returns the start, which settles once the boot lands. */
  const startRuntime = () => {
    let starting: Promise<void> = Promise.resolve();
    act(() => {
      starting = getRuntime().startRuntime();
    });
    return starting;
  };

  /** Loads `project` in place, as an imported recording or a next lesson does. */
  const loadProject = (project: WorkspaceProject) => {
    act(() => {
      if (!workspace) throw new Error("Expected the workspace provider to render");
      workspace.loadProject(project, project.entryFilePath);
    });
  };

  return { startRuntime, loadProject, unmount: view.unmount };
}

/**
 * The agent's bash tool on its own: it boots or joins the shared container
 * without holding it or telling the runtime, then mounts the project it reads.
 */
async function bashMounts(tree: object): Promise<WebContainer> {
  const instance = await getOrBootSharedWebContainer();
  await instance.mount(tree as never);
  return instance;
}

describe("WebContainerRuntimeProvider shared container lifetime", () => {
  beforeEach(() => {
    bootWebContainer.mockReset();
    // isWebContainerRuntimeSupported() gates the runtime on cross-origin isolation.
    vi.stubGlobal("crossOriginIsolated", true);
  });

  // The shared container is module state, so a test that leaves one behind would
  // hand it to the next. Unmount what a failed test left mounted, check that a new
  // holder boots afresh and that its release is the last, and clear the container
  // either way.
  afterEach(async () => {
    vi.unstubAllGlobals();
    cleanup();

    const fresh = createStandInWebContainer();
    const freshInstance = fresh as unknown as WebContainer;
    bootWebContainer.mockReset();
    bootWebContainer.mockResolvedValueOnce(freshInstance);
    const release = holdSharedWebContainer();
    const shared = await getOrBootSharedWebContainer();
    release();
    const releasedLast = fresh.teardown.mock.calls.length === 1;
    teardownSharedWebContainer(shared);

    if (shared !== freshInstance) {
      throw new Error("The test left the shared container behind");
    }
    if (!releasedLast) {
      throw new Error("The test left a holder of the shared container behind");
    }
  });

  it("tears down a container whose boot lands after the editor left", async () => {
    const landBoot = deferNextBoot();
    const editor = await renderEditor();
    const starting = editor.startRuntime();
    editor.unmount();

    const instance = createStandInWebContainer();
    await act(async () => {
      landBoot(instance);
      await starting;
    });

    expect(instance.teardown).toHaveBeenCalledOnce();
    expect(instance.mount).not.toHaveBeenCalled();
  });

  it("hands a boot the previous editor left behind to the editor that replaced it", async () => {
    const landBoot = deferNextBoot();
    const previous = await renderEditor();
    void previous.startRuntime();
    previous.unmount();

    const next = await renderEditor();
    const starting = next.startRuntime();
    const instance = createStandInWebContainer();
    await act(async () => {
      landBoot(instance);
      await starting;
    });

    expect(bootWebContainer).toHaveBeenCalledOnce();
    expect(instance.mount).toHaveBeenCalledOnce();
    expect(instance.teardown).not.toHaveBeenCalled();

    next.unmount();
    expect(instance.teardown).toHaveBeenCalledOnce();
  });

  // A project change resets the runtime so the next project starts from a clean
  // container. A container only the agent's bash tool booted still holds that
  // command's copy of the old project, files it wrote and anything it left running.
  it("tears down a container the agent booted when the project changes", async () => {
    const agentContainer = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(agentContainer as unknown as WebContainer);
    const editor = await renderEditor();
    editor.loadProject(nodeProject("lesson-a", { ".pnpmfile.cjs": "from lesson A" }));
    await act(async () => {
      await bashMounts({ "lesson-a": true });
    });

    editor.loadProject(nodeProject("project-b", {}));
    expect(agentContainer.teardown).toHaveBeenCalledOnce();

    const next = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(next as unknown as WebContainer);
    await act(async () => {
      await editor.startRuntime();
    });
    expect(bootWebContainer).toHaveBeenCalledTimes(2);
    expect(next.mount).toHaveBeenCalledOnce();
    expect(agentContainer.mount).toHaveBeenCalledOnce();

    editor.unmount();
  });

  // The runtime mounts a project over the container's tree without removing the
  // paths it does not know, and its reverse sync then reads them all back into the
  // workspace. So it never adopts a container only the agent has used, whatever
  // that tool mounted there; the same id does not make it the same project.
  it("boots its own container instead of the one the agent booted", async () => {
    const agentContainer = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(agentContainer as unknown as WebContainer);
    const editor = await renderEditor();
    await act(async () => {
      await bashMounts({ "planted.cjs": true });
    });

    const own = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(own as unknown as WebContainer);
    await act(async () => {
      await editor.startRuntime();
    });

    expect(agentContainer.teardown).toHaveBeenCalledOnce();
    expect(own.mount).toHaveBeenCalledOnce();
    expect(own.teardown).not.toHaveBeenCalled();

    editor.unmount();
  });

  // The agent's bash tool still shares the runtime's container: it reads the files
  // the user is looking at, and its changes fold back into the workspace.
  it("lets the agent join the runtime's container", async () => {
    const instance = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(instance as unknown as WebContainer);
    const editor = await renderEditor();
    await act(async () => {
      await editor.startRuntime();
    });

    await act(async () => {
      expect(await bashMounts({})).toBe(instance);
    });
    expect(bootWebContainer).toHaveBeenCalledOnce();
    expect(instance.teardown).not.toHaveBeenCalled();

    editor.unmount();
  });

  // A project change while the first boot is still in flight, with an approved
  // bash command waiting on that boot: the command mounts the old project there
  // once it lands, so the next project must not be handed the same container.
  it("does not hand the next project a boot that was in flight at the reset", async () => {
    const landFirstBoot = deferNextBoot();
    const editor = await renderEditor();
    editor.loadProject(nodeProject("lesson-a", {}));
    const firstStart = editor.startRuntime();
    let agentInstance: WebContainer | null = null;
    const agentMount = bashMounts({ "lesson-a": true }).then(
      (instance) => {
        agentInstance = instance;
      },
      () => {},
    );

    editor.loadProject(nodeProject("project-b", {}));
    const next = createStandInWebContainer();
    bootWebContainer.mockResolvedValueOnce(next as unknown as WebContainer);
    const nextStart = editor.startRuntime();

    const first = createStandInWebContainer();
    await act(async () => {
      landFirstBoot(first);
      await Promise.all([firstStart, agentMount, nextStart]);
    });

    expect(agentInstance).toBe(first);
    expect(first.teardown).toHaveBeenCalledOnce();
    expect(bootWebContainer).toHaveBeenCalledTimes(2);
    expect(next.mount).toHaveBeenCalledOnce();
    // The bash tool's copy of lesson A is the only thing the old container got.
    expect(first.mount).toHaveBeenCalledOnce();

    editor.unmount();
  });

  // The provider resets before it releases, so its processes are stopped before
  // the container they run in is torn down.
  it("stops the editor's runner before it tears the container down", async () => {
    const kill = vi.fn<() => void>();
    const instance = {
      ...createStandInWebContainer(),
      // A dev server that keeps running.
      spawn: vi.fn<() => Promise<WebContainerProcess>>(
        async () =>
          ({
            output: new ReadableStream({ start: (controller) => controller.close() }),
            input: new WritableStream(),
            exit: new Promise<number>(() => {}),
            kill,
            resize: vi.fn<() => void>(),
          }) as unknown as WebContainerProcess,
      ),
    };
    bootWebContainer.mockResolvedValueOnce(instance as unknown as WebContainer);
    const editor = await renderEditor({ runner: true });
    const starting = editor.startRuntime();
    await act(async () => {
      await starting;
    });
    expect(instance.spawn).toHaveBeenCalledOnce();

    editor.unmount();

    expect(kill).toHaveBeenCalledOnce();
    expect(instance.teardown).toHaveBeenCalledOnce();
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(
      instance.teardown.mock.invocationCallOrder[0],
    );
  });
});
