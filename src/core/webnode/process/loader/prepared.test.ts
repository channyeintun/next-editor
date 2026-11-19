// @vitest-environment node
// The loader takes a large module's prepared form from the kernel's entry
// instead of rewriting the file, and rewrites it itself whenever there is no
// entry to read.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { O_CREAT, O_TRUNC, O_WRONLY } from "../../kernel/vfs/types";
import { loadBuiltin } from "../node/index";
import { setRuntime } from "../runtime";
import { createFakeRuntime, type FakeRuntime } from "../testing/fakeRuntime";
import { configureLoader, importModule } from "./modules";
import { PREPARED_DIR, PREPARED_MIN_BYTES, encodePreparedEntry } from "./preparedEntry";
import { prepareSource, transformReady } from "./transform";

// What build/webnodeBundle.ts does to sucrase's code templates in the bundle:
// the code it writes for `import` and `export` uses the loader's own names.
vi.mock("sucrase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sucrase")>();
  return {
    ...actual,
    transform(code: string, options: Parameters<typeof actual.transform>[1]) {
      const result = actual.transform(code, options);
      if (!options.transforms.includes("imports")) {
        return result;
      }
      return {
        ...result,
        code: result.code
          .replaceAll("require('", "__webnode_require('")
          .replace(/(?<!module\.)\bexports\b/g, "__webnode_exports"),
      };
    },
  };
});

beforeAll(async () => {
  await transformReady;
});

afterEach(() => {
  setRuntime(null);
});

/** A module that says where it came from, padded to `bytes`. */
function moduleSaying(origin: string, bytes: number): string {
  const body = `export const origin = ${JSON.stringify(origin)};\n`;
  return body + `// ${"x".repeat(Math.max(0, bytes - body.length - 4))}\n`;
}

function write(fake: FakeRuntime, path: string, data: string | Uint8Array): void {
  fake.fs.mkdir(path.slice(0, path.lastIndexOf("/")), true, 0o755);
  fake.fs.writeFile(
    path,
    typeof data === "string" ? new TextEncoder().encode(data) : data,
    O_WRONLY | O_CREAT | O_TRUNC,
    0o644,
  );
}

/** A runtime whose kernel answers `locate` from `entries`, and the files it was asked about. */
function start(entries: Record<string, string>): { fake: FakeRuntime; asked: string[] } {
  const asked: string[] = [];
  const fake = createFakeRuntime({
    cwd: "/p",
    preparedEntry(filename) {
      asked.push(filename);
      return entries[filename] ?? null;
    },
  });
  setRuntime(fake);
  configureLoader({ loadBuiltin, conditions: [] });
  return { fake, asked };
}

// A file of its own for each test: the loader keeps the modules it has loaded.
const large = (name: string) => `/p/node_modules/${name}/index.mjs`;

describe("a large module of a package", () => {
  it("runs from the kernel's entry, the file itself not rewritten", async () => {
    const file = large("kept");
    const entry = `${PREPARED_DIR}/of-kept`;
    const { fake, asked } = start({ [file]: entry });
    write(fake, file, moduleSaying("the file", PREPARED_MIN_BYTES));
    write(
      fake,
      entry,
      encodePreparedEntry(prepareSource(moduleSaying("the entry", 0), file, "esm")),
    );
    expect((await importModule(file, "/p/main.mjs")).origin).toBe("the entry");
    expect(asked).toEqual([file]);
  });

  it("is rewritten here when the kernel has no entry", async () => {
    const file = large("unknown");
    const { fake, asked } = start({});
    write(fake, file, moduleSaying("the file", PREPARED_MIN_BYTES));
    expect((await importModule(file, "/p/main.mjs")).origin).toBe("the file");
    expect(asked).toEqual([file]);
  });

  it("is rewritten here when the entry cannot be read", async () => {
    const broken = large("broken");
    const gone = large("gone");
    const { fake } = start({ [broken]: `${PREPARED_DIR}/broken`, [gone]: "/nowhere" });
    write(fake, broken, moduleSaying("the file", PREPARED_MIN_BYTES));
    write(fake, `${PREPARED_DIR}/broken`, "no entry at all");
    write(fake, gone, moduleSaying("that file", PREPARED_MIN_BYTES));
    expect((await importModule(broken, "/p/main.mjs")).origin).toBe("the file");
    expect((await importModule(gone, "/p/main.mjs")).origin).toBe("that file");
  });
});

describe("any other module", () => {
  it("is rewritten here without the kernel being asked", async () => {
    const { fake, asked } = start({});
    write(fake, "/p/node_modules/small/index.mjs", moduleSaying("a small file", 200));
    write(fake, "/p/src/own.mjs", moduleSaying("the project's own", 2 * PREPARED_MIN_BYTES));
    expect((await importModule("/p/node_modules/small/index.mjs", "/p/main.mjs")).origin).toBe(
      "a small file",
    );
    expect((await importModule("/p/src/own.mjs", "/p/main.mjs")).origin).toBe("the project's own");
    expect(asked).toEqual([]);
  });
});
