# Standalone Cloudflare control plane

This Worker is intentionally separate from the editor's existing `infra/` deployment. It provisions
one Cloudflare Container per Go 1.26.5 session through `RuntimeGoSessionDO`.

## Before deployment

Complete `../../docs/remote-runtime-cloudflare-setup.md` first:

1. Enable the Workers Paid plan and Containers.
2. Choose preview hostname Option A, B, or C and create its proxied wildcard DNS record.
3. Set `PREVIEW_URL_TEMPLATE` in `wrangler.toml`, then add the matching Worker wildcard route.
   The checked-in path template is deliberately local-only so no hostname choice is guessed.
4. Replace the D1 `database_id` placeholder after creating the standalone quota database.
5. Store a 32-byte-or-longer `RUNTIME_SESSION_SECRET` with
   `bunx wrangler secret put RUNTIME_SESSION_SECRET`.

The API expects an externally issued HMAC bearer token containing `{ "userId", "exp" }`, signed with
the same secret. The editor integration phase should replace that boundary with the application's
normal session authentication; it is not wired here.

Apply the local quota migration explicitly:

```sh
bunx wrangler d1 migrations apply next-editor-remote-runtime --local
```

Applying it to remote D1 is a separate, explicitly authorized operation. Do not combine it with a
deploy.

## Local development

Docker must be running. From this directory:

```sh
bun install
bun run typecheck
bun run dev
```

Path previews use `http://localhost:8787/preview/{{sessionId}}/{{port}}`. Production preview
responses strip cookies and set `Cross-Origin-Resource-Policy: cross-origin` plus
`Cross-Origin-Embedder-Policy: unsafe-none`.

## Deployment

After completing the manual prerequisites, `bunx wrangler deploy` builds the self-contained
root-level `Dockerfile.go1.26.5` for `linux/amd64` (with the package root as its build context) and
pushes it to Cloudflare's managed registry. Remote D1
migrations are never implicit. Periodically inspect old images with
`bunx wrangler containers images list` to stay below the account image-storage cap.
