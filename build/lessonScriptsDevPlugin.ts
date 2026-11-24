import { createHash } from "node:crypto";
import { readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import type { PublishedScriptEntry } from "../src/studio/plans/publishedScripts";
import {
  encodePublishedScriptIndex,
  PUBLISHED_SCRIPT_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
  PUBLISHED_SCRIPT_INDEX_PATH,
  PUBLISHED_SCRIPT_INDEX_VERSION,
  PUBLISHED_SCRIPTS_PATH,
  publishedScriptIdOfPath,
  WORKING_TREE_SOURCE,
} from "../src/studio/plans/publishedScripts";
import { lessonScriptsDir } from "../scripts/lessonScriptsDir";

/**
 * The dev server's stand-in for the Worker's /api/studio/scripts route
 * (infra/worker/routes/studioScripts.ts): under `vp dev` and `vp preview` the
 * studio reads the lesson index and the scripts straight from the folder, so
 * a lesson saved on disk is in /studio after a reload, with nothing published.
 *
 * Its index is built from the working tree (`source` is "working-tree"), with
 * entries made the way a publish makes them (publishedScriptEntry.ts). A file
 * that does not parse, or whose name is not its `lesson.slug`, is one warning
 * in the terminal and is left out: the dev server never fails because of
 * another session's half-written lesson.
 */

/** What one script's bytes gave: its entry and its slug, or why it has none. */
type Parsed = { entry: PublishedScriptEntry; slug: string } | { problem: string };

interface Snapshot {
  indexText: string;
  /** The bytes of every script in the index, by id: the only objects served. */
  objects: Map<string, Uint8Array>;
}

interface Warn {
  (message: string): void;
}

export interface LessonScriptsMiddleware {
  (request: IncomingMessage, response: ServerResponse, next: () => void): void;
  /** Build the index again before it is next asked for. */
  invalidate(): void;
}

const INDEX_CACHE_CONTROL = "no-cache";
const OBJECT_CACHE_CONTROL = "public, max-age=31536000, immutable";

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");
}

/**
 * The middleware, reading the scripts in `dir`. Every rebuild hashes every
 * file, which is quick; a file is parsed only when its bytes were not seen
 * before, which is what is slow.
 */
