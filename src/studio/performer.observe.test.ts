import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceProject } from "../core/src/workspace";
import { createRuntimePanelStore } from "../stores/runtimePanelStore";
import { createSlidesStore } from "../stores/slidesStore";
import { createWhiteboardStore } from "../stores/whiteboardStore";
import {
  createStudioDriver,
  type StudioActionEndReading,
  type StudioDriverDeps,
  type StudioPageReading,
} from "./driver";
import { performPlan } from "./performer";
import { parseStudioPlan } from "./plan";
import { createVirtualRenderClock } from "./renderClock";

vi.mock("../monaco", () => {
  class Range {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
    constructor(
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) {
      this.startLineNumber = startLineNumber;
      this.startColumn = startColumn;
      this.endLineNumber = endLineNumber;
      this.endColumn = endColumn;
    }
  }
  class Selection extends Range {
    readonly selectionStartLineNumber: number;
    readonly selectionStartColumn: number;
    readonly positionLineNumber: number;
    readonly positionColumn: number;
    constructor(
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) {
      super(startLineNumber, startColumn, endLineNumber, endColumn);
      this.selectionStartLineNumber = startLineNumber;
      this.selectionStartColumn = startColumn;
      this.positionLineNumber = endLineNumber;
      this.positionColumn = endColumn;
    }
  }
  return {
    monaco: { Range, Selection },
    workspacePathFromMonacoModelUri: () => "main.go",
  };
});

// The canvas the virtual clock's settle step would flush is not mounted here.
vi.mock("../hooks/useWhiteboardController", () => ({
  flushPendingWhiteboardChange: vi.fn<() => void>(),
}));

const plan = parseStudioPlan({
  schemaVersion: 1,
  lesson: { slug: "observe", title: "Observe", locale: "en-US" },
  seed: 3,
  workspace: {
    lessonType: "go",
    name: "T",
    entryFilePath: "main.go",
    files: { "main.go": "" },
  },
  narration: {
    audioPath: "/x.wav",
    mimeType: "audio/wav",
    expectedDurationMs: 5_000,
    captions: { id: "c", language: "en", cues: [{ start: 0, end: 1_000, text: "hi" }] },
  },
  runtime: {
    kind: "go-playground",
    defaultMode: "fixture",
    fixture: { latencyMs: 10, result: { status: "success", output: "ok\n", exitCode: 0 } },
  },
  slides: [{ id: "s1", contentType: "markdown", content: "# One" }],
  whiteboardAssets: [{ id: "box", kind: "rectangle", x: 10, y: 20, width: 100, height: 50 }],
  actions: [
    { id: "open", type: "workspace.openFile", at: 20, timeoutMs: 1_000, path: "main.go" },
    {
      id: "type",
      type: "editor.type",
      at: 60,
      timeoutMs: 1_000,
      path: "main.go",
      anchor: { after: "", occurrence: 1 },
      chunks: [
        { delayMs: 30, text: "package" },
        { delayMs: 45, text: " main" },
      ],
    },
    { id: "show", type: "slide.show", at: 300, timeoutMs: 1_000, slideId: "s1", maximized: true },
    {
      id: "draw",
      type: "whiteboard.apply",
      at: 400,
      timeoutMs: 1_000,
      open: true,
      upsertIds: ["box"],
      drawMs: 100,
    },
    { id: "close", type: "slide.close", at: 700, timeoutMs: 1_000 },
  ],
});

/**
 * A page for the driver: a one-line editor whose edits reach the workspace
 * store at once (as the editor bridge does), and the real panel stores. Every
 * edit, render and recorder send is logged with the render's time.
 */
