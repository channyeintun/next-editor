// @vitest-environment node
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePublishedScriptIndex,
  PUBLISHED_SCRIPT_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_CACHE_CONTROL,
  PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
  PUBLISHED_SCRIPT_MISS_CACHE_CONTROL,
  PUBLISHED_SCRIPT_OBJECT_CACHE_CONTROL,
} from "../src/studio/plans/publishedScripts";
import { createLessonScriptsMiddleware } from "./lessonScriptsDevPlugin";

// Lets a test give entries an id other than the bare hash, as a later change
// to the id rule in publishedScriptEntry.ts would.
const entryIds = vi.hoisted(() => ({ rewrite: null as ((id: string) => string) | null }));
vi.mock("../src/studio/plans/publishedScriptEntry", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/studio/plans/publishedScriptEntry")>();
  return {
    ...original,
    publishedScriptFileOf: async (bytes: Uint8Array) => {
      const file = await original.publishedScriptFileOf(bytes);
      const rewrite = entryIds.rewrite;
      return rewrite ? { ...file, entry: { ...file.entry, id: rewrite(file.entry.id) } } : file;
    },
  };
});

const FIXTURES = fileURLToPath(new URL("../src/studio/script/__fixtures__/", import.meta.url));

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  passed: boolean;
}

function ask(
  middleware: ReturnType<typeof createLessonScriptsMiddleware>,
  url: string,
  method = "GET",
): Promise<Answer> {
  return new Promise((done) => {
    const answer: Answer = { status: 0, headers: {}, body: Buffer.alloc(0), passed: false };
    const response = {
      writeHead(status: number, headers: Record<string, string>) {
        answer.status = status;
        answer.headers = headers;
      },
      end(body?: string | Uint8Array) {
        if (body !== undefined) answer.body = Buffer.from(body);
        done(answer);
      },
    } as unknown as ServerResponse;
    middleware({ url, method } as IncomingMessage, response, () => {
      answer.passed = true;
      done(answer);
    });
  });
}

let dir: string;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lesson-scripts-dev-"));
  warnings = [];
  copyFileSync(join(FIXTURES, "go-swap.yaml"), join(dir, "go-swap.yaml"));
});

