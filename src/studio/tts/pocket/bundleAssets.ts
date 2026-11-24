/**
 * Pocket-tts ONNX bundle metadata + asset loading. Assets stream from the
 * pinned upstream revision (immutable URL) through a Cache-storage bucket, so
 * the ~125MB bundle downloads once per browser profile.
 *
 * The cache is an optimization only, so it never fails a load: storage that is
 * blocked or over quota is skipped and the asset comes from the network.
 */

export interface StateManifestEntry {
  dtype: "float32" | "int64" | "bool";
  fill?: "nan" | "ones";
  index: number;
  input_name: string;
  key: string;
  module: string;
  output_name: string;
  path: string;
  shape: number[];
}

export interface PocketBundleMetadata {
  bundle_name: string;
  language: string;
  schema_version: number;
  sample_rate: number;
  samples_per_frame: number;
  frame_rate: number;
  latent_dim: number;
  conditioning_dim: number;
  max_token_per_chunk: number;
  tokenizer_file: string;
  bos_before_voice_file: string | null;
  insert_bos_before_voice: boolean;
  predefined_voices: string[];
  remove_semicolons: boolean;
  pad_with_spaces_for_short_inputs: boolean;
  model_recommended_frames_after_eos: number | null;
  flow_lm_state_manifest: StateManifestEntry[];
  mimi_state_manifest: StateManifestEntry[];
}

const ASSET_CACHE_NAME = "next-editor-studio-pocket-assets-v1";

/** How often one file is asked for, and the pause before the second try (it grows with each try). */
const DOWNLOAD_ATTEMPTS = 4;
const DOWNLOAD_RETRY_PAUSE_MS = 1_500;

/** An answer that trying again will not change. */
class PermanentDownloadError extends Error {}

/** The asset cache, or null where Cache storage is missing or refuses to open. */
async function openAssetCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    return await caches.open(ASSET_CACHE_NAME);
  } catch {
    return null;
  }
}

export async function fetchBundleAsset(baseUrl: string, filename: string): Promise<ArrayBuffer> {
  const url = `${baseUrl}/${filename}`;
  const cache = await openAssetCache();
  if (cache) {
    let hit: Response | undefined;
    try {
      hit = await cache.match(url);
    } catch {
      hit = undefined;
    }
    if (hit) {
      return hit.arrayBuffer();
    }
  }

  // The bundle is about 125 MB in a handful of files, and a slow line drops a
  // connection now and then. One dropped file would fail the whole render and
  // start every download again, so each file is tried a few times. An answer
  // the server gave on purpose (a 4xx) is not tried again.
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise((resume) => setTimeout(resume, DOWNLOAD_RETRY_PAUSE_MS * (attempt - 1)));
    }
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const error = new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
        if (response.status < 500) throw new PermanentDownloadError(error.message);
        throw error;
      }
      if (cache) {
        // Clone into the cache before consuming the body.
        try {
          await cache.put(url, response.clone());
        } catch {
          // Best-effort: the cache only saves a re-download.
        }
      }
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof PermanentDownloadError) throw new Error(error.message);
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Failed to download ${filename} after ${DOWNLOAD_ATTEMPTS} tries: ${reason}. Files already downloaded are kept; start the render again.`,
  );
}

export async function fetchBundleMetadata(baseUrl: string): Promise<PocketBundleMetadata> {
  const buffer = await fetchBundleAsset(baseUrl, "bundle.json");
  return JSON.parse(new TextDecoder().decode(buffer)) as PocketBundleMetadata;
}
