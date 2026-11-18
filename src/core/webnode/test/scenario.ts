// What a scenario script (`bun scripts/webnode-harness.ts script <file>`) checks
// the runtime with: steps that fail the run when they do not hold, a terminal
// it types into, and the preview of a server a process started. It runs in
// the harness, not in the page: it reaches the page (test/harnessPage.ts)
// through `PageCall`, and the page's preview frame through `PreviewFrame`.
//
// A scenario passes by returning. Every step here throws a `ScenarioFailure`
// when it does not hold, and the harness then exits 1. Nothing here answers
// false for the scenario to print.
import type { OutputMatch } from "./outputMatch";

/** What a step throws when it does not hold. */
export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

/** Calls a method of the harness page (`window.webnodeHarness`). */
export type PageCall = <T>(method: string, ...args: unknown[]) => Promise<T>;

/** A server a process listens on, as the runtime announced it. */
export interface AnnouncedServer {
  port: number;
  url: string;
}

/** What a preview shows. */
export interface PreviewView {
  title: string;
  /** The body's visible text, runs of white space made one space. */
  text: string;
  /** The text of Vite's error overlay, when it shows one. */
  overlay: string | null;
}

/** The harness page's preview frame, as the harness reaches it. */
export interface PreviewFrame {
  /** Points the frame at `url`. */
  show(url: string): Promise<void>;
  /**
   * What the frame shows; null while it has no document the server at `url`
   * sent: it is loading, or shows the preview origin's own connecting page.
   */
  read(url: string): Promise<PreviewView | null>;
  /** Clicks the element `selector` names in the document from `url`. */
  click(url: string, selector: string): Promise<void>;
}

/** The preview of one server. */
export interface Preview {
  /** What it shows now; null while the frame has no document of the server's. */
  read(): Promise<PreviewView | null>;
  /** Waits until it shows what `holds` accepts. */
  expect(
    label: string,
    holds: (view: PreviewView) => boolean,
    timeoutMs?: number,
  ): Promise<PreviewView>;
  click(selector: string): Promise<void>;
}

/** What `expect` found. */
export interface TerminalMatch {
  text: string;
  /** The pattern's capture groups, null for one that took no part. */
  groups: (string | null)[];
}

/**
 * A command running on a terminal. `expect` reads what the terminal printed
 * after the last thing it matched, so a step is never satisfied by output an
 * earlier step already accounted for; `enter` moves that point past the echo
 * of the line it types, so a step is never satisfied by its own command.
 */
