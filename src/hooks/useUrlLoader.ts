import { useCallback, useState } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import { decodeBase64ToRecordings } from "../storage/recordingCodecClient";

const SAME_ORIGIN_PROXY_PATH = "/api/proxy";
const MISSING_PROXY_STATUS_CODES = new Set([404, 405, 501]);

function buildSameOriginProxyUrl(targetUrl: string): string {
  const proxyUrl = new URL(SAME_ORIGIN_PROXY_PATH, window.location.origin);
  proxyUrl.searchParams.set("url", targetUrl);
  return proxyUrl.toString();
}

async function fetchNextEditorUrl(url: string): Promise<Response> {
  const urlObj = new URL(url);

  if (urlObj.origin === window.location.origin) {
    return fetch(url);
  }

  const proxyUrl = buildSameOriginProxyUrl(url);

  try {
    const proxyResponse = await fetch(proxyUrl);

    if (proxyResponse.ok || !MISSING_PROXY_STATUS_CODES.has(proxyResponse.status)) {
      return proxyResponse;
    }
  } catch (error) {
    console.warn("Same-origin proxy request failed, falling back to direct fetch:", error);
  }

  return fetch(url);
}

export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  const { loadRecording } = useNextEditorActions();

  const isNextEditorUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      return pathname.endsWith(".ne");
    } catch {
      return false;
    }
  };

  const importNextEditorFile = useCallback(
    async (file: File) => {
      try {
        setIsLoading(true);
        if (file.name.endsWith(".ne")) {
          const text = await file.text();
          const trimmedText = text.trim();

          if (!trimmedText || trimmedText.length === 0) {
            throw new Error("File appears to be empty or corrupted");
          }

          // Relaxed validation: Allow whitespace/newlines and check general format
          // Strip whitespace for the check
          const stripped = trimmedText.replace(/\s/g, "");
          const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
          if (!base64Pattern.test(stripped)) {
            throw new Error("File does not contain valid base64 data");
          }

          const recordings = await decodeBase64ToRecordings(stripped);

          if (recordings.length > 0) {
            loadRecording(recordings[0]);
          }
        }
      } catch (error) {
        console.error("Failed to import file:", error);
        alert(`Failed to import file: ${error instanceof Error ? error.message : "Unknown error"}`);
      } finally {
        setIsLoading(false);
      }
    },
    [loadRecording],
  );

  const fetchNextEditorFile = useCallback(
    async (url: string) => {
      if (!isNextEditorUrl(url)) {
        throw new Error("URL does not point to a supported file (.ne)");
      }

      try {
        setIsLoading(true);
        const response = await fetchNextEditorUrl(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.statusText}`);
        }

        const blob = await response.blob();
        const file = new File([blob], url.split("/").pop() || "recording", {
          type: blob.type,
        });
        await importNextEditorFile(file);
      } catch (error) {
        console.error("Failed to load tutorial from URL:", error);
        alert(
          `Failed to load tutorial: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [importNextEditorFile],
  );

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading,
  };
};
