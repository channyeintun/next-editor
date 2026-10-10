import { useState, useRef, useEffect } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import {
  attachCompanionMedia,
  decodeRecordingFile,
  selectRecordingFiles,
} from "../storage/recordingImport";
import { loadRecordingFromUrl } from "../storage/recordingLoad";
import { isNextEditorUrl } from "../utils/recordingUrl";

interface LoadFailure {
  /** Human-readable reason, shown in the editor's inline error panel. */
  message: string;
  /** The URL that failed, so it can be retried; null for a file, which cannot be fetched again. */
  url: string | null;
}

/**
 * Awaits `task` and returns what it threw, or null when it finished. Module-level because the
 * React Compiler skips a hook that holds a try/finally or a throw inside a try block.
 */
async function failureOf(task: () => Promise<void>): Promise<{ error: unknown } | null> {
  try {
    await task();
    return null;
  } catch (error) {
    return { error };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export type UrlLoader = ReturnType<typeof useUrlLoader>;

/**
 * Loads a lesson from a URL or a dropped/picked `.ne` file into the editor. One instance serves
 * every entry point of an editor surface (the `?url=` query and drag-and-drop), so a newer load of
 * either kind supersedes an older one: its requests are aborted and its late results dropped.
 */
export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  // Surfaces a human-readable load failure to the UI instead of a blocking `alert()`,
  // so callers can render an inline, themeable error panel (with retry) in context.
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const { loadRecording, extendRecording, appendRecordingDelta, addCaptionTrack } =
    useNextEditorActions();
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  /** Starts a load that supersedes the previous one: aborts its requests and makes it stale. */
  const beginLoad = () => {
    const generation = ++generationRef.current;
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsLoading(true);
    setFailure(null);
    return {
      signal: abortController.signal,
      isStale: () => generationRef.current !== generation,
    };
  };

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  /**
   * Loads the `.ne` among files dropped together, pairing it with the camera video and audio
   * among them the way the file picker does. Files without a `.ne` are not a lesson: they are
   * left alone and do not interrupt a load in progress.
   */
  const importNextEditorFile = async (files: File[]) => {
    const selection = selectRecordingFiles(files);
    if (!selection) return;
    const { isStale } = beginLoad();
    const failed = await failureOf(async () => {
      const recording = await decodeRecordingFile(selection.neFile);
      if (!isStale()) {
        loadRecording(attachCompanionMedia(recording, selection));
      }
    });
    if (isStale()) return;
    if (failed) {
      console.error("Failed to import file:", failed.error);
      setFailure({
        message: `Failed to import file: ${describeError(failed.error)}`,
        url: null,
      });
    }
    setIsLoading(false);
  };

  const fetchNextEditorFile = async (url: string) => {
    const { signal, isStale } = beginLoad();

    if (!isNextEditorUrl(url)) {
      // Reported like any other failure: a `?url=` that is not a lesson must not leave a blank
      // editor. Retry is not offered, since fetching the same URL again cannot help.
      const message = "URL does not point to a supported file (.ne)";
      setFailure({ message: `Failed to load tutorial: ${message}`, url: null });
      setIsLoading(false);
      throw new Error(message);
    }

    const failed = await failureOf(() =>
      loadRecordingFromUrl(url, signal, {
        isStale,
        load: (recording) => {
          loadRecording(recording);
          setIsLoading(false);
        },
        appendDelta: appendRecordingDelta,
        extend: extendRecording,
        addCaptionTrack,
      }),
    );
    if (isStale()) return;
    // Leaving the editor aborts the load; that is not a failure.
    if (failed && !(failed.error instanceof Error && failed.error.name === "AbortError")) {
      console.error("Failed to load tutorial from URL:", failed.error);
      setFailure({
        message: `Failed to load tutorial: ${describeError(failed.error)}`,
        url,
      });
      setIsLoading(false);
      throw failed.error;
    }
    setIsLoading(false);
  };

  const failedUrl = failure?.url;

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading,
    error: failure?.message ?? null,
    /** Repeats a failed URL load; undefined when the last failure was a file. */
    retry: failedUrl
      ? () => {
          // The loader records a new failure itself; this only keeps it off the console as an
          // unhandled rejection.
          fetchNextEditorFile(failedUrl).catch(() => {});
        }
      : undefined,
    clearError: () => setFailure(null),
  };
};
