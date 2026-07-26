// Worker Env bindings — kept in sync with infra/wrangler.toml.
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  PUBLIC_URL: string;
  COLLABORATION_ROOMS?: DurableObjectNamespace;
  // Voice chat control plane. All four are required for voice to be enabled;
  // isVoiceChatEnabled() fails closed when any is missing.
  COLLABORATION_VOICE_ROOMS?: DurableObjectNamespace;
  VOICE_CHAT_ENABLED?: string;
  // Kill switch for live Go lesson execution via the Go Playground proxy
  // (routes/goPlayground.ts). Fails closed: anything but "true" disables Run
  // while Go editing and recorded playback keep working.
  GO_PLAYGROUND_ENABLED?: string;
  // Same kill-switch contract for Kotlin lessons via the Kotlin Playground
  // proxy (routes/kotlinPlayground.ts).
  KOTLIN_PLAYGROUND_ENABLED?: string;
  // Same kill-switch contract for Rust lessons via the Rust Playground proxy
  // (routes/rustPlayground.ts).
  RUST_PLAYGROUND_ENABLED?: string;
  // Private Burmese Studio narration. All three values are required and the
  // requesting user must also have studio.burmese-voxcpm2 enabled in D1.
  // The browser never receives these Modal workspace credentials.
  VOXCPM2_MODAL_ENDPOINT?: string;
  MODAL_PROXY_TOKEN_ID?: string;
  MODAL_PROXY_TOKEN_SECRET?: string;
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_APP_SECRET?: string;
  // Cloudflare Workers KV cache (infra/worker/cache.ts). Optional in the type
  // so self-hosted/test environments can omit it and fall through to D1.
  CACHE?: KVNamespace;
  // Optional in local development. When configured together, QStash handles
  // delayed room cleanup outside the edit path.
  QSTASH_TOKEN?: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
}
