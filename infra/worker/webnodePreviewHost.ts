import { BUILD_PARAMETER } from "../../src/core/webnode/buildId";
import {
  DEPS_OBJECT_HEADERS,
  DEPS_OBJECT_REFUSAL_HEADERS,
  depsObjectKey,
} from "../../src/core/webnode/depsObjects";
import {
  depsObjectRequest,
  webnodeHostAsset,
  webnodeHostResponse,
} from "../../src/core/webnode/preview/hostResponses";
import { isWebnodeHostname } from "../../src/core/webnode/preview/origin";
import type { Env } from "./env";
import { acceptsBrotli } from "./staticAssets";

/** Where the build puts the runtime's scripts (build/webnodeBundlePlugin.ts). */
const ASSET_DIRECTORY = "/webnode/";
/** The file there that names the build (WEBNODE_BUILD_MANIFEST in build/webnodeBundle.ts). */
const BUILD_MANIFEST = "build.json";

/**
 * Whether `hostname` is one of this deployment's webnode hosts: the runtime
 * host `runtime.<WEBNODE_PREVIEW_HOST>` or a preview host
 * `<session>-<port>.<WEBNODE_PREVIEW_HOST>`. Without the variable there are none.
 */
export function isWebnodeHost(hostname: string, env: Pick<Env, "WEBNODE_PREVIEW_HOST">): boolean {
  const base = webnodeBase(env);
  return base ? isWebnodeHostname(hostname, base) : false;
}

function webnodeBase(env: Pick<Env, "WEBNODE_PREVIEW_HOST">): string {
  return env.WEBNODE_PREVIEW_HOST?.trim() ?? "";
}

function refuseDepsObject(status: 404 | 405): Response {
  return new Response(null, { status, headers: DEPS_OBJECT_REFUSAL_HEADERS });
}

/**
 * A prepared install object from the bucket. It is stored Brotli-compressed
 * and only ever sent that way: the installer checks the decoded bytes against
 * the id, so a browser that cannot decode them gets nothing rather than bytes
 * that would fail. The whole object always: no Range or conditional request
 * reaches the bucket, and the answer carries none of the stored metadata.
 */
async function serveDepsObject(
  request: Request,
  id: string,
  bucket: R2Bucket | undefined,
): Promise<Response> {
  if (!acceptsBrotli(request) || !bucket) {
    return refuseDepsObject(404);
  }
  const stored = await bucket.get(depsObjectKey(id));
  if (!stored) {
    return refuseDepsObject(404);
  }
  return new Response(stored.body, {
    status: 200,
    headers: { ...DEPS_OBJECT_HEADERS, "content-length": String(stored.size) },
    // The stored bytes are already Brotli: sent as they are, not compressed again.
    encodeBody: "manual",
  });
}

/**
 * The id of the build whose scripts an ASSETS binding holds. The binding is one
 * object for the life of an isolate, which is one deployment, so an answer is
 * kept: the id, or null for a deployment whose build wrote no manifest. A read
 * that failed is not an answer and is tried again by the next request, since
 * without the id no request for another build can be refused.
 */
const servedBuilds = new WeakMap<Fetcher, Promise<string | null>>();

function readServedBuild(assets: Fetcher, base: URL): Promise<string | null> {
  const known = servedBuilds.get(assets);
  if (known) {
    return known;
  }
  const forget = () => {
    if (servedBuilds.get(assets) === build) {
      servedBuilds.delete(assets);
    }
    return null;
  };
  const build: Promise<string | null> = assets
    .fetch(new Request(new URL(`${ASSET_DIRECTORY}${BUILD_MANIFEST}`, base)))
    .then(async (stored) => {
      if (!stored.ok) {
        return forget();
      }
      // A missing file comes back as the app shell: only JSON is the manifest.
      if (!stored.headers.get("content-type")?.includes("json")) {
        return null;
      }
      const id = ((await stored.json()) as { id?: unknown }).id;
      return typeof id === "string" && id ? id : null;
    })
    .catch(forget);
  servedBuilds.set(assets, build);
  return build;
}

/**
 * Answers a request to a webnode host. These hosts run lesson code, so they
 * serve only the runtime's own scripts and pages, which the editor alone may
 * frame: no app asset, API route or cookie is ever reachable on them.
 */
export async function serveWebnodeHost(
  request: Request,
  env: Pick<Env, "ASSETS" | "PUBLIC_URL" | "WEBNODE_PREVIEW_HOST"> & Partial<Pick<Env, "BUCKET">>,
): Promise<Response> {
  const url = new URL(request.url);
  // Decided before anything else, so a path under the objects' prefix never
  // gets the document fallback or a script's answer.
  const deps = depsObjectRequest(
    {
      method: request.method,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    },
    webnodeBase(env),
  );
  if (deps) {
    return deps.status === 200
      ? serveDepsObject(request, deps.id, env.BUCKET)
      : refuseDepsObject(deps.status);
  }
  const asset = webnodeHostAsset(url.pathname);
  const requestedBuild = url.searchParams.get(BUILD_PARAMETER);
  const currentBuild = await readServedBuild(env.ASSETS, url);
  let assetSource: string | null = null;
  // A request for another build is refused whatever the file holds.
  if (
    asset &&
    (requestedBuild === null || currentBuild === null || requestedBuild === currentBuild)
  ) {
    const stored = await env.ASSETS.fetch(new Request(new URL(`${ASSET_DIRECTORY}${asset}`, url)));
    // A missing file comes back as the app shell: only JavaScript is the script.
    const isScript = stored.headers.get("content-type")?.includes("javascript") ?? false;
    assetSource = stored.ok && isScript ? await stored.text() : null;
  }
  const answer = webnodeHostResponse(url.pathname, {
    editorOrigin: new URL(env.PUBLIC_URL).origin,
    assetSource,
    requestedBuild,
    currentBuild,
    method: request.method,
    requestOrigin: request.headers.get("origin"),
    destination: request.headers.get("sec-fetch-dest"),
  });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}
