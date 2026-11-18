// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../kernel/streams";
import { LineEditor } from "../process/programs/shell/lineEditor";
import { findInOutput } from "./outputMatch";
import { ScenarioFailure, scenarioTools } from "./scenario";
import type { AnnouncedServer, PageCall, PreviewFrame, PreviewView } from "./scenario";

const PROMPT = "\x1b[1;34m~/app\x1b[0m \x1b[32m❯\x1b[0m ";
/** The columns `PROMPT` takes. */
const PROMPT_WIDTH = "~/app ❯ ".length;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A small shell behind the harness page's calls, made of the kernel's
 * terminal and the shell's own line editor, so that what a scenario's
 * terminal reads is what those two really print. Its commands:
 * `echo <text>`, `true` (prints nothing), `count` (prints how often it has
 * run), `cat` (a program that reads lines in cooked mode and prints each,
 * until Ctrl+D), `hang` (never comes back to the prompt) and `exit`.
 */
function shellPage(cols = 100) {
  let output = "";
  let exited: number | null = null;
  let counted = 0;
  const servers: AnnouncedServer[] = [];
  const shellPid = 1;
  const terminal = new Terminal(
    { cols, rows: 30 },
    (text) => {
      output += text;
    },
    () => {},
  );
  terminal.attach(shellPid);
  const print = (text: string) => terminal.write(encoder.encode(text));
  const editor = new LineEditor({
    write: print,
    columns: () => terminal.cols,
    complete: () => ({ start: 0, candidates: [] }),
  });
  /** The program reading lines, while one runs: called with a line, or null at the end of input. */
  let program: ((line: string | null) => void) | null = null;

  const prompt = () => {
    terminal.setRaw(true, shellPid);
    void editor.readLine(PROMPT).then((result) => {
      terminal.setRaw(false, shellPid);
      if (result.type === "line") {
        runCommand(result.text);
      }
    });
  };
  const runCommand = (line: string) => {
    const [name, ...words] = line.split(" ");
    if (name === "echo") {
      print(`${words.join(" ")}\n`);
    } else if (name === "count") {
      counted += 1;
      print(`${counted}\n`);
    } else if (name === "cat") {
      program = (typed) => {
        if (typed === null) {
          program = null;
          prompt();
        } else {
          print(typed);
        }
      };
      return;
    } else if (name === "hang") {
      return;
    } else if (name === "exit") {
      exited = Number(words[0] ?? 0);
      return;
    }
    prompt();
  };
  /** Hands what was typed to whoever reads the terminal now. */
  const deliver = () => {
    for (;;) {
      const chunk = terminal.take(65536, shellPid);
      if (chunk === undefined) {
        return;
      }
      if (terminal.raw) {
        if (chunk !== null) {
          editor.feed(chunk);
        }
      } else {
        program?.(chunk === null ? null : decoder.decode(chunk));
      }
    }
  };
  prompt();

  const methods: Record<string, (...args: never[]) => unknown> = {
    start: () => shellPid,
    read: () => ({ output, exited }),
    write: (_id: number, text: string) => {
      const printed = output.length;
      terminal.input(text);
      deliver();
      return printed;
    },
    match: async (_id: number, pattern: string, from: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = findInOutput(output, pattern, from);
        if (found || Date.now() >= deadline) {
          return found;
        }
        await sleep(1);
      }
    },
    resize: (_id: number, columns: number, rows: number) => {
      terminal.cols = columns;
      terminal.rows = rows;
      editor.resize();
    },
    kill: () => {
      exited = 137;
    },
    servers: () => servers,
  };
  const call: PageCall = async <T>(method: string, ...args: unknown[]) =>
    (await methods[method](...(args as never[]))) as T;
  return {
    call,
    print,
    servers,
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    exit: (code: number) => {
      exited = code;
    },
  };
}

/** A preview frame that shows whatever `views` holds for a url. */
function fakeFrame(views: Map<string, PreviewView>): PreviewFrame & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    show: async (url) => {
      shown.push(url);
    },
    read: async (url) => views.get(url) ?? null,
    click: async () => {},
  };
}

