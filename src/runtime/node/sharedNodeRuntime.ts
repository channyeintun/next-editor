// The one WebNode that every editor's runtime and the agent's bash tool
// share: whether it can boot here, its boot and lifetime, and the queue that
// serializes work on it.
import type { WebNode } from "../../core/webnode/api";
import { isMobileBrowser } from "../../utils/isMobileBrowser";
import { bootRuntimeEngine } from "./engine";

const sharedNodeRuntimeState: {
  instance: WebNode | null;
  bootPromise: Promise<WebNode> | null;
  holders: number;
  /** An editor's runtime booted or joined the container (or the boot in flight). */
  runtimeOwned: boolean;
  /** A boot a reset gave up on; settles once it has landed and been torn down. */
  retiringBoot: Promise<void> | null;
} = {
  instance: null,
  bootPromise: null,
  holders: 0,
  runtimeOwned: false,
  retiringBoot: null,
};

/**
 * Who asks for the container. An editor's runtime mounts its project over the
 * container's tree without removing paths it does not know, and its reverse sync
 * reads every path back into the workspace, so it must start from a container it
 * booted or joined itself. The agent's bash tool may use any container.
 */
export type SharedNodeRuntimeUser = "runtime" | "agent";

const nodeRuntimeTaskQueues = new WeakMap<WebNode, Promise<void>>();

/**
 * Serialize filesystem transactions across the runtime UI, reverse sync, and
 * agent tools that share one WebNode instance.
 */
export function runSerializedNodeRuntimeTask<T>(
  instance: WebNode,
  task: () => Promise<T>,
): Promise<T> {
  const queue = nodeRuntimeTaskQueues.get(instance) ?? Promise.resolve();
  const result = queue.then(task, task);
  nodeRuntimeTaskQueues.set(
    instance,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * Whether the in-browser runtime can boot here. It requires both cross-origin
 * isolation (for SharedArrayBuffer) and a non-mobile browser. Mobile is
 * excluded because a phone has no memory for it: the boot attempt OOM-reloads
 * the tab. This gates auto-boot, so the runtime never starts on mobile.
 */
export function isNodeRuntimeSupported(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.crossOriginIsolated === true && !isMobileBrowser();
}

function bootSharedNodeRuntime(): Promise<WebNode> {
  // Fetched alongside the boot, not statically: it carries the ~77 KB recorder
  // bundle as text, which no page that never boots a WebNode (mobile,
  // playback) should fetch. A failure surfaces where it is awaited below; this
  // handler only keeps it from going unhandled when the boot fails first.
  const previewScriptModule = import("./previewScript");
  previewScriptModule.catch(() => {});

  // Only one WebNode boots at a time, so a boot a reset gave up on lands
  // and goes down before this one starts.
  const boot: Promise<WebNode> = (sharedNodeRuntimeState.retiringBoot ?? Promise.resolve())
    .then(() => bootRuntimeEngine())
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

      if (sharedNodeRuntimeState.bootPromise !== boot) {
        // A reset gave up on this boot while it was in flight: whoever joined it
        // was working for the workspace the reset replaced.
        instance.teardown();
        return instance;
      }

      sharedNodeRuntimeState.instance = instance;
      return instance;
    })
    .catch((error) => {
      if (sharedNodeRuntimeState.bootPromise === boot) {
        sharedNodeRuntimeState.bootPromise = null;
      }
      throw error;
    });

  return boot;
}

export async function getOrBootSharedNodeRuntime(
  user: SharedNodeRuntimeUser = "agent",
): Promise<WebNode> {
  const state = sharedNodeRuntimeState;

  if (user === "runtime") {
    if ((state.instance || state.bootPromise) && !state.runtimeOwned) {
      // Only the agent's bash tool has used this container: it holds that tool's
      // copy of some workspace, maybe another project's, plus whatever its
      // commands wrote or left running.
      resetSharedNodeRuntime();
    }
    state.runtimeOwned = true;
  }

  if (state.instance) {
    return state.instance;
  }

  if (!state.bootPromise) {
    state.bootPromise = bootSharedNodeRuntime();
  }

  return state.bootPromise;
}

export function teardownSharedNodeRuntime(instance: WebNode | null): void {
  if (!instance || instance !== sharedNodeRuntimeState.instance) {
    return;
  }

  instance.teardown();
  nodeRuntimeTaskQueues.delete(instance);
  sharedNodeRuntimeState.instance = null;
  sharedNodeRuntimeState.bootPromise = null;
  sharedNodeRuntimeState.runtimeOwned = false;
}

/**
 * Tears down the shared container whoever booted it, for a runtime reset (a
 * project or lesson-type change): the next project starts from a clean boot and
 * install. That includes a container only the agent's bash tool booted, which no
 * runtime session claimed, and a boot still in flight, which is torn down when it
 * lands; the next caller boots a container of its own after it.
 */
export function resetSharedNodeRuntime(): void {
  const state = sharedNodeRuntimeState;

  if (state.instance) {
    teardownSharedNodeRuntime(state.instance);
    return;
  }

  const boot = state.bootPromise;
  state.runtimeOwned = false;
  if (!boot) {
    return;
  }

  state.bootPromise = null;
  const retiring = boot.then(
    () => undefined,
    () => undefined,
  );
  state.retiringBoot = retiring;
  void retiring.then(() => {
    if (state.retiringBoot === retiring) {
      state.retiringBoot = null;
    }
  });
}

/**
 * Holds the shared WebNode until the returned release is called. An editor
 * holds it while mounted; the agent's bash tool lives inside one and reuses the
 * container between commands without holding it. The last release tears the
 * container down, or tears down a boot still in flight once it lands, unless
 * someone holds the container by then. A reset (a project or lesson-type change)
 * still tears the container down directly, for a clean reinstall (see
 * resetSharedNodeRuntime).
 */
export function holdSharedNodeRuntime(): () => void {
  sharedNodeRuntimeState.holders += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;
    sharedNodeRuntimeState.holders -= 1;

    if (sharedNodeRuntimeState.holders > 0) {
      return;
    }

    if (sharedNodeRuntimeState.instance) {
      teardownSharedNodeRuntime(sharedNodeRuntimeState.instance);
      return;
    }

    if (sharedNodeRuntimeState.bootPromise) {
      void sharedNodeRuntimeState.bootPromise.then(
        (instance) => {
          if (sharedNodeRuntimeState.holders === 0) {
            teardownSharedNodeRuntime(instance);
          }
        },
        // A failed boot leaves nothing to tear down; its callers report the error.
        () => {},
      );
    }
  };
}
