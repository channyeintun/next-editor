import type { WhisperAssets } from "./whisperTranscriber";

// ============================================================================
// The Whisper model files: whisper-base, int8, from a pinned revision of the
// ONNX export on Hugging Face (immutable URLs). They go through a Cache
// storage bucket, so the ~79 MB download happens once per browser profile.
// ============================================================================

const REPOSITORY = "onnx-community/whisper-base";
const REVISION = "1846881b6b3a3024392c1eea3ad983695bc23925";
const BASE_URL = `https://huggingface.co/${REPOSITORY}/resolve/${REVISION}`;
const CACHE_NAME = "next-editor-whisper-base-v1";

const FILES = {
  encoder: "onnx/encoder_model_quantized.onnx",
  decoder: "onnx/decoder_model_merged_quantized.onnx",
  config: "config.json",
  generationConfig: "generation_config.json",
  tokenizer: "tokenizer.json",
} as const;

/** Rough sizes, for progress before the server reports the real ones. */
const EXPECTED_BYTES: Record<keyof typeof FILES, number> = {
  encoder: 23_201_314,
  decoder: 53_693_315,
  config: 2_243,
  generationConfig: 3_832,
  tokenizer: 2_480_466,
};

export type ModelProgress = (loadedBytes: number, totalBytes: number) => void;

/** A large file's connection can drop mid-download; each retry resumes where it stopped. */
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 1_000;

class DownloadStatusError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`The speech model could not be downloaded (${path}: HTTP ${status})`);
    this.status = status;
  }
}

function concatenate(chunks: readonly Uint8Array[], length: number): ArrayBuffer {
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/**
 * Downloads `url` in full, reporting bytes as they arrive (negative when a retry has to
 * start over). A dropped connection is retried with a Range request from the bytes
 * already received; a server error is retried too, a missing file is not.
 */
async function download(
  url: string,
  path: string,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        signal,
        headers: received > 0 ? { Range: `bytes=${received}-` } : undefined,
      });
      // Every byte had arrived when the connection dropped: nothing is left to send.
      if (response.status === 416 && received > 0) return concatenate(chunks, received);
      if (!response.ok) throw new DownloadStatusError(path, response.status);
      if (received > 0 && response.status !== 206) {
        // The server ignored the range and sent the whole file again.
        onBytes(-received);
        chunks.length = 0;
        received = 0;
      }
      if (!response.body) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        chunks.push(buffer);
        received += buffer.byteLength;
        onBytes(buffer.byteLength);
      } else {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          onBytes(value.byteLength);
        }
      }
      return concatenate(chunks, received);
    } catch (error) {
      const retryable =
        !signal?.aborted &&
        attempt < MAX_ATTEMPTS &&
        (!(error instanceof DownloadStatusError) || error.status >= 500);
      if (!retryable) {
        if (error instanceof DownloadStatusError || signal?.aborted) throw error;
        throw new Error(
          "The speech model could not be downloaded. Check the connection and try again.",
          {
            cause: error,
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

async function fetchFile(
  path: string,
  onBytes: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = `${BASE_URL}/${path}`;
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  const cached = await cache?.match(url);
  if (cached) {
    const buffer = await cached.arrayBuffer();
    onBytes(buffer.byteLength);
    return buffer;
  }
  const buffer = await download(url, path, onBytes, signal);
  // Only a complete file is cached, so an interrupted run never leaves a broken model.
  await cache?.put(url, new Response(buffer.slice(0)));
  return buffer;
}

/** Downloads (or reads from the cache) every file the transcriber needs. */
export async function loadWhisperAssets(
  onProgress?: ModelProgress,
  signal?: AbortSignal,
): Promise<WhisperAssets> {
  const total = Object.values(EXPECTED_BYTES).reduce((sum, bytes) => sum + bytes, 0);
  let loaded = 0;
  const onBytes = (bytes: number) => {
    loaded += bytes;
    onProgress?.(Math.max(0, Math.min(loaded, total)), total);
  };
  const text = async (path: string) =>
    JSON.parse(new TextDecoder().decode(await fetchFile(path, onBytes, signal)));

  const [encoder, decoder, config, generationConfig, tokenizer] = await Promise.all([
    fetchFile(FILES.encoder, onBytes, signal),
    fetchFile(FILES.decoder, onBytes, signal),
    text(FILES.config),
    text(FILES.generationConfig),
    text(FILES.tokenizer),
  ]);
  return { encoder, decoder, config, generationConfig, tokenizer };
}
