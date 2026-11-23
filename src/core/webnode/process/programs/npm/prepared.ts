// Prepared installs, a process's end: the plan the runtime's own index names
// for a manifest, and each package's archive (its tarball, already
// gunzipped), fetched from the runtime's own origin and kept in Cache Storage.
// Every object is checked against its id wherever it came from: code a lesson
// runs can write this origin's Cache Storage, and a planted object fails its
// check, is dropped and is fetched again. It takes its `fetch`, origin, index
// and cache as arguments, so tests run it in memory.
import { depsObjectPath, isDepsObjectId } from "../../../depsObjects";
import { decodePlan } from "./plan";
import type { DependencyPlan, PackageArchive } from "./plan";
import {
  DEFAULT_REGISTRY,
  TARBALL_CONCURRENCY,
  TARBALL_TIMEOUT_MS,
  createBodyRequest,
  createLimiter,
  openCache,
} from "./registry";
import type { FetchLike, RetryOptions, TarballCache, TarballFetch } from "./registry";

/** The Cache Storage cache that keeps objects, decoded, by their URL. */
export const DEPS_OBJECT_CACHE_NAME = "webnode-deps-objects-v1";

/** What an install reads in place of the registry. */
export interface PreparedInstalls {
  /**
   * The plan for the manifest `manifestHash`, checked; null when the index
   * has no row for it, or the plan could not be had or failed a check.
   */
  plan(manifestHash: string): Promise<DependencyPlan | null>;
  /**
   * A package's tar, checked against its id, and whether it came from Cache
   * Storage; null when it could not be had (the package then comes from the
   * registry).
   */
  archive(archive: PackageArchive): Promise<TarballFetch | null>;
  /** Resolves once every object fetched so far is stored: a process may end right after. */
  stored(): Promise<void>;
}

export interface PreparedOptions extends RetryOptions {
  fetch: FetchLike;
  /** The origin the objects are served from: the runtime's own. */
  origin: string;
  /** Manifest hash → the id of its plan (plans.generated.ts). */
  index: Readonly<Record<string, string>>;
  cache?: TarballCache | null;
  /** How many objects are fetched at once. */
  concurrency?: number;
  /** How long a request may wait for headers or the next bytes (ms). */
  timeoutMs?: number;
}

/**
 * Whether an install may use prepared objects: the process has an http(s)
 * origin to fetch them from, the registry is the one the plans were made
 * from, and the environment does not switch them off (`WEBNODE_DEPS=0`, for
 * measuring and diagnosing: then no object is asked for at all).
 */
export function preparedInstallsWanted(environment: {
  origin: string | undefined;
  registry: string;
  env: Record<string, string>;
}): boolean {
  return (
    /^https?:\/\//.test(environment.origin ?? "") &&
    environment.registry === DEFAULT_REGISTRY &&
    environment.env.WEBNODE_DEPS !== "0"
  );
}

/** The id an object with these decoded bytes has: the lowercase hex SHA-256. */
export async function depsObjectIdOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Opens the object cache when the environment has Cache Storage, else null. */
export function openDepsObjectCache(): Promise<TarballCache | null> {
  return openCache(DEPS_OBJECT_CACHE_NAME);
}

/** Creates the prepared installs a process reads. */
export function createPreparedInstalls(options: PreparedOptions): PreparedInstalls {
  const origin = options.origin.replace(/\/+$/, "");
  const request = createBodyRequest((url, init) => options.fetch(url, init), options);
  const limit = createLimiter(options.concurrency ?? TARBALL_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? TARBALL_TIMEOUT_MS;
  const cache = options.cache ?? null;
  const storing: Promise<void>[] = [];

  const fromCache = async (url: string, id: string): Promise<Uint8Array | null> => {
    if (!cache) {
      return null;
    }
    try {
      const hit = await cache.match(url);
      if (!hit) {
        return null;
      }
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if ((await depsObjectIdOf(bytes)) === id) {
        return bytes;
      }
      await cache.delete(url);
    } catch {
      // A broken cache is not fatal; the network is asked.
    }
    return null;
  };

  const fromNetwork = async (url: string, id: string): Promise<Uint8Array | null> => {
    let bytes: Uint8Array;
    try {
      bytes = await request(
        url,
        { cache: "no-store", credentials: "omit" },
        `The object ${id}`,
        timeoutMs,
      );
    } catch {
      return null;
    }
    if ((await depsObjectIdOf(bytes)) !== id) {
      return null;
    }
    if (cache) {
      storing.push(
        cache.put(url, new Response(bytes.slice().buffer)).catch(() => {
          // Quota or a private window: keeping objects is best effort.
        }),
      );
    }
    return bytes;
  };

  const object = (id: string): Promise<TarballFetch | null> =>
    limit(async () => {
      if (!isDepsObjectId(id)) {
        return null;
      }
      const url = `${origin}${depsObjectPath(id)}`;
      const cached = await fromCache(url, id);
      if (cached) {
        return { bytes: cached, cached: true };
      }
      const fetched = await fromNetwork(url, id);
      return fetched ? { bytes: fetched, cached: false } : null;
    });

  return {
    async plan(manifestHash) {
      if (!Object.hasOwn(options.index, manifestHash)) {
        return null;
      }
      const found = await object(options.index[manifestHash]);
      return found ? decodePlan(found.bytes, manifestHash) : null;
    },
    archive: (archive) => object(archive.id),
    async stored() {
      await Promise.all(storing);
    },
  };
}
