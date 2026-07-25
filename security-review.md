# Security review — next-editor

**Scanned revision:** `17a9dcf49c8228ce57652c9db76500d9c21e5a2a` (branch `main`, clean tree)
**Date:** 2026-07-25 · **Scope:** whole repository, ~700 tracked files · **Effort:** high

**Method.** 18 independent component audits (infra worker auth / data routes / outbound-fetch
proxies / collaboration backend / D1 / SSR, `src/core`, `src/storage`, `src/studio`, `src/agent`,
`src/collaboration` + `src/voice`, slide sanitization + iframe bridges, the React and tube clients,
`remote-runtime` agent / worker / protocol client, build config), plus a dedicated secrets sweep and
a cross-cutting breadth sweep. Every candidate was then challenged by a four-lens adversarial
verification panel, which rejected or corrected several claims — those corrections are recorded
below rather than hidden.

**Headline.** Two findings allowed script execution on the app's own origin, both reachable by
publishing an ordinary lesson. One allowed unauthenticated denial of service against the edge
renderer. One allowed a single link click to plant and execute attacker files in a victim's
workspace. The secrets sweep came back clean, including full git history.

---

## Summary

| #   | Finding                                                                  | Severity | Verdict   | Status    |
| --- | ------------------------------------------------------------------------ | -------- | --------- | --------- |
| 1   | Preview iframe replays recorded HTML with `allow-same-origin`            | **High** | Confirmed | ✅ Fixed  |
| 2   | Upload stores attacker-chosen `Content-Type`; `/media` replays it inline | **High** | Confirmed | ✅ Fixed  |
| 3   | SSR lesson text expands as a `String.replace` substitution pattern       | **High** | Confirmed | ✅ Fixed  |
| 4   | Collaboration invite auto-claims on page load → attacker files execute   | **High** | Confirmed | ✅ Fixed  |
| 5   | Empty-body `PATCH` bypasses ownership on lessons and playlists           | Medium   | Confirmed | ✅ Fixed  |
| 6   | Slide sanitizer skips the root element; CSP nonce is a constant          | Medium   | Confirmed | ✅ Fixed  |
| 7   | Open redirect in the OAuth `returnTo` (backslash bypass)                 | Medium   | Confirmed | ✅ Fixed  |
| 8   | Any editor-role peer can permanently brick a collaboration room          | Medium   | Confirmed | ⬜ Open   |
| 9   | Voice DO buffers an unbounded body when `Content-Length` is absent       | Medium   | Confirmed | ✅ Fixed  |
| 10  | `/media` serves collaboration assets with no membership check            | Medium   | Plausible | ✅ Fixed  |
| 11  | `/api/proxy` is an unauthenticated open forward proxy                    | Medium   | Confirmed | ◐ Partial |
| 12  | Playground rate limiters are a non-atomic read-modify-write              | Medium   | Plausible | ⬜ Open   |
| 13  | Voice roster fillable by one member via client-chosen session ids        | Medium   | Confirmed | ⬜ Open   |
| 14  | `.ne` decode has no aggregate decompression cap                          | Medium   | Plausible | ✅ Fixed  |
| 15  | Whiteboard replay folds the entire event array                           | Medium   | Plausible | ⬜ Open   |
| 16  | No Content-Security-Policy on any app response                           | Medium   | Plausible | ⬜ Open   |
| 17  | Login CSRF on `/api/auth/google/onetap`                                  | Low–Med  | Plausible | ⬜ Open   |
| 18  | Prototype-chain lookups in plain-object tables (5 sites)                 | Low      | Confirmed | ✅ Fixed  |
| 19  | `SlidePreview` message handler checks neither origin nor source          | Low      | Confirmed | ✅ Fixed  |
| 20  | Recording-supplied URLs reach media/fetch sinks unvalidated              | Low      | Confirmed | ⬜ Open   |
| 21  | Negative lookups write a KV entry that is never read                     | Low      | Plausible | ✅ Fixed  |
| 22  | Vite dev server serves `infra/.dev.vars`                                 | Low      | Plausible | ✅ Fixed  |
| 23  | Unvalidated slide `sourceUrl` rendered as `<a href>`                     | Low      | Plausible | ✅ Fixed  |
| 24  | Peer display name rendered as Markdown in Monaco hovers                  | Low      | Plausible | ✅ Fixed  |
| 25  | Peer-controlled `tname` grows the victim's Y.Doc                         | Low      | Plausible | ✅ Fixed  |
| 26  | Unbounded orphaned R2 uploads; room create/close storage growth          | Low      | Confirmed | ⬜ Open   |
| 27  | `remote-runtime` pre-deployment hardening (5 issues)                     | Low*     | Plausible | ⬜ Open   |

