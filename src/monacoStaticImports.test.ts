// @vitest-environment node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";
import { describe, expect, it } from "vite-plus/test";

/**
 * Editor lazy-loads CodeEditor so the lesson shell can paint, and start fetching
 * the recording, while Monaco (about 1 MB gzipped, 4 MB of JS) downloads. A
 * single static import of y-monaco or monaco-editor anywhere below the shell
 * undoes that without any error: the bundler moves Monaco into the eager
 * closure, and the /learn gallery, which never shows an editor, pays for it too
 * (it happened once through src/collaboration/undo.ts). This walks the static,
 * runtime imports below each entry the way the bundler sees them — type-only
 * imports are erased, dynamic import() starts a lazy chunk — and fails on any
 * path to Monaco.
 */
const ENTRIES = [
  "src/components/Editor.tsx",
  "src/contexts/CollaborationContext.tsx",
  "tube/src/index.tsx",
];
const MONACO = /^(?:y-monaco|monaco-editor)(?:\/|$)/;
// vite.config.ts resolve.alias, minus the Monaco deep-path alias.
const ALIASES: Array<[prefix: string, target: string]> = [
  ["@next-editor/tube", "tube/src/index.tsx"],
  ["@next-editor/infra", "infra/client/index.ts"],
  ["@app/", "src/"],
];
const SOURCE = /\.tsx?$/;

function resolveFile(base: string): string {
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const path = base + suffix;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  throw new Error(`cannot resolve ${relative(process.cwd(), base)}`);
}

/** The module a specifier names: a file path, or the bare package specifier. */
function resolveSpecifier(
  specifier: string,
  importer: string,
): { file: string } | { bare: string } {
  if (specifier.startsWith("."))
    return { file: resolveFile(resolve(dirname(importer), specifier)) };
  for (const [prefix, target] of ALIASES) {
    if (specifier === prefix || (prefix.endsWith("/") && specifier.startsWith(prefix))) {
      return { file: resolveFile(resolve(target + specifier.slice(prefix.length))) };
    }
  }
  return { bare: specifier };
}

function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const { module } = parseSync(file, source);
  // `import type` / `export type` are erased. With verbatimModuleSyntax an
  // inline `import { type X }` still leaves a side-effect import, so it counts.
  const isTypeOnly = (start: number, end: number) =>
    /^(?:import|export)\s+type[\s{*]/.test(source.slice(start, end));
  const specifiers = [
    ...module.staticImports
      .filter((entry) => !isTypeOnly(entry.start, entry.end))
      .map((entry) => entry.moduleRequest.value),
    ...module.staticExports
      .filter((entry) => !isTypeOnly(entry.start, entry.end))
      .flatMap((entry) => entry.entries.flatMap((exported) => exported.moduleRequest?.value ?? [])),
  ];
  // `?worker`, `?url` and `?raw` imports are separate bundles or plain strings.
  return specifiers.filter((specifier) => !specifier.includes("?"));
}

/** Every Monaco import reachable from `entry`, as the import chain that reaches it. */
function findMonacoImports(entry: string): string[] {
  const importerOf = new Map<string, string | null>([[resolve(entry), null]]);
  const queue = [resolve(entry)];
  const found: string[] = [];
  const chainTo = (file: string) => {
    const chain: string[] = [];
    for (let at: string | null | undefined = file; at; at = importerOf.get(at)) {
      chain.unshift(relative(process.cwd(), at));
    }
    return chain.join(" -> ");
  };
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const specifier of runtimeImports(file)) {
      const target = resolveSpecifier(specifier, file);
      if ("bare" in target) {
        if (MONACO.test(target.bare)) found.push(`${chainTo(file)} -> ${target.bare}`);
      } else if (!importerOf.has(target.file)) {
        importerOf.set(target.file, file);
        if (SOURCE.test(target.file)) queue.push(target.file);
      }
    }
  }
  return found;
}

describe("Monaco stays behind the lazy CodeEditor", () => {
  it.each(ENTRIES)("%s has no static path to y-monaco or monaco-editor", (entry) => {
    expect(findMonacoImports(entry)).toEqual([]);
  });

  it("finds the Monaco imports CodeEditor does have", () => {
    expect(findMonacoImports("src/components/CodeEditor.tsx")).toContain(
      "src/components/CodeEditor.tsx -> src/components/codeEditor/useYMonacoBinding.ts -> y-monaco",
    );
  });
});
