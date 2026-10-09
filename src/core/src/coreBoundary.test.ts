// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Core's dependencies point inward (CLAUDE.md): nothing under src/core imports
 * the app layer — src/storage, src/utils, src/components, src/types,
 * src/contexts, or any other module outside src/core. What core needs is
 * defined in core and re-exported from the app path when the app still uses it
 * (src/types/runtime.ts, slides.ts, textEdit.ts, chat.ts, workspace.ts).
 *
 * This scans every non-test module under src/core, resolves each relative
 * import against the importing file, and fails on any that lands outside
 * src/core; the `@app/*` alias (src/*) always does. Tests are exempt: they may
 * drive core through app code such as the storage codec.
 */
const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CORE_ROOT, "../..");

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function listCoreModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : listCoreModules(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function isInsideCore(path: string): boolean {
  return path === CORE_ROOT || path.startsWith(CORE_ROOT + sep);
}

function resolveSpecifier(file: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return resolve(dirname(file), specifier);
  if (specifier.startsWith("@app/")) return resolve(REPO_ROOT, "src", specifier.slice(5));
  return null;
}

function importsLeavingCore(file: string, source: string): string[] {
  return source.split("\n").flatMap((line, index) =>
    Array.from(line.matchAll(IMPORT_SPECIFIER), (match) => match[1])
      .filter((specifier) => {
        const target = resolveSpecifier(file, specifier);
        return target !== null && !isInsideCore(target);
      })
      .map((specifier) => `${relative(REPO_ROOT, file)}:${index + 1} imports "${specifier}"`),
  );
}

describe("core boundary", () => {
  it("flags every import form that leaves src/core and nothing else", () => {
    const file = join(CORE_ROOT, "src", "machine", "example.ts");
    const source = [
      'import type { WorkspaceProject } from "../../../types/workspace";',
      'import { areStructuredDataEqual } from "../utils/equality";',
      "import {",
      "  saveRecording,",
      '} from "../../../storage/recordingStore";',
      'const panel = await import("../../../components/TerminalPanel");',
      'import "@app/utils/clipboard";',
      'export * from "../../dmp/dmpCodec";',
      'import { setup } from "xstate";',
    ].join("\n");

    expect(importsLeavingCore(file, source)).toEqual([
      'src/core/src/machine/example.ts:1 imports "../../../types/workspace"',
      'src/core/src/machine/example.ts:5 imports "../../../storage/recordingStore"',
      'src/core/src/machine/example.ts:6 imports "../../../components/TerminalPanel"',
      'src/core/src/machine/example.ts:7 imports "@app/utils/clipboard"',
    ]);
  });

  it("imports nothing outside src/core from a non-test module", () => {
    const modules = listCoreModules(CORE_ROOT);
    expect(modules).toContain(join(CORE_ROOT, "src", "machine", "editorMachine.ts"));

    const offenders = modules.flatMap((file) =>
      importsLeavingCore(file, readFileSync(file, "utf8")),
    );
    expect(offenders, "core must not import the app layer; move what it needs into core").toEqual(
      [],
    );
  });
});
