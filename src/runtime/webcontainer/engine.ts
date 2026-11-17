// Which engine runs the in-browser Node runtime, and how it boots: StackBlitz's
// WebContainer (the default) or webnode, the engine in src/core/webnode. Both
// present the `@webcontainer/api` surface, so everything past this module is the
// same code for either.
import type { WebContainer } from "@webcontainer/api";
import { readStoredPreference, writeStoredPreference } from "../../stores/preferenceStorage";

export type RuntimeEngine = "webcontainer" | "webnode";

const ENGINE_PREFERENCE_KEY = "next-editor:runtime-engine";
const ENGINE_QUERY_PARAMETER = "runtime";
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

/** What this page load runs: decided once, so every caller agrees with the runtime that booted. */
let pageEngine: RuntimeEngine | null = null;

function chooseRuntimeEngine(): RuntimeEngine {
  const requested = new URLSearchParams(window.location.search).get(ENGINE_QUERY_PARAMETER);
  if (requested === "webcontainer") {
    writeStoredPreference(ENGINE_PREFERENCE_KEY, null);
    return "webcontainer";
  }
  // A link chooses for this page load and is not remembered: following one
  // must not move a visitor's later lessons onto another runtime. The stored
  // preference is the lasting choice, and only the visitor's own action sets it.
  const wantsWebnode =
    requested === "webnode" || readStoredPreference(ENGINE_PREFERENCE_KEY) === "webnode";
  return wantsWebnode && webnodePreviewBase() ? "webnode" : "webcontainer";
}

/**
 * The engine this page load runs. `?runtime=webnode` in the address chooses
 * webnode for the load, where it can serve previews; `?runtime=webcontainer`
 * also forgets a stored choice of webnode.
 */
export function selectedRuntimeEngine(): RuntimeEngine {
  if (typeof window === "undefined") {
    return "webcontainer";
  }
  pageEngine ??= chooseRuntimeEngine();
  return pageEngine;
}

/** Boots the selected engine with the options the app uses for both. */
export async function bootRuntimeEngine(): Promise<WebContainer> {
  if (selectedRuntimeEngine() === "webnode") {
    try {
      const { WebNode } = await import("../../core/webnode/api");
      const instance = await WebNode.boot({
        previewBase: webnodePreviewBase()!,
        workdirName: RUNTIME_WORKDIR_NAME,
        coep: "require-corp",
        forwardPreviewErrors: true,
      });
      // The app uses the part of the WebContainer API that webnode implements.
      return instance as unknown as WebContainer;
    } catch (error) {
      // webnode is switched off for this deployment, or this editor is older
      // than the scripts its hosts serve: run the lesson on WebContainer, for
      // the rest of this page load and until the visitor chooses webnode again.
      console.warn("webnode did not start; using WebContainer instead:", error);
      writeStoredPreference(ENGINE_PREFERENCE_KEY, null);
      pageEngine = "webcontainer";
    }
  }

  const { WebContainer } = await import("@webcontainer/api");
  return WebContainer.boot({
    coep: "require-corp",
    forwardPreviewErrors: true,
    workdirName: RUNTIME_WORKDIR_NAME,
  });
}

/** Reloads the preview in `iframe` the way the selected engine does it. */
export async function reloadRuntimeEnginePreview(iframe: HTMLIFrameElement): Promise<void> {
  if (selectedRuntimeEngine() === "webnode") {
    const { reloadPreview } = await import("../../core/webnode/api");
    await reloadPreview(iframe);
    return;
  }
  const { reloadPreview } = await import("@webcontainer/api");
  reloadPreview(iframe);
}
