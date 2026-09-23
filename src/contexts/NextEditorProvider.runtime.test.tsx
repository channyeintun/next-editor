import { act, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextEditorProvider } from "./NextEditorProvider";
import { NextEditorActorContext } from "./NextEditorActorContext";
import { PreviewAdapterHandleProvider } from "./PreviewAdapterHandleContext";
import { RuntimePanelStoreProvider } from "./RuntimePanelStoreContext";
import { SlidesStoreProvider } from "./SlidesStoreContext";
import { WebContainerRuntimeProvider } from "./WebContainerRuntimeProvider";
import { WhiteboardStoreProvider } from "./WhiteboardStoreContext";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { getOrBootSharedWebContainer } from "./webContainerRuntimeSupport";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useWebContainerRuntimeMetadata } from "../hooks/useWebContainerRuntime";
import { createWorkspaceFile } from "../starters/shared";
import type { NextEditorActions } from "./NextEditorContext";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type { Recording } from "../core/src/types";
import {
  isWorkspaceTextFile,
  type WorkspaceLessonType,
  type WorkspaceRecordingSnapshot,
} from "../types/workspace";

// Kept out of NextEditorProvider.test.tsx so this module mock, which puts a fake
// WebContainer behind the runtime, does not reach the tests there.
vi.mock("./webContainerRuntimeSupport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webContainerRuntimeSupport")>();
  return {
    ...actual,
    getOrBootSharedWebContainer: vi.fn<() => Promise<WebContainer>>(),
  };
});

interface SurfaceProps {
  /** False for surfaces that never start the runtime on their own (`runtimeAutoStart`). */
  allowAmbientStart: boolean;
  /** Set on /learn, where the store starts empty until the lesson's recording loads. */
  pendingRecordingUrl?: string;
}

/** The providers Editor.tsx wraps NextEditorProvider in, minus collaboration and UI. */
function EditorProviders({
  allowAmbientStart,
  pendingRecordingUrl,
  children,
}: PropsWithChildren<SurfaceProps>) {
  return (
    <WorkspaceProvider pendingRecordingUrl={pendingRecordingUrl}>
      <WebContainerRuntimeProvider allowAmbientStart={allowAmbientStart}>
        <SlidesStoreProvider>
          <WhiteboardStoreProvider>
            <RuntimePanelStoreProvider>
              <PreviewAdapterHandleProvider>
                <NextEditorProvider>{children}</NextEditorProvider>
              </PreviewAdapterHandleProvider>
            </RuntimePanelStoreProvider>
          </WhiteboardStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}

/** A container whose every process exits at once, like a script that has finished. */
function createFakeInstance() {
  return {
    on: vi.fn<() => () => void>(() => () => {}),
    mount: vi.fn<() => Promise<void>>(async () => {}),
    setPreviewScript: vi.fn<() => Promise<void>>(async () => {}),
    spawn: vi.fn<(command: string, args: string[]) => Promise<WebContainerProcess>>(
      async () =>
        ({
          output: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          input: new WritableStream(),
          exit: Promise.resolve(0),
          kill: vi.fn<() => void>(),
          resize: vi.fn<() => void>(),
        }) as unknown as WebContainerProcess,
    ),
    fs: {
      readdir: vi.fn<() => Promise<[]>>(async () => []),
      readFile: vi.fn<() => Promise<string>>(async () => ""),
      mkdir: vi.fn<() => Promise<void>>(async () => {}),
      writeFile: vi.fn<() => Promise<void>>(async () => {}),
      rm: vi.fn<() => Promise<void>>(async () => {}),
      watch: vi.fn<() => { close: () => void }>(() => ({ close: vi.fn<() => void>() })),
    },
  };
}

function renderEditor(surface: SurfaceProps) {
  const instance = createFakeInstance();
  const boot = vi.mocked(getOrBootSharedWebContainer);
  boot.mockReset();
  boot.mockResolvedValue(instance as unknown as WebContainer);

  const captured: {
    actions: NextEditorActions | null;
    actor: EditorActorRef | null;
    runtimeStatus: string | null;
  } = { actions: null, actor: null, runtimeStatus: null };

  function Capture() {
    captured.actions = useNextEditorActions();
    captured.actor = NextEditorActorContext.useActorRef();
    captured.runtimeStatus = useWebContainerRuntimeMetadata().status;
    return null;
  }

  render(
    <EditorProviders {...surface}>
      <Capture />
    </EditorProviders>,
  );

  const { actions, actor } = captured;
  if (!actions || !actor) throw new Error("Expected the providers to render");

  const loadRecording = async (recording: Recording) => {
    act(() => actions.loadRecording(recording));
    await waitFor(() => expect(actor.getSnapshot().matches({ playback: "ready" })).toBe(true));
    await settle();
  };
  const send = async (event: Parameters<EditorActorRef["send"]>[0]) => {
    act(() => actor.send(event));
    await settle();
  };
  const spawnedCommands = () => instance.spawn.mock.calls.map(([, args]) => args.join(" "));

  return { boot, captured, loadRecording, send, spawnedCommands };
}

/** Lets the runtime's boot, sync, install and runner promises run out. */
async function settle() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }
}

