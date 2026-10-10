/**
 * The answer to a request whose client went away first: 499 (nginx's "Client
 * Closed Request", the status Cloudflare records for a cancelled request) with
 * no body. Nobody receives it; the status only keeps the request log
 * (index.ts) from counting a cancel as a server error.
 */
export function clientClosedResponse(): Response {
  return new Response(null, { status: 499 });
}
