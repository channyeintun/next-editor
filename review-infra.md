# Code review — `infra/`

Scope: the Cloudflare Worker (`worker/`), D1 access layer (`db/`), and the
client SDK (`client/`) that the host app and `tube/` consume. Reviewed for
correctness and security; nothing implemented.

Overall this is careful, well-commented code — parameterized SQL everywhere,
owner checks pushed into the `WHERE` clause (not post-hoc), PKCE + signed-state
OAuth, `sanitizeReturnTo` against open redirects, the `isAllowedImageHost`
suffix check against SSRF. The findings below are the exceptions.

---

## High

### H1 — Stored XSS: user SVGs are served as active content from the app's own origin

**Files:** `worker/routes/media.ts:21-47`, `worker/routes/uploads.ts:16` &
`:41-43`, `client/upload/resizeThumbnail.ts:10`,
`client/upload/thumbnailConstraints.ts:1`

SVG is an allowed thumbnail type through the entire pipeline:

- The upload filename allow-list includes `svg` (`uploads.ts:16`).
- `resizeThumbnail` passes `image/svg+xml` through **unchanged** (`resizeThumbnail.ts:10`) — no rasterization, no sanitization.
- `uploads.ts:41-43` stores the object with `contentType` taken straight from the request header (attacker-controlled).
- `media.ts` re-emits that stored content-type verbatim via `object.writeHttpMetadata(headers)` and returns the raw bytes. There is no `Content-Security-Policy`, no `X-Content-Type-Options: nosniff`, and no `Content-Disposition: attachment` (confirmed: no such header anywhere in `infra/`).

`/media/*` is served by the same Worker, on the same origin (`nexteditor.dev`),
as the app itself. An SVG can contain `<script>`, and when a document is
navigated to directly (not loaded via `<img>`), that script executes **in the
app's origin**. So:

1. Any signed-in user PUTs `/api/uploads/<any-uuid>/media/x.svg` with a
   `<script>` payload — this does **not** even require creating or publishing a
   lesson (the route allows writing media under a fresh id with no row yet,
   `uploads.ts:25-34`).
2. They share `https://nexteditor.dev/media/lessons/<uuid>/x.svg` (for a
   published lesson this URL is also publicly exposed in the lesson's
   `thumbnail` field).
3. A victim who opens the link runs attacker JS on `nexteditor.dev`, which can
   then call the same-origin authenticated APIs (`DELETE /api/lessons/:id`,
   `PATCH /api/auth/username`, etc.) with the victim's session cookie.

The `httpOnly` cookie and `COEP: require-corp` do **not** mitigate this — COEP
governs sub-resource embedding, not top-level navigation script execution.

**Recommendation (any one closes it):** drop `svg` from the upload allow-list
and the client `accept` list; **or** on `/media/*` set
`Content-Security-Policy: default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff`, and `Content-Disposition: attachment` (plus
force a non-executable content-type for `.svg`). The `nosniff` header is worth
adding regardless, so a mislabeled non-SVG upload can't be sniffed into HTML.

---

## Medium

### M1 — Uploads have no server-side size limit

**File:** `worker/routes/uploads.ts:36-43`

The route streams `c.req.raw.body` straight into R2 with no byte cap and no
per-user quota. The only size check (`MAX_THUMBNAIL_BYTES = 5MB`,
`thumbnailConstraints.ts`) is **client-side** and trivially bypassed by hitting
the PUT directly. Any signed-in user can:

- write arbitrarily large objects, and
- write unlimited objects under arbitrary `lessons/<uuid>/…` prefixes without
  ever creating a lesson row (so nothing associates them with a deletable
  lesson).

This is an unmetered storage/cost abuse vector. Consider a `Content-Length`
check (reject over N MB) before the `BUCKET.put`, and/or a per-user object
budget. (The `.ne`/media allow-list on the extension helps, but not on size or
count.)

### M2 — `/media/*` serves any R2 key publicly with `immutable` caching and no published check

**File:** `worker/routes/media.ts:15-47`

