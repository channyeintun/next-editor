# Collaboration Deployment Operations

Status: implementation complete; deployment validation checklist

This runbook covers the selected hybrid: a hibernating Cloudflare Durable Object WebSocket
coordinator, Upstash Redis durability, and QStash maintenance. The Upstash Realtime SSE/HTTP
provider remains deployed for rooms assigned to it. It does not store or operate SCR3 recordings:
only the room host may record, the bytes remain in that browser, and the existing post-recording
upload modal is available after live ends.

## Required production resources

- An Upstash Redis database reserved for collaboration durability and the Realtime fallback.
  Public lesson and playlist caching uses Cloudflare Workers KV, not Redis.
- Upstash Realtime enabled against that database for fallback rooms.
- QStash token plus current and next receiver signing keys.
- The existing Cloudflare Worker, D1 database, and private R2 bucket.
- A `COLLABORATION_ROOMS` Durable Object binding whose class is
  `CollaborationRoomDurableObject`, plus the `collaboration-room-v1` SQLite-class migration. One
  named object coordinates each WebSocket room with the Hibernation API; it does not persist room
  documents in Durable Object storage.
- The separate `CACHE` Workers KV binding for public lesson/playlist reads, provisioned through the
  [main Cloudflare deployment runbook](./cloudflare-deploy-guide.md#5-prepare-the-workers-kv-cache).
- Workers Logs enabled as configured in [`wrangler.toml`](../infra/wrangler.toml).

The current Upstash free plans make development cost $0 within their published limits: Redis has
256 MB data, 10 GB monthly bandwidth, and 500,000 monthly commands; QStash has 1,000 messages per
day. Realtime consumes the Redis allowance rather than adding an independent free quota.
Cloudflare Workers Free currently includes 100,000 requests/day, while Durable Objects Free
includes 100,000 request units/day and 13,000 GB-s/day. WebSocket upgrades consume requests;
incoming Durable Object frames are metered at 20 messages per request unit, outgoing frames are
free, and hibernation avoids idle duration. These are prototype limits, not a production capacity
promise. See the current comparison in
[Cloudflare WebSocket + Upstash Hybrid](./live-collaboration-hybrid-cloudflare-upstash.md).

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

Set the non-secret Wrangler variable to select the transport only for rooms created afterward:

```text
COLLABORATION_DEFAULT_TRANSPORT=cloudflare-websocket
```

The only supported values are `cloudflare-websocket` and `upstash-realtime`. The default
WebSocket choice fails configuration validation when `COLLABORATION_ROOMS` is absent rather than
creating a partially usable room. Room descriptors persist the selected value in D1; never change
it for an active room.

Do not restore or reuse the obsolete `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` cache secrets. The gallery cache has no secret: it
uses `env.CACHE`, while all Redis credentials are reserved for this
collaboration/Realtime data plane.

`PUBLIC_URL` must be the canonical HTTPS origin because QStash signs the exact maintenance
destination URL. Publishing uses the official `@upstash/qstash` `Client.publishJSON` API, and the
maintenance endpoint uses the SDK `Receiver` against the unmodified request body and exact
destination URL. Apply all D1 migrations through
[`0008_collaboration_transport.sql`](../infra/db/migrations/0008_collaboration_transport.sql)
before deploying the hybrid Worker:

```sh
wrangler d1 migrations apply next-editor-tube --remote --config infra/wrangler.toml
```

The migration assigns existing rooms to `upstash-realtime`; it does not move a live room between
providers. Deploy the Worker only after the D1 migration succeeds and confirm Wrangler applies the
`collaboration-room-v1` Durable Object class migration. A missing collaboration Redis
configuration fails rooms closed with `503`; it never falls back to Workers KV, D1, or Durable
Object SQLite for document storage.
The Redis URL must be the HTTPS REST URL from the Upstash database details page. The Worker uses
the official Cloudflare Redis SDK with read-your-writes and structured response decoding enabled;
neither Redis credential is sent to the browser. WebSocket rooms persist accepted updates without
Redis `PUBLISH`; their Durable Object directly fans out updates and keeps awareness entirely
ephemeral. Realtime rooms use the same database and authorize every requested room channel through
the application session and D1 membership before opening SSE.
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
| Live connection attempts | 30/user/minute |
| Binary asset | 5 MiB |
| Binary assets per room | 100 and 25 MiB total |
| Closed-room retention | 7 days before Redis/R2 purge |

Changing these values is a protocol/capacity decision. Increase them only after measuring Redis
commands, Worker CPU, R2 operations, bootstrap latency, and browser memory with representative
projects.

## Deployment smoke test

Use two signed-in browser profiles and one separate viewer invitation:

1. With `COLLABORATION_DEFAULT_TRANSPORT=cloudflare-websocket`, the owner starts a room containing
   text files and one small binary asset. Confirm the room descriptor reports that transport and
   the browser opens one WebSocket without a Realtime `EventSource`.
2. An editor claims an invitation and receives the initial project, asset, participants, and host
   active-file state.
3. Both users edit the same file and different files. Confirm byte-for-byte convergence and remote
   cursor movement.
4. Disconnect the editor, make local text changes, reconnect, and confirm both accepted histories
   converge without stale presence.
5. Downgrade the editor to viewer while connected. Confirm the existing socket receives the new
   role immediately, Monaco becomes read-only without reconnecting, and a modified client cannot
   publish a durable update. Promote the viewer again and confirm editing is enabled immediately.
6. Upload a binary file as an editor. Confirm the peer hydrates it, its CRDT node contains only a
   digest/MIME/size descriptor, and Retry restores the preview after a simulated failed fetch.
7. Confirm only the owner/host can start recording. End recording, then end live; only then should
   the existing upload modal be available for the local finished recording.
8. Enter playback and verify its workspace writes do not publish collaboration updates.
9. After a compaction threshold is reached, confirm a `collaboration_qstash_queued` log and a
   labeled `collaboration-maintenance` message in QStash. Close a test room and confirm its cleanup
   message carries a seven-day delay.
10. Confirm Redis metrics show durable document stream/idempotency activity but no awareness keys,
    awareness stream entries, or document Pub/Sub for the WebSocket room. Confirm Durable Object
    metrics show upgrades and incoming messages, then leave sockets idle and verify hibernation
    keeps duration within expectation.
11. Temporarily set `COLLABORATION_DEFAULT_TRANSPORT=upstash-realtime`, create a separate room, and
    repeat convergence, reconnect, awareness, and role-change checks. Confirm that room opens SSE
    plus authenticated HTTP writes and does not open the collaboration WebSocket. Restore the
    default afterward; the stored room transport does not change.
12. Verify no Redis URL or token appears in browser requests, responses, or built assets. End live
    only after pending updates flush, and export the owner recovery JSON before retention expires.

## Transport spike and release gate

Run the smoke flow at 2, 5, and 10 simultaneous editors with same-file and different-file edits,
one-minute offline recovery, reconnect storms, duplicated/reordered delivery, role changes, and a
near-limit initial snapshot. Capture:

- P50/P95/P99 accepted-update-to-remote-apply latency.
- WebSocket and Realtime reconnect plus bootstrap duration.
- Redis commands and bandwidth per active room-hour.
- Snapshot/update bytes and compaction duration.
- Worker CPU, Durable Object request units/duration, and D1/R2 operations.
- Divergence, rejected writes, dropped updates, duplicate handling, and stale awareness.

Compare rooms at the same load and retain the Realtime fallback until the hybrid meets the
product's room-size, latency, reconnect, and cost targets. A failed spike changes the provider
adapter, not the Yjs document, workspace projection, permissions, recording, or asset contracts.

## Logs, dashboards, and alerts

The Worker emits structured `collaboration_update`, `collaboration_qstash_queued`,
`collaboration_qstash_disabled`, `collaboration_qstash_publish_failed`, and
`collaboration_maintenance` records without source text, snapshots, cursor payloads, credentials,
or SCR3 bytes. Build dashboards for:

- Update count, accepted bytes, duplicates, `429`, `403`, and `413` responses.
- Bootstrap, WebSocket upgrade, Realtime `5xx`, abnormal close, and connection-rate rejections.
- Active Durable Object sockets, incoming frame request units, duration/hibernation, wakeups, and
  per-room message-rate rejections.
- Compaction attempts, successful generations, duration, and failures.
- Cleanup jobs, Redis keys deleted, R2 assets deleted, and rooms marked purged.
- D1/R2/Redis/QStash errors and QStash retry/dead-letter activity.

Alert on sustained update or bootstrap `5xx`, any repeated compaction/cleanup failure, unexpected
document/asset quota growth, Redis command or bandwidth budget thresholds, and QStash signature
failures. Correlate by opaque room ID only; never add document content or invitation tokens.

## Failure and recovery

- Redis unavailable: clients reconnect with capped jittered backoff and retain unsent local Yjs
  changes. Do not acknowledge writes that were not persisted.
- WebSocket or Durable Object interruption: clients retain unacknowledged Yjs updates, reconnect
  with capped jittered backoff, and use snapshot plus update tail before replaying the outbox.
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

To stop assigning new WebSocket rooms, set `COLLABORATION_DEFAULT_TRANSPORT=upstash-realtime` and
deploy while keeping the Durable Object binding, class export, WebSocket route, and Redis document
schema available for existing WebSocket rooms. Do not mutate their D1 transport values or silently
open Realtime alongside them. If the deployed WebSocket code itself is unsafe, disable new room
creation and close/export affected rooms before removing the class; changing a live room's bus can
split accepted history.

All accepted rooms require their Redis history and R2 assets until they are closed, exported if
needed, and retained for seven days. Do not reuse collaboration credentials for application
caching during rollback. A future storage-provider change must preserve the same protocol and
document schema or provide an explicit migration; silently creating an empty replacement room is
data loss.
