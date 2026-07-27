# Private Burmese narration with VoxCPM2 on Modal

This integration keeps English Studio narration on the existing in-browser
Pocket-TTS path. Burmese narration uses VoxCPM2 in a Modal workspace and is
available only when the signed-in user has the
`studio.burmese-voxcpm2` D1 feature flag.

## Request path

1. `GET /api/studio/capabilities` checks the session, D1 flag, and Modal
   configuration. The Studio shows `မြန်မာ · VoxCPM2 (Modal)` only when all
   are present.
2. The user records or uploads 5–20 seconds of the narrator. Each uncached
   Burmese dialog posts the text, seed, and that same PCM16 reference WAV to
   `POST /api/studio/tts/voxcpm2`.
3. The Worker rechecks the session and D1 flag, then calls the private Modal
   Web Function with Modal proxy-auth headers. It accepts only mono 24 kHz
   PCM16 reference audio within the duration bound.
4. The browser receives PCM16 mono WAV audio and keeps using the existing
   dialog cache, scheduler, stitcher, captions, and render pipeline.

Next Editor does not add a synthesis timeout to the upstream request. It waits
until Modal responds or the client or hosting infrastructure closes the
connection.

The selected sample stays in browser IndexedDB between runs. It is sent
transiently for each uncached Burmese dialog, used as VoxCPM2's
`reference_wav_path`, and discarded at the end of that request. The Worker and
Modal function do not persist or log it. Reusing the recording fixes the
speaker identity; the server-pinned `burmese-educator-v3` prompt fixes delivery.

The prompt text lives only in `integrations/modal/voxcpm2_tts.py` and is never
sent by the client. `voiceDesignId` in `src/studio/tts/profiles.ts` carries its
version into the per-dialog TTS request hash, so the two must be bumped
together: editing the prompt alone leaves every cached dialog on the old
delivery, and redeploying Modal alone changes nothing the browser asks for.

UI visibility is not authorization. Calling the synthesis endpoint directly
without the D1 flag returns `403`, and the Modal credentials never reach the
browser.

## 1. Deploy VoxCPM2 in your Modal workspace

The deployment pins:

- `voxcpm==2.0.3`
- `openbmb/VoxCPM2` revision
  `bffb3df5a29440629464e5e839f4d214c8714c3d`
- 48 kHz PCM16 WAV, CFG 2.0, and 10 inference steps
- the `burmese-educator-v3` delivery prompt plus a required 5–20 second
  per-render narrator reference
- eager CUDA inference; VoxCPM's `torch.compile` warm-up is disabled because it
  exceeds the Web Function proxy deadline on an L4 cold start
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

Choose `မြန်မာ · VoxCPM2 (Modal)`, then record or upload 5–20 seconds of clear
narrator speech before rendering. Studio rejects a missing reference, a
Burmese provider paired with a non-Burmese script, or the reverse pairing. The
provider option selects TTS; it does not translate English narration.

Previously synthesized dialogs remain in the browser's content-addressed
cache. Clear that site's IndexedDB only when intentionally forcing fresh
Modal synthesis.
