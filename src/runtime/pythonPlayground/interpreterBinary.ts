// The interpreter's WebAssembly file, fetched ahead of Pyodide's loader.
//
// Pyodide's loader fetches `pyodide.asm.wasm` and compiles it as it arrives.
// When that fails — the page went offline, the connection dropped, the body
// was cut short — the loader logs "wasm instantiation failed!" and goes no
// further: `loadPyodide` neither resolves nor rejects, and a Run would spin
// until the page was reloaded. Its other three files fail as they should: a
// missing one rejects the load.
//
// So the file is fetched here first, where a failure is a rejection. The
// loader's own request for it is then answered from the browser's cache: the
// file never changes under its URL and is served to be kept. The loader still
// compiles a cached response, which is what lets the browser keep the compiled
// code between starts; handing it bytes of our own would lose that.

/** The file, beside the others under the interpreter's `indexURL`. */
export const PYTHON_BINARY_FILE = "pyodide.asm.wasm";

/**
 * How long the file may send nothing before the fetch is given up. A stalled
 * connection does not fail by itself, and a limit on the whole download would
 * end a slow one that is still arriving: this one starts again with every
 * piece.
 */
export const PYTHON_BINARY_STALL_MS = 30_000;

export interface FetchPythonBinaryOptions {
  /** Both are for tests; the defaults are the page's `fetch` and {@link PYTHON_BINARY_STALL_MS}. */
  fetch?: typeof fetch;
  stallMs?: number;
}

/**
 * Fetch the interpreter's WebAssembly file to its end, keeping nothing: what
 * matters is that all of it arrived. Rejects when the request fails, when the
 * server answers with an error, when the body breaks off, and when nothing has
 * arrived for `stallMs`.
 */
export async function fetchPythonBinary(
  indexURL: string,
  { fetch: fetchFile = fetch, stallMs = PYTHON_BINARY_STALL_MS }: FetchPythonBinaryOptions = {},
): Promise<void> {
  const controller = new AbortController();
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stillArriving = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };

  stillArriving();
  try {
    const response = await fetchFile(indexURL + PYTHON_BINARY_FILE, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`the interpreter could not be fetched (HTTP ${response.status})`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      await response.arrayBuffer();
      return;
    }
    for (;;) {
      stillArriving();
      if ((await reader.read()).done) return;
    }
  } catch (cause) {
    // The abort is this function's own: say what happened, not "aborted".
    throw stalled
      ? new Error(`the interpreter stopped arriving for ${Math.round(stallMs / 1000)} seconds`)
      : cause;
  } finally {
    clearTimeout(watchdog);
  }
}
