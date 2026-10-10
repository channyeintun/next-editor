# Threat model

## What this project does and where untrusted input enters

Next Editor (nexteditor.dev) is a browser code editor that records and replays narrated coding lessons. It also hosts live collaboration rooms. The front end is a React 19 SPA (`src/`, `tube/src`, `infra/client`). The back end is one Hono Cloudflare Worker (`infra/worker/index.ts`) backed by D1, R2, KV and Durable Objects.

- **No CSP.** The app origin sets only COEP and COOP (`index.ts` ~L46).
- **Cookie auth.** Sessions use the `ne_session` cookie: HttpOnly, SameSite=Lax, and an opaque D1 row id (`auth/session.ts`). `hono/csrf()` guards `/api/*`.

Where untrusted input enters:

- **Anyone, signed in or not:**
  - Sign-in through OAuth, One Tap and passkeys (`infra/worker/auth/`).
  - Public reads: the catalog, search and server-rendered pages (`routes/{lessons,search,authors,playlists}.ts`, `ssr/`), and `/media/*` (`routes/media.ts`).
  - Proxies: `/api/proxy` (`src/shared/proxy.ts`), the OpenRouter relay (`src/shared/openrouterProxy.ts`) and the language playgrounds (`routes/*Playground.ts`).
  - The QStash webhook (`routes/collaborationMaintenance.ts`).
- **Any signed-in account.** Anyone with a Google account can sign up.
  - Lessons and uploads (`routes/uploads.ts`), slide images (`routes/slideImages.ts`) and playlists.
  - AthanLab keys (`athanlab/keyVault.ts`).
  - Creating rooms and claiming invitations.
- **Room members** (viewer < editor < owner):
  - The Yjs WebSocket (`collaboration/roomDurableObject.ts`, `src/collaboration/binaryProtocol.ts`).
  - Room assets.
  - Voice and the SFU proxy (`voiceDurableObject.ts`, `realtimeSfuGateway.ts`).
- **`.ne` lesson files.** These load with no click, either from a published lesson or from `/code?url=<any .ne>`.
  - They are decoded on the app origin (`src/storage/streamingRecordingCodec/`, plus the Rust WASM in `src/core/dmp`).
  - They are replayed into Monaco, Excalidraw, slide and preview iframes, xterm and the WebContainer.
- **Prompt injection** into the bring-your-own-key agent (`src/agent/`), from lesson files, room files and the preview DOM.

## Components that matter most / least

**Most:**

- **Auth:**
  - `auth/google.ts` (state, PKCE, `sanitizeReturnTo`).
  - `auth/googleIdToken.ts`, `auth/passkey.ts` and `auth/requireUser.ts`.
  - `getSessionUser` in `infra/db/queries.ts`.
- **Cross-user authorization:**
  - Owner-scoped SQL in `infra/db/queries.ts` and `playlistQueries.ts`.
  - The owner check in `uploads.ts`, and `isOwnUploadPath` in `lessons.ts`.
- **Script running on the app origin.** With no CSP, this means account takeover and theft of keys stored in localStorage. Places to check:
  - Content types: `RENDERABLE_CONTENT_TYPES` in `media.ts`, and `lessonMediaFiles.ts`.
  - Response headers passed through by the proxy and the OpenRouter relay.
  - Author-written fields spliced into server-rendered pages (`ssr/documentHtml.ts`, `ssr/lessonDetail.ts`).
  - Slide sanitizing (`src/utils/sanitizeSlideContent.ts`, `sandboxedSlideDocument.ts`).
  - The sandbox on the recorded-preview `srcdoc` frame (`shouldAllowSameOriginPreview` in `usePreviewController.ts`).
  - Whiteboard scenes from recordings and rooms, including Excalidraw `iframe` and `embeddable` elements (`src/components/WhiteboardPanel.tsx`).
  - Blob MIME types that a room peer or a recording controls (`src/storage/workspaceAssetStore.ts`, `BinaryFilePreview.tsx`).
- **Collaboration:**
  - Every `getCollaborationRoomAccess` call site, and the identity header set on WebSocket upgrade.
  - The role check in `acceptDocumentUpdate`.
  - Invitation claims (`infra/db/collaborationQueries.ts`).
  - The identity the server stamps on presence (awareness) messages.
  - The Yjs validators that keep an update from permanently breaking a room (`src/collaboration/projectDocument.ts`, `teaching*.ts`).
  - Voice SFU authorization.
- **Secrets:**
  - The AthanLab key vault and `sanitizeAthanLabText`.
  - The Modal secrets in `routes/studio.ts`.
  - The SFU and QStash keys.
- **SSRF:**
  - The redirect loop in `src/shared/proxy.ts`.
  - The Google-hosted slide image fetch in `slideImages.ts`.
  - `fetchSample` in `athanlab.ts`.
- **Decoder robustness:** `streamingRecordingCodec/{format,decode}.ts` and `src/core/dmp/src/lib.rs`.
- **Untrusted lessons auto-running in the WebContainer** with the user's stored environment variables (`src/runtime/webcontainer/environmentVariables.ts`).

**Least:**

- `docs/`, `scripts/`, `share/` and `integrations/modal`.
- The author-only studio in `src/studio`.
- Vite dev-server plugins (`tube/vite/*`).
- The x86 emulator, the Kite compiler and playground output formatting. These run only when the user clicks Run.
- Importing files the user picks.
- Bridge scripts that run inside the preview origin.
- `public/`.
- Generated files: `src/core/dmp/build/*.wasm` and `dist/`.

