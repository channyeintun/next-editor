import { act, cleanup, render } from "@testing-library/react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WorkspaceProvider } from "./WorkspaceProvider";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import { getOrBootSharedWebContainer } from "../runtime/webcontainer/sharedContainer";
import { createWorkspaceFile } from "../starters/shared";
import type { WorkspaceLessonType, WorkspaceProject } from "../types/workspace";
import type { WorkspaceActions } from "./WorkspaceContext";
import type {
  WebContainerRuntimeActions,
  WebContainerRuntimeMetadata,
} from "./WebContainerRuntimeContext";

vi.mock("../runtime/webcontainer/sharedContainer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/webcontainer/sharedContainer")>();
  return {
    ...actual,
    getOrBootSharedWebContainer: vi.fn<() => Promise<WebContainer>>(),
    teardownSharedWebContainer: vi.fn<(instance: WebContainer | null) => void>(),
    holdSharedWebContainer: vi.fn<() => () => void>(() => () => {}),
    isWebContainerRuntimeSupported: () => true,
  };
});

/** Every command line spawned on any container, in order. */
const spawned: string[] = [];

function createFakeWebContainer(): WebContainer {
  return {
    on: vi.fn<() => () => void>(() => () => {}),
    mount: vi.fn<() => Promise<void>>(async () => {}),
    spawn: vi.fn<(command: string, args: string[]) => Promise<WebContainerProcess>>(
      async (command, args) => {
        // Commands run as `sh -lc "<command line>"`.
        const commandLine = command === "sh" ? args[args.length - 1] : [command, ...args].join(" ");
        spawned.push(commandLine);
        // The install exits; the dev server keeps running.
        const isDevServer = commandLine.endsWith(" dev");
        return {
          output: new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`${commandLine} output\n`);
              if (!isDevServer) controller.close();
            },
          }),
          input: new WritableStream<string>(),
          exit: isDevServer ? new Promise<number>(() => {}) : Promise.resolve(0),
          kill: vi.fn<() => void>(),
          resize: vi.fn<() => void>(),
        } as unknown as WebContainerProcess;
      },
    ),
    fs: {
      readdir: vi.fn<() => Promise<never[]>>(async () => []),
      readFile: vi.fn<() => Promise<string>>(async () => {
        throw new Error("ENOENT");
      }),
      mkdir: vi.fn<() => Promise<void>>(async () => {}),
      writeFile: vi.fn<() => Promise<void>>(async () => {}),
      rm: vi.fn<() => Promise<void>>(async () => {}),
    },
  } as unknown as WebContainer;
}

function starterProject(id: string, lessonType: WorkspaceLessonType): WorkspaceProject {
  return {
    id,
    name: id,
    lessonType,
    entryFilePath: "src/main.tsx",
    folders: ["src"],
    files: {
      "package.json": createWorkspaceFile(
        "package.json",
        JSON.stringify({ name: id, scripts: { dev: "vite" } }),
      ),
      "src/main.tsx": createWorkspaceFile("src/main.tsx", `// ${id}`),
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Renders the runtime over a workspace that has already auto-started a Solid
 * starter, then hands control to React's own scheduling. Under act() the swap's
 * render and effects would wait for the end of the act scope, after everything
 * the test does next, which hides the ordering these tests are about.
 */
async function renderRunningSolidWorkspace() {
  let runtime: WebContainerRuntimeActions | null = null;
  let workspace: WorkspaceActions | null = null;
  let metadata: WebContainerRuntimeMetadata | null = null;

  function Capture() {
    runtime = useWebContainerRuntimeActions();
    workspace = useWorkspaceActions();
    metadata = useWebContainerRuntimeMetadata();
    return null;
  }

  render(
    <WorkspaceProvider>
      <WebContainerRuntimeProvider>
        <Capture />
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>,
  );

  await act(async () => {
    workspace!.reconcileExternalProject(starterProject("solid-workspace", "solid"));
    await wait(150);
  });
  expect(spawned).toEqual(["pnpm install", "pnpm dev"]);
  spawned.length = 0;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

  return {
    runtime: () => runtime!,
    workspace: () => workspace!,
    metadata: () => metadata!,
  };
}

describe("WebContainerRuntimeProvider resets a consumer asks for", () => {
  beforeEach(() => {
    spawned.length = 0;
    // A real boot takes seconds; this one is still in flight when the save after
    // the swap resolves.
    vi.mocked(getOrBootSharedWebContainer).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(createFakeWebContainer()), 40)),
    );
  });

  afterEach(() => {
    cleanup();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("installs and runs a switched-to starter when the reset comes before the swap", async () => {
    const editor = await renderRunningSolidWorkspace();

    // EditorHeader's starter switch.
    editor.runtime().resetRuntime();
    editor
      .workspace()
      .reconcileExternalProject(starterProject("tanstack-start-workspace", "react"));
    await editor.workspace().saveProject();
    editor.runtime().updateRunnerConfig({ enabled: true });
    await wait(300);

    expect(spawned).toEqual(["pnpm install", "pnpm dev"]);
  });

  it("starts the new project again when a reset lands after the swap already auto-started it", async () => {
    const editor = await renderRunningSolidWorkspace();

    // The swap's render auto-starts the starter before the save resolves; the
    // reset after it cancels that start mid-boot. It used to leave the runtime
    // idle with no output ("Waiting for runtime output...") until a reload.
    editor
      .workspace()
      .reconcileExternalProject(starterProject("tanstack-start-workspace", "react"));
    await editor.workspace().saveProject();
    editor.runtime().resetRuntime();
    await wait(300);

    expect(spawned).toEqual(["pnpm install", "pnpm dev"]);
    expect(editor.metadata().status).not.toBe("idle");
  });

  it("reinstalls a re-imported project that keeps its id", async () => {
    const editor = await renderRunningSolidWorkspace();
    const reimported = starterProject("solid-workspace", "solid");
    reimported.files["src/extra.ts"] = createWorkspaceFile("src/extra.ts", "export {};");

    // EditorHeader's zip import: the id comes from the zip's name, so no
    // project change resets the runtime; only the explicit reset does.
    editor.runtime().resetRuntime();
    editor.workspace().reconcileExternalProject(reimported);
    await editor.workspace().saveProject();
    await wait(300);

    expect(spawned).toEqual(["pnpm install", "pnpm dev"]);
  });

  it("starts nothing when the reset comes with a runner config that does not run on startup", async () => {
    const editor = await renderRunningSolidWorkspace();

    // The studio's runtime contract: it starts the runner itself.
    editor.runtime().resetRuntime();
    editor.runtime().configureRuntime({
      environmentVariables: {},
      runnerConfig: {
        enabled: true,
        runOnStartup: false,
        runOnFileSave: false,
        initCommand: "pnpm install",
        runCommand: "pnpm dev",
      },
    });
    await wait(300);

    expect(spawned).toEqual([]);
    expect(editor.metadata().status).toBe("idle");
  });
});
