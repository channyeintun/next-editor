// @vitest-environment node
// tsx's command line as tsx 4 reads it: Node's options and the script's own
// arguments pass through, tsx's options are dropped, and `watch` becomes the
// node program's private watch option with tsx's watch options as its value.
import { describe, expect, it } from "vitest";
import { TSX_WATCH_OPTION, tsxArguments, type TsxWatchSettings } from "./watchOptions";

/** The settings `tsx watch …` reaches the node program with, and what follows them. */
function watching(args: string[]): { settings: TsxWatchSettings; rest: string[] } {
  const [option, ...rest] = tsxArguments(["watch", ...args]);
  expect(option.startsWith(`${TSX_WATCH_OPTION}=`)).toBe(true);
  return {
    settings: JSON.parse(option.slice(TSX_WATCH_OPTION.length + 1)) as TsxWatchSettings,
    rest,
  };
}

const DEFAULTS: TsxWatchSettings = {
  include: [],
  exclude: [],
  clearScreen: true,
  noCache: false,
  tsconfig: null,
};

describe("tsx <script>", () => {
  it("passes Node's options on to node", () => {
    expect(tsxArguments(["--env-file=.env", "src/server.ts"])).toEqual([
      "--env-file=.env",
      "src/server.ts",
    ]);
    expect(tsxArguments(["--no-warnings", "--conditions", "dev", "x.ts", "--port", "3"])).toEqual([
      "--no-warnings",
      "--conditions",
      "dev",
      "x.ts",
      "--port",
      "3",
    ]);
    expect(tsxArguments(["--import", "./setup.ts", "x.ts"])).toEqual([
      "--import",
      "./setup.ts",
      "x.ts",
    ]);
  });

  it("drops tsx's own options with their values, and only before the script", () => {
    expect(
      tsxArguments(["--tsconfig", "tsconfig.app.json", "--no-cache", "x.ts", "--no-cache"]),
    ).toEqual(["x.ts", "--no-cache"]);
    expect(tsxArguments(["--tsconfig=tsconfig.app.json", "x.ts"])).toEqual(["x.ts"]);
    // `run` is tsx's name for the same thing.
    expect(tsxArguments(["run", "--noCache", "x.ts"])).toEqual(["x.ts"]);
    // The watch options are options of `watch` only: node gets them here.
    expect(tsxArguments(["--include", "x.ts"])).toEqual(["--include", "x.ts"]);
  });
});

describe("tsx watch", () => {
  it("makes its watch options the supervisor's settings and passes the rest on", () => {
    expect(
      watching([
        "--ignore",
        "./data",
        "--clear-screen=false",
        "--include",
        "src/**",
        "--exclude=tmp",
        "--tsconfig",
        "tsconfig.app.json",
        "src/index.ts",
        "--include",
        "x",
      ]),
    ).toEqual({
      settings: {
        include: ["src/**"],
        exclude: ["./data", "tmp"],
        clearScreen: false,
        noCache: false,
        tsconfig: "tsconfig.app.json",
      },
      rest: ["src/index.ts", "--include", "x"],
    });
    expect(watching(["--env-file=.env", "src/index.ts"])).toEqual({
      settings: DEFAULTS,
      rest: ["--env-file=.env", "src/index.ts"],
    });
  });

  it("reads tsx's flags as its parser does", () => {
    // camelCase spellings, a boolean that is only false as "false", and a
    // value option followed by another option, which then gets "".
    const { settings } = watching([
      "--clearScreen=0",
      "--noCache",
      "--include",
      "--exclude",
      "y",
      "a.ts",
    ]);
    expect(settings).toEqual({ ...DEFAULTS, noCache: true, include: [""], exclude: ["y"] });
    // tsx does not know --no-clear-screen: node gets it.
    expect(watching(["--no-clear-screen", "a.ts"]).rest).toEqual(["--no-clear-screen", "a.ts"]);
  });

  it("leaves nothing to run when no script follows, which the supervisor refuses", () => {
    expect(watching([])).toEqual({ settings: DEFAULTS, rest: [] });
    // A value option takes the only argument for itself.
    expect(watching(["--exclude", "a.ts"])).toEqual({
      settings: { ...DEFAULTS, exclude: ["a.ts"] },
      rest: [],
    });
    // After `--` the script is still the script.
    expect(watching(["--", "x.ts"]).rest).toEqual(["--", "x.ts"]);
  });
});
