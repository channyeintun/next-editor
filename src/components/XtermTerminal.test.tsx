import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import XtermTerminal from "./XtermTerminal";

const xterm = vi.hoisted(() => {
  /** Records what the component asks the terminal to draw. */
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 96;
    rows = 18;
    options: Record<string, unknown>;
    calls: Array<"reset" | string> = [];

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      FakeTerminal.instances.push(this);
    }

    loadAddon() {}
    open() {}
    focus() {}
    scrollToLine() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onScroll() {
      return { dispose() {} };
    }
    reset() {
      this.calls.push("reset");
    }
    write(data: string, callback?: () => void) {
      this.calls.push(data);
      callback?.();
    }
  }

  class FakeFitAddon {
    fit() {}
    dispose() {}
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));

const WINDOW = 6000;
const log = Array.from({ length: 400 }, (_, index) => `line ${index} of the dev server log\n`).join(
  "",
);
/** The capped runner output after `length` characters of the log. */
const windowAt = (length: number) => log.slice(0, length).slice(-WINDOW);

function renderTerminal(output: string, keepScrolledOffOutput: boolean) {
  const view = render(
    <XtermTerminal
      sessionId="runner"
      output={output}
      interactive={false}
      keepScrolledOffOutput={keepScrolledOffOutput}
    />,
  );
  const terminal = xterm.FakeTerminal.instances.at(-1);

  if (!terminal) {
    throw new Error("Expected the component to create a terminal");
  }

  return {
    terminal,
    update: (nextOutput: string, nextKeepScrolledOffOutput = keepScrolledOffOutput) => {
      terminal.calls = [];
      view.rerender(
        <XtermTerminal
          sessionId="runner"
          output={nextOutput}
          interactive={false}
          keepScrolledOffOutput={nextKeepScrolledOffOutput}
        />,
      );
      return terminal.calls;
    },
  };
}

describe("XtermTerminal", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    xterm.FakeTerminal.instances = [];
  });

  it("writes only the new text once a capped log starts dropping its oldest text", () => {
    const { update } = renderTerminal(windowAt(7000), true);

    expect(update(windowAt(7300))).toEqual([log.slice(7000, 7300)]);
    expect(update(windowAt(7310))).toEqual([log.slice(7300, 7310)]);
  });

  it("re-renders exactly the window while scroll lines are recorded or replayed", () => {
    const { update } = renderTerminal(windowAt(7000), false);

    expect(update(windowAt(7300))).toEqual(["reset", windowAt(7300)]);
  });

  it("rewrites unrelated output whole", () => {
    const { update } = renderTerminal(windowAt(7000), true);

    expect(update("Waiting for runner output...")).toEqual([
      "reset",
      "Waiting for runner output...",
    ]);
  });

  it("drops the slid-off scrollback once scroll lines are recorded again", () => {
    const { update } = renderTerminal(windowAt(7000), true);
    update(windowAt(7300));

    expect(update(windowAt(7300), false)).toEqual(["reset", windowAt(7300)]);
    expect(update(windowAt(7300), false)).toEqual([]);
  });
});
