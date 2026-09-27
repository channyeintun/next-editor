// How the URL loader (src/hooks/useUrlLoader.ts) fetches a `.ne` and its sibling
// files: through the same-origin proxy when the host is another origin, since a
// host without CORS is reachable only that way, and directly when there is no
// proxy to ask.

const SAME_ORIGIN_PROXY_PATH = "/api/proxy";
const MISSING_PROXY_STATUS_CODES = new Set([404, 405, 501]);

function buildSameOriginProxyUrl(targetUrl: string): string {
  const proxyUrl = new URL(SAME_ORIGIN_PROXY_PATH, window.location.origin);
  proxyUrl.searchParams.set("url", targetUrl);
  return proxyUrl.toString();
}

export async function fetchNextEditorUrl(url: string, init?: RequestInit): Promise<Response> {
  const urlObj = new URL(url);

  if (urlObj.origin === window.location.origin) {
    return fetch(url, init);
  }

  const proxyUrl = buildSameOriginProxyUrl(url);

  try {
    const proxyResponse = await fetch(proxyUrl, init);

    // Hosts without a real `/api/proxy` endpoint (static/SPA deploys) rewrite the
    // unknown path to the app shell and answer 200 with `text/html`. That HTML is
    // not a recording, so treat it as "proxy unavailable" and fall through to the
    // direct cross-origin fetch (which needs CORS on the recording's host).
    const isSpaFallback = (proxyResponse.headers.get("content-type") ?? "").includes("text/html");

    if (
      !isSpaFallback &&
      (proxyResponse.ok || !MISSING_PROXY_STATUS_CODES.has(proxyResponse.status))
    ) {
      return proxyResponse;
    }
    // Not the proxy's answer: stop that download before asking the host directly.
    await proxyResponse.body?.cancel().catch(() => {});
  } catch (error) {
    // An abort means the load was left or superseded, not that the proxy is missing.
    if (init?.signal?.aborted) throw error;
    console.warn("Same-origin proxy request failed, falling back to direct fetch:", error);
  }

  return fetch(url, init);
}

/**
 * Why a `.ne` request failed, for the error panel. `statusText` is empty over HTTP/2 and HTTP/3,
 * so the status code is what is left; a proxied request that failed upstream comes back as a 502
 * whose JSON `error` says what the upstream answered, which is the more useful reason.
 */
export async function describeFailedResponse(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const reason =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    if (typeof reason === "string" && reason) {
      return `Failed to fetch file: ${reason}`;
    }
  } catch {
    // Not a JSON body (a plain 404 page, say): fall back to the status code.
  }
  return `Failed to fetch file (HTTP ${response.status})`;
}

/**
 * Checks whether a media URL is reachable and not an HTML fallback page, without downloading
 * the body — used to verify a camera `<video src>` candidate before assigning it (playback
 * would otherwise fail silently inside the `<video>` element). Tries `HEAD` first since it's
 * cheapest; some hosts (e.g. S3 presigned URLs scoped to `GetObject`) reject `HEAD`, so a
 * ranged `GET` is the fallback.
 */
export async function probeMediaUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    let response = await fetchNextEditorUrl(url, { method: "HEAD", signal });
    if (!response.ok) {
      response = await fetchNextEditorUrl(url, { headers: { Range: "bytes=0-0" }, signal });
      // Only the status and type matter, and a host that ignores Range sends the whole video.
      await response.body?.cancel().catch(() => {});
    }
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    return !contentType.includes("text/html");
  } catch (error) {
    // An abort ends the search for a camera URL; any other failure rules out this candidate.
    if (signal?.aborted) throw error;
    return false;
  }
}
