import type { Env } from "./env";

// The Workers KV result cache of the playground routes
// (routes/{go,kotlin,rust,zig,haskell}Playground.ts), keyed by the program's
// content hash under each route's own `<x>p:` prefix.
//
// The public lesson and playlist catalog used to read through KV as well, and
// no longer does: those reads query D1 directly (lessonCatalog.ts,
// routes/lessons.ts, routes/playlists.ts). KV's colo read cache only lasts 30 s,
// and at this site's traffic almost every catalog read fell outside it and paid
// KV's central store (~180-195 ms from Singapore), against ~55-90 ms for the
// indexed D1 query it was there to save. Reading D1 also makes a publish,
// unpublish or edit visible immediately rather than after a TTL. The playground
// keeps KV because the upstream compile it saves takes seconds.
//
// The checked-in Wrangler config provides this binding, but keeping it
// optional lets self-hosted/test environments omit it: the playground routes
// then run uncached against their upstream. Their per-caller rate limit never
// touches KV: the *_RATE_LIMITER bindings (see env.d.ts) enforce it.
export function getCache(env: Env): KVNamespace | null {
  return env.CACHE ?? null;
}
