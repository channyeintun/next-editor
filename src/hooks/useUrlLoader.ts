import { useCallback, useState } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import {
  decodeBase64ToRecordings,
  decompressBinaryToRecordings,
} from "../storage/recordingCodecClient";
import {
  createStreamingRecordingReader,
  type StreamingRecordingReader,
} from "../storage/streamingRecordingCodec";

const SAME_ORIGIN_PROXY_PATH = "/api/proxy";
const MISSING_PROXY_STATUS_CODES = new Set([404, 405, 501]);

// Decode the accumulated stream into a (partial) recording roughly every this many bytes of
// downloaded bytes, so playback can start before the whole `.ne` file has arrived.
const STREAM_DECODE_INTERVAL_BYTES = 512 * 1024;
const SCR3_MAGIC_BYTES = new Uint8Array([0x53, 0x43, 0x52, 0x33]);

function concatByteChunks(parts: Uint8Array[], totalLength?: number): Uint8Array {
  const total = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

function startsWithScr3(bytes: Uint8Array): boolean {
  return (
    bytes.length >= SCR3_MAGIC_BYTES.length &&
    SCR3_MAGIC_BYTES.every((value, index) => bytes[index] === value)
  );
}

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
  const { loadRecording, extendRecording } = useNextEditorActions();

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
          const bytes = new Uint8Array(await file.arrayBuffer());

          if (bytes.length === 0) {
            throw new Error("File appears to be empty or corrupted");
          }

          if (startsWithScr3(bytes)) {
            const recordings = await decompressBinaryToRecordings(bytes);
            if (recordings.length > 0) {
              loadRecording(recordings[0]);
            }
            return;
          }

          const text = new TextDecoder().decode(bytes);
          const trimmedText = text.trim();

          if (!trimmedText) {
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

  const loadRecordingFromBase64Text = useCallback(
    async (text: string) => {
      const stripped = text.replace(/\s/g, "");
      if (!stripped) {
        throw new Error("File appears to be empty or corrupted");
      }
      const recordings = await decodeBase64ToRecordings(stripped);
      if (recordings.length > 0) {
        loadRecording(recordings[0]);
      }
    },
    [loadRecording],
  );

  const loadRecordingFromBinaryBytes = useCallback(
    async (bytes: Uint8Array) => {
      if (!startsWithScr3(bytes)) {
        throw new Error("File does not contain a valid SCR3 recording stream");
      }

      const recordings = await decompressBinaryToRecordings(bytes);
      if (recordings.length > 0) {
        loadRecording(recordings[0]);
      }
    },
    [loadRecording],
  );

  /**
   * Streams a `.ne` response and progressively decodes ever-larger prefixes of the SCR3 stream,
   * so playback can begin before the whole file has downloaded. The first decodable prefix is
   * loaded; subsequent prefixes extend it in place (see `extendRecording`). Falls back to the
   * caller for whole-file decoding when the body is not streamable.
   */
  const streamRecordingFromResponse = useCallback(
    async (response: Response): Promise<boolean> => {
      const body = response.body;
      if (!body || typeof body.getReader !== "function") {
        return false;
      }

      const reader = body.getReader();
      const textDecoder = new TextDecoder();
      const sniffParts: Uint8Array[] = [];
      let sniffLength = 0;
      let base64 = "";
      let streamReader: StreamingRecordingReader | null = null;
      let lastDecodeLength = 0;
      let loadedOnce = false;

      const applyRecording = (
        recording: Awaited<ReturnType<typeof decodeBase64ToRecordings>>[0] | null | undefined,
      ) => {
        if (!recording) {
          return;
        }

        if (!loadedOnce) {
          loadRecording(recording);
          loadedOnce = true;
          setIsLoading(false);
          return;
        }

        extendRecording(recording);
      };

      const decodeAndApplyText = async (final: boolean) => {
        const stripped = base64.replace(/\s/g, "");
        // Base64 decodes in 4-character groups; drop a partial trailing group until the end so
        // we never feed a half-character to the decoder.
        const aligned = final
          ? stripped
          : stripped.slice(0, stripped.length - (stripped.length % 4));
        if (aligned.length === 0) return;

        try {
          const recordings = await decodeBase64ToRecordings(aligned);
          applyRecording(recordings[0]);
        } catch {
          // Not enough bytes for a valid prefix yet (e.g. header incomplete) — wait for more.
          return;
        }
      };

      // The incremental reader decodes only the newly-arrived segments on each push, so a
      // prefix that isn't decodable yet simply yields `null` (no throw). A thrown error means
      // genuine corruption/desync and is allowed to propagate to the whole-file fallback.
      const applyStreamedBinary = () => {
        applyRecording(streamReader?.getRecording());
      };

      try {
        let streamMode: "binary" | "text" | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;

          if (!value || value.length === 0) {
            continue;
          }

          if (streamMode === null) {
            sniffParts.push(value);
            sniffLength += value.length;
            if (sniffLength < SCR3_MAGIC_BYTES.length) {
              continue;
            }

            const sniffBytes = concatByteChunks(sniffParts, sniffLength);
            streamMode = startsWithScr3(sniffBytes) ? "binary" : "text";

            if (streamMode === "binary") {
              streamReader = createStreamingRecordingReader();
              streamReader.push(sniffBytes);
            } else {
              base64 += textDecoder.decode(sniffBytes, { stream: true });
            }
            sniffParts.length = 0;
            sniffLength = 0;
          } else if (streamMode === "binary") {
            streamReader?.push(value);
          } else {
            base64 += textDecoder.decode(value, { stream: true });
          }

          if (streamMode === "binary") {
            const downloaded = streamReader?.byteLength() ?? 0;
            if (downloaded - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES) {
              lastDecodeLength = downloaded;
              applyStreamedBinary();
            }
          } else if (streamMode === "text") {
            if (base64.length - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES) {
              lastDecodeLength = base64.length;
              await decodeAndApplyText(false);
            }
          }
        }

        if (streamMode === null && sniffLength > 0) {
          const sniffBytes = concatByteChunks(sniffParts, sniffLength);
          streamMode = startsWithScr3(sniffBytes) ? "binary" : "text";
          if (streamMode === "binary") {
            streamReader = createStreamingRecordingReader();
            streamReader.push(sniffBytes);
          } else {
            base64 += textDecoder.decode(sniffBytes, { stream: true });
          }
        }

        if (streamMode === "binary") {
          applyStreamedBinary();
        } else {
          base64 += textDecoder.decode();
          await decodeAndApplyText(true);
        }
      } finally {
        reader.releaseLock();
      }

      if (!loadedOnce) {
        throw new Error("No valid recording found in stream");
      }
      return true;
    },
    [loadRecording, extendRecording],
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

        // Stream + progressively decode straight from the response body. Cloning the
        // response here would tee the stream and buffer the *entire* file in the unread
        // branch — defeating streaming — so the body is consumed directly. The reader
        // only returns `false` before touching the body (not a readable stream); any
        // failure after it starts reading throws, in which case the body is already
        // drained and the whole-file fallback re-fetches the URL.
        let streamed = false;
        let bodyConsumed = false;
        try {
          streamed = await streamRecordingFromResponse(response);
        } catch {
          bodyConsumed = true;
        }

        if (!streamed) {
          const source = bodyConsumed ? await fetchNextEditorUrl(url) : response;
          const bytes = new Uint8Array(await source.arrayBuffer());
          if (startsWithScr3(bytes)) {
            await loadRecordingFromBinaryBytes(bytes);
          } else {
            await loadRecordingFromBase64Text(new TextDecoder().decode(bytes).trim());
          }
        }
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
    [streamRecordingFromResponse, loadRecordingFromBase64Text, loadRecordingFromBinaryBytes],
  );

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading,
  };
};
