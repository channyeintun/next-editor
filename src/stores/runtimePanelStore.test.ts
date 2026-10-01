import { describe, expect, it } from "vite-plus/test";
import {
  createRuntimePanelStore,
  selectIsFullHeight,
  selectRecordingState,
  selectViewerFullHeight,
} from "./runtimePanelStore";

describe("runtimePanelStore viewer full height", () => {
  it("starts with no viewer choice", () => {
    const store = createRuntimePanelStore();

    expect(selectViewerFullHeight(store.getSnapshot().context)).toBeNull();
  });

  it("keeps the viewer's choice apart from the live height", () => {
    const store = createRuntimePanelStore();

    store.trigger.setViewerFullHeight({ fullHeight: true });

    expect(selectViewerFullHeight(store.getSnapshot().context)).toBe(true);
    expect(selectIsFullHeight(store.getSnapshot().context)).toBe(false);

    store.trigger.setViewerFullHeight({ fullHeight: false });
    expect(selectViewerFullHeight(store.getSnapshot().context)).toBe(false);

    store.trigger.clearViewerFullHeight();
    expect(selectViewerFullHeight(store.getSnapshot().context)).toBeNull();
  });

  it("leaves the store untouched when nothing changes", () => {
    const store = createRuntimePanelStore();
    store.trigger.setViewerFullHeight({ fullHeight: true });
    const before = store.getSnapshot().context;

    store.trigger.setViewerFullHeight({ fullHeight: true });
    expect(store.getSnapshot().context).toBe(before);

    store.trigger.clearViewerFullHeight();
    const cleared = store.getSnapshot().context;
    store.trigger.clearViewerFullHeight();
    expect(store.getSnapshot().context).toBe(cleared);
  });

  it("never puts the viewer's choice into what a recording captures", () => {
    const store = createRuntimePanelStore();

    store.trigger.setViewerFullHeight({ fullHeight: true });
    const recorded = selectRecordingState(store.getSnapshot().context);

    expect(recorded.isFullHeight).toBe(false);
    expect(recorded).not.toHaveProperty("viewerFullHeight");
  });
});