## How to exercise it

Everything here runs offline:

- **Worker and Durable Object tests:** `npx vitest run --config infra/worker/vitest.config.ts`. Fetch is stubbed.
- **D1 and shared code:** `npx vp test run infra/db src/shared`. `openSqliteD1()` (`infra/db/testing.ts`) is an in-memory D1 with every migration applied.
- **Client:** `npx vp test run src/collaboration src/voice src/storage/streamingRecordingCodec src/core/dmp src/components/preview src/agent`.
- **Typecheck:** `bun run typecheck`.
- **Full stack in one process:** call `app.request(url, init, {DB: openSqliteD1().db, BUCKET: <fake R2>})`, using the default `app` from `infra/worker/index.ts`.
  - Insert `users` and `sessions` rows, then send `Cookie: ne_session=<id>`.
  - POSTs with no body need an `Origin` header that matches the URL.
- **Room Durable Object:** follow `roomDurableObject.test.ts`. It uses `SqliteTestStorage`, `FakeSocket`, and frames built with `binaryProtocol.ts`.
- **Hostile `.ne` files:**
  - Build an SCR3 stream by hand, in this order:
    1. The `SCR3` magic.
    2. A u16 version.
    3. Flags.
    4. A u32 metadata length.
    5. `zlibSync(msgpackEncode(meta))`.
    6. Segments, each a 22-byte header followed by deflated msgpack.
  - Pass the bytes to `decodeRecordingStream()`.
- **Expected results:**
  - User B changing or uploading to user A's lesson gets 404 or 403.
  - HTML uploaded as `x.png` is served as `image/png` with nosniff.
  - `/media/lessons%2F..%2Fcollaboration/x` returns 404.
  - `/api/proxy?url=https://169.254.169.254/` returns 400.
  - A document update sent by a viewer is rejected.

## How you rate severity

Invite links are shared widely, so treat viewers as untrusted. An issue that needs a malicious room member rates **one level lower**, unless it crosses accounts or harms other members' browsers.

- **Critical:**
  - Auth bypass or account takeover.
  - An outsider reading or writing another user's lessons, R2 objects or AthanLab key, or a room's content or audio.
  - Leaked server secrets.
  - Zero-click script execution on nexteditor.dev.
- **High:**
  - XSS on the app origin that needs one user action, such as opening an app-origin `blob:` link.
  - SSRF with real impact.
  - A viewer getting edits saved.
  - A removed member keeping access after revocation.
  - Bypassing invitation expiry or use limits, or gaining a higher role.
  - Impersonating another member.
  - The agent running bash without confirmation, or leaking the user's key.
- **Medium:**
  - Reading another user's drafts through the API, or reading the private `collaboration/` storage through `/media`.
  - Bypassing the VoxCPM2 feature flag.
  - Login CSRF.
  - Breaking a room permanently.
  - Denial of service against a room's Durable Object.
  - A `.ne` file that hangs every viewer.
  - Forged postMessages that the app acts on.
  - Forged QStash jobs.
- **Low:**
  - Script confined to a sandboxed frame, the cross-origin preview or the WebContainer, unless it escapes.
  - Crashing or hanging only your own tab.
  - Abuse of the open proxy and relay.
  - Cost or quota abuse.
  - Clickjacking.
  - Issues that exist only on the dev server.
  - DNS rebinding with no production impact.
  - Issues in the author-only studio tooling.
- **Informational:** missing hardening with no exploit.

## Anything to leave alone

- **Third parties:**
  - The playground hosts, openrouter.ai, AthanLab, Modal, Google and the Cloudflare SFU.
  - WebContainer and StackBlitz internals.
  - `node_modules`, except where our code feeds a library untrusted input.
- **Analytics:** PostHog and Cloudflare analytics.
- **Intended public reads:**
  - The published catalog.
  - Unauthenticated `/media/*`. Drafts are protected only by an unguessable id, so report only a new way to learn one.
- **Owner decisions:**
  - `/api/proxy` and the OpenRouter relay are anonymous by design.
  - Playground runs need no sign-in.
  - The OAuth callback reads its id_token without verifying the signature. The token comes server-to-server from Google.
  - The passkey relying-party ID is taken from a localhost Origin.
  - Session ids are stored unhashed.
  - There is no frame-ancestors policy, because lessons are embedded on other sites.
  - The live preview keeps `allow-same-origin`.
  - Lessons and rooms auto-run in the WebContainer.
  - Of the agent's tools, only bash needs confirmation.
  - Viewers can read all room content.
  - Access is rechecked only every 5 seconds.
  - Voice is open to every role.
  - Durable Objects trust headers that the Worker sets.
- **Already fixed.** Report these only if they come back:
  - `..` in lesson ids.
  - The KV page cache.
  - Unbounded metadata.
  - Go txtar marker injection.
  - `$'` replacement in server-rendered pages.
  - The empty-PATCH read oracle.
  - C-005 and C-018.
  - Unbounded inflation.
  - dmp allocator overflow.
- **Stale hints:** `docs/security-scan-2026-08-08-unverified-candidates.md` lists an earlier scan's unverified candidates; verify against the code.
