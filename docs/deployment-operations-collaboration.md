# Collaboration Deployment Operations

Status: implementation complete; deployment validation checklist

This runbook covers the selected Upstash Redis + Realtime + QStash provider, with the existing
Cloudflare Worker, D1, and R2 services. It does not store or operate SCR3 recordings: only the room
host may record, the bytes remain in that browser, and the existing post-recording upload modal is
available after live ends.

## Required production resources

- An Upstash Redis database reserved for collaboration and Realtime. Public lesson and playlist
  caching uses Cloudflare Workers KV, not Redis.
- Upstash Realtime enabled against that database.
- QStash token plus current and next receiver signing keys.
- The existing Cloudflare Worker, D1 database, and private R2 bucket.
- The separate `CACHE` Workers KV binding for public lesson/playlist reads, provisioned through the
  [main Cloudflare deployment runbook](./cloudflare-deploy-guide.md#5-prepare-the-workers-kv-cache).
- Workers Logs enabled as configured in [`wrangler.toml`](../infra/wrangler.toml).

The current Upstash free plans make development cost $0 within their published limits: Redis has
256 MB data, 10 GB monthly bandwidth, and 500,000 monthly commands; QStash has 1,000 messages per
day. Realtime consumes the Redis allowance rather than adding an independent free quota. These are
prototype limits, not a production capacity promise.

## Configuration and migration

Set these Worker secrets without putting their values in Wrangler variables, client code, logs,
or documentation:

```text
COLLAB_REDIS_REST_URL
COLLAB_REDIS_REST_TOKEN
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
```

Do not restore or reuse the obsolete `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` cache secrets. The gallery cache has no secret: it
uses `env.CACHE`, while all Redis credentials are reserved for this
collaboration/Realtime data plane.

`PUBLIC_URL` must be the canonical HTTPS origin because QStash signs the exact maintenance
destination URL. Publishing uses the official `@upstash/qstash` `Client.publishJSON` API, and the
maintenance endpoint uses the SDK `Receiver` against the unmodified request body and exact
destination URL. Apply all D1 migrations through
[`0007_collaboration_assets.sql`](../infra/db/migrations/0007_collaboration_assets.sql) before
deploying code that exposes asset routes:

```sh
wrangler d1 migrations apply next-editor-tube --remote --config infra/wrangler.toml
```

Deploy the Worker only after the migration succeeds. A missing collaboration Redis configuration
fails rooms closed with `503`; it never falls back to Workers KV or D1 for document storage.
The Redis URL must be the HTTPS REST URL from the Upstash database details page. The Worker uses
the official Cloudflare Redis SDK with read-your-writes and structured response decoding enabled;
neither Redis credential is sent to the browser. Realtime runs over the same dedicated Redis
database and authorizes every requested room channel through the application session and D1
membership before opening SSE.
QStash may be omitted in local development, where threshold compaction runs inline, but production
should configure all three QStash secrets so maintenance stays outside the edit acknowledgement
path. An incomplete QStash configuration never publishes a job that its receiver cannot verify:
compaction falls back inline, while closed-room cleanup emits a
`collaboration_qstash_disabled` error because delayed cleanup cannot be reproduced inline.

Room cleanup is published with a seven-day delay, matching both the retention boundary and the
maximum delay currently available on QStash Free. QStash is background maintenance only: awareness
POSTs, cursor updates, document updates, and immediate role changes do not use it.

## Fixed safety limits

| Boundary | Implemented limit |
| -------- | ----------------- |
| Members per room | 10 |
| Active rooms per owner | 5 |
| Decoded Yjs update | 64 KiB |
| Initial Yjs snapshot | 4 MiB |
| Accepted document bytes per room | 64 MiB |
| User update rate | 30 updates/second |
| Room update rate | 120 updates/second |
| SSE connection attempts | 30/user/minute |
| Binary asset | 5 MiB |
| Binary assets per room | 100 and 25 MiB total |
| Closed-room retention | 7 days before Redis/R2 purge |

Changing these values is a protocol/capacity decision. Increase them only after measuring Redis
commands, Worker CPU, R2 operations, bootstrap latency, and browser memory with representative
projects.

## Deployment smoke test

Use two signed-in browser profiles and one separate viewer invitation:

1. The owner starts a room containing text files and one small binary asset.
2. An editor claims an invitation and receives the initial project, asset, participants, and host
   active-file state.
3. Both users edit the same file and different files. Confirm byte-for-byte convergence and remote
   cursor movement.
4. Disconnect the editor, make local text changes, reconnect, and confirm both accepted histories
   converge without stale presence.
5. Downgrade the editor to viewer while connected. Confirm editing stops immediately and a direct
   update request is rejected server-side.
6. Upload a binary file as an editor. Confirm the peer hydrates it, its CRDT node contains only a
   digest/MIME/size descriptor, and Retry restores the preview after a simulated failed fetch.
7. Confirm only the owner/host can start recording. End recording, then end live; only then should
   the existing upload modal be available for the local finished recording.
8. Enter playback and verify its workspace writes do not publish collaboration updates.
9. After a compaction threshold is reached, confirm a `collaboration_qstash_queued` log and a
   labeled `collaboration-maintenance` message in QStash. Close a test room and confirm its cleanup
   message carries a seven-day delay.
10. Confirm Redis metrics show stream/TTL activity and the Realtime dashboard shows the three
    room-scoped document, awareness, and control channels. Verify no Redis URL or token appears in
    browser requests, responses, or built assets.
11. End live only after pending updates flush. Export the owner recovery JSON before retention
    expires.

## Transport spike and release gate

Run the smoke flow at 2, 5, and 10 simultaneous editors with same-file and different-file edits,
one-minute offline recovery, reconnect storms, duplicated/reordered delivery, role changes, and a
near-limit initial snapshot. Capture:

- P50/P95/P99 accepted-update-to-remote-apply latency.
- Realtime SSE reconnect and bootstrap duration.
- Redis commands and bandwidth per active room-hour.
- Snapshot/update bytes and compaction duration.
- Worker CPU plus D1/R2 operations.
- Divergence, rejected writes, dropped updates, duplicate handling, and stale awareness.

Do not remove the Cloudflare Durable Object fallback decision until this spike meets the product's
room-size and latency targets. A failed spike changes the provider adapter, not the Yjs document,
workspace projection, permissions, recording, or asset contracts.

## Logs, dashboards, and alerts

The Worker emits structured `collaboration_update`, `collaboration_qstash_queued`,
`collaboration_qstash_disabled`, `collaboration_qstash_publish_failed`, and
`collaboration_maintenance` records without source text, snapshots, cursor payloads, credentials,
or SCR3 bytes. Build dashboards for:

- Update count, accepted bytes, duplicates, `429`, `403`, and `413` responses.
- Bootstrap/realtime `5xx` rates and connection-rate rejections.
- Compaction attempts, successful generations, duration, and failures.
- Cleanup jobs, Redis keys deleted, R2 assets deleted, and rooms marked purged.
- D1/R2/Redis/QStash errors and QStash retry/dead-letter activity.

Alert on sustained update or bootstrap `5xx`, any repeated compaction/cleanup failure, unexpected
document/asset quota growth, Redis command or bandwidth budget thresholds, and QStash signature
failures. Correlate by opaque room ID only; never add document content or invitation tokens.

## Failure and recovery

- Redis unavailable: clients reconnect with capped jittered backoff and retain unsent local Yjs
  changes. Do not acknowledge writes that were not persisted.
- Realtime interruption: bootstrap snapshot plus update tail closes the subscription race; repeated
  Yjs events are idempotent.
- QStash delivery unavailable after publication: editing remains available and QStash retries the
  idempotent job. Operators can republish the same room/generation or room/closed-at job.
- QStash missing or unavailable while publishing: compaction falls back inline. A cleanup job is
  not scheduled, so alert on `collaboration_qstash_disabled` and
  `collaboration_qstash_publish_failed`, restore the configuration/service, and republish the same
  room/closed-at job before its retention deadline.
- R2 asset unavailable: text editing continues and the UI shows a recoverable placeholder. Retry
  hydration after R2 recovers.
- Owner browser/recorder loss: use existing browser-local recording recovery. Collaboration
  services cannot recover SCR3 because they never receive it.
- Room recovery: before the seven-day purge, the owner can download the snapshot/update export.
  After purge, the collaboration document and private room assets are intentionally unavailable.

## Rollback

Disable new room creation at the application/release layer before changing providers. Existing
accepted rooms require their Redis history and R2 assets until they are closed, exported if
needed, and retained for seven days. Do not reuse the collaboration credentials for application
caching during rollback. A future Durable Object adapter must use the same protocol and document
schema or provide an explicit migration; silently creating an empty replacement room is data loss.
