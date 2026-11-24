/**
 * The command line of scripts/studio-render.ts: what each command takes, the
 * help text, and the checks that turn a mistyped flag into one plain line
 * before a browser is started. Pure, so every refusal is tested.
 */

import { join, resolve } from "node:path";
import type { StudioRuntimeMode } from "../../src/studio/plan.ts";
import { parseRenderSpeedParam, parseRuntimeModeParam } from "../../src/studio/renderLaunch.ts";
import type { RenderSpeed } from "../../src/studio/renderClock.ts";
import { isLoopbackUrl } from "./site.ts";

export const DEFAULT_URL = "http://localhost:5173";
export const DEFAULT_OUT_DIR = "studio-out";
/** Where the driver keeps its browser profile when neither --profile nor STUDIO_PROFILE names one. */
export const DEFAULT_PROFILE_FROM_HOME = ".next-editor/studio-profile";
const DEFAULT_RUNS = 2;
const MAX_RUNS = 10;

export interface SharedOptions {
  /** The site's origin, with no trailing slash. */
  url: string;
  /** The browser profile directory, absolute. */
  profile: string;
  headed: boolean;
  /** The output folder, absolute. */
  out: string;
}

/** What every command that renders shares. */
export interface RenderGuards {
  speed: RenderSpeed;
  /** Go on when a paid narration provider would synthesize dialogs it has not kept. */
  allowSynthesis: boolean;
  /** Render what the site publishes even when the local script differs. */
  published: boolean;
}

export type WorkflowMode = "render" | "draft" | "publish";

export type Command =
  | { kind: "help" }
  | { kind: "login"; shared: SharedOptions; local: boolean; chrome: string | null }
  | { kind: "status"; shared: SharedOptions }
  | {
      kind: "render";
      shared: SharedOptions;
      guards: RenderGuards;
      slugs: string[];
      /** Null renders each lesson in its own default mode. */
      runtime: StudioRuntimeMode | null;
      runs: number;
    }
  | {
      kind: "workflow";
      shared: SharedOptions;
      guards: RenderGuards;
      slugs: string[];
      resume: boolean;
      mode: WorkflowMode;
      playlist: string | null;
      thumbnails: string | null;
      defaultThumbnail: boolean;
      narrateFirst: boolean;
    }
  | {
      kind: "update";
      shared: SharedOptions;
      guards: RenderGuards;
      slug: string;
      lesson: string | null;
      replace: boolean;
    };

export type ParsedArgs = { command: Command } | { error: string };

export interface ArgsEnvironment {
  /** The STUDIO_PROFILE variable, when set. */
  studioProfile?: string;
  home: string;
  cwd: string;
}

const COMMANDS = ["login", "status", "render", "workflow", "update", "help"] as const;
type CommandName = (typeof COMMANDS)[number];

const SHARED_VALUE_FLAGS = ["url", "profile", "out"];
const SHARED_BOOLEAN_FLAGS = ["headed"];
const GUARD_VALUE_FLAGS = ["speed"];
const GUARD_BOOLEAN_FLAGS = ["allow-synthesis", "published"];

/** The flags each command takes beyond the shared ones: value flags, then switches. */
const COMMAND_FLAGS: Record<
  Exclude<CommandName, "help">,
  { values: string[]; switches: string[] }
> = {
  login: { values: ["chrome"], switches: ["local"] },
  status: { values: [], switches: [] },
  render: {
    values: ["runtime", "runs", ...GUARD_VALUE_FLAGS],
    switches: GUARD_BOOLEAN_FLAGS,
  },
  workflow: {
    values: ["playlist", "thumbnails", ...GUARD_VALUE_FLAGS],
    switches: [
      "draft",
      "publish",
      "default-thumbnail",
      "no-narrate-first",
      "resume",
      ...GUARD_BOOLEAN_FLAGS,
    ],
  },
  update: {
    values: ["lesson", ...GUARD_VALUE_FLAGS],
    switches: ["replace", ...GUARD_BOOLEAN_FLAGS],
  },
};

