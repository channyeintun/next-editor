import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { useUrlLoader } from "./useUrlLoader";

export const useUrlQuery = (overrideUrl?: string) => {
  const { fetchNextEditorFile, isLoading, error, clearError } = useUrlLoader();
  const [searchParams] = useSearchParams();
  // Remember the last resolved URL so Retry can re-run the same load without
  // re-deriving it from params (which may have changed in the meantime).
  const lastUrlRef = useRef<string | null>(null);

  const resolveUrl = useCallback((): string | null => {
    // An explicit override (e.g. the /learn detail view passing a recording via a
    // prop) takes precedence over the `?url=` query param.
    const url = overrideUrl ?? searchParams.get("url");
    if (!url) {
      return null;
    }

    // Decode URL in case it was URL encoded
    const decodedUrl = decodeURIComponent(url);

    // Convert relative URLs to absolute URLs for same origin
    if (decodedUrl.startsWith("http://") || decodedUrl.startsWith("https://")) {
      return decodedUrl;
    }
    const origin = window.location.origin;
    return decodedUrl.startsWith("/") ? `${origin}${decodedUrl}` : `${origin}/${decodedUrl}`;
  }, [overrideUrl, searchParams]);

  const load = useCallback(
    (fullUrl: string) => {
      lastUrlRef.current = fullUrl;
      // The loader records the failure in its `error` state; the catch only keeps the
      // rejected promise from surfacing as an unhandled rejection.
      fetchNextEditorFile(fullUrl).catch((err) => {
        console.error("Failed to load from URL query:", err);
      });
    },
    [fetchNextEditorFile],
  );

  useEffect(() => {
    const fullUrl = resolveUrl();
    if (fullUrl) {
      load(fullUrl);
    }
  }, [resolveUrl, load]);

  const retry = useCallback(() => {
    const fullUrl = lastUrlRef.current ?? resolveUrl();
    if (fullUrl) {
      clearError();
      load(fullUrl);
    }
  }, [resolveUrl, load, clearError]);

  return { isLoading, error, retry };
};
