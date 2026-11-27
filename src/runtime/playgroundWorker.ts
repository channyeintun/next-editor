/**
 * Why a worker whose script never ran did not start.
 *
 * A worker's `error` event says nothing about a script that could not be
 * loaded: no status and no message. Two different things look the same there:
 *
 * - "outdated": the app was deployed again after this page was opened. A
 *   worker's script is served under a name that changes with its content, so
 *   the name this page asks for is gone, and asking again gets the same
 *   answer. Only a reload, which brings the page that names the new script,
 *   can start it.
 * - "unreachable": the server could not be reached. The same request can work
 *   a moment later.
 *
 * What tells them apart is whether the app's own server answers right now.
 */
export type WorkerStartFailure = "outdated" | "unreachable";

/** How long the server is given to answer before it counts as out of reach. */
const SERVER_ANSWER_TIMEOUT_MS = 8_000;

/**
 * Ask the app's server for its front page, bypassing the cache: any good
 * answer means the server is there and the worker's script is what is missing.
 * Only the headers are asked for; nothing of the page is read.
 */
export async function explainWorkerStartFailure(): Promise<WorkerStartFailure> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_ANSWER_TIMEOUT_MS);
  try {
    const response = await fetch(`${window.location.origin}/`, {
      method: "HEAD",
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok ? "outdated" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timeout);
  }
}