/**
 * A lesson slug is a script's file name. Anything that could step out of the
 * scripts folder, or that is not a file name at all, is refused here.
 */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const HELP = `bun scripts/studio-render.ts <command> [options]

Drives /studio in system Chrome with its own browser profile, through the
studio's automation surface (it never clicks). One driver per profile at a
time: a second command on the same profile is refused while one runs.

Commands
  <slug…>                 the same as "render <slug…>"
  render <slug…>          render each lesson and save its reports and bundle
      --runtime=fixture|live   default: the lesson's own mode
      --runs=N                 renders per lesson (default ${DEFAULT_RUNS}); two give a repeatability check
  workflow <slug…>        take the lessons through the studio workflow
      --draft | --publish      upload a draft, or a draft that is then published
                               (neither: render only)
      --playlist=<id>          the playlist every published lesson joins (needs --publish)
      --thumbnails=<dir>       thumbnail images, matched to lessons by file name
      --default-thumbnail      give a lesson with no image the site's default
      --no-narrate-first       narrate each lesson as it renders, not all first
      --resume                 go on with the workflow stored in the profile
  update <slug>           render a lesson again and compare it with the published one
      --lesson=<slug>          the published lesson's URL slug, when its title is not enough
      --replace                put the new render in its place (otherwise nothing changes)
  status                  sign-in, narration provider, voice, screen recording, lesson index
  login --url=<site>      open Chrome on the profile so a person can sign in
      --chrome=<path>          the Chrome binary (default: found per platform)
  login --local           sign this machine's dev server in as a fixed test user
                          (loopback URLs only; writes only local D1 and the profile)

Options for every command
  --url=<site>            default ${DEFAULT_URL}
  --profile=<dir>         default $STUDIO_PROFILE, else ~/${DEFAULT_PROFILE_FROM_HOME}
  --headed                show the window (default: headless)
  --out=<dir>             default ${DEFAULT_OUT_DIR}

Options for render, workflow and update
  --speed=full|real       full renders off the wall clock where a lesson allows it (default full)
  --allow-synthesis       go on when a paid narration provider has dialogs to synthesize
  --published             against a site, render what it publishes even when the local
                          script differs from it

State in the profile is kept per site (per origin): the sign-in, the narration
cache, the narration provider and voice, the stored workflow and its thumbnails
for http://localhost:5173 are not those of https://nexteditor.dev. Sign in, and
pick a provider and voice, once for every --url you use.`;

function sharedOf(
  values: Map<string, string>,
  switches: Set<string>,
  env: ArgsEnvironment,
): SharedOptions | { error: string } {
  const rawUrl = values.get("url") ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `--url is not a URL: "${rawUrl}"` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `--url must be http or https, got "${rawUrl}"` };
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return { error: `--url names a site, not a page: use ${url.origin}` };
  }
  const profileValue = values.get("profile") ?? env.studioProfile;
  const profile = profileValue
    ? resolve(env.cwd, expandHome(profileValue, env.home))
    : join(env.home, DEFAULT_PROFILE_FROM_HOME);
  return {
    url: url.origin,
    profile,
    headed: switches.has("headed"),
    out: resolve(env.cwd, values.get("out") ?? DEFAULT_OUT_DIR),
  };
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function guardsOf(
  values: Map<string, string>,
  switches: Set<string>,
): RenderGuards | { error: string } {
  const speedValue = values.get("speed");
  let speed: RenderSpeed = "full";
  if (speedValue !== undefined) {
    const parsed = parseRenderSpeedParam(speedValue);
    if (!parsed.speed) return { error: `--speed must be full or real, got "${speedValue}"` };
    speed = parsed.speed;
  }
  return {
    speed,
    allowSynthesis: switches.has("allow-synthesis"),
    published: switches.has("published"),
  };
}

function checkSlugs(slugs: string[]): string | null {
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug)) return `"${slug}" is not a lesson slug`;
  }
  const seen = new Set<string>();
  for (const slug of slugs) {
    if (seen.has(slug)) return `"${slug}" is named twice`;
    seen.add(slug);
  }
  return null;
}

