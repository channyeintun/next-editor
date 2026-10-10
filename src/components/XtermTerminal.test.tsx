import { render, screen, within } from "@testing-library/react";
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
    /** xterm's helper textarea, which it names "Terminal input". */
    textarea = Object.assign(document.createElement("textarea"), { tabIndex: 0 });
    /** Sees every key before xterm does; false hands the key to the browser. */
    keyHandler?: (event: KeyboardEvent) => boolean;
    dataListener?: (input: string) => void;
    scrollListener?: (line: number) => void;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      this.textarea.setAttribute("aria-label", "Terminal input");
      FakeTerminal.instances.push(this);
    }

    loadAddon() {}
    open(parent: HTMLElement) {
      parent.append(this.textarea);
    }
    focus() {}
    scrollToLine() {}
    dispose() {}
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onData(listener: (input: string) => void) {
      this.dataListener = listener;
      return { dispose() {} };
    }
    onScroll(listener: (line: number) => void) {
      this.scrollListener = listener;
      return { dispose() {} };
    }
    onWriteParsed() {
      return { dispose() {} };
    }
    onResize() {
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
      label="Runner output"
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
          label="Runner output"
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

  it("exposes a passive output to screen readers as a named region", () => {
    const { terminal } = renderTerminal("Compiled successfully\n", true);

    expect(terminal.options.screenReaderMode).toBe(true);
    const region = screen.getByRole("region", { name: "Runner output" });
    // The output takes no input, so its focus target does not claim to.
    expect(within(region).getByRole("textbox", { name: "Runner output" })).toBe(terminal.textarea);
  });

  it("keeps xterm's input name on the interactive shell", () => {
    render(<XtermTerminal sessionId="shell-1" output="" interactive label="Terminal" />);

    expect(xterm.FakeTerminal.instances.at(-1)?.options.screenReaderMode).toBe(true);
    const region = screen.getByRole("region", { name: "Terminal" });
    expect(within(region).getByRole("textbox", { name: "Terminal input" })).toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps text at 7:1 or better, the dimmed console text included (interactive: %s)",
    (interactive) => {
      render(
        <XtermTerminal sessionId="shell-1" output="" interactive={interactive} label="Console" />,
      );
      const { options } = xterm.FakeTerminal.instances.at(-1)!;

      expect(options.minimumContrastRatio).toBe(7);
      // ANSI 90, which dims the text after every console [tag]: slate-400.
      expect(options.theme).toMatchObject({ background: "#15191f", brightBlack: "#90a1b9" });
    },
  );

  it("reports a scroll to the onScroll passed after the terminal was built", () => {
    const firstOnScroll = vi.fn<(line: number) => void>();
    const latestOnScroll = vi.fn<(line: number) => void>();
    const props = { sessionId: "runner", output: "", interactive: false, label: "Runner output" };
    const view = render(<XtermTerminal {...props} onScroll={firstOnScroll} />);
    view.rerender(<XtermTerminal {...props} onScroll={latestOnScroll} />);

    expect(xterm.FakeTerminal.instances).toHaveLength(1);
    xterm.FakeTerminal.instances[0].scrollListener?.(12);

    expect(latestOnScroll).toHaveBeenCalledWith(12);
    expect(firstOnScroll).not.toHaveBeenCalled();
  });

  it("drops the slid-off scrollback once scroll lines are recorded again", () => {
    const { update } = renderTerminal(windowAt(7000), true);
    update(windowAt(7300));

    expect(update(windowAt(7300), false)).toEqual(["reset", windowAt(7300)]);
    expect(update(windowAt(7300), false)).toEqual([]);
  });

  describe("keyboard", () => {
    /** Whether xterm keeps the key (true) or the browser gets it (false). */
    function keyHandlerOf(terminal: InstanceType<typeof xterm.FakeTerminal>) {
      const handler = terminal.keyHandler;

      if (!handler) {
        throw new Error("Expected the component to attach a key handler");
      }

      return (key: string, init: KeyboardEventInit = {}, type = "keydown") =>
        handler(new KeyboardEvent(type, { key, ...init }));
    }

    function renderShell(onData?: (input: string) => void) {
      render(
        <>
          <XtermTerminal
            sessionId="shell-1"
            output=""
            interactive
            label="Terminal"
            describedBy="terminal-exit-hint"
            onData={onData}
          />
          <p id="terminal-exit-hint">Press Esc, then Tab, to leave the terminal</p>
        </>,
      );
      const terminal = xterm.FakeTerminal.instances.at(-1);

      if (!terminal) {
        throw new Error("Expected the component to create a terminal");
      }

      return { terminal, press: keyHandlerOf(terminal) };
    }

    it("lets Tab and Shift+Tab leave a passive output and keeps Shift+PageUp scrolling it", () => {
      const press = keyHandlerOf(renderTerminal("Compiled successfully\n", true).terminal);

      expect(press("Tab")).toBe(false);
      expect(press("Tab", { shiftKey: true })).toBe(false);
      expect(press("Tab", {}, "keyup")).toBe(false);
      expect(press("PageUp", { shiftKey: true })).toBe(true);
      expect(press("PageDown", { shiftKey: true })).toBe(true);
      expect(press("Tab", { ctrlKey: true })).toBe(true);
    });

    it("keeps Tab in the shell for completion", () => {
      const { press } = renderShell();

      expect(press("Tab")).toBe(true);
      expect(press("Tab", { shiftKey: true })).toBe(true);
    });

    it("lets Tab or Shift+Tab leave the shell once, right after Escape", () => {
      const { press } = renderShell();

      expect(press("Escape")).toBe(true);
      expect(press("Escape", {}, "keyup")).toBe(true);
      expect(press("Tab")).toBe(false);
      expect(press("Tab")).toBe(true);

      expect(press("Escape")).toBe(true);
      expect(press("Shift", { shiftKey: true })).toBe(true);
      expect(press("Tab", { shiftKey: true })).toBe(false);
    });

    it("forgets a pending Escape after any other key", () => {
      const { press } = renderShell();

      expect(press("Escape")).toBe(true);
      expect(press("a")).toBe(true);
      expect(press("Tab")).toBe(true);
    });

    it("still sends typed text to the shell", () => {
      const onData = vi.fn<(input: string) => void>();
      const { terminal, press } = renderShell(onData);

      for (const key of ["l", "s", "Enter"]) {
        expect(press(key)).toBe(true);
      }
      terminal.dataListener?.("ls\r");

      expect(onData).toHaveBeenCalledWith("ls\r");
    });

    it("describes how to leave the shell", () => {
      renderShell();

      expect(
        screen.getByRole("textbox", {
          name: "Terminal input",
          description: "Press Esc, then Tab, to leave the terminal",
        }),
      ).toBeInTheDocument();
    });
  });
});
