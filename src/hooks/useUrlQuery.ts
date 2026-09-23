import { useEffect } from "react";
import { useSearchParams } from "react-router";
import type { UrlLoader } from "./useUrlLoader";

/** Loads the lesson named by the `overrideUrl` prop or the `?url=` query param with the given loader. */
export const useUrlQuery = ({ fetchNextEditorFile }: UrlLoader, overrideUrl?: string) => {
  const [searchParams] = useSearchParams();

  const resolveUrl = (): string | null => {
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
  };

  useEffect(() => {
    const fullUrl = resolveUrl();
    if (fullUrl) {
      // The loader records the failure in its `error` state; the catch only keeps the
      // rejected promise from surfacing as an unhandled rejection.
      fetchNextEditorFile(fullUrl).catch((err) => {
        console.error("Failed to load from URL query:", err);
      });
    }
    // Re-runs when the resolved URL changes (override prop or `?url=` param).
  }, [overrideUrl, searchParams]);
};
