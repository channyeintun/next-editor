import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * zod's index re-exports its whole namespace as the named binding `z` (and as
 * the default export). Rolldown tree-shakes that; esbuild, which Wrangler uses
 * to bundle this Worker, cannot. One `import { z } from "zod"` in the Worker's
 * graph shipped all of zod and its ~50 locales (about 350 KB) in the script
 * that every isolate start and Durable Object wake parses, where
 * `import * as z from "zod"` keeps only what is used. A lint rule cannot say
 * this (no-restricted-imports also rejects the namespace import once it
 * restricts the `z` name), so this scan does. It covers every source root,
 * client-only modules included, so the repository keeps one import style.
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_ROOTS = ["src", "infra", "tube/src", "scripts", "build"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
const ZOD_IMPORT = /\bimport\s+(type\s+)?([^;]*?)\s*from\s*["']zod["']/g;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/** The bindings of a zod import that pull in its whole namespace; empty when it shakes. */
function namespaceBindings(importStatement: string): string[] {
  const [, typeOnly, clause = ""] = new RegExp(ZOD_IMPORT.source).exec(importStatement) ?? [];
  if (typeOnly || clause.startsWith("*")) return [];

  const named = /\{([^}]*)\}/.exec(clause);
  const defaultBinding = clause
    .replace(/\{[^}]*\}/, "")
    .replace(/,/g, "")
    .trim();
  const namedBindings = (named?.[1] ?? "")
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== "" && !specifier.startsWith("type "))
    .map((specifier) => specifier.split(/\s+as\s+/)[0])
    .filter((name) => name === "z" || name === "default");

  return [...(defaultBinding ? ["default"] : []), ...namedBindings];
}

describe("zod imports", () => {
  it("recognises the forms esbuild cannot tree-shake", () => {
    expect(namespaceBindings('import { z } from "zod";')).toEqual(["z"]);
    expect(namespaceBindings('import { ZodError, z as zod } from "zod";')).toEqual(["z"]);
    expect(namespaceBindings('import zod from "zod";')).toEqual(["default"]);
    expect(namespaceBindings('import zod, { ZodError } from "zod";')).toEqual(["default"]);
    expect(namespaceBindings('import * as z from "zod";')).toEqual([]);
    expect(namespaceBindings('import type { z } from "zod";')).toEqual([]);
    expect(namespaceBindings('import { type z, ZodError } from "zod";')).toEqual([]);
  });

  it('uses `import * as z from "zod"` everywhere', () => {
    const offenders = SOURCE_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root)))
      .flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(ZOD_IMPORT)]
          .filter((match) => namespaceBindings(match[0]).length > 0)
          .map((match) => `${relative(REPO_ROOT, path)}: ${match[0]}`),
      )
      .filter((offender) => !offender.startsWith("infra/worker/zodImports.test.ts"));

    expect(offenders).toEqual([]);
  });
});