/** Parse the arguments after the script's path. */
export function parseArgs(argv: readonly string[], env: ArgsEnvironment): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: { kind: "help" } };
  }
  const positionals: string[] = [];
  const flags: { name: string; value: string | null; raw: string }[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      flags.push(
        eq === -1
          ? { name: arg.slice(2), value: null, raw: arg }
          : { name: arg.slice(2, eq), value: arg.slice(eq + 1), raw: arg },
      );
    } else if (arg.startsWith("-")) {
      return { error: `unknown option ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  // A bare slug first means "render": the documented way to render a lesson
  // has always been `bun scripts/studio-render.ts <slug>`.
  const first = positionals[0];
  const name: CommandName =
    first !== undefined && (COMMANDS as readonly string[]).includes(first)
      ? (first as CommandName)
      : "render";
  const slugs = name === "render" && first !== "render" ? positionals : positionals.slice(1);
  if (name === "help") return { command: { kind: "help" } };

  const allowed = COMMAND_FLAGS[name];
  const valueFlags = new Set([...SHARED_VALUE_FLAGS, ...allowed.values]);
  const switchFlags = new Set([...SHARED_BOOLEAN_FLAGS, ...allowed.switches]);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (const flag of flags) {
    if (valueFlags.has(flag.name)) {
      if (flag.value === null || flag.value === "") {
        return { error: `--${flag.name} needs a value: --${flag.name}=<…>` };
      }
      if (values.has(flag.name)) return { error: `--${flag.name} is given twice` };
      values.set(flag.name, flag.value);
    } else if (switchFlags.has(flag.name)) {
      if (flag.value !== null) return { error: `--${flag.name} takes no value: ${flag.raw}` };
      switches.add(flag.name);
    } else {
      return { error: `"${name}" takes no option ${flag.raw.split("=")[0]}` };
    }
  }

  const shared = sharedOf(values, switches, env);
  if ("error" in shared) return shared;
  const slugError = checkSlugs(slugs);
  if (slugError) return { error: slugError };

  switch (name) {
    case "login": {
      if (slugs.length) return { error: "login takes no lessons" };
      const local = switches.has("local");
      if (local && !isLoopbackUrl(shared.url)) {
        return {
          error: `login --local signs in this machine's dev server only; ${shared.url} is not a loopback name`,
        };
      }
      if (local && new URL(shared.url).protocol !== "http:") {
        // Over https the Worker reads only a __Host- cookie; the dev server is http.
        return { error: `login --local signs in an http dev server; ${shared.url} is https` };
      }
      if (local && values.has("chrome")) {
        return { error: "login --local starts no Chrome of its own; drop --chrome" };
      }
      return {
        command: {
          kind: "login",
          shared,
          local,
          chrome: values.has("chrome") ? resolve(env.cwd, values.get("chrome")!) : null,
        },
      };
    }
    case "status":
      if (slugs.length) return { error: "status takes no lessons" };
      return { command: { kind: "status", shared } };
    case "render": {
      if (!slugs.length) return { error: "name at least one lesson: render <slug…>" };
      const guards = guardsOf(values, switches);
      if ("error" in guards) return guards;
      let runtime: StudioRuntimeMode | null = null;
      const runtimeValue = values.get("runtime");
      if (runtimeValue !== undefined) {
        const parsed = parseRuntimeModeParam(runtimeValue);
        if (!parsed.mode)
          return { error: `--runtime must be fixture or live, got "${runtimeValue}"` };
        runtime = parsed.mode;
      }
      let runs = DEFAULT_RUNS;
      const runsValue = values.get("runs");
      if (runsValue !== undefined) {
        if (!/^\d+$/.test(runsValue))
          return { error: `--runs must be a whole number, got "${runsValue}"` };
        runs = Number(runsValue);
        if (runs < 1 || runs > MAX_RUNS) return { error: `--runs must be 1 to ${MAX_RUNS}` };
      }
      return { command: { kind: "render", shared, guards, slugs, runtime, runs } };
    }
    case "workflow": {
      const guards = guardsOf(values, switches);
      if ("error" in guards) return guards;
      const resume = switches.has("resume");
      const draft = switches.has("draft");
      const publish = switches.has("publish");
      const defaultThumbnail = switches.has("default-thumbnail");
      const thumbnails = values.get("thumbnails") ?? null;
      const playlist = values.get("playlist") ?? null;
      if (resume) {
        // A resumed workflow goes on with the settings it was started with.
        const setting = [
          draft && "--draft",
          publish && "--publish",
          playlist && "--playlist",
          thumbnails && "--thumbnails",
          defaultThumbnail && "--default-thumbnail",
          switches.has("no-narrate-first") && "--no-narrate-first",
          values.has("speed") && "--speed",
        ].find(Boolean);
        if (setting) {
          return { error: `--resume keeps the stored workflow's settings; drop ${setting}` };
        }
      } else if (!slugs.length) {
        return { error: "name at least one lesson: workflow <slug…> (or --resume)" };
      }
      if (draft && publish) {
        return { error: "--draft and --publish are exclusive: --publish also uploads the draft" };
      }
      if (playlist && !publish) return { error: "--playlist needs --publish" };
      if (thumbnails && defaultThumbnail) {
        return { error: "--thumbnails and --default-thumbnail are exclusive" };
      }
      const mode: WorkflowMode = publish ? "publish" : draft ? "draft" : "render";
      if (!resume && mode !== "render" && !thumbnails && !defaultThumbnail) {
        return {
          error:
            "a draft needs a thumbnail for every lesson: pass --thumbnails=<dir> or --default-thumbnail",
        };
      }
      if (!resume && mode === "render" && (thumbnails || defaultThumbnail)) {
        return { error: "thumbnails are for drafts: add --draft or --publish, or drop them" };
      }
      return {
        command: {
          kind: "workflow",
          shared,
          guards,
          slugs,
          resume,
          mode,
          playlist,
          thumbnails: thumbnails ? resolve(env.cwd, thumbnails) : null,
          defaultThumbnail,
          narrateFirst: !switches.has("no-narrate-first"),
        },
      };
    }
    case "update": {
      if (slugs.length !== 1) return { error: "update takes exactly one lesson: update <slug>" };
      const guards = guardsOf(values, switches);
      if ("error" in guards) return guards;
      return {
        command: {
          kind: "update",
          shared,
          guards,
          slug: slugs[0],
          lesson: values.get("lesson") ?? null,
          replace: switches.has("replace"),
        },
      };
    }
  }
}