\* `remote-runtime` is **not deployed** — see §27.

---

## 1. Preview iframe replays recorded HTML with `allow-same-origin` — HIGH ✅ Fixed

**Where:** [RuntimePreviewRenderer.tsx:35](src/components/preview/RuntimePreviewRenderer.tsx),
sink [usePreviewController.ts:196](src/components/preview/usePreviewController.ts)

The preview iframe was declared `sandbox="allow-scripts allow-same-origin allow-forms"` and used for
two different documents. Pointed at the cross-origin WebContainer URL via `src`, the flag is
harmless. Loaded from `srcdoc` it is fatal: an `about:srcdoc` document inherits its _embedder's_
origin, and the flag stops the sandbox forcing an opaque one.

`previewState.content` is replayed verbatim out of the `.ne` file with no sanitizer anywhere on the
path: `?url=` → `fetchNextEditorFile` (accepts any https URL whose path ends `.ne`) →
`replayActions.ts:823` → `usePreviewPlaybackRegistration.ts:326/336` → `writeIframeContent`. The
guard selecting that path (`shouldApplySnapshotContent = !hasPreviewPatchReplay`) is computed from
the same attacker-supplied file, so omitting `previewInitialDocuments`/`previewPatchBatches` selects
it.

**Impact.** Script execution on the app origin: read `localStorage` (including the stored OpenRouter
key), issue credentialed same-origin `/api/*` calls as the viewer, reach `parent.document`. Any
signed-in user can publish a lesson, making this stored XSS against every viewer.

_Panel correction:_ for lessons whose runtime has not booted, the write actually lands in
`patchIframeContentFromHtml`, which `importNode`s attacker nodes into the live document — a cloned
`<script>` does not run, but `on*` attributes and nested `<iframe srcdoc>` do. Both branches
execute; only the mechanism differs.

**Fixed** in `6e2309d`. The frame drops `allow-same-origin` as soon as a recording is loaded, with a
`key` change so React mounts a new element (changing `sandbox` does not re-apply to a loaded
document). **Deliberate trade-off:** on the static-snapshot path the parent can no longer reach into
the frame, so replayed scroll and interaction capture degrade for loaded recordings. The rrweb
replay path that published WebContainer lessons use is unaffected. Restoring full fidelity needs a
nonce-guarded `postMessage` bridge inside the document, as `sandboxedSlideDocument` already does.

---

## 2. Upload stores an attacker-chosen `Content-Type`; `/media` replays it inline — HIGH ✅ Fixed

**Where:** [uploads.ts:73](infra/worker/routes/uploads.ts), served by
[media.ts:32](infra/worker/routes/media.ts)

`PUT /api/uploads/:id/media/:filename` copied `Content-Type` straight from the request header into
R2. No lesson row is required, so any signed-in user can claim a fresh UUID. `GET /media/:key`
replays the stored type via `writeHttpMetadata`, and the Worker is bound to the apex custom domain —
so `/media` is same-origin with the SPA and the session cookie.

`Content-Type: text/html` on a `.png` key therefore yields a same-origin HTML document. The comment
claiming `nosniff` prevented this was wrong: `nosniff` stops the browser sniffing _away from_ a
declared type; a declared `text/html` is still parsed as a document. The filename allow-list
constrains the URL, not the type the browser dispatches on.

The same primitive existed via collaboration assets, whose MIME comes from the uploader's header.

**Fixed** in `722ac2b`. Uploads derive the stored type from the validated extension; `/media` pins
the renderable set and serves anything else as an `octet-stream` attachment, covering collaboration
assets and objects stored before the fix.

---

## 3. SSR lesson text expands as a `String.replace` substitution pattern — HIGH ✅ Fixed

**Where:** [lessonDetail.ts:51,66,75](infra/worker/ssr/lessonDetail.ts)

The metadata rewriters passed their replacement as a _string_, which honours `$&`, `` $` ``, `$'`
and `$1`. The HTML escapers escape `& < > "` but deliberately not `$`, and title/description are
attacker-authored and length-uncapped. `$'` inserts everything following the match, and
`injectLessonDocument` runs eight such passes each over the previous output — so growth is
multiplicative. The panel's own arithmetic against the real `index.html`: a 12-character title and
description reach ~141 MB, and six occurrences each reach ~3.6 GB. An isolate killed for exceeding
its memory limit is not catchable by the route's `try/catch` and takes co-resident requests with it.

