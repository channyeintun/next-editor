// The /learn gallery keeps its search in the URL (/learn?q=css+course), so
// Back from a result, a reload and a shared link all bring the search back.

const SEARCH_PARAM = "q";

/** The search a /learn URL names: "" for the plain gallery. */
export function searchQueryFrom(params: URLSearchParams): string {
  return (params.get(SEARCH_PARAM) ?? "").trim();
}

/** `params` naming the search `q` instead, or no search when `q` is "". Other params are kept. */
export function withSearchQuery(params: URLSearchParams, q: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (q) next.set(SEARCH_PARAM, q);
  else next.delete(SEARCH_PARAM);
  return next;
}