function makePage() {
  const clock = createVirtualRenderClock();
  const started = clock.perfNow();
  const at = () => clock.perfNow() - started;
  const log: string[] = [];
  let text = "";
  let selection: unknown = null;
  let project: WorkspaceProject = {
    id: "studio-observe",
    name: "T",
    lessonType: "go",
    entryFilePath: "main.go",
    folders: [],
    files: { "main.go": { path: "main.go", name: "main.go", language: "go", content: "" } },
  };
  const model = {
    uri: {},
    getValue: () => text,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
  const editor = {
    getModel: () => model,
    getSelection: () => selection,
    focus: () => {},
    setSelection: (next: unknown) => {
      selection = next;
    },
    revealPositionInCenterIfOutsideViewport: () => {},
    executeEdits: (_source: string, edits: { range: { startColumn: number }; text: string }[]) => {
      for (const edit of edits) {
        const offset = edit.range.startColumn - 1;
        text = text.slice(0, offset) + edit.text + text.slice(offset);
        project = {
          ...project,
          files: { "main.go": { path: "main.go", name: "main.go", language: "go", content: text } },
        };
        log.push(`edit ${JSON.stringify(edit.text)}@${at()}`);
      }
      return true;
    },
    render: () => log.push(`render@${at()}`),
  };
  const slidesStore = createSlidesStore();
  slidesStore.trigger.setSlides({
    slides: [{ id: "s1", content: "# One", contentType: "markdown", name: "One", order: 0 }],
  });
  const deps = {
    getEditor: () => editor as unknown as ReturnType<StudioDriverDeps["getEditor"]>,
    workspace: {
      getFile: (path: string) => project.files[path] ?? null,
      getProject: () => project,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => log.push(`workspace@${at()}`),
    notifyRuntimeEvent: () => log.push(`runtime@${at()}`),
    runtimePanelStore: createRuntimePanelStore(),
    slidesStore,
    whiteboardStore: createWhiteboardStore(),
    notifySlideEvent: (event) => log.push(`slide ${event.type}@${at()}`),
    notifyWhiteboardEvent: (event) =>
      log.push(`board ${JSON.stringify(event.upserts?.map((element) => element.width))}@${at()}`),
    notifyPreviewEvent: () => log.push(`preview@${at()}`),
    runtimeMode: "fixture",
    runtime: plan.runtime,
    planSeed: plan.seed,
    whiteboardAssets: plan.whiteboardAssets,
    nodeRuntime: {} as StudioDriverDeps["nodeRuntime"],
    preview: {} as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
    clock,
  } satisfies StudioDriverDeps;
  return { driver: createStudioDriver(deps), clock, at, log };
}

async function perform({ observe }: { observe: boolean }) {
  const { driver, clock, at, log } = makePage();
  const controller = new AbortController();
  const actionEnds: StudioActionEndReading[] = [];
  const pages: StudioPageReading[] = [];
  const result = await performPlan({
    plan,
    driver,
    clock: { nowMs: at },
    renderClock: clock,
    signal: controller.signal,
    abort: () => controller.abort(),
    onActionEnd: observe
      ? () => {
          actionEnds.push(driver.readActionEnd());
          pages.push(driver.readPage());
        }
      : undefined,
  });
  return { result, log, actionEnds, pages, sends: driver.stageSends };
}

describe("reading the page at each action's end", () => {
  it("records the same events at the same times on the virtual clock, read or not", async () => {
    const plain = await perform({ observe: false });
    const observed = await perform({ observe: true });

    expect(plain.result.status).toBe("completed");
    expect(observed.result.status).toBe("completed");
    expect(observed.log).toEqual(plain.log);
    expect(observed.result.receipts).toEqual(plain.result.receipts);
    // Something was recorded, and the readings saw the page each action left.
    expect(plain.log).toContain('edit " main"@135');
    expect(plain.log).toContain("workspace@135");
    expect(observed.actionEnds).toHaveLength(plan.actions.length);
    expect(observed.actionEnds.map((reading) => reading.editor?.text)).toEqual([
      "",
      "package main",
      "package main",
      "package main",
      "package main",
    ]);
    expect(observed.actionEnds[1].workspaceFiles["main.go"].content).toBe("package main");
    expect(observed.actionEnds[1].editor?.selection).toEqual({
      selectionStartLineNumber: 1,
      selectionStartColumn: 13,
      positionLineNumber: 1,
      positionColumn: 13,
    });
    const last = observed.pages.at(-1)!;
    expect(last.slidePanel.isOpen).toBe(false);
    expect(last.whiteboard.isOpen).toBe(true);
    expect(last.whiteboard.elements.map((element) => element.id)).toEqual(["box"]);
    expect(last.consoleLines).toEqual([]);
    // What the driver sent is what it logs, in order.
    expect(observed.sends.slideEvents.map((event) => event.type)).toEqual([
      "slide_open",
      "slide_close",
    ]);
    expect(observed.sends.whiteboardEvents).toHaveLength(
      plain.log.filter((entry) => entry.startsWith("board")).length,
    );
  });
});
