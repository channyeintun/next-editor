import {
  webnodeHostAsset,
  webnodeHostResponse,
} from "../../src/core/webnode/preview/hostResponses";
import { isWebnodeHostname } from "../../src/core/webnode/preview/origin";
import type { Env } from "./env";

/** Where the build puts the runtime's scripts (build/webnodeBundlePlugin.ts). */
const ASSET_DIRECTORY = "/webnode/";

/**
 * Whether `hostname` is one of this deployment's webnode hosts: the runtime
 * host `runtime.<WEBNODE_PREVIEW_HOST>` or a preview host
 * `<session>-<port>.<WEBNODE_PREVIEW_HOST>`. Without the variable there are none.
 */
export function isWebnodeHost(hostname: string, env: Pick<Env, "WEBNODE_PREVIEW_HOST">): boolean {
  const base = env.WEBNODE_PREVIEW_HOST?.trim();
  return base ? isWebnodeHostname(hostname, base) : false;
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
  let assetSource: string | null = null;
  if (asset) {
    const stored = await env.ASSETS.fetch(new Request(new URL(`${ASSET_DIRECTORY}${asset}`, url)));
    // A missing file comes back as the app shell: only JavaScript is the script.
    const isScript = stored.headers.get("content-type")?.includes("javascript") ?? false;
    assetSource = stored.ok && isScript ? await stored.text() : null;
  }
  const answer = webnodeHostResponse(url.pathname, {
    editorOrigin: new URL(env.PUBLIC_URL).origin,
    assetSource,
  });
  return new Response(answer.body, { status: answer.status, headers: answer.headers });
}
