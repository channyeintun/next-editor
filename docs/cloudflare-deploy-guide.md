# Deploying Tube to Cloudflare

A practical runbook for deploying/redeploying the Cloudflare Worker that
serves the whole app (SPA + `/api/*` + `/media/*`) — see
[cloudflare-architecture.md](./cloudflare-architecture.md) for the _why_. This
doc is the "how do I ship a change / set this up from scratch" reference.

## Prerequisites

- `wrangler` (already a devDependency — `bunx wrangler` or `npx wrangler` from
  `infra/` picks it up)
- Authenticated: `npx wrangler login` (opens a browser) or a
  `CLOUDFLARE_API_TOKEN` env var
- `bun` installed (package manager for this repo)

## Regular deploy (the common case)

Once everything below is set up, shipping a change is two commands:

```sh
bun run build          # from the repo root — builds dist/
cd infra
npx wrangler deploy    # uploads the Worker + dist/ as static assets
```

`wrangler deploy` reads `infra/wrangler.toml`, which points `[assets]` at
`../dist` (the just-built SPA) and the Worker entry at `./worker/index.ts`.
Static assets are uploaded incrementally — only new/changed files get
re-uploaded — so most deploys are fast.

**Smoke test after every deploy** (replace the domain if not yet cut over,
use the `*.workers.dev` URL instead):

```sh
curl -s https://<your-domain>/api/health                      # {"status":"ok"}
curl -sI https://<your-domain>/api/health | grep -i cross-origin  # COEP/COOP present
curl -s https://<your-domain>/lessons/page-0.json              # seed catalog
curl -s https://<your-domain>/api/lessons                      # D1-backed gallery
```

If COEP/COOP headers are missing on a _static asset_ specifically (not an
`/api/*` route), check `run_worker_first = true` is still set in
`wrangler.toml`'s `[assets]` block — without it, exact-match static files
bypass the Worker (and its header middleware) entirely.

## One-time setup (fresh Cloudflare account / disaster recovery)

### 1. Create the D1 database

```sh
cd infra
npx wrangler d1 create next-editor-tube
```

Copy the `database_id` from the output into `infra/wrangler.toml`'s
`[[d1_databases]]` block (replacing whatever placeholder/old id is there).

### 2. Create the R2 bucket

```sh
npx wrangler r2 bucket create next-editor-tube-media
```

No id to copy — `wrangler.toml` only needs the bucket name, already there.

### 3. Apply the D1 schema to the real (remote) database

```sh
npx wrangler d1 migrations apply next-editor-tube --remote
```

Verify:

```sh
npx wrangler d1 execute next-editor-tube --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
# expect: users, sessions, lessons, playlists, playlist_lessons,
# collaboration_rooms, collaboration_members (plus D1's internal tables)
```

### 4. Set production secrets

**Never pass secret values as CLI arguments or via `echo` — they'd end up in
shell history and process listings.** Pipe from a file instead, then delete
the file immediately:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID     < /path/to/tmpfile
npx wrangler secret put GOOGLE_CLIENT_SECRET < /path/to/tmpfile
npx wrangler secret put SESSION_SECRET       < /path/to/tmpfile   # openssl rand -hex 32
```

Use a **different** `SESSION_SECRET` than local dev's `infra/.dev.vars` —
it's what signs the OAuth handshake cookie, no reason to share it across
environments.

### 5. First deploy (no custom domain yet)

```sh
bun run build
cd infra
npx wrangler deploy
```

Without a `[[routes]]` entry in `wrangler.toml`, this deploys to the free
`https://<worker-name>.<your-subdomain>.workers.dev` URL. Smoke test there
first (see above) before touching any domain/DNS.

### Optional: Upstash Redis cache

