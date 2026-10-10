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
  // Same kill-switch contract for Haskell lessons via the Haskell Playground
  // proxy (routes/haskellPlayground.ts).
  HASKELL_PLAYGROUND_ENABLED?: string;
  // Same kill-switch contract for Kotlin lessons via the Kotlin Playground
  // proxy (routes/kotlinPlayground.ts).
  KOTLIN_PLAYGROUND_ENABLED?: string;
  // Same kill-switch contract for Rust lessons via the Rust Playground proxy
  // (routes/rustPlayground.ts).
  RUST_PLAYGROUND_ENABLED?: string;
  // Same kill-switch contract for Zig lessons via the Zig Playground proxy
  // (routes/zigPlayground.ts).
  ZIG_PLAYGROUND_ENABLED?: string;
  // Per-caller playground budgets, keyed by user id when signed in and by
  // client IP when signed out (Workers Rate Limiting, see the [[ratelimits]]
  // section of infra/wrangler.toml). Like the kill switches above they fail
  // closed: a route whose binding is missing answers 502 instead of proxying.
  GO_RUN_RATE_LIMITER?: RateLimit;
  GO_FORMAT_RATE_LIMITER?: RateLimit;
  RUST_RUN_RATE_LIMITER?: RateLimit;
  RUST_FORMAT_RATE_LIMITER?: RateLimit;
  KOTLIN_RUN_RATE_LIMITER?: RateLimit;
  HASKELL_RUN_RATE_LIMITER?: RateLimit;
  ZIG_UPSTREAM_RATE_LIMITER?: RateLimit;
  // Private Burmese Studio narration. All three values are required and the
  // requesting user must also have studio.burmese-voxcpm2 enabled in D1.
  // The browser never receives these Modal workspace credentials.
  // VOXCPM2_MODAL_JOBS_URL is the base URL of the Modal `jobs` app.
  VOXCPM2_MODAL_JOBS_URL?: string;
  MODAL_PROXY_TOKEN_ID?: string;
  MODAL_PROXY_TOKEN_SECRET?: string;
  // Burmese Studio narration with each user's own AthanLab API key
  // (routes/athanlab.ts). The secret is base64 of exactly 32 random bytes
  // (`openssl rand -base64 32`); it seals the keys stored in D1 with
  // AES-256-GCM (athanlab/keyVault.ts). Missing or malformed, AthanLab
  // narration fails closed. Rotating it makes every stored key unreadable, so
  // users connect their key again.
  ATHANLAB_KEY_ENCRYPTION_SECRET?: string;
  // Per-user AthanLab budgets (Workers Rate Limiting, keyed "user:<id>"): key
  // checks on PUT /api/studio/athanlab/key, and every route that sends a
  // stored key to AthanLab. A missing binding fails closed with a 503.
  ATHANLAB_KEY_RATE_LIMITER?: RateLimit;
  ATHANLAB_API_RATE_LIMITER?: RateLimit;
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_APP_SECRET?: string;
  // Workers KV result cache for the playground routes (infra/worker/cache.ts).
  // Fail-open and optional: an environment that omits it runs them uncached.
  CACHE?: KVNamespace;
  // Optional in local development. When configured together, QStash handles
  // delayed room cleanup outside the edit path.
  QSTASH_TOKEN?: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
}
