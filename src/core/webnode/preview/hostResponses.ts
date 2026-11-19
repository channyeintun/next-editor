// What the real server in front of the runtime's hosts answers (a Vite dev
// middleware and a Cloudflare Worker serve these). Those hosts carry nothing of
// the app: a preview host gets the connect page and its service worker, the
// runtime host gets the frame that runs the kernel and its worker scripts.
import { STALE_BUILD_MESSAGE, versionedPath } from "../buildId";
import { createPreviewConnectHtml, EDITOR_ORIGIN_GLOBAL } from "./connectPage";
import { PREVIEW_SERVICE_WORKER_PATH } from "./protocol";

/** A response for the host to send as is. */
export interface WebnodeHostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The scripts a runtime host serves, by the file name the build gives them. */
export type WebnodeHostAsset =
  | "preview-sw.js"
  | "runtime.js"
  | "kernel.js"
  | "process.js"
  | "prepare.js";

/** The page that runs the kernel, on the runtime origin. */
export const RUNTIME_FRAME_PATH = "/__webnode__/runtime.html";

const ASSET_PATHS: Record<string, WebnodeHostAsset> = {
  [PREVIEW_SERVICE_WORKER_PATH]: "preview-sw.js",
  "/__webnode__/runtime.js": "runtime.js",
  "/__webnode__/kernel.js": "kernel.js",
  "/__webnode__/process.js": "process.js",
  "/__webnode__/prepare.js": "prepare.js",
};

const ISOLATION_HEADERS = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
};

/** `value` as JSON that is safe inside an inline script. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The script `pathname` names on a runtime host, or null when it names a page. */
export function webnodeHostAsset(pathname: string): WebnodeHostAsset | null {
  return ASSET_PATHS[pathname] ?? null;
}

export interface WebnodeHostOptions {
  /** The origin of the editor: the only site allowed to frame these hosts. */
  editorOrigin: string;
  /** The source of the script `webnodeHostAsset(pathname)` named, when it named one. */
  assetSource: string | null;
  /** The build the request named (its `v` parameter, buildId.ts), or null when it named none. */
  requestedBuild?: string | null;
  /** The build this host serves, or null when it does not know. */
  currentBuild?: string | null;
  /** The request's method; GET when not given. */
  method?: string;
  /** The request's `Origin` header, or null when it sent none. */
  requestOrigin?: string | null;
  /** The request's `Sec-Fetch-Dest`, or null when it sent none (then any path may be a page). */
  destination?: string | null;
}

/** The scripts that are the same bytes for every request of one build, so a browser may keep them. */
const IMMUTABLE_ASSETS = new Set<WebnodeHostAsset>(["kernel.js", "process.js", "prepare.js"]);

export { STALE_BUILD_MESSAGE };

/**
 * Where the editor asks a preview origin it has given up to drop what its
 * pages stored (api.ts): the answer carries `Clear-Site-Data: "storage"`.
 */
export const PREVIEW_CLEAR_PATH = "/__webnode__/clear";

/**
 * The request destinations that load a document. A page path asked for as
 * anything else (a page's own service worker script, an `importScripts`) is
 * not the connect page: it gets a 404, which a browser refuses plainly instead
 * of failing on an HTML "script".
 */
const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object"]);

/**
 * The host's answer for a request to `pathname` on a preview or runtime host.
 * Every document it serves can be framed by the editor only, and the scripts
 * that take a connection from a parent window are told who that parent is.
 */
export function webnodeHostResponse(
  pathname: string,
  options: WebnodeHostOptions,
): WebnodeHostResponse {
  const asset = webnodeHostAsset(pathname);
  const requestedBuild = options.requestedBuild ?? null;
  const currentBuild = options.currentBuild ?? null;
  // An editor, kernel or frame from before a deploy asks for its own build.
  // Answering with this one would run two builds against each other.
  const isStale =
    requestedBuild !== null && currentBuild !== null && requestedBuild !== currentBuild;
  if (asset) {
    if (isStale) {
      return {
        status: 409,
        headers: { "cache-control": "no-store", ...ISOLATION_HEADERS },
        body: "",
      };
    }
    if (options.assetSource === null) {
      return {
        status: 404,
        headers: { "cache-control": "no-store", ...ISOLATION_HEADERS },
        body: "",
      };
    }
    const knowsEditor = asset === "preview-sw.js" || asset === "runtime.js";
    return {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        // A process starts by loading process.js, so a named build is kept for good.
        "cache-control":
          requestedBuild !== null && requestedBuild === currentBuild && IMMUTABLE_ASSETS.has(asset)
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        ...(asset === "preview-sw.js" ? { "service-worker-allowed": "/" } : {}),
        ...ISOLATION_HEADERS,
      },
      body: knowsEditor
        ? `self.${EDITOR_ORIGIN_GLOBAL} = ${JSON.stringify(options.editorOrigin)};\n${options.assetSource}`
        : options.assetSource,
    };
  }

  if (pathname === PREVIEW_CLEAR_PATH) {
    // Only the editor may clear a preview origin. "cookies" would clear the
    // whole site's, the editor's sign-in included, so only storage is named.
    const allowed =
      (options.method ?? "GET").toUpperCase() === "POST" &&
      options.requestOrigin === options.editorOrigin;
    return {
      status: allowed ? 200 : 403,
      headers: {
        "cache-control": "no-store",
        ...(allowed ? { "clear-site-data": '"storage"' } : {}),
        ...ISOLATION_HEADERS,
      },
      body: "",
    };
  }

  const destination = options.destination?.trim().toLowerCase() ?? null;
  if (destination !== null && destination !== "" && !DOCUMENT_DESTINATIONS.has(destination)) {
    return {
      status: 404,
      headers: { "cache-control": "no-store", ...ISOLATION_HEADERS },
      body: "",
    };
  }

  const documentHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${options.editorOrigin}`,
    // These pages may share a site with the editor (a subdomain of it): ask
    // the browser to keep this origin apart from every other, the editor's
    // included, which it may honour with a process of its own.
    "origin-agent-cluster": "?1",
    ...ISOLATION_HEADERS,
  };
  if (pathname === RUNTIME_FRAME_PATH) {
    const head = '<!doctype html><meta charset="utf-8"><title>webnode runtime</title>';
    if (isStale) {
      const error = { type: "webnode:runtime-error", message: STALE_BUILD_MESSAGE };
      return {
        status: 200,
        headers: documentHeaders,
        body: `${head}<script>parent.postMessage(${inlineJson(error)}, ${inlineJson(options.editorOrigin)})</script>`,
      };
    }
    const script = versionedPath("/__webnode__/runtime.js", requestedBuild ?? "");
    return {
      status: 200,
      headers: documentHeaders,
      body: `${head}<script src="${script.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script>`,
    };
  }
  return {
    status: 200,
    headers: documentHeaders,
    body: createPreviewConnectHtml(options.editorOrigin),
  };
}