function workspaceSnapshot({
  projectId,
  lessonType = "javascript",
  source,
  sidebarScrollTop = 0,
}: {
  projectId: string;
  lessonType?: WorkspaceLessonType;
  source: string;
  sidebarScrollTop?: number;
}): WorkspaceRecordingSnapshot {
  const entryFilePath = lessonType === "go" ? "main.go" : "main.js";
  const files = { [entryFilePath]: createWorkspaceFile(entryFilePath, source) };
  if (lessonType !== "go") {
    files["package.json"] = createWorkspaceFile(
      "package.json",
      JSON.stringify({ scripts: { dev: "node main.js" } }),
    );
  }

  return {
    activeFilePath: entryFilePath,
    collapsedFolders: [],
    sidebarScrollTop,
    project: { id: projectId, name: projectId, lessonType, entryFilePath, folders: [], files },
  };
}

function lessonRecording(id: string, snapshots: WorkspaceRecordingSnapshot[]): Recording {
  const [first] = snapshots;
  const activeFile = first?.project.files[first.activeFilePath];
  return {
    version: 4,
    id,
    name: id,
    createdAt: 1,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: activeFile && isWorkspaceTextFile(activeFile) ? activeFile.content : "",
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
            selectionStartLineNumber: 1,
            selectionStartColumn: 1,
            positionLineNumber: 1,
            positionColumn: 1,
          },
          position: { lineNumber: 1, column: 1 },
          viewState: null,
          mouseCursor: { x: 0, y: 0, visible: false },
        },
      },
    ],
    workspaceEvents: snapshots.map((snapshot, index) => ({ timestamp: index * 100, snapshot })),
  };
}

/** A javascript lesson whose three workspace events only scroll the file tree. */
function scrollingLesson(projectId: string) {
  return lessonRecording(
    "scrolling-lesson",
    [0, 40, 80].map((sidebarScrollTop) =>
      workspaceSnapshot({ projectId, source: "console.log(1)", sidebarScrollTop }),
    ),
  );
}

const goLesson = () =>
  lessonRecording("go-lesson", [
    workspaceSnapshot({ projectId: "go-workspace", lessonType: "go", source: "package main" }),
  ]);

describe("NextEditorProvider replay and the WebContainer runtime", () => {
  beforeEach(() => {
    // isWebContainerRuntimeSupported() gates the runtime on cross-origin isolation.
    vi.stubGlobal("crossOriginIsolated", true);
    // The playback clock ticks on animation frames. Holding them leaves the
    // tests' TICK events as the only clock, so each replay position is exact.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn<(callback: FrameRequestCallback) => number>(() => 0),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn<(id: number) => void>());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Starting the runtime is the auto-start's call (allowAmbientStart,
  // runOnStartup, browser support) or the viewer's. A replay only keeps a
  // runtime that has been started in step with the replayed workspace.
  it("does not start a runtime that is not up", async () => {
    const editor = renderEditor({ allowAmbientStart: false });

    await editor.loadRecording(scrollingLesson("javascript-workspace"));
    act(() => editor.captured.actions?.play());
    await editor.send({ type: "TICK", currentTime: 150 });
    await editor.send({ type: "TICK", currentTime: 250 });
    act(() => editor.captured.actions?.pause());
    await settle();

    expect(editor.boot).not.toHaveBeenCalled();
    expect(editor.spawnedCommands()).toEqual([]);
    expect(editor.captured.runtimeStatus).toBe("idle");
  });

  it.each([
    { surface: "a fresh /learn visit", allowAmbientStart: true, pendingRecordingUrl: "/lesson.ne" },
    { surface: "a surface that never auto-starts", allowAmbientStart: false },
  ])("does not boot a WebContainer to load a Go lesson on $surface", async (surface) => {
    const editor = renderEditor(surface);
    await settle();
    editor.boot.mockClear();

    await editor.loadRecording(goLesson());

    expect(editor.boot).not.toHaveBeenCalled();
  });

  // Continue-to-Next on /learn loads the next lesson into the mounted Editor.
  // A hand-recorded lesson keeps its starter's project id, so the runtime is not
  // reset and does not auto-start again: the replayed save is what runs it.
  it("re-runs a finished runner when the next lesson reuses the project id", async () => {
    const editor = renderEditor({ allowAmbientStart: true, pendingRecordingUrl: "/lesson.ne" });
    const lesson = (id: string, source: string) =>
      lessonRecording(id, [workspaceSnapshot({ projectId: "javascript-workspace", source })]);

    await editor.loadRecording(lesson("lesson-a", "console.log('A')"));
    const runsOfA = editor.spawnedCommands();
    expect(runsOfA.at(-1)).toContain("pnpm dev");

    await editor.loadRecording(lesson("lesson-b", "console.log('B')"));

    expect(editor.spawnedCommands()).toEqual([...runsOfA, runsOfA.at(-1)]);
  });

  // The live console shows whenever playback is not playing, so STOP and a seek
  // while stopped keep a finished script's output in step with the workspace.
  it("re-runs a finished runner on STOP and on a seek while stopped", async () => {
    const editor = renderEditor({ allowAmbientStart: true, pendingRecordingUrl: "/lesson.ne" });
    await editor.loadRecording(scrollingLesson("javascript-workspace"));
    act(() => editor.captured.actions?.play());
    await editor.send({ type: "TICK", currentTime: 150 });
    act(() => editor.captured.actions?.pause());
    await settle();

    const runsBeforeStop = editor.spawnedCommands().length;
    await editor.send({ type: "STOP" });
    const runsAfterStop = editor.spawnedCommands().length;
    expect(runsAfterStop).toBeGreaterThan(runsBeforeStop);

    await editor.send({ type: "SEEK", time: 250 });
    expect(editor.spawnedCommands().length).toBeGreaterThan(runsAfterStop);
  });
});
