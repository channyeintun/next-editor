// The one WebContainer that every editor's runtime and the agent's bash tool
// share: whether it can boot here, its boot and lifetime, and the queue that
// serializes work on it.
import type { WebContainer } from "@webcontainer/api";
import { isMobileBrowser } from "../../utils/isMobileBrowser";

const sharedWebContainerState: {
  instance: WebContainer | null;
  bootPromise: Promise<WebContainer> | null;
  holders: number;
} = {
  instance: null,
  bootPromise: null,
  holders: 0,
};

const webContainerTaskQueues = new WeakMap<WebContainer, Promise<void>>();

// WebContainer.boot fetches its runtime from this CDN. The connection is warmed
// here, when a boot starts, rather than by a static hint in index.html, which
// opened it on every page: the landing, the /learn gallery, mobile and
// playground-language lessons never boot a WebContainer.
const WEBCONTAINER_CDN_ORIGIN = "https://w-corp-staticblitz.com";

function preconnectWebContainerCdn(): void {
  if (
    typeof document === "undefined" ||
    document.head.querySelector(`link[rel="preconnect"][href="${WEBCONTAINER_CDN_ORIGIN}"]`)
  ) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = WEBCONTAINER_CDN_ORIGIN;
  link.crossOrigin = "";
  document.head.append(link);
}

/**
 * Serialize filesystem transactions across the runtime UI, reverse sync, and
 * agent tools that share one WebContainer instance.
 */
export function runSerializedWebContainerTask<T>(
  instance: WebContainer,
  task: () => Promise<T>,
): Promise<T> {
  const queue = webContainerTaskQueues.get(instance) ?? Promise.resolve();
  const result = queue.then(task, task);
  webContainerTaskQueues.set(
    instance,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * Whether the in-browser WebContainer runtime can boot here. It requires both
 * cross-origin isolation (for SharedArrayBuffer) and a non-mobile browser. Mobile
 * is excluded because WebContainers are unsupported there and the boot attempt
 * OOM-reloads the tab. This gates auto-boot, so the runtime never starts on mobile.
 */
export function isWebContainerRuntimeSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.crossOriginIsolated === true && !isMobileBrowser();
}

export async function getOrBootSharedWebContainer(): Promise<WebContainer> {
  if (sharedWebContainerState.instance) {
    return sharedWebContainerState.instance;
  }

  if (!sharedWebContainerState.bootPromise) {
    preconnectWebContainerCdn();
    // Fetched alongside the boot, not statically: it carries the ~77 KB recorder
    // bundle as text, which no page that never boots a WebContainer (mobile,
    // playback) should fetch. A failure surfaces where it is awaited below; this
    // handler only keeps it from going unhandled when the boot fails first.
    const previewScriptModule = import("./previewScript");
    previewScriptModule.catch(() => {});

    sharedWebContainerState.bootPromise = import("@webcontainer/api")
      .then(({ WebContainer }) =>
        WebContainer.boot({
          coep: "require-corp",
          forwardPreviewErrors: true,
          workdirName: "next-editor-runtime",
        }),
      )
      .then(async (instance) => {
        // Install the rrweb recorder into every preview HTML response up front,
        // so replay works regardless of how the app renders (SSR/CSR/hybrid).
        // Set once per boot; it persists for the instance's whole lifetime and
        // applies to every preview reloaded afterwards.
        try {
          const { createRuntimePreviewScript } = await previewScriptModule;
          await instance.setPreviewScript(createRuntimePreviewScript());
        } catch (error) {
          console.warn("Failed to install runtime preview recorder script:", error);
        }

        sharedWebContainerState.instance = instance;
        return instance;
      })
      .catch((error) => {
        sharedWebContainerState.bootPromise = null;
        throw error;
      });
  }

  return sharedWebContainerState.bootPromise;
}

export function teardownSharedWebContainer(instance: WebContainer | null): void {
  if (!instance || instance !== sharedWebContainerState.instance) {
    return;
  }

  instance.teardown();
  webContainerTaskQueues.delete(instance);
  sharedWebContainerState.instance = null;
  sharedWebContainerState.bootPromise = null;
}

/**
 * Holds the shared WebContainer until the returned release is called. An editor
 * holds it while mounted; the agent's bash tool lives inside one and reuses the
 * container between commands without holding it. The last release tears the
 * container down, or tears down a boot still in flight once it lands, unless
 * someone holds the container by then. A reset (a project or lesson-type change)
 * still tears the instance down directly, for a clean reinstall.
 */
export function holdSharedWebContainer(): () => void {
  sharedWebContainerState.holders += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    sharedWebContainerState.holders -= 1;

    if (sharedWebContainerState.holders > 0) {
      return;
    }

    if (sharedWebContainerState.instance) {
      teardownSharedWebContainer(sharedWebContainerState.instance);
      return;
    }

    if (sharedWebContainerState.bootPromise) {
      void sharedWebContainerState.bootPromise.then(
        (instance) => {
          if (sharedWebContainerState.holders === 0) {
            teardownSharedWebContainer(instance);
          }
        },
        // A failed boot leaves nothing to tear down; its callers report the error.
        () => {},
      );
    }
  };
}
