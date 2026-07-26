# Private Burmese narration with VoxCPM2 on Modal

This integration keeps English Studio narration on the existing in-browser
Pocket-TTS path. Burmese narration uses VoxCPM2 in a Modal workspace and is
available only when the signed-in user has the
`studio.burmese-voxcpm2` D1 feature flag.

## Request path

1. `GET /api/studio/capabilities` checks the session, D1 flag, and Modal
   configuration. The Studio shows `မြန်မာ · VoxCPM2 (Modal)` only when all
   are present.
2. Each uncached Burmese dialog is posted to
   `POST /api/studio/tts/voxcpm2`.
3. The Worker rechecks the session and D1 flag, then calls the private Modal
   Web Function with Modal proxy-auth headers.
4. The browser receives PCM16 mono WAV audio and keeps using the existing
   dialog cache, scheduler, stitcher, captions, and render pipeline.

UI visibility is not authorization. Calling the synthesis endpoint directly
without the D1 flag returns `403`, and the Modal credentials never reach the
browser.

## 1. Deploy VoxCPM2 in your Modal workspace

The deployment pins:

- `voxcpm==2.0.3`
- `openbmb/VoxCPM2` revision
  `bffb3df5a29440629464e5e839f4d214c8714c3d`
- 48 kHz PCM16 WAV, CFG 2.0, and 10 inference steps
- one L4 container maximum, scaling to zero after one idle minute

Authenticate the Modal CLI, then deploy from the repository root:

```sh
python -m pip install modal
modal setup
modal deploy integrations/modal/voxcpm2_tts.py
```

Copy the `synthesize` Web Function URL printed by `modal deploy`. It must be an
HTTPS `*.modal.run` URL.

Create a proxy token for the Modal workspace:

```sh
modal workspace proxy-tokens create
```

Save the printed `wk-...` token ID and one-time `ws-...` secret. If Modal RBAC
is enabled, allow that token in the environment containing the deployment:

```sh
modal workspace proxy-tokens allow wk-REPLACE_ME main
```

Modal rejects bad proxy credentials before starting a GPU container.

## 2. Configure the Cloudflare Worker

Store all three values as Worker secrets:

```sh
bunx wrangler secret put VOXCPM2_MODAL_ENDPOINT --config infra/wrangler.toml
bunx wrangler secret put MODAL_PROXY_TOKEN_ID --config infra/wrangler.toml
bunx wrangler secret put MODAL_PROXY_TOKEN_SECRET --config infra/wrangler.toml
```

Use the full Web Function URL for `VOXCPM2_MODAL_ENDPOINT`, the `wk-...` value
for `MODAL_PROXY_TOKEN_ID`, and the `ws-...` value for
`MODAL_PROXY_TOKEN_SECRET`.

For local development, put the same names in `infra/.dev.vars`, which is
gitignored, and run both servers with `bun run dev:all`.

## 3. Apply the D1 migration

Apply migrations before enabling anyone:

```sh
bunx wrangler d1 migrations apply next-editor-tube --remote --config infra/wrangler.toml
```

Find the exact user ID:

```sh
bunx wrangler d1 execute next-editor-tube --remote --config infra/wrangler.toml \
  --command "SELECT id, email, username FROM users ORDER BY created_at DESC;"
```

Enable only that user:

```sh
bunx wrangler d1 execute next-editor-tube --remote --config infra/wrangler.toml \
  --command "INSERT INTO user_feature_flags (user_id, feature_key, enabled, updated_at) VALUES ('USER_UUID', 'studio.burmese-voxcpm2', 1, unixepoch() * 1000) ON CONFLICT(user_id, feature_key) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at;"
```

Disable the capability without deleting history:

```sh
bunx wrangler d1 execute next-editor-tube --remote --config infra/wrangler.toml \
  --command "UPDATE user_feature_flags SET enabled = 0, updated_at = unixepoch() * 1000 WHERE user_id = 'USER_UUID' AND feature_key = 'studio.burmese-voxcpm2';"
```

The capability query is cached in the browser for up to one minute. The
synthesis endpoint checks D1 on every request, so disabling takes effect for
new synthesis immediately even if an open page still shows the option.

## 4. Use it in Studio

Import a LessonScript whose locale is Burmese:

```yaml
lesson:
  locale: my-MM
```

Choose `မြန်မာ · VoxCPM2 (Modal)` before rendering. Studio rejects a Burmese
provider paired with a non-Burmese script (and vice versa); this option selects
TTS, it does not translate English narration.

Previously synthesized dialogs remain in the browser's content-addressed
cache. Clear that site's IndexedDB only when intentionally forcing fresh
Modal synthesis.
