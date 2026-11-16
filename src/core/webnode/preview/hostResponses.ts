// What the real server in front of the runtime's hosts answers (a Vite dev
// middleware and a Cloudflare Worker serve these). Those hosts carry nothing of
// the app: a preview host gets the connect page and its service worker, the
// runtime host gets the frame that runs the kernel and its worker scripts.
import { createPreviewConnectHtml, EDITOR_ORIGIN_GLOBAL } from "./connectPage";
import { PREVIEW_SERVICE_WORKER_PATH } from "./protocol";

/** A response for the host to send as is. */
export interface WebnodeHostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The scripts a runtime host serves, by the file name the build gives them. */
export type WebnodeHostAsset = "preview-sw.js" | "runtime.js" | "kernel.js" | "process.js";

/** The page that runs the kernel, on the runtime origin. */
export const RUNTIME_FRAME_PATH = "/__webnode__/runtime.html";

const ASSET_PATHS: Record<string, WebnodeHostAsset> = {
  [PREVIEW_SERVICE_WORKER_PATH]: "preview-sw.js",
  "/__webnode__/runtime.js": "runtime.js",
  "/__webnode__/kernel.js": "kernel.js",
  "/__webnode__/process.js": "process.js",
};

const ISOLATION_HEADERS = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
};

/** The script `pathname` names on a runtime host, or null when it names a page. */
export function webnodeHostAsset(pathname: string): WebnodeHostAsset | null {
  return ASSET_PATHS[pathname] ?? null;
}

export interface WebnodeHostOptions {
  /** The origin of the editor: the only site allowed to frame these hosts. */
  editorOrigin: string;
  /** The source of the script `webnodeHostAsset(pathname)` named, when it named one. */
  assetSource: string | null;
}

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
  if (asset) {
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
        "cache-control": "no-cache",
        ...(asset === "preview-sw.js" ? { "service-worker-allowed": "/" } : {}),
        ...ISOLATION_HEADERS,
      },
      body: knowsEditor
        ? `self.${EDITOR_ORIGIN_GLOBAL} = ${JSON.stringify(options.editorOrigin)};\n${options.assetSource}`
        : options.assetSource,
    };
  }

  const documentHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${options.editorOrigin}`,
    ...ISOLATION_HEADERS,
  };
  if (pathname === RUNTIME_FRAME_PATH) {
    return {
      status: 200,
      headers: documentHeaders,
      body: '<!doctype html><meta charset="utf-8"><title>webnode runtime</title><script src="/__webnode__/runtime.js"></script>',
    };
  }
  return {
    status: 200,
    headers: documentHeaders,
    body: createPreviewConnectHtml(options.editorOrigin),
  };
}
