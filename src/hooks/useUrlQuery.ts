import { useEffect } from "react";
import { useSearchParams } from "react-router";
import type { UrlLoader } from "./useUrlLoader";
import { resolveRecordingUrl } from "../utils/recordingUrl";

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
