import { describe, expect, it, vi } from "vite-plus/test";
import { createRuntimePanelStore, selectIsCollapsed } from "../stores/runtimePanelStore";
import { createStudioDriver, type StudioDriverDeps } from "./driver";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

function makeDriver() {
  const runtimePanelStore = createRuntimePanelStore();
  const runtimeEvents: number[] = [];

  const deps = {
    getEditor: () => null,
    workspace: {
      getFile: () => null,
      getProject: () => ({ lessonType: "rust" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    notifyRuntimeEvent: () => runtimeEvents.push(runtimeEvents.length),
    runtimePanelStore,
    slidesStore: {} as StudioDriverDeps["slidesStore"],
    whiteboardStore: {} as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: () => {},
    notifyPreviewEvent: () => {},
    runtimeMode: "fixture",
    runtime: { kind: "rust-playground", defaultMode: "fixture" } as StudioDriverDeps["runtime"],
    planSeed: 29,
    whiteboardAssets: [],
    webContainerRuntime: {} as StudioDriverDeps["webContainerRuntime"],
    preview: {} as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
  } satisfies StudioDriverDeps;

  return { driver: createStudioDriver(deps), runtimePanelStore, runtimeEvents };
}

describe("StudioDriver runner dock", () => {
  it("collapses the dock and records it on the runtime track", async () => {
    const { driver, runtimePanelStore, runtimeEvents } = makeDriver();
    expect(selectIsCollapsed(runtimePanelStore.getSnapshot().context)).toBe(false);

    await expect(driver.collapseRuntimeDock(1_000)).resolves.toMatchObject({ collapsed: true });

    expect(selectIsCollapsed(runtimePanelStore.getSnapshot().context)).toBe(true);
    // Without this the dock's own diff-on-render would only capture the collapse
    // whenever the next unrelated runtime change happened to land, leaving the
    // dock over the editor on replay.
    expect(runtimeEvents).toHaveLength(1);
  });

  it("is a no-op on an already collapsed dock", async () => {
    const { driver, runtimePanelStore, runtimeEvents } = makeDriver();
    runtimePanelStore.trigger.setIsCollapsed({ collapsed: true });

    await expect(driver.collapseRuntimeDock(1_000)).resolves.toMatchObject({
      collapsed: true,
      alreadyCollapsed: true,
    });

    // Re-recording an unchanged state would put a redundant runtime frame in the
    // track for an action that changed nothing.
    expect(runtimeEvents).toHaveLength(0);
  });
});
