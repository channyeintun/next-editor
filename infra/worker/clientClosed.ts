// workerd's message when the far end of a stream goes away mid-transfer: here,
// the browser cancelling while its request body is still being read. R2's own
// failures carry "put: … (code)" messages instead.
const DROPPED_CONNECTION_MESSAGE = "Network connection lost.";

/**
 * Whether `error`, thrown while reading `request`, means its client cancelled:
 * the request signal fired (enable_request_signal, wrangler.toml), or the body
 * broke off because the connection dropped, which can surface first.
 */
export function isClientCancel(request: Request, error: unknown): boolean {
  return (
    request.signal.aborted ||
    (error instanceof Error && error.message === DROPPED_CONNECTION_MESSAGE)
  );
}

/**
 * The answer to a request whose client went away first: 499 (nginx's "Client
 * Closed Request", the status Cloudflare records for a cancelled request) with
 * no body. Nobody receives it; the status only keeps the request log
 * (index.ts) from counting a cancel as a server error.
 */
export function clientClosedResponse(): Response {
  return new Response(null, { status: 499 });
}
