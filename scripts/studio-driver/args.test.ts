// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type Command, parseArgs } from "./args.ts";

const env = { home: "/home/me", cwd: "/repo" };

function command(argv: string[], environment: Parameters<typeof parseArgs>[1] = env): Command {
  const parsed = parseArgs(argv, environment);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.command;
}

function error(argv: string[]): string {
  const parsed = parseArgs(argv, env);
  if (!("error" in parsed)) throw new Error(`parsed: ${JSON.stringify(parsed.command)}`);
  return parsed.error;
}

describe("parseArgs", () => {
  it("reads a bare slug as render, with today's defaults", () => {
    expect(command(["rust-borrow"])).toEqual({
      kind: "render",
      shared: {
        url: "http://localhost:5173",
        profile: "/home/me/.next-editor/studio-profile",
        headed: false,
        out: "/repo/studio-out",
      },
      guards: { speed: "full", allowSynthesis: false, published: false },
      slugs: ["rust-borrow"],
      runtime: null,
      runs: 2,
    });
    expect(command(["--runs=1", "a", "b"])).toMatchObject({
      kind: "render",
      slugs: ["a", "b"],
      runs: 1,
    });
    expect(command(["render", "a", "--runtime=live", "--speed=real"])).toMatchObject({
      kind: "render",
      slugs: ["a"],
      runtime: "live",
      guards: { speed: "real" },
    });
  });

  it("shows the help for no arguments or --help anywhere", () => {
    expect(command([])).toEqual({ kind: "help" });
    expect(command(["render", "a", "--help"])).toEqual({ kind: "help" });
    expect(command(["help"])).toEqual({ kind: "help" });
  });

  it("takes the profile from --profile, then STUDIO_PROFILE, expanding ~", () => {
    expect(command(["status", "--profile=~/p"])).toMatchObject({
      shared: { profile: "/home/me/p" },
    });
    expect(command(["status"], { ...env, studioProfile: "rel/p" })).toMatchObject({
      shared: { profile: "/repo/rel/p" },
    });
    expect(command(["status", "--profile=/abs"], { ...env, studioProfile: "/env" })).toMatchObject({
      shared: { profile: "/abs" },
    });
  });

  it("takes a site, not a page, and keeps only its origin", () => {
    expect(command(["status", "--url=https://nexteditor.dev/"])).toMatchObject({
      shared: { url: "https://nexteditor.dev" },
    });
    expect(error(["status", "--url=https://nexteditor.dev/studio"])).toContain("names a site");
    expect(error(["status", "--url=ftp://x"])).toContain("http or https");
    expect(error(["status", "--url=nope"])).toContain("not a URL");
  });

  it("refuses flags a command does not take, and malformed ones", () => {
    expect(error(["render", "a", "--lesson=x"])).toBe('"render" takes no option --lesson');
    expect(error(["render", "a", "--runs"])).toContain("needs a value");
    expect(error(["render", "a", "--headed=yes"])).toContain("takes no value");
    expect(error(["render", "a", "-x"])).toBe("unknown option -x");
    expect(error(["render", "a", "--runs=2", "--runs=3"])).toContain("given twice");
    expect(error(["render", "a", "--runs=1.5"])).toContain("whole number");
    expect(error(["render", "a", "--runtime=both"])).toContain("fixture or live");
  });

  it("refuses slugs that are not file names, or are named twice", () => {
    expect(error(["../etc"])).toContain("not a lesson slug");
    expect(error(["a/b"])).toContain("not a lesson slug");
    expect(error(["a", "a"])).toContain("named twice");
  });

  it("keeps login --local to an http loopback site", () => {
    expect(command(["login", "--local"])).toMatchObject({
      kind: "login",
      local: true,
      chrome: null,
    });
    expect(command(["login", "--local", "--url=http://127.0.0.1:5173"])).toMatchObject({
      local: true,
    });
    expect(error(["login", "--local", "--url=https://nexteditor.dev"])).toContain(
      "not a loopback name",
    );
    expect(error(["login", "--local", "--url=https://localhost:5173"])).toContain("is https");
    expect(error(["login", "--local", "--chrome=/c"])).toContain("drop --chrome");
    expect(command(["login", "--url=https://nexteditor.dev", "--chrome=bin/chrome"])).toMatchObject(
      {
        local: false,
        chrome: "/repo/bin/chrome",
      },
    );
  });

  it("builds a workflow's settings and refuses ones that cannot go together", () => {
    expect(command(["workflow", "a", "b"])).toMatchObject({
      kind: "workflow",
      mode: "render",
      narrateFirst: true,
      resume: false,
    });
    expect(
      command([
        "workflow",
        "a",
        "--publish",
        "--playlist=p1",
        "--thumbnails=thumbs",
        "--no-narrate-first",
      ]),
    ).toMatchObject({
      mode: "publish",
      playlist: "p1",
      thumbnails: "/repo/thumbs",
      narrateFirst: false,
    });
    expect(command(["workflow", "a", "--draft", "--default-thumbnail"])).toMatchObject({
      mode: "draft",
      defaultThumbnail: true,
    });
    expect(error(["workflow"])).toContain("at least one lesson");
    expect(error(["workflow", "a", "--draft", "--publish"])).toContain("exclusive");
    expect(error(["workflow", "a", "--draft", "--playlist=p", "--default-thumbnail"])).toBe(
      "--playlist needs --publish",
    );
    expect(error(["workflow", "a", "--draft"])).toContain("needs a thumbnail");
    expect(error(["workflow", "a", "--default-thumbnail"])).toContain("thumbnails are for drafts");
  });

  it("resumes a workflow with no lessons named and none of its settings", () => {
    expect(command(["workflow", "--resume"])).toMatchObject({
      kind: "workflow",
      resume: true,
      slugs: [],
    });
    expect(error(["workflow", "--resume", "--speed=real"])).toContain("drop --speed");
    expect(error(["workflow", "--resume", "--publish"])).toContain("drop --publish");
  });

  it("takes exactly one lesson to update", () => {
    expect(command(["update", "a", "--lesson=a-intro", "--replace", "--published"])).toMatchObject({
      kind: "update",
      slug: "a",
      lesson: "a-intro",
      replace: true,
      guards: { published: true },
    });
    expect(error(["update"])).toContain("exactly one");
    expect(error(["update", "a", "b"])).toContain("exactly one");
  });

  it("takes no lessons for status or login", () => {
    expect(error(["status", "a"])).toContain("no lessons");
    expect(error(["login", "a"])).toContain("no lessons");
  });
});