export function createLessonScriptsMiddleware(
  dir: string,
  warn: Warn,
  /** When given, the folder is watched from the first request on, and each change rebuilds the index. */
  watching?: (watcher: FSWatcher) => void,
): LessonScriptsMiddleware {
  const parsedById = new Map<string, Parsed>();
  let snapshot: Promise<Snapshot> | null = null;

  // Each file name and content warned about, so a rebuild repeats no warning.
  const warned = new Set<string>();

  async function build(): Promise<Snapshot> {
    // Loaded on first use, so the config every `vp` command loads does not
    // load the lesson schema too.
    const { lessonFileNameProblem, lessonSlugOfFileName, publishedScriptFileOf } =
      await import("../src/studio/plans/publishedScriptEntry");
    const lessons = Object.create(null) as Record<string, PublishedScriptEntry>;
    const objects = new Map<string, Uint8Array>();
    const names = readdirSync(dir)
      .filter((name) => name.endsWith(".yaml"))
      .sort();
    for (const name of names) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(join(dir, name)));
      } catch {
        // Removed or renamed since the folder was listed: the watcher rebuilds again.
        continue;
      }
      const id = createHash("sha256").update(bytes).digest("hex");
      let parsed = parsedById.get(id);
      if (!parsed) {
        parsed = await publishedScriptFileOf(bytes).then(
          ({ entry, script }): Parsed => ({ entry, slug: script.lesson.slug }),
          (error: unknown): Parsed => ({ problem: oneLine(error) }),
        );
        parsedById.set(id, parsed);
      }
      const problem =
        "problem" in parsed ? parsed.problem : lessonFileNameProblem(name, parsed.slug);
      if ("problem" in parsed || problem !== null) {
        if (!warned.has(`${name}\0${id}`)) {
          warned.add(`${name}\0${id}`);
          warn(`lesson scripts: ${name} is left out: ${problem}`);
        }
        continue;
      }
      lessons[lessonSlugOfFileName(name)!] = parsed.entry;
      objects.set(id, bytes);
    }
    const indexText = encodePublishedScriptIndex({
      version: PUBLISHED_SCRIPT_INDEX_VERSION,
      source: WORKING_TREE_SOURCE,
      lessons,
    });
    return { indexText, objects };
  }

  let watched = false;
  function watchFolder(): void {
    if (!watching || watched) return;
    watched = true;
    // The folder itself is watched, not through Vite's watcher, which sees
    // only the project: with LESSONS_DIR it can be elsewhere, and the preview
    // server has no watcher. Started on the first request, so a server that
    // never serves the studio (the test runner's) watches nothing, and
    // unref'd, so it never keeps a process alive.
    try {
      const watcher = watch(dir, () => middleware.invalidate());
      watcher.unref();
      watching(watcher);
    } catch (error) {
      warn(`lesson scripts: ${dir} is not watched, so a change needs a restart: ${oneLine(error)}`);
    }
  }

  function current(): Promise<Snapshot> {
    watchFolder();
    if (!snapshot) {
      const promise = build();
      snapshot = promise;
      // A failed build (the folder is gone, say) is tried again on the next request.
      promise.catch(() => {
        if (snapshot === promise) snapshot = null;
      });
    }
    return snapshot;
  }

  function send(
    response: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: string | Uint8Array,
    head: boolean,
  ): void {
    response.writeHead(status, headers);
    response.end(head ? undefined : body);
  }

  function notFound(response: ServerResponse, head: boolean): void {
    send(
      response,
      404,
      { "content-type": "application/json", "cache-control": "no-store" },
      JSON.stringify({ error: "not found" }),
      head,
    );
  }

  const middleware = ((request, response, next) => {
    const pathname = new URL(request.url ?? "/", "http://dev").pathname;
    if (pathname !== PUBLISHED_SCRIPTS_PATH && !pathname.startsWith(`${PUBLISHED_SCRIPTS_PATH}/`)) {
      next();
      return;
    }
    const head = request.method === "HEAD";
    // Everything under the prefix is answered here, so nothing reaches the
    // /api/studio proxy and a wrong path is a 404, as on the Worker.
    if (request.method !== "GET" && !head) {
      notFound(response, head);
      return;
    }
    current()
      .then(({ indexText, objects }) => {
        if (pathname === PUBLISHED_SCRIPT_INDEX_PATH) {
          send(
            response,
            200,
            {
              "content-type": PUBLISHED_SCRIPT_INDEX_CONTENT_TYPE,
              "cache-control": INDEX_CACHE_CONTROL,
            },
            indexText,
            head,
          );
          return;
        }
        // The id is looked up, never joined onto a path: only bytes this
        // index holds are served.
        const id = publishedScriptIdOfPath(pathname);
        const bytes = id === null ? undefined : objects.get(id);
        if (!bytes) {
          notFound(response, head);
          return;
        }
        send(
          response,
          200,
          {
            "content-type": PUBLISHED_SCRIPT_CONTENT_TYPE,
            "cache-control": OBJECT_CACHE_CONTROL,
            "x-content-type-options": "nosniff",
          },
          bytes,
          head,
        );
      })
      .catch((error: unknown) => {
        warn(`lesson scripts: the index could not be built: ${oneLine(error)}`);
        send(
          response,
          500,
          { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          `the lesson index could not be built: ${oneLine(error)}`,
          head,
        );
      });
  }) as LessonScriptsMiddleware;

  middleware.invalidate = () => {
    snapshot = null;
  };
  return middleware;
}

/**
 * Registers the middleware on the dev server and the preview server. Both add
 * it directly in their configure hook, so it runs before their proxies, which
 * would otherwise send /api/studio to the Worker on :8787.
 */
export function lessonScriptsDevPlugin(): Plugin {
  const watchers = new Set<FSWatcher>();

  function middlewareFor(warn: Warn): LessonScriptsMiddleware {
    return createLessonScriptsMiddleware(lessonScriptsDir(), warn, (watcher) =>
      watchers.add(watcher),
    );
  }
  const closeAll = () => {
    for (const watcher of watchers) watcher.close();
    watchers.clear();
  };

  return {
    name: "next-editor:lesson-scripts-dev",
    configureServer(server) {
      server.middlewares.use(middlewareFor((message) => server.config.logger.warn(message)));
      server.httpServer?.on("close", closeAll);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middlewareFor((message) => server.config.logger.warn(message)));
      server.httpServer.on("close", closeAll);
    },
  };
}
