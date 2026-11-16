// @vitest-environment node
// tty: isatty, ReadStream raw mode, WriteStream size/resize/cursor helpers,
// and the colour-depth table compared with real Node's.
import * as nodeTty from "node:tty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import tty, { getColorDepth, hasColors, isatty, ReadStream, WriteStream } from "./tty";

let fake: FakeRuntime;

beforeEach(() => {
  fake = createFakeRuntime({ tty: true, env: { TERM: "xterm-256color" } });
  setRuntime(fake);
});

afterEach(() => {
  setRuntime(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

describe("isatty", () => {
  it("is true for the terminal fds and false otherwise", () => {
    expect(isatty(0)).toBe(true);
    expect(isatty(1)).toBe(true);
    expect(isatty(2)).toBe(true);
    expect(isatty(7)).toBe(false);
    expect(isatty(-1)).toBe(false);
    expect(isatty(1.5)).toBe(false);
    expect(isatty("1")).toBe(false);
    expect(tty.isatty).toBe(isatty);
  });

  it("is false for a pipe and with no runtime", () => {
    const { readFd } = fake.processes.pipe();
    expect(isatty(readFd)).toBe(false);
    setRuntime(null);
    expect(isatty(1)).toBe(false);
  });
});

describe("ReadStream", () => {
  it("sets raw mode on the terminal", () => {
    const stdin = new ReadStream(0);
    expect(stdin.isTTY).toBe(true);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.setRawMode(true)).toBe(stdin);
    expect(stdin.isRaw).toBe(true);
    expect(fake.rawMode).toBe(true);
    stdin.setRawMode(false);
    expect(fake.rawMode).toBe(false);
    stdin.destroy();
  });

  it("reads what is typed", async () => {
    const stdin = new ReadStream(0);
    const seen: string[] = [];
    stdin.on("data", (chunk: Uint8Array) => seen.push(Buffer.from(chunk).toString()));
    fake.feedStdin("q");
    await settle();
    expect(seen).toEqual(["q"]);
    stdin.destroy();
  });
});

describe("WriteStream", () => {
  it("reports the window size live and emits resize", () => {
    const stdout = new WriteStream(1);
    expect(stdout.isTTY).toBe(true);
    expect(stdout.columns).toBe(80);
    expect(stdout.rows).toBe(24);
    expect(stdout.getWindowSize()).toEqual([80, 24]);
    let resized = 0;
    stdout.on("resize", () => resized++);
    fake.resize(120, 40);
    expect(resized).toBe(1);
    expect(stdout.columns).toBe(120);
    expect(stdout.rows).toBe(40);
    fake.resize(120, 40);
    expect(resized).toBe(1);
  });

  it("writes the cursor sequences", async () => {
    const stdout = new WriteStream(1);
    stdout.cursorTo(2);
    stdout.cursorTo(1, 3);
    stdout.moveCursor(-2, 1);
    stdout.clearLine(0);
    stdout.clearLine(-1);
    stdout.clearLine(1);
    await new Promise<void>((resolve) => stdout.clearScreenDown(() => resolve()));
    expect(fake.stdout()).toBe("\x1b[3G\x1b[4;2H\x1b[2D\x1b[1B\x1b[2K\x1b[1K\x1b[0K\x1b[0J");
  });

  it("defaults the colour depth to the runtime env", () => {
    const stdout = new WriteStream(1);
    expect(stdout.getColorDepth()).toBe(8);
    expect(stdout.hasColors()).toBe(true);
    expect(stdout.hasColors(256)).toBe(true);
    expect(stdout.hasColors(2 ** 24)).toBe(false);
    expect(stdout.getColorDepth({})).toBe(1);
  });
});

describe("getColorDepth", () => {
  const envs: Record<string, string>[] = [
    {},
    { TERM: "dumb" },
    { TERM: "xterm" },
    { TERM: "xterm-256color" },
    { TERM: "xterm-truecolor" },
    { TERM: "screen" },
    { TERM: "linux" },
    { TERM: "rxvt-unicode-24bit" },
    { TERM: "xterm-kitty" },
    { TERM: "mosh" },
    { TERM: "konsole" },
    { TERM: "XTERM" },
    { TERM: "vt100" },
    { TERM: "con80x25" },
    { TERM: "unknown" },
    { COLORTERM: "truecolor" },
    { COLORTERM: "24bit" },
    { COLORTERM: "yes" },
    { COLORTERM: "1", TERM: "xterm-256color" },
    { FORCE_COLOR: "" },
    { FORCE_COLOR: "0" },
    { FORCE_COLOR: "1" },
    { FORCE_COLOR: "true" },
    { FORCE_COLOR: "2" },
    { FORCE_COLOR: "3" },
    { FORCE_COLOR: "4" },
    { FORCE_COLOR: "false" },
    { NO_COLOR: "1", TERM: "xterm-256color" },
    { NODE_DISABLE_COLORS: "1", TERM: "xterm-256color" },
    { TMUX: "1" },
    { TMUX: "", TERM: "xterm" },
    { CI: "true" },
    { CI: "true", GITHUB_ACTIONS: "true" },
    { CI: "true", GITLAB_CI: "1" },
    { CI: "true", TRAVIS: "1" },
    { CI: "true", CIRCLECI: "1" },
    { CI: "true", APPVEYOR: "1" },
    { CI: "true", BUILDKITE: "1" },
    { CI: "true", DRONE: "1" },
    { CI: "true", GITEA_ACTIONS: "1" },
    { CI: "true", CI_NAME: "codeship" },
    { TF_BUILD: "1", AGENT_NAME: "x" },
    { TEAMCITY_VERSION: "9.1.0" },
    { TEAMCITY_VERSION: "8.0.0" },
    { TEAMCITY_VERSION: "2023.1" },
    { TERM_PROGRAM: "iTerm.app" },
    { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.4.1" },
    { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "2.9" },
    { TERM_PROGRAM: "HyperTerm" },
    { TERM_PROGRAM: "MacTerm" },
    { TERM_PROGRAM: "Apple_Terminal" },
    { TERM_PROGRAM: "vscode", TERM: "xterm-256color" },
  ];

  const nodeGetColorDepth = nodeTty.WriteStream.prototype.getColorDepth as (
    env: Record<string, string>,
  ) => number;
  const nodeHasColors = nodeTty.WriteStream.prototype.hasColors as (
    count: number,
    env: Record<string, string>,
  ) => boolean;

  it("matches real Node for every env in the table", () => {
    const quietWarnings = process.emitWarning;
    process.emitWarning = () => {};
    try {
      for (const env of envs) {
        expect([env, getColorDepth(env)]).toEqual([env, nodeGetColorDepth.call(null, env)]);
        for (const count of [2, 16, 256, 2 ** 24]) {
          expect([env, count, hasColors(count, env)]).toEqual([
            env,
            count,
            nodeHasColors.call(null, count, env),
          ]);
        }
      }
    } finally {
      process.emitWarning = quietWarnings;
    }
  });

  it("treats an empty NO_COLOR as set, as Node 22 does (later Node ignores it)", () => {
    expect(getColorDepth({ NO_COLOR: "", TERM: "xterm-256color" })).toBe(1);
  });

  it("validates hasColors' count", () => {
    expect(hasColors({ TERM: "xterm" })).toBe(true);
    expect(() => hasColors(1, {})).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
    expect(() => hasColors("x", {})).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });
});
