/**
 * The same-origin Worker transport the Worker-backed narration adapters share
 * (Modal VoxCPM2, AthanLab): one JSON POST per dialog to
 * `/api/studio/tts/<provider>` that answers with a WAV take or an error
 * payload, and the rule for asking again after a dropped connection. Each
 * adapter keeps its own wording and its own provider-specific retries on top.
 */

interface ErrorPayload {
  error?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
}

export type WorkerTtsResult =
  | { kind: "audio"; bytes: Uint8Array }
  /** A non-ok response, with the Worker's error payload read as far as it goes. */
  | {
      kind: "error";
      status: number;
      /** The Worker's message, or `request failed with HTTP <status>`. */
      detail: string;
      code: string | null;
      /** As sent; the adapter that honors it validates it. */
      retryAfterSeconds: unknown;
    }
  /** An ok response that is not a WAV. */
  | { kind: "not-wav" };

/** POST one synthesis request to the Worker's `/api/studio/tts/<path>` route. */
export async function postStudioTtsWav(path: string, body: string): Promise<WorkerTtsResult> {
  const response = await fetch(`/api/studio/tts/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "audio/wav",
      "Content-Type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    return {
      kind: "error",
      status: response.status,
      detail:
        typeof payload?.error === "string"
          ? payload.error
          : `request failed with HTTP ${response.status}`,
      code: typeof payload?.code === "string" ? payload.code : null,
      retryAfterSeconds: payload?.retryAfterSeconds,
    };
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("audio/wav")) {
    return { kind: "not-wav" };
  }

  return { kind: "audio", bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** How many times a dropped connection is tried in all, and the waits between. */
export const DROPPED_CONNECTION_ATTEMPTS = 3;
const DROPPED_CONNECTION_RETRY_DELAYS_MS = [2_000, 5_000];

/**
 * Run `run`, asking again after a dropped connection. A connection dropped
 * between the browser and the Worker rejects with a TypeError ("Failed to
 * fetch") and no response, even when the provider finished the take. A
 * synthesis request is safe to repeat: an AthanLab retry re-attaches to the
 * job already bought, and a VoxCPM2 retry starts a new Modal job (the Worker
 * cancels the old one once it sees the browser leave). So it is tried
 * DROPPED_CONNECTION_ATTEMPTS times before `onExhausted` names the failure.
 * Any other rejection (a Worker error carries its own message) is never
 * retried.
 */
export async function retryDroppedConnection<T>(
  run: () => Promise<T>,
  onExhausted: (error: TypeError) => Error,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (attempt >= DROPPED_CONNECTION_ATTEMPTS) {
        throw onExhausted(error);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, DROPPED_CONNECTION_RETRY_DELAYS_MS[attempt - 1]),
      );
    }
  }
}