Every R2 key is served to anyone, with `cache-control: public, max-age=31536000,
immutable`. Draft-lesson media (the `.ne` recording, thumbnails) is therefore
publicly readable to anyone who knows the key — the only protection is that the
key embeds a UUID (security-through-obscurity). For published lessons the code
comments correctly note the keys are already public; for **drafts** this means
"unpublished" is not actually private at the bytes level. If draft privacy is a
requirement, gate `/media` for non-published objects behind an ownership check;
if it's acceptable-by-design, a one-line comment saying so would prevent a
future regression from assuming drafts are private.

---

## Low

### L1 — Concurrent first-sign-in can 500 on a username collision; taken-username detection is string-fragile

**File:** `db/queries.ts:25-35`, `:90-101`, `:345-370`

- `generateUniqueUsername` (`:25`) does a check-then-insert with no
  transaction. Two brand-new users signing up concurrently can both slugify to
  the same base, both see it free, and both `INSERT`; the loser trips the
  `UNIQUE(username)` index. The `upsertUserByGoogleSub` catch (`:90-101`) only
  anticipates a `google_sub` race — it re-`SELECT`s by `google_sub`, finds
  nothing (different user), and re-throws → a 500 for the losing signup instead
  of retrying with a new suffix. Rare, but a real latent bug; the catch comment
  only covers the `google_sub` case.
- `updateUsername` (`:365`) detects "taken" via
  `String(error).includes("UNIQUE")`. If D1's error wording ever changes, a
  taken username surfaces as a 500 rather than the intended 409. Matching on
  the message text is brittle; consider a pre-check `SELECT` (accepting the
  small TOCTOU window this exact function otherwise races) or asserting on a
  more stable error property.
- Related: `email` is `UNIQUE NOT NULL` (migration `0001`), but the login
  `UPDATE` (`:54-61`) refreshes `email` on every sign-in. If two Google
  identities ever present the same email, that update violates the constraint
  and throws. Unlikely with real Google accounts, worth being aware of.

### L2 — `LIKE` search: query not length-capped and wildcards unescaped

**File:** `db/queries.ts:388-395` (`searchUsers`), `:401-417` (`searchPublishedLessons`)

`q` is interpolated into `` `%${q}%` `` and bound (so no SQL injection), but:

- `%`, `_`, and `\` in `q` act as LIKE metacharacters — e.g. a query of `%`
  matches every row. Minor, but it makes user search behave surprisingly.
- `q` is only `.trim()`-ed upstream (`worker/routes/search.ts:16`), never
  length-limited. A long `%…%` term forces a full-table scan (a leading `%`
  precludes index use). Add a length cap and escape LIKE metacharacters with an
  `ESCAPE` clause.

### L3 — CSRF relies solely on `SameSite=Lax`; expired sessions are never reaped

**File:** `worker/auth/session.ts:27-35`, `db/queries.ts:121-131`

- Mutations are cookie-authenticated with no CSRF token; the defense is
  `SameSite=Lax` + the same-origin-only API (no CORS). That's a legitimate,
  common mitigation — flagging only so it's a conscious choice. Cross-site
  `POST`/`PATCH`/`DELETE` won't carry a Lax cookie, so this holds today; it
  would break if CORS or a cross-origin surface is ever added.
- `getSessionUser` filters on `expires_at > now`, but nothing deletes expired
  rows (the `sessions` table grows unbounded). The code references a "Phase 4
  reconcile cron" elsewhere — a session-sweep belongs there too.

---

## Notes (no action needed)

- OAuth `id_token` signature/`aud`/`iss` are intentionally not verified because
  the token is fetched server-to-server from Google's token endpoint
  (`auth/google.ts:57-70`). The reasoning is sound and well-documented; re-add
  JWKS verification only if id_tokens ever arrive from the client.
- `.dev.vars` and `.wrangler/` are correctly git-ignored (verified) — no
  secrets are tracked.
- `updateLesson`'s dynamic `SET` uses a fixed column whitelist with only values
  bound; parameter/placeholder order checked and correct (`db/queries.ts:242-277`).
- The `worker/index.ts` global COEP/COOP wrapper rebuilds every response
  (needed for immutable ASSETS/Fetcher headers) — correct, and it preserves
  streaming/range bodies.
