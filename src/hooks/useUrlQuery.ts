import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { useUrlLoader } from "./useUrlLoader";

export const useUrlQuery = (overrideUrl?: string) => {
  const { fetchNextEditorFile, isLoading } = useUrlLoader();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // An explicit override (e.g. the /learn detail view passing a recording via a
    // prop) takes precedence over the `?url=` query param.
    const url = overrideUrl ?? searchParams.get("url");

    if (url) {
      // Decode URL in case it was URL encoded
      const decodedUrl = decodeURIComponent(url);

      // Convert relative URLs to absolute URLs for same origin
      let fullUrl = decodedUrl;
      if (!decodedUrl.startsWith("http://") && !decodedUrl.startsWith("https://")) {
        // It's a relative URL, make it absolute with current origin
        const origin = window.location.origin;
        fullUrl = decodedUrl.startsWith("/") ? `${origin}${decodedUrl}` : `${origin}/${decodedUrl}`;
      }

      fetchNextEditorFile(fullUrl).catch((error) => {
        console.error("Failed to load from URL query:", error);
      });
    }
  }, [searchParams, fetchNextEditorFile, overrideUrl]);

  return { isLoading };
};
