/**
 * Pocket-tts ONNX bundle metadata + asset loading. Assets stream from the
 * pinned upstream revision (immutable URL) through a Cache-storage bucket, so
 * the ~125MB bundle downloads once per browser profile.
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

export async function fetchBundleAsset(baseUrl: string, filename: string): Promise<ArrayBuffer> {
  const url = `${baseUrl}/${filename}`;
  if (typeof caches !== "undefined") {
    const cache = await caches.open(ASSET_CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      return hit.arrayBuffer();
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
    }
    // Clone into the cache before consuming the body.
    await cache.put(url, response.clone());
    return response.arrayBuffer();
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filename}: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

export async function fetchBundleMetadata(baseUrl: string): Promise<PocketBundleMetadata> {
  const buffer = await fetchBundleAsset(baseUrl, "bundle.json");
  return JSON.parse(new TextDecoder().decode(buffer)) as PocketBundleMetadata;
}