const noFrame = () => fakeFrame(new Map());

describe("a scenario's terminal", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a command's output after the echo of the command", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    const found = await term.run("echo prints", "echo hi there", /^hi there\r\n/, 200);
    expect(found.text).toBe("hi there\r\n");
  });

  it("is not satisfied by the echo of the command it typed", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    // `true` prints nothing: the only place MARKER5 shows is the typed line.
    await expect(term.run("marker", "true MARKER5", /MARKER5/, 60)).rejects.toThrow(
      ScenarioFailure,
    );
    // The same marker, printed by the command.
    await term.expect("prompt again", /❯/);
    await term.run("marker", "echo MARKER5", /^MARKER5\r\n/, 200);
  });

  it("is not satisfied by a prompt that was there before the command", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    await term.run("a command that returns", "true", /^[^\r\n]*❯/, 200);
    await expect(term.run("one that does not", "hang", /❯/, 60)).rejects.toThrow(
      /did not show within 60 ms/,
    );
  });

  it("does not read again what an earlier step matched", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.run("first", "echo once", /once\r\n/, 200);
    await expect(term.expect("second", /once/, 60)).rejects.toThrow(ScenarioFailure);
  });

  it("reads the output of the second of two commands typed alike", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    expect((await term.run("first", "count", /^1\r\n/, 200)).text).toBe("1\r\n");
    expect((await term.run("second", "count", /^2\r\n/, 200)).text).toBe("2\r\n");
  });

  it("finds the end of the echo when the line ends in the terminal's last column", async () => {
    const line = "echo wrapped";
    const page = shellPage(PROMPT_WIDTH + line.length);
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    const found = await term.run("output right after the Enter", line, /^wrapped\r\n/, 200);
    expect(found.text).toBe("wrapped\r\n");
  });

  it("finds the end of the echo of a line wider than the terminal", async () => {
    const line = "echo a line that takes more than one row of this terminal";
    const page = shellPage(24);
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    const found = await term.run("output right after the Enter", line, /^a line that takes/, 200);
    expect(found.text).toBe("a line that takes");
  });

  it("reads what a program prints after the terminal's own echo of a typed line", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.expect("prompt", /❯/);
    await term.enter("cat");
    await term.enter("line one");
    // The echo is behind the cursor: this is the copy cat printed.
    const printed = await term.expect("cat prints it", /^line one\r\n/, 200);
    expect(printed.text).toBe("line one\r\n");
    await expect(term.expect("only once", /line one/, 60)).rejects.toThrow(ScenarioFailure);
    await term.keys("\x04");
    await term.expect("the prompt is back", /^[^\r\n]*❯/, 200);
  });

  it("fails a step with what the terminal printed, escapes spelled out", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.run("first", "echo before", /^before\r\n/, 200);
    const failed = term.run("the step", "echo actual", /^expected\r\n/, 60);
    await expect(failed).rejects.toThrow(
      /^the step: \/\^expected\\r\\n\/ did not show within 60 ms\n {3}printed since the last match: "actual\\r\\n\\u001b\[1;34m~\/app/,
    );
    await expect(failed).rejects.toThrow(/before that: ".*echo actual\\u001b\[J/);
  });

  it("says that the process exited when a step fails after it did", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.enter("exit 3");
    await expect(term.expect("more output", /never/, 60)).rejects.toThrow(
      /\(the process exited 3\)/,
    );
  });

  it("checks the exit code", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await expect(term.expectExit("still running", 0, 60)).rejects.toThrow(
      /expected exit 0, still running after 60 ms/,
    );
    await term.enter("exit 3");
    await expect(term.expectExit("wrong code", 0, 60)).rejects.toThrow(/expected exit 0, got 3/);
    await term.expectExit("right code", 3, 60);
  });

  it("resizes the terminal", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await term.resize(120, 40);
    expect(page.size()).toEqual({ cols: 120, rows: 40 });
  });

  it("refuses a line with a line break and a pattern with flags", async () => {
    const page = shellPage();
    const term = await scenarioTools(page.call, noFrame()).tools.terminal("jsh");
    await expect(term.enter("one\rtwo")).rejects.toThrow(/one line/);
    await expect(term.expect("flags", /x/i, 60)).rejects.toThrow(/without flags/);
  });
});

