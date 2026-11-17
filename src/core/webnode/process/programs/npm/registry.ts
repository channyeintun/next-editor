// The npm registry client: abbreviated packuments (memory-cached, in-flight
// de-duplicated, about 16 at once) and tarballs (about 8 at once, kept in the
// Cache Storage when the browser has it). It takes its `fetch` and cache as
// arguments, so tests run it against an in-memory registry.
import { PmError } from "./errors";

/** One version of a package as the abbreviated packument describes it. */
export interface PackageVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: string | Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

/** The abbreviated packument (`application/vnd.npm.install-v1+json`). */
export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackageVersion>;
}

/** The subset of `fetch` the client uses. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The subset of a Cache Storage `Cache` the client uses. */
export interface TarballCache {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

/** A downloaded tarball and whether it came from the cache. */
export interface TarballFetch {
  bytes: Uint8Array;
  cached: boolean;
}

export interface RegistryClient {
  /** The registry base URL, without a trailing slash. */
  readonly registry: string;
  /** The packument for `name`; throws `PmError("E404")` when there is none. */
  packument(name: string): Promise<Packument>;
  /** Starts fetching a packument without waiting for it (errors surface on the real request). */
  prefetch(name: string): void;
  /** True once the full packument for `name` has been requested. */
  hasPackument(name: string): boolean;
  /**
   * One version's document (`/<name>/<version-or-tag>`, a few KB where a
   * packument can be megabytes), or null when the registry has no such version.
   */
  version(name: string, versionOrTag: string): Promise<PackageVersion | null>;
  /**
   * The tarball at `url`, from the cache when it holds it and
   * `options.cache` is not false. The cache is shared by every runtime session
   * in the browser, so the caller verifies cached bytes like downloaded ones.
   */
  tarball(url: string, options?: { cache?: boolean }): Promise<TarballFetch>;
  /** Stores verified tarball bytes in the cache. */
  remember(url: string, bytes: Uint8Array): Promise<void>;
  /** Drops a cached tarball (it failed verification). */
  forget(url: string): Promise<void>;
}

export interface RegistryOptions {
  fetch: FetchLike;
  /** Base URL, e.g. `https://registry.npmjs.org`. */
  registry: string;
  cache?: TarballCache | null;
  packumentConcurrency?: number;
  tarballConcurrency?: number;
  /** Extra attempts after a failed request (network error or 5xx). */
  retries?: number;
  /** The wait before the first retry, in milliseconds; it doubles for each one after. */
  retryDelayMs?: number;
  /** How long a packument or version request may wait for headers or the next bytes (ms). */
  packumentTimeoutMs?: number;
  /** The same for a tarball (ms). */
  tarballTimeoutMs?: number;
}

/**
 * Long enough for a dropped connection or a busy registry to pass, which an
 * immediate retry mostly meets again; short enough not to be noticed in an
 * install of hundreds of requests.
 */
const RETRY_DELAY_MS = 300;

/**
 * A stalled connection otherwise leaves an install waiting forever. The clock
 * restarts whenever bytes arrive, so a large tarball on a slow link is not cut
 * off. The waits are long on purpose: an install opens two dozen requests at
 * once, and on a slow link one of them can get nothing for a long while
 * although the link is alive (30 s here failed installs that would have
 * finished). pnpm waits 60 s for a request and npm 5 minutes.
 */
const PACKUMENT_TIMEOUT_MS = 120_000;
const TARBALL_TIMEOUT_MS = 300_000;

/** The registry used when the environment names none. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** The name of the Cache Storage cache that keeps tarballs. */
export const TARBALL_CACHE_NAME = "webnode-npm-tarballs-v1";

/** The registry URL for `name` (`@scope/name` → `@scope%2Fname`). */
export function packumentUrl(registry: string, name: string): string {
  return `${registry}/${name.replace("/", "%2F")}`;
}

/** Runs at most `limit` tasks at a time, in the order they were queued. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit) {
      return;
    }
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Creates a registry client. */
export function createRegistryClient(options: RegistryOptions): RegistryClient {
  const registry = options.registry.replace(/\/+$/, "");
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const packumentLimit = createLimiter(options.packumentConcurrency ?? 16);
  const tarballLimit = createLimiter(options.tarballConcurrency ?? 8);
  const packuments = new Map<string, Promise<Packument>>();
  const versions = new Map<string, Promise<PackageVersion | null>>();
  const cache = options.cache ?? null;

  const packumentTimeoutMs = options.packumentTimeoutMs ?? PACKUMENT_TIMEOUT_MS;
  const tarballTimeoutMs = options.tarballTimeoutMs ?? TARBALL_TIMEOUT_MS;

  /**
   * GETs `url` and reads its whole body. One attempt is the request and the
   * body together, so a connection that drops mid-body is retried like one
   * that fails outright.
   */
  async function request(
    url: string,
    init: RequestInit,
    what: string,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0 && retryDelayMs > 0) {
        const delay = retryDelayMs * 2 ** (attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const restartTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), timeoutMs);
      };
      restartTimer();
      try {
        const response = await options.fetch(url, { ...init, signal: controller.signal });
        if (response.status === 404) {
          throw new PmError("E404", `GET ${url}: Not Found - 404`, [
            `${what} is not in this registry.`,
          ]);
        }
        if (response.ok) {
          return await readBody(response, restartTimer, controller.signal);
        }
        lastError = new PmError(
          "EFETCH",
          `GET ${url}: ${response.statusText || "Error"} - ${response.status}`,
        );
        if (response.status < 500 && response.status !== 429) {
          break;
        }
      } catch (error) {
        if (error instanceof PmError && error.code === "E404") {
          throw error;
        }
        lastError = controller.signal.aborted
          ? new PmError("EFETCH", `GET ${url}: timed out after ${timeoutMs / 1000} s`)
          : error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof PmError) {
      throw lastError;
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new PmError("EFETCH", `GET ${url}: request failed (${reason})`);
  }

