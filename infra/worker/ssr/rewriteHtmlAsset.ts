/**
 * Serve an edited copy of an HTML asset from ASSETS.fetch. A response that is
 * not a successful HTML document (a 304 revalidation, a missing file, a
 * non-HTML body) passes through untouched. `status` overrides the asset's own,
 * e.g. to answer a missing lesson with the SPA shell as a 404.
 */
export async function rewriteHtmlAsset(
  assetResponse: Response,
  rewrite: (html: string) => string,
  status?: { status: number; statusText: string },
): Promise<Response> {
  const contentType = assetResponse.headers.get("content-type");
  if (!assetResponse.ok || !contentType?.includes("text/html")) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  // The body differs from the static asset, so representation-specific headers
  // from ASSETS.fetch must not describe the rewritten document.
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) {
    headers.delete(name);
  }

  return new Response(rewrite(await assetResponse.text()), {
    status: status?.status ?? assetResponse.status,
    statusText: status?.statusText ?? assetResponse.statusText,
    headers,
  });
}
