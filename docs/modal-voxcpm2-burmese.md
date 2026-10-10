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
   Burmese dialog posts the text (as written — the English pronunciation
   lexicon is not applied), seed, and that same PCM16 reference WAV to
   `POST /api/studio/tts/voxcpm2`.
3. The Worker rechecks the session and D1 flag and accepts only mono 24 kHz
   PCM16 reference audio within the duration bound. With Modal proxy-auth
   headers it then submits a job to the private Modal `jobs` app
   (`POST /jobs`), which validates the request on a CPU container and spawns
   the GPU synthesis, and polls that job (`GET /jobs/{id}`) until the audio is
   ready.
4. The browser receives PCM16 mono WAV audio and keeps using the existing
   dialog cache, scheduler, stitcher, captions, and render pipeline.

### Why a job, not one request

The first dialog of a render usually meets a cold L4 container: about 10 s to
boot, 23 s to load the model, and 27 s of first-inference warm-up before the
first generation step, plus however long Modal waits for a free GPU. Cloudflare
ends a Worker subrequest that has sent no response within its proxy read
timeout (125 s; not configurable below Enterprise) with HTTP 524, and a render
failed that way on 2026-10-05 when a single request was held open across all
of it. Now each poll waits at most 20 s on the Modal side, so no subrequest
comes near that timeout.

The browser request itself stays open while the Worker polls (Workers have no
duration limit while the client is connected). The Worker gives up after
280 s, which leaves about 160 s for a GPU queue on top of the slowest cold start
and dialog seen, cancels the job so the single L4 is free for the next dialog,
and answers 504; "Render again" resumes from the dialog cache. It sends at most
47 subrequests per dialog (one submit, up to 45 polls, one cancel), under the
Workers Free limit of 50. A failed poll (a dropped connection, a
502/503/504/524 between the Worker and Modal, or the jobs app's own 503 when it
briefly cannot reach Modal's API) is polled again; three in a row end the wait.
Whenever the Worker stops waiting without audio, it cancels the job.
A dropped browser connection ("Failed to fetch", no response) is retried twice
for that dialog; an error response from the Worker is not.

The selected sample stays in browser IndexedDB between runs. It is sent with
each uncached Burmese dialog as the input of that dialog's job, and used as
VoxCPM2's `reference_wav_path`. The Worker does not keep or log it. Modal
uploads each job's input, sample included, to its object storage (every
spawned input over 8 KiB goes there) and keeps each job's result for 7 days so
a poll can collect it; the function logs neither the text nor the sample. Reusing the recording fixes the speaker
identity; the server-pinned `burmese-educator-v3` prompt fixes delivery.

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
- eager CUDA inference; VoxCPM's `torch.compile` warm-up is disabled because on
  an L4 cold start it would outlast the Worker's 280 s wait for a job
- one L4 container maximum, scaling to zero after one idle minute
- a separate CPU `jobs` web app (FastAPI only) that validates, spawns, polls,
  and cancels synthesis jobs, so a malformed request never starts an L4

Authenticate the Modal CLI, then deploy from the repository root:

```sh
python -m pip install modal
modal setup
modal deploy integrations/modal/voxcpm2_tts.py
```

Copy the `jobs` web function URL printed by `modal deploy` (it ends in
`--next-editor-voxcpm2-jobs.modal.run`). It must be an HTTPS `*.modal.run` URL
with no path.

Create a proxy token for the Modal workspace:

```sh
modal workspace proxy-tokens create
```

Save the printed `wk-...` token ID and one-time `ws-...` secret. If Modal RBAC
is enabled, allow that token in the environment containing the deployment:

```sh
modal workspace proxy-tokens allow wk-REPLACE_ME main
```

Modal rejects bad proxy credentials before starting any container.

Until the jobs flow is confirmed in production, the GPU class also keeps the
old synchronous `synthesize` endpoint, so a Worker rolled back to a version
that reads `VOXCPM2_MODAL_ENDPOINT` still works. Remove both together.

## 2. Configure the Cloudflare Worker

Store all three values as Worker secrets:

```sh
bunx wrangler secret put VOXCPM2_MODAL_JOBS_URL --config infra/wrangler.toml
bunx wrangler secret put MODAL_PROXY_TOKEN_ID --config infra/wrangler.toml
bunx wrangler secret put MODAL_PROXY_TOKEN_SECRET --config infra/wrangler.toml
```

Use the `jobs` URL for `VOXCPM2_MODAL_JOBS_URL`, the `wk-...` value
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
dialog cache, which lives in Cache Storage (`next-editor-studio-tts-v1`,
`src/studio/tts/dialogCache.ts`), not IndexedDB. Every take is validated before
it is cached, and a cache hit is validated again: a bad entry is evicted with a
warning and synthesized afresh, so clearing the cache is not needed to recover
from one. Delete that cache (or the site's data) only when intentionally
forcing fresh Modal synthesis.

The cache keeps each take as Modal returned it. Studio trims the lead-in and
tail silence VoxCPM2 leaves around the speech on every build
(`prepareModalVoxCpm2Take`), the way Pocket-TTS and AthanLab takes are
trimmed, so captions and mark-anchored actions start with the voice. Because
the trim is applied at build time, changing it never discards a paid take.

When Modal rejects a request, the Worker passes its reason through, for example
`Burmese narration service failed with HTTP 400: reference audio must be a
valid WAV`.
