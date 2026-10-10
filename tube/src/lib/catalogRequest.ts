import axios from "axios";
import { isNotFoundError } from "../../../infra/client/apiClient";

// axios has no timeout by default and nothing in tube configures one, so a
// request that is accepted and then never answered (a stalled mobile
// connection, a proxy holding the socket) never settles: Query's retry never
// fires and the grid sits in isFetchingNextPage forever, showing a trailing
// row of skeletons with no "Load more" and no error row to retry from. Failing
// after a bounded wait puts the stall back into the retry/error UI that
// already exists. Generous, since these are cache-backed JSON reads and a slow
// answer is still better than a spurious failure. Scoped to these catalog
// reads rather than apiClient, whose upload PUTs can legitimately run longer.
export const REQUEST_TIMEOUT_MS = 15_000;

// The Worker's SPA fallback (not_found_handling = "single-page-application",
// see infra/wrangler.toml) means an unmatched path is NEVER a real 404 — it's
// always a 200 carrying index.html. A seed shard that doesn't exist (any slug
// beyond what's in the static manifest) hits exactly this: isNotFoundError()
// never fires because there's no error at all, so the raw HTML would otherwise
// be trusted as real JSON. Same fix src/storage/recordingFetch.ts already uses
// for the equivalent problem on the recording-proxy path — check Content-Type
// instead of trusting the status code alone.
function isHtmlFallback(res: { headers: Record<string, unknown> }): boolean {
  const contentType = res.headers["content-type"];
  return typeof contentType === "string" && contentType.includes("text/html");
}

/**
 * A bounded catalog read. Resolves to null when a host without the Worker
 * answers with the SPA's index.html; any HTTP error (including a 404) rejects.
 */
export async function getCatalogJson<T>(url: string): Promise<T | null> {
  const res = await axios.get<T>(url, { timeout: REQUEST_TIMEOUT_MS });
  return isHtmlFallback(res) ? null : res.data;
}

/**
 * A single-item catalog lookup: like getCatalogJson, but a real 404 is a miss
 * too. Returns null (not undefined — Query rejects undefined) so a route can
 * tell "not found" from a real fetch failure.
 */
export async function findCatalogItem<T>(url: string): Promise<T | null> {
  try {
    return await getCatalogJson<T>(url);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}
