import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceEventRecorder } from "./WorkspaceEventRecorder";
import { createWorkspaceStore, WorkspaceStoreContext } from "../stores/workspaceStore";
import type { WorkspaceProject, WorkspaceTextFile } from "../types/workspace";

function file(path: string, content: string): WorkspaceTextFile {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    language: "typescript",
    content,
  };
}

function project(): WorkspaceProject {
  return {
    id: "recorder",
    name: "Recorder",
    lessonType: "react",
    entryFilePath: "src/a.ts",
    folders: ["src"],
    files: {
      "src/a.ts": file("src/a.ts", "export const a = 1;"),
      "src/b.ts": file("src/b.ts", "export const b = 1;"),
    },
  };
}

function initializedContext(store: ReturnType<typeof createWorkspaceStore>) {
  const context = store.getSnapshot().context;
  if (!context.isInitialized) throw new Error("Expected initialized workspace");
  return context;
}

function renderRecorder(options?: { isRecording?: boolean }) {
  const store = createWorkspaceStore({ activeFilePath: "src/a.ts", project: project() });
  const handleWorkspaceEvent = vi.fn<(event?: { sidebarWidthDelta?: number }) => void>();
  render(
    <WorkspaceStoreContext value={store}>
      <WorkspaceEventRecorder
        handleWorkspaceEvent={handleWorkspaceEvent}
        isRecording={options?.isRecording ?? false}
        shouldTrackWorkspaceChanges={true}
      />
    </WorkspaceStoreContext>,
  );
  return { store, handleWorkspaceEvent };
}

function externallyChangedProject(current: WorkspaceProject): WorkspaceProject {
  return {
    ...current,
    files: {
      ...current.files,
      "pnpm-lock.yaml": file("pnpm-lock.yaml", "lockfileVersion: 9"),
    },
  };
}

describe("WorkspaceEventRecorder", () => {
  it("absorbs external reconciles during playback so they cannot pause the lesson", () => {
    const { store, handleWorkspaceEvent } = renderRecorder({ isRecording: false });

    act(() => {
      store.trigger.reconcileExternalProject({
        project: externallyChangedProject(initializedContext(store).project),
      });
    });

    expect(handleWorkspaceEvent).not.toHaveBeenCalled();
  });

  it("still fires for external reconciles while recording so they are captured", () => {
    const { store, handleWorkspaceEvent } = renderRecorder({ isRecording: true });

    act(() => {
      store.trigger.reconcileExternalProject({
        project: externallyChangedProject(initializedContext(store).project),
      });
    });

    expect(handleWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(handleWorkspaceEvent).toHaveBeenCalledWith({ sidebarWidthDelta: 0 });
  });

  it("fires for local project replacements during playback", () => {
    const { store, handleWorkspaceEvent } = renderRecorder({ isRecording: false });
    const nextProject = { ...project(), id: "imported", name: "Imported" };

    act(() => {
      store.trigger.loadProject({
        project: nextProject,
        activeFilePath: "src/a.ts",
        savedSnapshot: { activeFilePath: "src/a.ts", project: nextProject },
      });
    });

    expect(handleWorkspaceEvent).toHaveBeenCalledTimes(1);
  });

  it("fires with the width delta for local sidebar resizes", () => {
    const { store, handleWorkspaceEvent } = renderRecorder({ isRecording: false });
    const initialWidth = store.getSnapshot().context.sidebarWidth;

    act(() => {
      store.trigger.setSidebarWidth({ width: initialWidth + 40 });
    });

    expect(handleWorkspaceEvent).toHaveBeenCalledTimes(1);
    expect(handleWorkspaceEvent).toHaveBeenCalledWith({ sidebarWidthDelta: 40 });
  });
});
