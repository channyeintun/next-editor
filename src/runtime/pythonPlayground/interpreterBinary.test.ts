// @vitest-environment node
import { describe, expect, it, vi } from "vite-plus/test";

import { fetchPythonBinary, PYTHON_BINARY_FILE } from "./interpreterBinary";

const INDEX = "https://app.test/assets/pyodide/";

/** A response whose body the test feeds piece by piece. */
function streamedResponse(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: new Response(body, { status }),
    send: () => controller.enqueue(new Uint8Array(1024)),
    end: () => controller.close(),
    breakOff: (cause: unknown = new TypeError("network error")) => controller.error(cause),
  };
}

/** A `fetch` that answers with `file`, whose body breaks off when the request is aborted, as a real one's does. */
function fetchAnswering(file: ReturnType<typeof streamedResponse>) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    init?.signal?.addEventListener("abort", () =>
      file.breakOff(new DOMException("The request was aborted", "AbortError")),
    );
    return file.response;
  });
}

describe("fetchPythonBinary", () => {
  it("fetches the interpreter's file from the folder it is served in, to its end", async () => {
    const file = streamedResponse();
    const fetchFile = fetchAnswering(file);

    const fetched = fetchPythonBinary(INDEX, { fetch: fetchFile });
    file.send();
    file.send();
    file.end();

    await expect(fetched).resolves.toBeUndefined();
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(fetchFile.mock.calls[0][0]).toBe(`${INDEX}${PYTHON_BINARY_FILE}`);
    // All of it was read: nothing is left for a second reader.
    expect(file.response.bodyUsed).toBe(true);
  });

  it("rejects when the request cannot be made", async () => {
    const offline = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(fetchPythonBinary(INDEX, { fetch: offline })).rejects.toThrow("Failed to fetch");
  });

  it("rejects when the server answers with an error", async () => {
    const missing = fetchAnswering(streamedResponse(404));

    await expect(fetchPythonBinary(INDEX, { fetch: missing })).rejects.toThrow(
      "the interpreter could not be fetched (HTTP 404)",
    );
  });

  it("rejects when the body breaks off", async () => {
    const file = streamedResponse();

    const fetched = fetchPythonBinary(INDEX, { fetch: fetchAnswering(file) });
    file.send();
    file.breakOff();

    await expect(fetched).rejects.toThrow("network error");
  });

  it("gives up on a file that stops arriving, and ends the request", async () => {
    const file = streamedResponse();
    const fetchFile = fetchAnswering(file);

    const fetched = fetchPythonBinary(INDEX, { fetch: fetchFile, stallMs: 40 });
    file.send();

    await expect(fetched).rejects.toThrow("the interpreter stopped arriving");
    expect(fetchFile.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("gives up on a request that is never answered", async () => {
    const silent = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        }),
    );

    await expect(fetchPythonBinary(INDEX, { fetch: silent, stallMs: 40 })).rejects.toThrow(
      "the interpreter stopped arriving",
    );
  });

  // The limit is on silence, not on the download: a slow file is still a file.
  it("waits for a slow file for as long as it keeps arriving", async () => {
    const file = streamedResponse();

    const fetched = fetchPythonBinary(INDEX, { fetch: fetchAnswering(file), stallMs: 60 });
    for (let piece = 0; piece < 5; piece++) {
      file.send();
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    file.end();

    await expect(fetched).resolves.toBeUndefined();
  });
});
