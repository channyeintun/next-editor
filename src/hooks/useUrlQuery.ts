import { useEffect } from "react";
import { useSearchParams } from "react-router";
import type { UrlLoader } from "./useUrlLoader";

/**
 * The absolute http(s) URL of the requested recording. `url` arrives already percent-decoded
 * (URLSearchParams.get decodes the param), so it is used as is; decoding it again would turn an
 * escaped `%23` into a fragment or `%2B` into a space. A relative path is relative to the site
 * root.
 */
function resolveRecordingUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const resolved = new URL(url, `${window.location.origin}/`);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}

/** Loads the lesson named by the `overrideUrl` prop or the `?url=` query param with the given loader. */
export const useUrlQuery = ({ fetchNextEditorFile }: UrlLoader, overrideUrl?: string) => {
  const [searchParams] = useSearchParams();
  // An explicit override (e.g. the /learn detail view passing a recording via a
  // prop) takes precedence over the `?url=` query param.
  const fullUrl = resolveRecordingUrl(overrideUrl ?? searchParams.get("url"));

  // Keyed on the resolved URL rather than on `searchParams`, which is a new object whenever any
  // query param changes: joining or leaving a live room rewrites `?room=` and must not reload
  // the lesson.
  useEffect(() => {
    if (!fullUrl) {
      return;
    }
    // The loader records the failure in its `error` state; the catch only keeps the
    // rejected promise from surfacing as an unhandled rejection.
    fetchNextEditorFile(fullUrl).catch((err) => {
      console.error("Failed to load from URL query:", err);
    });
  }, [fullUrl]);
};
