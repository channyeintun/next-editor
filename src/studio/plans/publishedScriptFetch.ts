import { sha256Hex } from "../../shared/sha256Hex";
import {
  PUBLISHED_SCRIPT_INDEX_PATH,
  parsePublishedScriptIndex,
  publishedScriptObjectPath,
  type PublishedScriptIndex,
} from "./publishedScripts";

/**
 * How the studio reads the published lesson scripts: the index once, and a
 * script's YAML by its id when a render or a narration pass needs it.
 *
 * Every answer is checked before it is believed. A path this site does not
 * route answers with the app's index.html and a 200, so the status alone
 * proves nothing: the content type must be the one the route sends, and a
 * script's bytes must hash to the id that named them.
 */

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** At most this many scripts are fetched at once: a course picked in the workflow is hundreds. */
export const MAX_SCRIPT_FETCHES = 6;

/** A script object the site does not have, or one whose bytes are not the ones its id names. */
export class PublishedScriptMissingError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`The published lesson object ${id} is missing`);
    this.name = "PublishedScriptMissingError";
    this.id = id;
  }
}

function contentTypeOf(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

/** The published index, checked and with a null-prototype `lessons` record. */
export async function fetchPublishedScriptIndex(
  signal?: AbortSignal,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<PublishedScriptIndex> {
  const response = await fetchImpl(PUBLISHED_SCRIPT_INDEX_PATH, { signal });
  if (response.status === 404) {
    throw new Error("No lessons are published on this site yet: publish the lessons first.");
  }
  if (!response.ok) {
    throw new Error(`The lesson index could not be read (HTTP ${response.status}).`);
  }
  if (!contentTypeOf(response).startsWith("application/json")) {
    throw new Error(
      `The lesson index could not be read: the site answered with ${contentTypeOf(response) || "no content type"}, not the index. The site's server may be older than this studio.`,
    );
  }
  return parsePublishedScriptIndex(await response.json());
}

/** A waiting room for fetch slots; a waiter whose signal aborts leaves it. */
function createLimiter(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };

  const acquire = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (running < limit) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const take = () => {
        signal.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const at = waiting.indexOf(take);
        if (at >= 0) waiting.splice(at, 1);
        reject(signal.reason);
      };
      waiting.push(take);
      signal.addEventListener("abort", leave, { once: true });
    });
  };

  return { acquire, release };
}

/** One shared fetch of a script, and how many callers still wait for it. */
interface PendingScript {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
}

/** A caller's wait for a shared fetch. Aborting it leaves the fetch to the others, and stops it once nobody waits. */
function waitFor(pending: PendingScript, signal: AbortSignal | undefined): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  // A caller without a signal never leaves, so it keeps the fetch alive.
  pending.waiters += 1;
  if (!signal) return pending.promise;
  return new Promise((resolve, reject) => {
    const leave = () => {
      pending.waiters -= 1;
      if (pending.waiters === 0) pending.controller.abort(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", leave, { once: true });
    pending.promise.then(
      (text) => {
        signal.removeEventListener("abort", leave);
        resolve(text);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", leave);
        reject(error);
      },
    );
  });
}

export interface PublishedScriptTexts {
  /** The YAML text of the script with this id. Throws PublishedScriptMissingError on a 404 or on bytes that do not match the id. */
  textOf(id: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Script texts by id. A text, once fetched, is kept for the life of the page:
 * an id names one content forever, and all of them together are the size the
 * bundled scripts used to be. Only the text is kept, never a parsed script,
 * so a caller parses what it needs when it needs it. Callers asking for one id
 * at the same time share one fetch, and a failed fetch is forgotten so the
 * next call tries again.
 */
export function createPublishedScriptTexts(
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): PublishedScriptTexts {
  const texts = new Map<string, string>();
  const pending = new Map<string, PendingScript>();
  const limiter = createLimiter(MAX_SCRIPT_FETCHES);

  const download = async (id: string, signal: AbortSignal): Promise<string> => {
    await limiter.acquire(signal);
    try {
      const response = await fetchImpl(publishedScriptObjectPath(id), { signal });
      if (response.status === 404) throw new PublishedScriptMissingError(id);
      if (!response.ok) {
        throw new Error(`The lesson script ${id} could not be read (HTTP ${response.status}).`);
      }
      if (!contentTypeOf(response).startsWith("text/plain")) {
        throw new Error(
          `The lesson script ${id} could not be read: the site answered with ${contentTypeOf(response) || "no content type"}, not a script. The site's server may be older than this studio.`,
        );
      }
      // The bytes as they came, not text decoded and encoded again: the id is
      // the hash of the file's bytes.
      const bytes = await response.arrayBuffer();
      if ((await sha256Hex(bytes)) !== id) throw new PublishedScriptMissingError(id);
      return new TextDecoder().decode(bytes);
    } finally {
      limiter.release();
    }
  };

  const textOf = (id: string, signal?: AbortSignal): Promise<string> => {
    const kept = texts.get(id);
    if (kept !== undefined) return Promise.resolve(kept);
    if (signal?.aborted) return Promise.reject(signal.reason);
    let shared = pending.get(id);
    if (!shared) {
      const controller = new AbortController();
      const promise = download(id, controller.signal);
      const entry: PendingScript = { promise, controller, waiters: 0 };
      shared = entry;
      pending.set(id, entry);
      promise.then(
        (text) => {
          texts.set(id, text);
          if (pending.get(id) === entry) pending.delete(id);
        },
        () => {
          if (pending.get(id) === entry) pending.delete(id);
        },
      );
    }
    return waitFor(shared, signal);
  };

  return { textOf };
}

/** What a published lesson's script is now: the id the index names and that id's text. */
export interface PublishedScriptText {
  id: string;
  text: string;
}

function missingObjectMessage(slug: string, id: string): string {
  return `The published lesson object for "${slug}" (${id}) is missing from this site. The lessons must be published again.`;
}

/**
 * The text of the published lesson `slug`, whose index entry named `id`. On a
 * missing or mismatched object the index is read again, once: a lesson
 * published again since this page loaded has a new id, and that one is
 * fetched. When the index still names the same object, it is gone.
 */
export async function loadPublishedScriptText(
  texts: PublishedScriptTexts,
  slug: string,
  id: string,
  refetchIndex: () => Promise<PublishedScriptIndex>,
  signal?: AbortSignal,
): Promise<PublishedScriptText> {
  try {
    return { id, text: await texts.textOf(id, signal) };
  } catch (error) {
    if (!(error instanceof PublishedScriptMissingError)) throw error;
  }
  const fresh = (await refetchIndex()).lessons[slug];
  if (!fresh) {
    throw new Error(
      `"${slug}" is no longer in this site's published lessons. Reload the studio, or publish the lessons again.`,
    );
  }
  if (fresh.id === id) throw new Error(missingObjectMessage(slug, id));
  try {
    return { id: fresh.id, text: await texts.textOf(fresh.id, signal) };
  } catch (error) {
    if (error instanceof PublishedScriptMissingError) {
      throw new Error(missingObjectMessage(slug, fresh.id));
    }
    throw error;
  }
}