describe("a scenario's steps", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws for a check that does not hold, with its detail", () => {
    const { tools } = scenarioTools(shellPage().call, noFrame());
    expect(() => tools.check("holds", true)).not.toThrow();
    expect(() => tools.check("install exits 0", false, "exit 1")).toThrow(
      new ScenarioFailure("install exits 0\n   exit 1"),
    );
  });

  it("goes on after a section that failed, and keeps what failed", async () => {
    const { tools, failures } = scenarioTools(shellPage().call, noFrame());
    const ran: string[] = [];
    const first = await tools.section("vue", async () => {
      ran.push("vue");
      tools.check("the preview shows the title", false, "it shows an error overlay");
    });
    const second = await tools.section("solid", async () => {
      ran.push("solid");
    });
    expect([first, second]).toEqual([false, true]);
    expect(ran).toEqual(["vue", "solid"]);
    expect(failures).toEqual(["vue: the preview shows the title\n   it shows an error overlay"]);
  });

  it("waits for the server on the port asked for", async () => {
    const page = shellPage();
    const { tools } = scenarioTools(page.call, noFrame());
    page.servers.push({ port: 3000, url: "http://a-3000.localhost/" });
    setTimeout(() => page.servers.push({ port: 4173, url: "http://a-4173.localhost/" }), 20);
    expect(await tools.server({ port: 4173, timeoutMs: 2000 })).toEqual({
      port: 4173,
      url: "http://a-4173.localhost/",
    });
    expect((await tools.server()).port).toBe(3000);
  });

  it("fails when no server is announced, and at once when the runner has exited", async () => {
    const page = shellPage();
    const { tools } = scenarioTools(page.call, noFrame());
    await expect(tools.server({ port: 5173, timeoutMs: 60 })).rejects.toThrow(
      /a server on port 5173 was not announced: none after 60 ms \(announced: none\)/,
    );
    const runner = await tools.terminal("sh", ["-lc", "pnpm dev"]);
    page.print("ELIFECYCLE Command failed.\n");
    page.exit(1);
    const started = Date.now();
    await expect(tools.server({ runner, timeoutMs: 5000 })).rejects.toThrow(
      /a server was not announced: its runner exited 1 \(announced: none\)\n {3}the runner printed: ".*ELIFECYCLE Command failed\.\\r\\n"/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("waits for the preview to show what a step accepts, and fails with what it shows", async () => {
    const url = "http://a-4173.localhost/";
    const views = new Map<string, PreviewView>();
    const frame = fakeFrame(views);
    const { tools } = scenarioTools(shellPage().call, frame);
    const preview = await tools.preview(url);
    expect(frame.shown).toEqual([url]);
    expect(await preview.read()).toBeNull();
    setTimeout(() => views.set(url, { title: "Vue Lesson", text: "Hello Vue", overlay: null }), 20);
    const view = await preview.expect("the page", (shown) => shown.text.includes("Hello"), 2000);
    expect(view.title).toBe("Vue Lesson");
    views.set(url, { title: "", text: "", overlay: "Failed to resolve import" });
    await expect(
      preview.expect("no overlay", (shown) => shown.overlay === null, 60),
    ).rejects.toThrow(/did not show it within 60 ms\n {3}it shows: \{.*Failed to resolve import/);
    await tools.closePreview();
    expect(frame.shown).toEqual([url, "about:blank"]);
  });
});

describe("findInOutput", () => {
  it("answers offsets into the whole output and the capture groups", () => {
    expect(findInOutput("one two two", "t(w)o(x)?", 5)).toEqual({
      start: 8,
      end: 11,
      groups: ["w", null],
    });
    expect(findInOutput("one two", "one", 1)).toBeNull();
  });

  it("anchors ^ at the offset", () => {
    expect(findInOutput("ab", "^b", 1)).toEqual({ start: 1, end: 2, groups: [] });
    expect(findInOutput("ab", "^b", 0)).toBeNull();
  });
});
