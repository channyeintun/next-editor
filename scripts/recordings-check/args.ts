/** The command line of scripts/recordings-check.ts. */

import { isSlug } from "./lessons.ts";

export const USAGE = [
  "Usage: bun scripts/recordings-check.ts [--count=N] [--slug=<lesson slug> …] [--cuts=K] [--seed=S] [--keep]",
  "",
  "Downloads published lessons from nexteditor.dev into a temporary folder of its own,",
  "checks each recording, prints one row per recording and track, and deletes the",
  "downloads when it ends (also on an error or Ctrl-C).",
  "",
  "  --count=N   the newest N published lessons (default 6); ignored with --slug",
  "  --slug=S    this lesson; repeat it for more (e.g. a human recording)",
  "  --cuts=K    random cuts for the cut law, one per edit (default 10)",
  "  --seed=S    the seed for the cuts and the seek order (default 1)",
  "  --keep      keep the downloads and print their folder, for debugging",
  "",
  "Checks: seeking lands where playing does (replay owns the page), and a cut keeps",
  "what is outside it (the pointer and captions are reported as outside the law).",
  "A file's own errors (decode, a damaged track) are counted under 'odd file'.",
  "",
  "How to read it: run it on main before a change to replay or cutting, and again",
  "after, with the same lessons and seed. The rule is no new difference: a row that",
  "differs only after the change is a regression; one present on main already is a",
  "finding to look at. The last line's hash is equal when two runs found the same.",
  "Exit code 0 when it ran, 1 when it could not (no network, no lessons, bad options).",
].join("\n");

export interface Options {
  count: number;
  slugs: string[];
  cuts: number;
  seed: number;
  keep: boolean;
}

export const DEFAULT_OPTIONS: Options = { count: 6, slugs: [], cuts: 10, seed: 1, keep: false };

const NUMBER_FLAGS = { "--count": "count", "--cuts": "cuts", "--seed": "seed" } as const;

export function parseArgs(argv: readonly string[]): { options: Options } | { error: string } {
  const options: Options = { ...DEFAULT_OPTIONS, slugs: [] };
  for (const arg of argv) {
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { error: "" };
    const [flag, value] = arg.split("=", 2);
    if (flag === "--slug" && value !== undefined) {
      if (!isSlug(value)) return { error: `not a lesson slug: ${value}` };
      options.slugs.push(value);
      continue;
    }
    const key = NUMBER_FLAGS[flag as keyof typeof NUMBER_FLAGS];
    const number = Number(value);
    if (!key || value === undefined || !Number.isInteger(number) || number < 0) {
      return { error: `unknown or bad option: ${arg}` };
    }
    if (key !== "seed" && number === 0) return { error: `${flag} must be at least 1` };
    options[key] = number;
  }
  return { options };
}