The 404 variant needs **no account and no lesson** — any `GET /learn/<anything>` puts the slug into
the payload that becomes `appendToHead`'s replacement. Measured: a 128-character slug produced a
**458,913-byte** response.

_Panel correction:_ two of the five originally cited lines were not defects (`removeMeta` replaces
with `""`; `setCanonical`'s value is slug-derived and `[a-z0-9-]`-constrained). An XSS variant was
investigated and **not** demonstrated — the attacker cannot emit a raw `<`, and the shell contains
no inline script. Reported as denial of service only.

**Fixed** in `e930e55`. All replacements are passed as functions. Two regression tests cover both
paths and fail against the previous code.

---

## 4. Collaboration invite auto-claims on page load — HIGH ✅ Fixed

**Where:** [CollaborationContext.tsx:603](src/contexts/CollaborationContext.tsx) (effect at 595–628)

The effect fires **on mount** whenever the URL carries `?invite=`, calling
`claimCollaborationInvitation` — a state-changing POST that permanently adds the caller to the room.
The server authenticates by session cookie only, with no origin check and no confirmation. There is
no "Join this room?" screen anywhere in the path; the only other reference to `invite` is the link
_builder_.

The panel verified the consequences of one click by a signed-in victim:

- **Their workspace is replaced.** `reprojectCollaborationWorkspace` is called with `baseActionsRef`
  — the _raw_ workspace actions, deliberately bypassing the guarded wrapper whose own comment says
  "Bulk project replacement is disabled in a live room" — reaching `reconcileExternalProject`, which
  replaces `context.project` wholesale.
- **Attacker files then execute.** The projected project carries an attacker-controlled `projectId`
  and `lessonType`; `WebContainerRuntimeProviderImpl` sees the change, clears `hasAutoStartedRef`,
  and auto-starts, running `pnpm install` then `pnpm dev`. `/code` mounts with `runtimeAutoStart`
  defaulting to `true`. So an attacker-authored `package.json` script runs with no further click.
- Identity, active file, cursor and viewport are broadcast to the attacker, and membership persists.

Execution is confined to the WebContainer sandbox, and it is one-click rather than zero-click — but
the file replacement and the auto-run land together.

**Fixed** in `4374536`. The token is staged as `pendingInviteToken` and claimed only from
`acceptInvitation`, called from a real button. The prompt states what accepting does — replaces the
workspace, runs that project, reveals your presence — so the choice is informed rather than implicit.

---

## 5. Empty-body `PATCH` bypasses ownership — MEDIUM ✅ Fixed

**Where:** [queries.ts:306](infra/db/queries.ts), [playlistQueries.ts:248](infra/db/playlistQueries.ts)

Both `updateLesson` and `updatePlaylist` short-circuit when no updatable fields are supplied, and
both returned the _unscoped_ getter — silently discarding `ownerId`. Only the `sets.length > 0` path
carried `owner_id` in its `WHERE`, contrary to both functions' comments.

`PATCH /api/lessons/<id>` with body `{}` returned 200 with any lesson's full row — title, slug,
tags, the `ne` R2 key, and `status`, including drafts the author had unpublished. Lesson ids are not
secret: a published lesson's public JSON carries `ne = media/lessons/<id>/<id>.ne`. The playlist
variant additionally let any signed-in user evict another user's cached playlist entry on demand.

**Fixed** in `739fe87`.

---

## 6. Slide sanitizer skips the root element; CSP nonce is a constant — MEDIUM ✅ Fixed

**Where:** [sanitizeSlideContent.ts:67](src/utils/sanitizeSlideContent.ts),
[sandboxedSlideDocument.ts:6](src/utils/sandboxedSlideDocument.ts)

`FORBIDDEN_ELEMENTS` was only checked inside the `root.querySelectorAll("*")` loop, which enumerates
descendants — never the root. For the SVG branch, where the return value is `root.outerHTML`, a
payload whose root _is_ a forbidden element passed through with its tag intact: `<script>…</script>`
parses as well-formed XML, so `documentElement` was the script, it had no descendants, and it was
re-emitted verbatim. The CSP that should have contained it used a **source-constant nonce**, so
authored markup could spell the value out and be trusted — `script-src 'nonce-<constant>'` was
effectively `'unsafe-inline'`.

`slide.content` is an unconstrained string on every ingestion path: a decoded `.ne`, a studio
LessonScript, and the collaboration teaching document. The studio path is worse than it looks —
`runStudioRender` auto-opens every `google-svg` slide to pre-warm it, so it renders on the
importer's machine before any action runs.

**Impact is bounded** and the report does not overstate it: the frame is opaque-origin with
`connect-src 'none'`, so no app data is reachable. What remains is beacon exfiltration via
`img-src https:`, content spoofing inside a slide that looks like part of the product, and
`postMessage` into the host — which chains into finding 19.

**Fixed** in `86ef403`. The root faces the element check, `nonce` is stripped from authored markup,
and the bridge nonce is generated per page load.

---

## 7. Open redirect in the OAuth `returnTo` — MEDIUM ✅ Fixed

**Where:** [google.ts:52-57](infra/worker/auth/google.ts) (guard), emitted at `:201`

`sanitizeReturnTo` rejects `//host` but not `/\host`. Under the WHATWG URL parser a `\` behaves as
`/` for special schemes (relative state → relative slash state → special authority ignore slashes),
so `Location: /\evil.com` resolves to `https://evil.com/`. Hono does not normalize it. The value is
stored in the signed handshake cookie at `/login` and emitted unmodified at the callback.

The victim completes a genuine Google sign-in on the real domain and lands on the attacker's page —
a high-credibility phishing pivot.

**Fixed** in `d8186b7`. `sanitizeReturnTo` resolves against a placeholder origin and re-serializes,
which collapses `/\`, `/\/` and the tab/newline variants alike, and the callback re-sanitizes rather
than trusting the handshake cookie's stored value.

---

## 8. Any editor-role peer can permanently brick a collaboration room — MEDIUM ⬜ Open

**Where:** [projectDocument.ts:425](src/collaboration/projectDocument.ts)

`schemaVersion` is an ordinary Yjs key on the shared `project` root map, and nothing defends it. The
Durable Object validates only the _teaching_ subtree — `collaborationTransactionTouchesTeaching`
returns true only for the `teaching` key or changes under the teaching root, so a write to
`schemaVersion` is never validated. One `client-update` frame setting it to `2` is applied,
persisted to SQLite, and broadcast.

Every participant's `projectCollaborationDocument` then throws. The error is swallowed into
`setLocalError`, so remote edits stop reaching the workspace, cursors and follow-mode die, and every
write throws. The poisoned value is persisted, so future joins are broken too.

_Panel correction:_ an already-connected client keeps its last good projection (degraded, not
nulled); a fresh join gets nothing. "Unrecoverable" should read "unrecoverable for that room" — the
owner's only remedy is to close it and create a new one, since `seedCollaborationProject` throws if
already seeded.

**Fix:** validate the project root's structural metadata server-side in `acceptDocumentUpdate`,
rejecting updates that change `schemaVersion` or destroy the `nodes`/`texts` maps — the way teaching
transitions are already guarded.

---

## 9. Voice DO buffers an unbounded body when `Content-Length` is absent — MEDIUM ✅ Fixed

**Where:** [collaboration.ts:1049](infra/worker/routes/collaboration.ts),
[voiceDurableObject.ts:854](infra/worker/collaboration/voiceDurableObject.ts)

The Worker's guard is `Number(c.req.header("content-length") ?? "0")` — **a missing header yields 0
and passes**. The forward builds fresh headers and streams the body, so the DO's request has no
`Content-Length` either, and `await request.text()` buffers the _entire_ stream before the 256 KB
check. Every other body reader in this component bounds while streaming; this one does not.

An authenticated member sending a chunked body far larger than the cap can exhaust the Durable
Object's memory, taking every participant's voice session with it.

**Fixed** in `6a7adc5`. The Worker requires a declared `Content-Length` rather than defaulting it,
and the DO reads through a bounded reader that cancels once the cap is passed.

---

## 10. `/media` serves collaboration assets with no membership check — MEDIUM ✅ Fixed

**Where:** [media.ts:26](infra/worker/routes/media.ts)

One R2 bucket holds lesson media _and_ collaboration room assets. The dedicated collaboration read
route enforces session, membership, purge and status checks and serves the bytes defanged. The
`/media` wildcard returns the identical bytes with none of it.

_Panel correction — the original "whole bucket exposed" framing is too strong._ Keys are not
enumerable (no `list` is exposed; room ids are UUIDs, asset ids are SHA-256), and the purge job does
delete the objects. The genuine delta is: a **revoked** member keeps permanent unauthenticated
access to every asset id they saw, since `/media` never re-checks membership; any leaked URL is
permanently public; and the defanging headers are lost.

**Fixed** in `d8186b7`. The wildcard allow-lists `lessons/` and `slide-images/` and 404s everything
else, so a namespace added to this bucket later is private by default.

---

## 11. `/api/proxy` is an unauthenticated open forward proxy — MEDIUM ⬜ Open

**Where:** [proxy.ts:20](infra/worker/routes/proxy.ts)

Mounted with no auth, no host allow-list and no rate limit, with a 200 MiB body cap. Anyone on the
internet gets an anonymizing HTTPS relay billed and attributed to the app's Cloudflare account, and
can serve attacker-chosen bytes from the app's domain. The route exists only to strip CORP from
Google slide images and avatars.

Related, same file: `isPubliclyRoutableHost` does not block IPv4-mapped IPv6 literals —
`new URL("https://[::ffff:127.0.0.1]/").hostname` serializes to `[::ffff:7f00:1]`, which matches
none of the denied prefixes, and the dotted-quad guard never runs because the string contains `:`.
Mitigated by the https-and-port-443 requirement, so metadata endpoints stay out of reach.

**Partially fixed** in `33aae79`: the IPv6 gap is closed — the embedded v4 address is extracted and
run through the v4 rules, and `fe80::/10` is matched as a range rather than as literal text. Public
addresses are covered in both directions by the tests.

**Still open:** the route remains unauthenticated with no host allow-list and a 200 MiB cap. That
part is deliberately left alone — narrowing the destination set touches the avatar and slide-image
paths that depend on it, and getting the allow-list wrong breaks image loading rather than failing
safe. It wants a deliberate decision about which hosts to permit, plus a rate limit.

---

## 12–15. Resource-exhaustion findings — MEDIUM ⬜ Open

- **12 · Playground rate limiters** ([goPlayground.ts:521](infra/worker/routes/goPlayground.ts) and
  the Kotlin/Rust twins). A non-atomic read-modify-write: N concurrent requests all read the same
  count and all write `count+1`, so a burst is admitted wholesale. `cache.get` also passes no
  `cacheTtl`, taking the 60 s colo default on a key that rolls every 60 s — while the repo's own
  cache helper explicitly overrides that elsewhere. _Panel correction:_ "unmetered" is too strong —
  the route requires sign-in and identical sources are content-addressed — but the burst bypass is
  real independent of KV semantics.
- **13 · Voice roster exhaustion**
  ([voiceDurableObject.ts:429](infra/worker/collaboration/voiceDurableObject.ts)). Seats are counted
  per socket keyed on `(userId, collaborationSessionId)`, and `collaborationSessionId` is a
  _client-chosen_ query parameter validated only for UUID shape. One member opening 10 sockets with
  fresh UUIDs fills a 10-seat room and locks out the owner.
- **14 · `.ne` aggregate decompression cap — ✅ Fixed in `33aae79`.**
  ([format.ts:323](src/storage/streamingRecordingCodec/format.ts)). `boundedUnzlib`'s counter is
  per-call, so the 64 MiB cap bounds one _segment_; the only aggregate limits are compressed bytes
  and record count. ~30 segments (~2 MB on the wire) retain ~1.9 GB. Decode starts automatically
  from `?url=` with no user interaction. Victim-tab OOM only — no server impact.
- **15 · Whiteboard replay fold**
  ([whiteboard.ts:56](src/core/src/machine/replayState/whiteboard.ts)). The loop folds _every_ event
  rather than stopping at the playback index, retaining one fully-sorted scene per event. Also
  degrades legitimate long whiteboard recordings, so worth fixing on performance grounds alone.

Related and lower: frame reconstruction walks an attacker-chosen delta chain synchronously on load
([frameDelta.ts:790](src/core/src/utils/frameDelta.ts)) — _panel correction:_ the work is linear in
the file's frame count, not amplified, so this only converts an amortized walk into one synchronous
burst.

---

## 16. No Content-Security-Policy on any app response — MEDIUM ⬜ Open

**Where:** [index.ts:31-44](infra/worker/index.ts)

The single global middleware sets only COEP and COOP. No CSP, no `frame-ancestors`, no
`Referrer-Policy`. The only CSPs in the tree are per-artifact.

_Panel correction:_ this is a missing defence-in-depth control, not a vulnerability with a source →
sink of its own. It is listed because it is the systemic mitigation for finding 1 — `srcdoc`
documents inherit their embedder's policy, so a strict `script-src` would have contained that XSS.

**A naive CSP will break the app.** WebContainer needs `'wasm-unsafe-eval'` and `worker-src blob:`;
Monaco and Excalidraw need `style-src 'unsafe-inline'`. And because srcdoc frames inherit, an
app-level `script-src` would also apply to the slide frames and block their nonce'd bridge unless
the parent policy carried that nonce too — which would weaken the top-level document. Give the
preview and slide frames their own real documents rather than papering over it in one header.

---

## 17–26. Lower-severity findings

- **17 · Login CSRF on `/api/auth/google/onetap`** ([google.ts:107](infra/worker/auth/google.ts)).
  No origin check, no nonce; `c.req.json()` parses a `text/plain` body, so no preflight is needed.
  An attacker supplies an ID token for their _own_ account and the victim is switched into it, so
  later drafts persist under the attacker's `owner_id`. _Panel correction:_ "silent" is overstated —
  the hidden-`fetch` variant is a third-party cookie write that Safari blocks and Chrome/Firefox
  partition; the reliable variant is a top-level form POST, which visibly lands the victim on a JSON
  response. Low–Medium.
- **18 · Prototype-chain lookups — ✅ Fixed in `a5dbb38`.** Plain object literals indexed by
  untrusted strings, where `??` does not fire for an inherited member:
  [StudioController.tsx](src/studio/StudioController.tsx) (`?plan=constructor` crashed the route
  during render, outside any try/catch), [lexicon.ts](src/studio/script/lexicon.ts),
  [workspace.ts](src/types/workspace.ts), [profiles.ts](src/studio/tts/profiles.ts), and the SSR
  image-MIME lookup. **`lexicon.ts` was a real product bug with no attacker at all** — a lesson
  narrating the ordinary word "constructor" spliced `function Object() { [native code] }` into the
  TTS audio and the caption alignment, and that ships in the published lesson.
- **19 · `SlidePreview` message handler — ✅ Fixed in `1fe60f6`.** ([SlidePreview.tsx:73](src/components/SlidePreview.tsx)).
  Validates neither `event.origin` nor `event.source`, then dereferences `payload.type` with no null
  guard. Any frame — including the untrusted preview iframe — can cancel follow-mode and forge a
  `slide_interaction` into the live recording. Every sibling bridge in the repo _does_ check, so
  this is an outlier rather than a design choice. Recording-state corruption only.
- **20 · Recording-supplied URLs at media sinks.** `audio.src`
  ([audioActor.ts:298](src/core/src/machine/audioActor.ts)), `<video src>`
  ([CameraOverlay.tsx:402](src/components/CameraOverlay.tsx)), the preview `iframe.src` fallback
  ([runtimePreview.ts:157](src/components/preview/runtimePreview.ts)), caption `fetch`
  ([useUrlLoader.ts:162](src/hooks/useUrlLoader.ts)) and chat `<img src>` all take a
  recording-declared URL with no scheme allow-list. The header itself is a bare type assertion. Not
  script execution, but arbitrary outbound requests from a victim's browser.
- **21 · Negative KV writes — ✅ Fixed in `1fe60f6`.** ([cache.ts:64](infra/worker/cache.ts)). `JSON.stringify(null)` is
  `"null"`, so the guard passes and a 404 writes an entry the read path then rejects. The comment
  asserting otherwise is wrong. _Panel correction:_ a wasted-write and cost bug, not a DoS —
  entries carry a TTL.
- **22 · Dev server serves `infra/.dev.vars` — ✅ Fixed in `1fe60f6`.** ([vite.config.ts](vite.config.ts)). Vite's default
  `fs.deny` covers `.env*` but not wrangler's secret file, which holds `GOOGLE_CLIENT_SECRET`,
  `SESSION_SECRET`, and the QStash keys. Not reachable from an arbitrary website by default
  (localhost bind, `allowedHosts`, CORS), so it matters when run with `--host` or on a shared host.
- **23 · Slide `sourceUrl` as `<a href>` — ✅ Fixed in `1fe60f6`.** ([SlidesManager.tsx:222](src/components/SlidesManager.tsx)).
  Only the import path validates the URL; the deserialize path does not, and the value is persisted
  to `localStorage`. A `javascript:` URL executes on click once the viewer takes manual control.
- **24 · Peer display name as Markdown — ✅ Fixed in `1fe60f6`.** ([CodeEditor.tsx:870](src/components/CodeEditor.tsx)).
  `hoverMessage` is an `IMarkdownString`; `name` comes from the Google ID token with only a length
  check. Renders a link or remote image in the victim's hover — phishing and an IP beacon. Monaco
  refuses `command:` without `isTrusted`, so no script execution.
- **25 · Peer-controlled `tname` — ✅ Fixed in `33aae79`.** ([monacoAwareness.ts:33](src/collaboration/monacoAwareness.ts)).
  The schema accepts any ≤1024-char `tname` and the DO copies it verbatim; `doc.get(tname)`
  permanently inserts a new root type in the victim's document. _Panel correction:_ the result is
  discarded and empty root types are not encoded into updates, so there is no corruption and no
  cross-client effect — client memory growth only.
- **26 · Unbounded storage.** Uploads have a per-object cap but no per-user quota and require no
  lesson row, so objects can be orphaned beyond the reach of every cleanup path
  ([uploads.ts:71](infra/worker/routes/uploads.ts)). Separately, the room quota counts only _active_
  rooms, so create/close cycles park 4 MB snapshots for a 7-day retention
  ([collaborationQueries.ts:103](infra/db/collaborationQueries.ts)).

---

## 27. `remote-runtime` — pre-deployment hardening, not live ⬜ Open

The panel established from evidence that **`remote-runtime/worker` is not deployed**: no routes or
custom domain in its `wrangler.toml`, a literal `REPLACE_WITH_D1_DATABASE_ID` placeholder, and an
existing test that walks `src/` and `infra/` asserting zero imports of `remote-runtime/`. The live
app uses WebContainer. These are therefore design bugs to fix _before_ wiring it up, not exploitable
today — a correction to the researchers' original severities.

- **Preview ingress is host-agnostic** ([routing.ts:9](remote-runtime/worker/src/routing.ts)).
  `/preview/:sessionId/:port/*` matches on any hostname and is tried before the host-based match;
  `preview()` performs no authentication and passes container headers through, so `text/html`
  survives. If the control plane is ever mounted on the app origin — which the SDK's `/api/runtime`
  default and the design doc both suggest — untrusted container output would execute on the app
  origin. Gate ingress on hostname before deploying.
- **Agent processes binary frames before `session.hello`**
  ([agent.go:412](remote-runtime/agent/agent.go)). The ready gate covers text frames only, and the
  channel lookup uses the agent-_global_ process table, so an unauthenticated peer could write to
  any live process's stdin. Only reachable in the documented direct-attach/docker mode, since the
  Worker gates `/ws`.
- **`/ws` accepts every Origin** ([agent.go:93](remote-runtime/agent/agent.go)) — WebSocket
  handshakes bypass CORS, so any page a developer visits could drive a locally-exposed agent.
- **No read limit; mount cap trusts declared sizes** — `SetReadLimit` is never called, and
  `unpackZip` accounts expansion from the zip header's `UncompressedSize64` rather than bytes
  written, so `HARDENING.md`'s stated limits are not enforced.
- **Client-side:** `zipToTree` caps only _compressed_ size while `unzipSync` allocates the declared
  size ([mountZip.ts:86](remote-runtime/src/remote/mountZip.ts)); an unvalidated wire `port` is
  string-interpolated into the preview URL; `RCP_LIMITS` are never enforced on the client read path
  despite `HARDENING.md` claiming both codecs enforce them.

---

## Secrets sweep — clean

Full tracked tree, all git history across every ref, and the working tree were swept for credential
patterns (Anthropic/OpenAI/AWS/GitHub/Google/Slack/Stripe/Upstash keys, PEM blocks, JWTs, database
URLs, registry tokens, high-entropy blobs). **No committed credential, none in history, and no
server-side secret reaching the browser bundle.**

Verified specifically: `.env` and `.dev.vars` were **never tracked** in any commit; the only
`import.meta.env` reads in browser code are the public PostHog token/host and a boolean flag;
OpenRouter is genuinely BYOK with no server-held key to leak; the Google **client id** returned to
the browser is public by design; `remote-runtime`'s `sessionSecret()` throws rather than defaulting.

Two gaps worth closing before they matter: `.gitignore` has no `*.pem`/`*.key`/`id_rsa*` patterns,
and `.dev.vars` matches only that exact basename, so `infra/.dev.vars.local` would not be ignored.

One stated limitation: `public/lessons/introduction/introduction.ne` is a compressed container; a
binary-aware grep found nothing, but a credential typed _inside_ the recorded editor content would
be compressed and invisible to grep.

---

## What was checked and found sound

Recorded so the clean areas mean "examined", not "skipped":

- **SQL injection** — every D1 statement binds its values. The two dynamic `SET` clauses join only
  function-local literals; `slug.ts`'s `${table}` is a two-member union with literal call sites.
  `LIKE` patterns are escaped with an explicit `ESCAPE`. No dynamic `ORDER BY`/`LIMIT`/column names.
- **Mass assignment** — every route field-picks; `owner_id`, `status`, `slug`, `published_at` are
  server-derived. No body spread into a write.
- **Google ID token verification** — pins RS256, requires `kid`, hardcoded JWKS URL, verifies before
  trusting claims, checks `iss`/`aud`/`exp`.
- **Passkeys/WebAuthn** — identity from `credential.user_id`, never the request body;
  `requireUserVerification` on both ceremonies; HMAC-signed, purpose-tagged challenge cookies;
  counter regression enforced by the library.
- **Sessions** — `crypto.randomUUID()` ids, server-side, 30-day expiry enforced in SQL, rotated on
  login, revoked on logout, never in a URL or log.
- **Collaboration authorization** — membership, status and protocol versions verified in the Worker
  _before_ the socket reaches the DO; the canonical session is injected with `headers.set`,
  overwriting any client-supplied value; privileged messages re-check D1. Identity fields in
  awareness are server-stamped, so peers cannot impersonate.
- **QStash webhooks** — signature verified against the `PUBLIC_URL`-derived destination,
  `devMode: false`, clock tolerance, idempotent handler.
- **Workspace path handling** — `parseWorkspacePath` folds backslashes, strips leading slashes,
  rejects `..` escapes, control characters and `__proto__`/`prototype`/`constructor`. Verified sound
  end-to-end into the WebContainer mount and the zip export.
- **Zip import** (`src/utils/workspaceZipImport.ts`) — entry names go through `parseWorkspacePath`
  before use, and the `unzipSync` filter enforces caps before allocation. (Contrast
  `remote-runtime`'s `mountZip`, §27.)
- **Prototype pollution from decoded data** — `@msgpack/msgpack` rejects a `__proto__` map key
  outright; workspace trees are built with `Object.create(null)`.
- **The Rust WASM diff-match-patch codec** — every `EQUAL`/`DELETE`/`INSERT` is bounds-checked
  before allocation; no reachable panic from a host-supplied delta.
- **The agent's file tools** — all route through the workspace normalizer; `bash` awaits explicit
  confirmation before every spawn; the agent UI renders as React text with no HTML renderer; the
  OpenRouter key is never serialized into a recording.
- **postMessage bridges** — every listener except `SlidePreview` validates `event.source` (several
  also check origin).
- **Studio YAML** — safe loader, no merge keys or type tags, alias-count bounded; no path is built
  from a slug or YAML field; no shell anywhere; the only script-controlled URL is host-pinned.
- **SSR escaping** — every interpolation passes an escaper; `serializeForScript` escapes `<` and the
  line separators, so `</script>` breakout is blocked.
- **rrweb replay** — mounts with `allow-same-origin` but _without_ `allow-scripts`, so recorded DOM
  does not execute.
- **Randomness and crypto** — ids, session ids, room capabilities and OAuth state all use
  `crypto.randomUUID()`/`getRandomValues`; `Math.random` appears only in non-security contexts; no
  MD5/SHA-1/`createCipher`/hardcoded IV; HMACs use `crypto.subtle`.

---

## Remaining work, in order

Eighteen findings are fixed (1–7, 9, 10, 14, 18, 19, 21–25) and one is partially fixed (11). What is
left, most worth doing first:

1. **Finding 8** — room bricking. Validate the project root's structural metadata server-side, so an
   `editor` cannot persist a value that breaks the room for everyone permanently. The largest
   remaining item, and the only remaining one an ordinary participant can trigger.
2. **Finding 13** — count voice seats per `userId`, not per client-chosen session UUID.
3. **Finding 12** — the playground limiter's concurrent-burst bypass. Needs a Durable Object or the
   Rate Limiting binding for an atomic increment; note that `cacheTtl` is _not_ a partial mitigation,
   since KV's minimum is 60 s, the same as the default it already gets.
4. **Finding 11 (rest)** — decide which hosts `/api/proxy` should serve and add a rate limit.
5. **Finding 15** — bound the whiteboard fold by the playback index. Also a straight performance win
   for long legitimate recordings.
6. **Finding 16** — CSP, but only once the preview and slide frames have their own documents; see
   the srcdoc-inheritance trap above. This is also what would restore finding 1's lost scroll and
   interaction fidelity.
7. **Findings 17, 20, 26, 27** — as capacity allows. 27 is dormant code; do it before wiring the
   remote runtime up, not after.

### Deliberately not attempted

Three areas were left alone because a wrong fix would break working behaviour rather than fail safe,
and each needs a product decision rather than a code change:

- **Finding 11's host allow-list** — narrowing it touches avatar and slide-image loading.
- **Finding 16's CSP** — WebContainer, Monaco and the slide frames each need specific directives, and
  srcdoc inheritance means an app-level policy silently governs the slide frames too.
- **Finding 26's storage quotas** — a per-user cap changes when uploads start failing for real users.

Scans are nondeterministic and this complements — does not replace — SAST, dependency scanning and
code review.
