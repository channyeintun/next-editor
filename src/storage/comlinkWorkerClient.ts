import { wrap, type Remote } from "comlink";

export interface ComlinkWorkerClient<Api> {
  api: Remote<Api>;
  /**
   * Races a worker call against the worker's own death. Comlink settles a call
   * only when a reply message arrives, so a worker that fails after
   * construction would otherwise leave every call pending forever, and with it
   * whatever the caller would have done instead.
   */
  call<T>(promise: Promise<T>): Promise<T>;
}

interface SpawnComlinkWorkerClientOptions {
  /**
   * Builds the worker. Each caller writes its own literal
   * `new Worker(new URL("./x.worker.ts", import.meta.url), …)` so Vite still
   * finds and bundles the worker chunk.
   */
  spawn: () => Worker;
  /** The rejection every pending and later call gets once the worker dies. */
  failure: () => Error;
  /** Marks the worker unavailable in the owning module; runs before the rejection. */
  onFailure: () => void;
}

/**
 * Starts a comlink worker whose calls reject when it dies, or returns null when
 * it cannot be constructed. The owning module keeps its own unavailable flag
 * and decides when a worker may be spawned at all.
 */
export function spawnComlinkWorkerClient<Api>({
  spawn,
  failure,
  onFailure,
}: SpawnComlinkWorkerClientOptions): ComlinkWorkerClient<Api> | null {
  let worker: Worker;
  try {
    worker = spawn();
  } catch {
    onFailure();
    return null;
  }

  // The constructor only throws for a synchronously rejected worker. One whose
  // module fails at runtime — chunk fetched over a flaky network, or the worker
  // killed under memory pressure mid-call — constructs fine and then fires
  // `error`.
  let failWorker: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    failWorker = reject;
  });
  failed.catch(() => {});
  const onWorkerFailure = () => {
    onFailure();
    worker.terminate();
    failWorker(failure());
  };
  worker.addEventListener("error", onWorkerFailure);
  worker.addEventListener("messageerror", onWorkerFailure);

  return {
    api: wrap<Api>(worker),
    call: (promise) => Promise.race([promise, failed]),
  };
}
