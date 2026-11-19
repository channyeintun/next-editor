// How the in-browser Node runtime boots: webnode, the engine in
// src/core/webnode, and nothing else. Its kernel and processes run on hosts of
// their own, so this module also says where those hosts are, and where the
// runtime cannot start at all.
import type { WebNode } from "../../core/webnode/api";

const RUNTIME_WORKDIR_NAME = "next-editor-runtime";

interface PreviewBase {
  protocol: "http:" | "https:";
  host: string;
}

/**
 * The host webnode runs under, or null where it cannot run. The runtime never
 * runs on this page's origin: its kernel and processes run on `runtime.<host>`
 * and each preview on `<session>-<port>.<host>`. The dev server answers for
 * `*.localhost`; a deployment names its wildcard host in
 * VITE_WEBNODE_PREVIEW_HOST.
 */
export function webnodePreviewBase(): PreviewBase | null {
  if (typeof window === "undefined") {
    return null;
  }
  return webnodePreviewBaseFor(
    window.location,
    // A dev server has no deployment's hosts to use: they would refuse its page.
    import.meta.env.DEV
      ? undefined
      : (import.meta.env.VITE_WEBNODE_PREVIEW_HOST as string | undefined),
  );
}

/** `webnodePreviewBase` for a page at `page` in a build configured with `configuredHost`. */
export function webnodePreviewBaseFor(
  page: Pick<Location, "protocol" | "hostname" | "host">,
  configuredHost: string | undefined,
): PreviewBase | null {
  // Development first: a local page uses the local hosts whatever the build is
  // configured with, since a deployment's hosts take a port only from its own editor.
  if (page.hostname === "localhost") {
    return { protocol: page.protocol === "https:" ? "https:" : "http:", host: page.host };
  }
  const configured = configuredHost?.trim();
  if (!configured) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(`https://${configured}`);
  } catch {
    return null;
  }
  // A host and nothing else: a value with a scheme or a path is a mistake, not a host.
  return url.host === configured.toLowerCase() ? { protocol: "https:", host: url.host } : null;
}

/**
 * Whether a page of another origin frames this one (a lesson embedded on
 * another site). webnode's hosts let only the editor's own origin frame them,
 * every ancestor included, so its runtime cannot start there.
 */
function isFramedByAnotherOrigin(): boolean {
  if (window.self === window.top) {
    return false;
  }
  const ancestors = window.location.ancestorOrigins;
  return !ancestors || Array.from(ancestors).some((origin) => origin !== window.location.origin);
}

/**
 * Why the runtime cannot start on this page, in words for the visitor, or
 * null when it can: a deployment that names no runtime hosts, or a lesson
 * embedded on another site.
 */
export function runtimeUnavailableReason(): string | null {
  if (typeof window === "undefined" || webnodePreviewBase() === null) {
    return "Code cannot run here: this site has no runtime hosts set up.";
  }
  if (isFramedByAnotherOrigin()) {
    return `Code cannot run inside another site's page. Open this lesson on ${window.location.host} to run it.`;
  }
  return null;
}

/** Boots the runtime with the options the app uses. Rejects where it cannot start. */
export async function bootRuntimeEngine(): Promise<WebNode> {
  const unavailable = runtimeUnavailableReason();
  if (unavailable !== null) {
    throw new Error(unavailable);
  }
  const { WebNode } = await import("../../core/webnode/api");
  return WebNode.boot({
    previewBase: webnodePreviewBase()!,
    workdirName: RUNTIME_WORKDIR_NAME,
    coep: "require-corp",
    forwardPreviewErrors: true,
  });
}

/** Reloads the preview in `iframe`. */
export async function reloadRuntimeEnginePreview(iframe: HTMLIFrameElement): Promise<void> {
  const { reloadPreview } = await import("../../core/webnode/api");
  await reloadPreview(iframe);
}