export interface TerminalSession {
  /** The handle the harness page knows the process by. */
  readonly id: number;
  /**
   * Types `text` as it is: nothing is added and no echo is waited for. What
   * the terminal echoes of it is part of what `expect` reads next. For control
   * keys, and for input to a program that does not echo.
   */
  keys(text: string): Promise<void>;
  /**
   * Types one line and Enter at a shell prompt, or to a program that reads
   * the terminal a line at a time, and waits for the terminal to have echoed
   * both. `expect` then reads only what follows the Enter.
   */
  enter(line: string, timeoutMs?: number): Promise<void>;
  /**
   * Waits for `pattern` in what the terminal printed since the last match.
   * `^` in it is where that match ended.
   */
  expect(label: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalMatch>;
  /** `enter(line)`, then `expect(label, pattern)`. */
  run(label: string, line: string, pattern: RegExp, timeoutMs?: number): Promise<TerminalMatch>;
  /** Gives the terminal a new size, as a resized window does. */
  resize(cols: number, rows: number): Promise<void>;
  /** Waits for the process to exit with `code`. */
  expectExit(label: string, code: number, timeoutMs?: number): Promise<void>;
  /** Everything the terminal printed so far, as it printed it. */
  output(): Promise<string>;
  kill(): Promise<void>;
}

/** The steps a scenario is given. */
export interface ScenarioTools {
  /** Prints `ok` for a step that holds; throws for one that does not. */
  check(label: string, holds: boolean, detail?: string): void;
  /**
   * Runs one part of a scenario that has several independent ones (a starter,
   * a lesson). A part that throws is reported and counted, the scenario goes
   * on to the next, and the run fails at its end.
   */
  section(label: string, run: () => Promise<void>): Promise<boolean>;
  /** Starts `command` on a terminal, of 100 by 30 unless `size` says otherwise. */
  terminal(
    command: string,
    args?: string[],
    options?: { env?: Record<string, string>; size?: { cols: number; rows: number } },
  ): Promise<TerminalSession>;
  /**
   * Waits for a server: on `port`, or the first one announced. Fails at once
   * when `runner` (the session that should start it) has exited instead.
   */
  server(options?: {
    port?: number;
    runner?: TerminalSession;
    timeoutMs?: number;
  }): Promise<AnnouncedServer>;
  /** Shows `url` in the harness page's preview frame. */
  preview(url: string): Promise<Preview>;
  /** Empties the preview frame. */
  closePreview(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `text` as a pattern that matches exactly it. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * How the shell's line editor ends a redraw of a line with the cursor at its
 * end: erase to the end of the screen, a new row when the line fills its last
 * one, then the cursor back to its column (lineEditor.ts, `refresh`). A line
 * typed to a program in cooked mode is echoed bare.
 */
const REDRAW_END = String.raw`\x1b\[J(?:\r\n)?\r(?:\x1b\[\d+C)?`;

/** The last `length` characters of `text`, escapes spelled out. */
function rawTail(text: string, length = 600): string {
  return JSON.stringify(text.slice(-length));
}

function terminalSession(call: PageCall, id: number): TerminalSession {
  /** Where the next `expect` starts reading: an offset into all the terminal printed. */
  let cursor = 0;
  const read = () => call<{ output: string; exited: number | null }>("read", id);
  const find = (pattern: string, from: number, timeoutMs: number) =>
    call<OutputMatch | null>("match", id, pattern, from, timeoutMs);
  const failure = async (what: string): Promise<ScenarioFailure> => {
    const state = await read();
    return new ScenarioFailure(
      `${what}${state.exited === null ? "" : ` (the process exited ${state.exited})`}\n` +
        `   printed since the last match: ${rawTail(state.output.slice(cursor))}\n` +
        `   before that: ${rawTail(state.output.slice(0, cursor), 200)}`,
    );
  };

  const session: TerminalSession = {
    id,
    async keys(text) {
      await call("write", id, text);
    },
    async enter(line, timeoutMs = 5000) {
      if (/[\r\n]/.test(line)) {
        throw new Error("enter() types one line: no line break inside it");
      }
      const typedAt = Math.max(cursor, await call<number>("write", id, line));
      const echoed = await find(`${literal(line)}(${REDRAW_END})?`, typedAt, timeoutMs);
      if (!echoed) {
        throw await failure(`the terminal did not echo ${JSON.stringify(line)}`);
      }
      const byEditor = echoed.groups[0] !== null;
      await call("write", id, "\r");
      // The editor redraws its line once more, then moves to a new line; the
      // terminal's own echo of Enter is the new line alone.
      const entered = await find(
        byEditor ? String.raw`${literal(line)}${REDRAW_END}\r?\n` : String.raw`\r\n`,
        echoed.end,
        timeoutMs,
      );
      if (!entered) {
        throw await failure(`Enter after ${JSON.stringify(line)} was not echoed`);
      }
      cursor = entered.end;
    },
    async expect(label, pattern, timeoutMs = 5000) {
      if (pattern.flags !== "") {
        throw new Error(`expect(${JSON.stringify(label)}): a pattern without flags`);
      }
      const found = await find(pattern.source, cursor, timeoutMs);
      if (!found) {
        throw await failure(`${label}: ${pattern} did not show within ${timeoutMs} ms`);
      }
      const text = (await read()).output.slice(found.start, found.end);
      cursor = found.end;
      console.log(`ok   ${label}`);
      return { text, groups: found.groups };
    },
    async run(label, line, pattern, timeoutMs) {
      await session.enter(line);
      return session.expect(label, pattern, timeoutMs);
    },
    async resize(cols, rows) {
      await call("resize", id, cols, rows);
    },
    async expectExit(label, code, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let state = await read();
      while (state.exited === null && Date.now() < deadline) {
        await sleep(25);
        state = await read();
      }
      if (state.exited !== code) {
        const found =
          state.exited === null ? `still running after ${timeoutMs} ms` : `got ${state.exited}`;
        throw await failure(`${label}: expected exit ${code}, ${found}`);
      }
      console.log(`ok   ${label}`);
    },
    async output() {
      return (await read()).output;
    },
    async kill() {
      await call("kill", id);
    },
  };
  return session;
}

function previewOf(frame: PreviewFrame, url: string): Preview {
  return {
    read: () => frame.read(url),
    async expect(label, holds, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      let view = await frame.read(url);
      while (!(view && holds(view)) && Date.now() < deadline) {
        await sleep(250);
        view = await frame.read(url);
      }
      if (!(view && holds(view))) {
        const shown = view
          ? JSON.stringify({ ...view, text: view.text.slice(0, 400) })
          : "no document";
        throw new ScenarioFailure(
          `${label}: the preview of ${url} did not show it within ${timeoutMs} ms\n` +
            `   it shows: ${shown}`,
        );
      }
      console.log(`ok   ${label}`);
      return view;
    },
    click: (selector) => frame.click(url, selector),
  };
}

/** The message of whatever a step threw. */
export function failureMessage(error: unknown): string {
  if (error instanceof ScenarioFailure) {
    return error.message;
  }
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * The steps for one scenario run. `failures` collects what its sections
 * reported, for the harness to fail the run with.
 */
export function scenarioTools(
  call: PageCall,
  frame: PreviewFrame,
): { tools: ScenarioTools; failures: string[] } {
  const failures: string[] = [];
  const tools: ScenarioTools = {
    check(label, holds, detail) {
      if (!holds) {
        throw new ScenarioFailure(detail === undefined ? label : `${label}\n   ${detail}`);
      }
      console.log(`ok   ${label}`);
    },
    async section(label, run) {
      console.log(`\n===== ${label}`);
      try {
        await run();
        return true;
      } catch (error) {
        const message = `${label}: ${failureMessage(error)}`;
        failures.push(message);
        console.log(`FAIL ${message}`);
        return false;
      }
    },
    async terminal(command, args = [], options = {}) {
      const id = await call<number>("start", command, args, options.env, options.size);
      return terminalSession(call, id);
    },
    async server({ port, runner, timeoutMs = 90000 } = {}) {
      const wanted = port === undefined ? "a server" : `a server on port ${port}`;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const servers = await call<AnnouncedServer[]>("servers");
        const server = port === undefined ? servers[0] : servers.find((one) => one.port === port);
        if (server) {
          return server;
        }
        const state = runner
          ? await call<{ output: string; exited: number | null }>("read", runner.id)
          : null;
        const exited = state?.exited ?? null;
        if (exited !== null || Date.now() >= deadline) {
          const why =
            exited !== null ? `its runner exited ${exited}` : `none after ${timeoutMs} ms`;
          const announced = servers.map((one) => one.port).join(", ") || "none";
          throw new ScenarioFailure(
            `${wanted} was not announced: ${why} (announced: ${announced})` +
              (state ? `\n   the runner printed: ${rawTail(state.output, 1500)}` : ""),
          );
        }
        // Often: a scenario may open the preview the moment the port is announced.
        await sleep(25);
      }
    },
    async preview(url) {
      await frame.show(url);
      return previewOf(frame, url);
    },
    closePreview: () => frame.show("about:blank"),
  };
  return { tools, failures };
}