  function packument(name: string): Promise<Packument> {
    let pending = packuments.get(name);
    if (!pending) {
      const url = packumentUrl(registry, name);
      pending = packumentLimit(async () => {
        const body = await request(
          url,
          {
            headers: {
              accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
            },
          },
          `'${name}'`,
          packumentTimeoutMs,
        );
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(body));
        } catch {
          throw new PmError("EJSONPARSE", `Invalid packument for ${name} from ${url}`);
        }
        const document = parsed as Partial<Packument>;
        return {
          name: typeof document.name === "string" ? document.name : name,
          "dist-tags": document["dist-tags"] ?? {},
          versions: document.versions ?? {},
        };
      });
      packuments.set(name, pending);
    }
    return pending;
  }

  function version(name: string, versionOrTag: string): Promise<PackageVersion | null> {
    const memo = `${name}@${versionOrTag}`;
    let pending = versions.get(memo);
    if (!pending) {
      const url = `${packumentUrl(registry, name)}/${encodeURIComponent(versionOrTag)}`;
      pending = packumentLimit(async () => {
        let body: Uint8Array;
        try {
          body = await request(
            url,
            { headers: { accept: "application/json" } },
            `'${name}@${versionOrTag}'`,
            packumentTimeoutMs,
          );
        } catch (error) {
          if (error instanceof PmError && error.code === "E404") {
            return null;
          }
          throw error;
        }
        let document: Partial<PackageVersion>;
        try {
          document = JSON.parse(new TextDecoder().decode(body)) as Partial<PackageVersion>;
        } catch {
          throw new PmError("EJSONPARSE", `Invalid version document for ${memo} from ${url}`);
        }
        if (typeof document.version !== "string" || !document.dist?.tarball) {
          return null;
        }
        return pickVersionFields(document as PackageVersion);
      });
      versions.set(memo, pending);
    }
    return pending;
  }

  return {
    registry,
    packument,
    version,
    hasPackument: (name) => packuments.has(name),
    prefetch(name) {
      packument(name).catch(() => {});
    },
    tarball(url, tarballOptions) {
      return tarballLimit(async () => {
        if (cache && tarballOptions?.cache !== false) {
          try {
            const hit = await cache.match(url);
            if (hit) {
              return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
            }
          } catch {
            // A broken cache is not fatal; fall through to the network.
          }
        }
        const bytes = await request(url, {}, `The tarball ${url}`, tarballTimeoutMs);
        return { bytes, cached: false };
      });
    },
    async remember(url, bytes) {
      if (!cache) {
        return;
      }
      try {
        await cache.put(url, new Response(bytes.slice().buffer));
      } catch {
        // Quota or a private window: caching is best effort.
      }
    },
    async forget(url) {
      if (!cache) {
        return;
      }
      try {
        await cache.delete(url);
      } catch {
        // Best effort, as above.
      }
    },
  };
}

/**
 * Reads a response body, calling `progress` for each chunk (which restarts the
 * request's timeout). An aborted `signal` ends the read even when the body
 * stream does not notice the abort itself.
 */
async function readBody(
  response: Response,
  progress: () => void,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason);
    if (signal.aborted) {
      fail();
    }
    signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        break;
      }
      chunks.push(value);
      length += value.length;
      progress();
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** The fields the installer reads, from a full version document. */
export function pickVersionFields(document: PackageVersion): PackageVersion {
  const picked: PackageVersion = {
    name: document.name,
    version: document.version,
    dist: document.dist,
  };
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bin",
    "os",
    "cpu",
    "libc",
    "deprecated",
    "hasInstallScript",
  ] as const) {
    if (document[field] !== undefined) {
      (picked as unknown as Record<string, unknown>)[field] = document[field];
    }
  }
  return picked;
}

/** Opens the tarball cache when the environment has Cache Storage, else null. */
export async function openTarballCache(): Promise<TarballCache | null> {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (!storage) {
    return null;
  }
  try {
    const cache = await storage.open(TARBALL_CACHE_NAME);
    return {
      match: (url) => cache.match(url),
      put: (url, response) => cache.put(url, response),
      delete: (url) => cache.delete(url),
    };
  } catch {
    return null;
  }
}
