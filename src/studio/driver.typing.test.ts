import { describe, expect, it, vi } from "vite-plus/test";
import { createStudioDriver, type StudioDriverDeps } from "./driver";
import { REAL_RENDER_CLOCK, createVirtualRenderClock, type RenderClock } from "./renderClock";

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
  class Selection extends Range {}
  return {
    monaco: { Range, Selection },
    workspacePathFromMonacoModelUri: () => "main.go",
  };
});

/** A one-line editor: enough of Monaco for typing, with every edit and render logged. */
function makeDriver(clock: RenderClock) {
  let text = "";
  const log: string[] = [];
  const started = clock.perfNow();
  const at = () => clock.perfNow() - started;
  const model = {
    uri: {},
    getValue: () => text,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
  const editor = {
    getModel: () => model,
    focus: () => {},
    setSelection: () => {},
    revealPositionInCenterIfOutsideViewport: () => {},
    executeEdits: (_source: string, edits: { range: { startColumn: number }; text: string }[]) => {
      for (const edit of edits) {
        const offset = edit.range.startColumn - 1;
        text = text.slice(0, offset) + edit.text + text.slice(offset);
        log.push(`edit ${JSON.stringify(edit.text)}@${at()}`);
      }
      return true;
    },
    render: () => log.push(`render@${at()}`),
  };
  const deps = {
    getEditor: () => editor as unknown as ReturnType<StudioDriverDeps["getEditor"]>,
    workspace: {
      getFile: () => ({ path: "main.go", content: text }) as never,
      getProject: () => ({ lessonType: "go" }) as never,
      setActiveFilePath: () => {},
    },
    notifyWorkspaceEvent: () => {},
    notifyRuntimeEvent: () => {},
    runtimePanelStore: {} as StudioDriverDeps["runtimePanelStore"],
    slidesStore: {} as StudioDriverDeps["slidesStore"],
    whiteboardStore: {} as StudioDriverDeps["whiteboardStore"],
    notifySlideEvent: () => {},
    notifyWhiteboardEvent: () => {},
    notifyPreviewEvent: () => {},
    runtimeMode: "fixture",
    runtime: { kind: "go-playground" } as StudioDriverDeps["runtime"],
    planSeed: 1,
    whiteboardAssets: [],
    nodeRuntime: {} as StudioDriverDeps["nodeRuntime"],
    preview: {} as StudioDriverDeps["preview"],
    signal: new AbortController().signal,
    clock,
  } satisfies StudioDriverDeps;
  return { driver: createStudioDriver(deps), log, at, getText: () => text };
}

const CHUNKS = [
  { delayMs: 40, text: "fmt" },
  { delayMs: 70, text: "." },
  { delayMs: 25, text: "Println" },
];

describe("StudioDriver typing on the render's clock", () => {
  it("lands each chunk exactly its delay after the last on a virtual clock, rendered at once", async () => {
    const { driver, log, at, getText } = makeDriver(createVirtualRenderClock());

    await driver.typeText({
      path: "main.go",
      anchor: { after: "", occurrence: 1 },
      chunks: CHUNKS,
    });

    expect(getText()).toBe("fmt.Println");
    // Monaco applies a horizontal reveal only when it renders, so each chunk
    // is rendered right after it lands, at the chunk's own time.
    expect(log).toEqual([
      'edit "fmt"@40',
      "render@40",
      'edit "."@110',
      "render@110",
      'edit "Println"@135',
      "render@135",
    ]);
    expect(at()).toBe(135);
  });

  it("leaves rendering to Monaco on the real clock", async () => {
    const { driver, log, getText } = makeDriver(REAL_RENDER_CLOCK);

    await driver.typeText({
      path: "main.go",
      anchor: { after: "", occurrence: 1 },
      chunks: CHUNKS.map((chunk) => ({ ...chunk, delayMs: 1 })),
    });

    expect(getText()).toBe("fmt.Println");
    expect(log.filter((entry) => entry.startsWith("render"))).toEqual([]);
  });
});
