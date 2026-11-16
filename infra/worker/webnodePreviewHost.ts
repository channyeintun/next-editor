import { BUILD_PARAMETER } from "../../src/core/webnode/buildId";
import {
  webnodeHostAsset,
  webnodeHostResponse,
} from "../../src/core/webnode/preview/hostResponses";
import { isSeparateSite, isWebnodeHostname } from "../../src/core/webnode/preview/origin";
import type { Env } from "./env";

/** Where the build puts the runtime's scripts (build/webnodeBundlePlugin.ts). */
const ASSET_DIRECTORY = "/webnode/";
/** The file there that names the build (WEBNODE_BUILD_MANIFEST in build/webnodeBundle.ts). */
const BUILD_MANIFEST = "build.json";

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Whether `hostname` is one of this deployment's webnode hosts: the runtime
 * host `runtime.<WEBNODE_PREVIEW_HOST>` or a preview host
 * `<session>-<port>.<WEBNODE_PREVIEW_HOST>`. Without the variable there are
 * none, and there are none either when the variable names a host on the
 * editor's own site: lesson code must run on another registrable domain
 * (isSeparateSite in src/core/webnode/preview/origin.ts says why).
 */
export function isWebnodeHost(
  hostname: string,
  env: Pick<Env, "WEBNODE_PREVIEW_HOST" | "PUBLIC_URL">,
): boolean {
  const base = env.WEBNODE_PREVIEW_HOST?.trim();
  const editor = hostnameOf(env.PUBLIC_URL);
  if (!base || !editor || !isSeparateSite(editor, base)) {
    return false;
  }
  return isWebnodeHostname(hostname, base);
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
  env: Pick<Env, "ASSETS" | "PUBLIC_URL">,
): Promise<Response> {
  const url = new URL(request.url);
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
  });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}
