import { act, render } from "@testing-library/react";
import type { WebContainer } from "@webcontainer/api";
import { describe, expect, it, vi } from "vite-plus/test";
import { useWebContainerWorkspaceSync } from "./useWebContainerWorkspaceSync";
import type { WorkspaceProject } from "../types/workspace";

const project: WorkspaceProject = {
  id: "project-1",
  name: "Project",
  lessonType: "node.js",
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

function renderWorkspaceSyncHook() {
  let hook: ReturnType<typeof useWebContainerWorkspaceSync> | null = null;

  function Harness() {
    hook = useWebContainerWorkspaceSync();
    return null;
  }

  render(<Harness />);

  if (!hook) {
    throw new Error("Expected workspace sync hook to render");
  }

  return hook;
}

describe("useWebContainerWorkspaceSync", () => {
  it("does not mark a project mounted when reset wins the mount race", async () => {
    const hook = renderWorkspaceSyncHook();
    let finishMount: (() => void) | null = null;
    const instance = {
      mount: vi.fn<() => Promise<void>>(
        () =>
          new Promise<void>((resolve) => {
            finishMount = resolve;
          }),
      ),
    } as unknown as WebContainer;

    const mountPromise = hook.ensureProjectMounted({
      instance,
      project,
    });

    hook.resetWorkspaceSync();

    await act(async () => {
      finishMount?.();
      await mountPromise;
    });

    expect(instance.mount).toHaveBeenCalledTimes(1);
    expect(hook.hasMountedProjectRef.current).toBe(false);
  });
});