afterEach(() => {
  entryIds.rewrite = null;
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the dev server's lesson scripts", () => {
  it("serves an index of the folder and each script by its id", async () => {
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    const index = await ask(middleware, "/api/studio/scripts/index");
    expect(index.status).toBe(200);
    expect(index.headers).toMatchObject({
      "content-type": PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
      "cache-control": PUBLISHED_SCRIPT_INDEX_CACHE_CONTROL,
    });
    const parsed = parsePublishedScriptIndex(JSON.parse(index.body.toString()));
    const bytes = readFileSync(join(dir, "go-swap.yaml"));
    expect(parsed.source).toBe("working-tree");
    expect(parsed.lessons["go-swap"]).toMatchObject({ id: sha256(bytes), locale: "en-US" });

    const object = await ask(middleware, `/api/studio/scripts/objects/${sha256(bytes)}`);
    expect(object.status).toBe(200);
    expect(object.headers).toMatchObject({
      "content-type": PUBLISHED_SCRIPT_CONTENT_TYPE,
      "cache-control": PUBLISHED_SCRIPT_OBJECT_CACHE_CONTROL,
    });
    expect(object.body.equals(bytes)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("serves each script under the id its index entry names", async () => {
    entryIds.rewrite = (id) => [...id].reverse().join("");
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    const index = parsePublishedScriptIndex(
      JSON.parse((await ask(middleware, "/api/studio/scripts/index")).body.toString()),
    );
    const bytes = readFileSync(join(dir, "go-swap.yaml"));
    const { id } = index.lessons["go-swap"];
    expect(id).not.toBe(sha256(bytes));

    const object = await ask(middleware, `/api/studio/scripts/objects/${id}`);
    expect(object.status).toBe(200);
    expect(object.body.equals(bytes)).toBe(true);
  });

  it("leaves out a file that does not parse or is misnamed, with one warning each", async () => {
    writeFileSync(join(dir, "broken.yaml"), "lesson: [\n");
    copyFileSync(join(FIXTURES, "go-cube.yaml"), join(dir, "not-go-cube.yaml"));
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    const index = parsePublishedScriptIndex(
      JSON.parse((await ask(middleware, "/api/studio/scripts/index")).body.toString()),
    );
    expect(Object.keys(index.lessons)).toEqual(["go-swap"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^lesson scripts: broken\.yaml is left out: /);
    expect(warnings[1]).toBe(
      'lesson scripts: not-go-cube.yaml is left out: not-go-cube.yaml holds lesson.slug "go-cube"; the file must be go-cube.yaml',
    );
    expect(warnings.every((line) => !line.includes("\n"))).toBe(true);

    // A rebuild with the same files says nothing again.
    middleware.invalidate();
    await ask(middleware, "/api/studio/scripts/index");
    expect(warnings).toHaveLength(2);
  });

  it("serves only ids in its index, never a path from the URL", async () => {
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    for (const url of [
      `/api/studio/scripts/objects/${"0".repeat(64)}`,
      "/api/studio/scripts/objects/go-swap.yaml",
      "/api/studio/scripts/objects/..%2F..%2F..%2Fpackage.json",
      "/api/studio/scripts/objects/",
      "/api/studio/scripts/other",
    ]) {
      const answer = await ask(middleware, url);
      expect({ url, status: answer.status }).toEqual({ url, status: 404 });
      expect(answer.headers["cache-control"]).toBe(PUBLISHED_SCRIPT_MISS_CACHE_CONTROL);
    }
    expect((await ask(middleware, "/api/studio/scripts/index", "POST")).status).toBe(404);
  });

  it("passes every other request on", async () => {
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    expect((await ask(middleware, "/api/studio/voices")).passed).toBe(true);
    expect((await ask(middleware, "/api/studio/scriptsx")).passed).toBe(true);
  });

  it("sees a change once invalidated", async () => {
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    const before = JSON.parse((await ask(middleware, "/api/studio/scripts/index")).body.toString());
    const edited = Buffer.concat([
      readFileSync(join(dir, "go-swap.yaml")),
      Buffer.from("# edit\n"),
    ]);
    writeFileSync(join(dir, "go-swap.yaml"), edited);
    copyFileSync(join(FIXTURES, "go-cube.yaml"), join(dir, "go-cube.yaml"));
    middleware.invalidate();
    const after = JSON.parse((await ask(middleware, "/api/studio/scripts/index")).body.toString());
    expect(after.lessons["go-swap"].id).toBe(sha256(edited));
    expect(after.lessons["go-swap"].id).not.toBe(before.lessons["go-swap"].id);
    expect(Object.keys(after.lessons)).toEqual(["go-cube", "go-swap"]);
    // The old bytes are no longer in the folder, so they are not served.
    const old = await ask(
      middleware,
      `/api/studio/scripts/objects/${before.lessons["go-swap"].id}`,
    );
    expect(old.status).toBe(404);
  });

  it("watches the folder from its first request when asked to", async () => {
    const watchers: { close(): void }[] = [];
    const middleware = createLessonScriptsMiddleware(
      dir,
      (line) => warnings.push(line),
      (watcher) => watchers.push(watcher),
    );
    expect(watchers).toHaveLength(0);
    await ask(middleware, "/api/studio/scripts/index");
    expect(watchers).toHaveLength(1);
    try {
      copyFileSync(join(FIXTURES, "go-cube.yaml"), join(dir, "go-cube.yaml"));
      let slugs: string[] = [];
      for (let attempt = 0; attempt < 100 && !slugs.includes("go-cube"); attempt += 1) {
        await new Promise((wait) => setTimeout(wait, 20));
        const index = await ask(middleware, "/api/studio/scripts/index");
        slugs = Object.keys(JSON.parse(index.body.toString()).lessons);
      }
      expect(slugs).toEqual(["go-cube", "go-swap"]);
    } finally {
      for (const watcher of watchers) watcher.close();
    }
  });

  it("answers HEAD without a body", async () => {
    const middleware = createLessonScriptsMiddleware(dir, (line) => warnings.push(line));
    const answer = await ask(middleware, "/api/studio/scripts/index", "HEAD");
    expect(answer.status).toBe(200);
    expect(answer.body.byteLength).toBe(0);
  });
});