The lessons list/detail endpoints read through an optional cache (see
[cloudflare-architecture.md](./cloudflare-architecture.md#caching--optional-upstash-redis-layer)).
The app runs fine without it — skip this if you don't want the dependency yet.

1. Create a free Redis database at https://console.upstash.com (Regional or
   Global — Global is closer to Workers' edge locations).
2. Set **both** the REST URL and token as secrets — same "pipe from a file,
   then delete it" caution as step 4 above. Neither belongs in `wrangler.toml`
   as a plaintext var (unlike `PUBLIC_URL`): the URL is project-identifying
   and the token is a bearer credential for it, so both are secrets, not
   vars committed to the repo.
   ```sh
   npx wrangler secret put UPSTASH_REDIS_REST_URL   < /path/to/tmpfile
   npx wrangler secret put UPSTASH_REDIS_REST_TOKEN < /path/to/tmpfile
   ```
3. Redeploy (`npx wrangler deploy`). No D1/R2/schema changes needed — the
   cache layer is purely additive.

### Required when enabling live collaboration: Upstash Redis data plane

Live collaboration is fail-closed and does not reuse the optional cache
configuration implicitly. Create a dedicated production Redis database, then
set its REST URL and token with the same secret-handling precautions:

```sh
npx wrangler secret put COLLAB_REDIS_REST_URL   < /path/to/tmpfile
npx wrangler secret put COLLAB_REDIS_REST_TOKEN < /path/to/tmpfile
```

Local development may explicitly set the collaboration and cache variables to
the same free database, but production should keep their budgets, retention,
and failure modes separate. Apply D1 migrations before deploying so
`collaboration_rooms` and `collaboration_members` exist. The Worker returns
`503 collaboration unavailable` from collaboration data-plane routes when the
dedicated credentials are absent; unrelated editor and gallery routes continue
to operate.

## Custom domain cutover

This is the part with real gotchas — read this section before running
anything.

### Step 1 — Add the domain to Cloudflare and point nameservers at it

Cloudflare has to be the domain's DNS host for a Custom Domain to work, even
if you only intend to route one subdomain to the Worker:

1. dash.cloudflare.com → **Add a domain** → enter the domain → **Free** plan
2. Let Cloudflare scan/import the existing DNS records (so nothing currently
   working breaks when nameservers switch)
3. Cloudflare gives you two nameservers (`xxx.ns.cloudflare.com`,
   `yyy.ns.cloudflare.com`) — set those at wherever the domain is
   **registered** (may or may not be the same place it's currently hosted)
4. Wait for Cloudflare to show the zone as Active. Public resolvers (Google
   `8.8.8.8`, Cloudflare `1.1.1.1`) usually pick this up within minutes; your
   _own_ device/ISP resolver can lag much longer (see Troubleshooting).

### Step 2 — Update `wrangler.toml`

```toml
[vars]
PUBLIC_URL = "https://<your-domain>"   # must exactly match what you register in Google Cloud Console

[[routes]]
pattern = "<your-domain>"   # bare hostname, NO path glob — Custom Domains
custom_domain = true        # cover every path by design, unlike a plain Route
```

(Verified against Cloudflare's own docs, not assumed: Custom Domain
`pattern` is a bare hostname; a plain Workers Route uses a path glob like
`"example.com/*"` instead.)

### Step 3 — Register the production OAuth redirect URI

In Google Cloud Console (the same OAuth client used for local dev), add
under **Authorized redirect URIs**:

```
https://<your-domain>/api/auth/google/callback
```

The exact full path, not just the origin — Google matches this byte-for-byte.

### Step 4 — Deploy

```sh
bun run build
cd infra
npx wrangler deploy
```

**If this fails with a 409 Conflict** on
`.../workers/scripts/<name>/domains/records`: Cloudflare imported an
existing DNS record at your domain's bare hostname when the zone was added
(e.g. old A records pointing at a previous host), and refuses to silently
overwrite a record at a name the Custom Domain needs to claim.

Fix: in the Cloudflare dashboard → **DNS → Records**, delete _only_ the
record(s) for the bare domain itself (not `www`, not wildcard, not `CAA`,
not any `_domainconnect`-style artifacts — those are unrelated). Then
re-run `wrangler deploy`.

### Step 5 — Verify for real

DNS propagation to _your own_ resolver can lag well behind public resolvers
even after the zone is active. To verify the deploy itself is correct
without waiting on that:

```sh
FRESH_IP=$(dig @1.1.1.1 <your-domain> +short | head -1)
curl -s --resolve <your-domain>:443:$FRESH_IP https://<your-domain>/api/health
curl -sI --resolve <your-domain>:443:$FRESH_IP https://<your-domain>/api/health | grep -i cross-origin
curl -sI --resolve <your-domain>:443:$FRESH_IP "https://<your-domain>/api/auth/google/login" | grep -i location
# confirm the redirect_uri in that Location header matches Google Cloud Console exactly
```

If that all checks out, the deploy is correct — any remaining "site looks
wrong" report from a real device is DNS propagation, not the deploy (see
Troubleshooting).

## Rollback

```sh
cd infra
npx wrangler rollback              # back to the previous version
npx wrangler versions list         # to pick a specific earlier version instead
```

Since this is a full domain cutover (not a subdomain trial), the other
rollback lever is DNS: re-add the previous host's A/CNAME records for the
bare domain (whatever they were before cutover) and remove/disable the
`[[routes]]` Custom Domain. Slower than `wrangler rollback` (DNS
propagation again), but available if the Worker itself is somehow
unusable.

## Troubleshooting

- **"Cannot find module 'hono'" (or `hono/cookie`) during `wrangler dev`/`deploy`**:
  esbuild's Yarn PnP detection can walk up past the repo root and false-positive
  on an unrelated `.pnp.cjs` elsewhere on the machine. Fix is already in
  `wrangler.toml`'s `[alias]` block (`hono = "hono"`, `"hono/cookie" = "hono/cookie"`)
  — if a _new_ package hits this, add it there too (Cloudflare's own documented
  workaround).
- **A worker-side file typechecks under the root `tsc -b tsconfig.json` but fails
  under `infra/worker/tsconfig.json`**: the root config's `@app/*` alias is a
  Vite-only alias — Wrangler's bundler doesn't read `vite.config.ts` at all, so
  worker code needs relative imports like every other file under `infra/worker/`.
- **"It works when you curl it but my browser/phone still shows the old site"**:
  DNS propagation lag on that specific device/network, not a real problem —
  confirm by checking `https://www.whatsmydns.net/#A/<your-domain>` (shows
  resolution from many global resolvers at once) or by querying `8.8.8.8`/`1.1.1.1`
  directly with `dig`. Public resolvers usually catch up in minutes; a specific
  ISP/router/device cache can take much longer. Flushing the local machine's DNS
  cache only fixes that one machine, not the underlying propagation.
- **Custom Domain deploy 409s** — see "Custom domain cutover" Step 4 above.
