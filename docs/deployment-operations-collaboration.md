# Collaboration Deployment Operations

Status: implementation complete; deployment validation checklist

This runbook covers the versioned collaboration deployment. New WebSocket rooms use a hibernating
Cloudflare Durable Object as both coordinator and SQLite-backed durable authority. Existing rooms
remain on persistence version 1, which uses Upstash Redis; the Upstash Realtime SSE/HTTP provider
also remains deployed for rooms assigned to that transport. QStash handles delayed cleanup and
legacy compaction, while Durable Object alarms compact SQLite rooms. None of these services stores
SCR3 recordings: only the room host may record, and those bytes remain in that browser until the
existing post-recording upload flow runs after live ends.

## Required production resources

- An Upstash Redis database when persistence-version-1 or Realtime fallback rooms must remain
  available. Public lesson and playlist caching uses Cloudflare Workers KV, not Redis.
- Upstash Realtime enabled against that database for fallback rooms.
- QStash token plus current and next receiver signing keys for delayed room cleanup and legacy
  compaction.
- The existing Cloudflare Worker, D1 database, and private R2 bucket.
- A `COLLABORATION_ROOMS` Durable Object binding whose class is
  `CollaborationRoomDurableObject`, plus the `collaboration-room-v1` SQLite-class migration. One
  named object coordinates each WebSocket room with the Hibernation API and persists version-2
  room snapshots, update tails, sequence numbers, quotas, and update-ID deduplication in its
  private SQLite database.
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

Set the applicable Worker secrets without putting their values in Wrangler variables, client
code, logs, or documentation. Redis credentials are required only while version-1/Realtime rooms
remain; QStash credentials are required for production cleanup:

```text
COLLAB_REDIS_REST_URL
COLLAB_REDIS_REST_TOKEN
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
```

Set non-secret Wrangler variables to select the transport and persistence only for rooms created
afterward:

```text
COLLABORATION_DEFAULT_TRANSPORT=cloudflare-websocket
COLLABORATION_WEBSOCKET_PERSISTENCE=sqlite
```

The transport values are `cloudflare-websocket` and `upstash-realtime`; persistence values are
`sqlite` and `redis`. An Upstash Realtime room always uses persistence version 1. A WebSocket room
created with `sqlite` uses version 2, while `redis` is the new-room rollback path. The default
WebSocket choice fails configuration validation when `COLLABORATION_ROOMS` is absent. D1 persists
both choices in the room descriptor; never mutate either value for an active room.

Do not restore or reuse the obsolete `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` cache secrets. The gallery cache has no secret: it
uses `env.CACHE`, while all Redis credentials are reserved for this
collaboration/Realtime data plane.

`PUBLIC_URL` must be the canonical HTTPS origin because QStash signs the exact maintenance
destination URL. Publishing uses the official `@upstash/qstash` `Client.publishJSON` API, and the
maintenance endpoint uses the SDK `Receiver` against the unmodified request body and exact
destination URL. Apply all D1 migrations through
[`0009_collaboration_persistence_version.sql`](../infra/db/migrations/0009_collaboration_persistence_version.sql)
before deploying the hybrid Worker:

```sh
wrangler d1 migrations apply next-editor-tube --remote --config infra/wrangler.toml
```

Migration 0008 assigns pre-hybrid rooms to `upstash-realtime`; migration 0009 assigns every
existing room persistence version 1. Neither migration moves live history. Deploy the Worker only
after both migrations succeed and confirm Wrangler has applied the `collaboration-room-v1`
Durable Object class migration. Missing Redis credentials fail only persistence-version-1 and
Realtime paths with `503`; a version-2 room never silently falls back to Redis, KV, or D1.
The Redis URL must be the HTTPS REST URL from the Upstash database details page. The Worker uses
the official Cloudflare Redis SDK with read-your-writes and structured response decoding enabled;
neither Redis credential is sent to the browser. Version-2 WebSocket rooms insert updates in one
room-local SQLite transaction, then acknowledge and fan out through the Durable Object output
gate without an external network write. A room alarm compacts the tail into its Yjs snapshot.
Version-1 WebSocket rooms retain Redis durability without Redis `PUBLISH`; Realtime rooms use the
same database and authorize every requested room channel through the application session and D1
membership before opening SSE.
QStash may be omitted in local development for version-1 compaction, which falls back inline, but
production should configure all three QStash secrets so delayed cleanup remains available. An
incomplete QStash configuration never publishes a job that its receiver cannot verify: legacy
compaction falls back inline, while closed-room cleanup emits a
`collaboration_qstash_disabled` error because delayed cleanup cannot be reproduced inline.

Room cleanup is published with a seven-day delay, matching both the retention boundary and the
maximum delay currently available on QStash Free. QStash is background maintenance only: awareness
POSTs, cursor updates, document updates, and immediate role changes do not use it.

## Fixed safety limits

| Boundary                         | Implemented limit                           |
| -------------------------------- | ------------------------------------------- |
| Members per room                 | 10                                          |
| Active rooms per owner           | 5                                           |
| Decoded Yjs update               | 64 KiB                                      |
| Initial Yjs snapshot             | 4 MiB                                       |
| Accepted document bytes per room | 64 MiB                                      |
| User update rate                 | 30 updates/second                           |
| Room update rate                 | 120 updates/second                          |
| Live connection attempts         | 30/user/minute                              |
| Binary asset                     | 5 MiB                                       |
| Binary assets per room           | 100 and 25 MiB total                        |
| Closed-room retention            | 7 days before SQLite or Redis plus R2 purge |

Changing these values is a protocol/capacity decision. Increase them only after measuring Durable
Object SQLite operations, Redis commands for legacy rooms, Worker CPU, R2 operations, bootstrap
latency, and browser memory with representative projects.

## Deployment smoke test

Use two signed-in browser profiles and one separate viewer invitation:

1. With `COLLABORATION_DEFAULT_TRANSPORT=cloudflare-websocket` and
   `COLLABORATION_WEBSOCKET_PERSISTENCE=sqlite`, the owner starts a room containing text files and
   one small binary asset. Confirm the descriptor reports that transport and persistence version
   2, then confirm the browser opens one WebSocket without a Realtime `EventSource`.
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
9. After 200 accepted updates, confirm a `collaboration_sqlite_compaction` log reports a newer
   generation and cutoff, and bootstrap still converges from the compacted snapshot. Close a test
   room and confirm its QStash cleanup message carries a seven-day delay and purges SQLite plus R2
   before D1 is marked purged.
10. Confirm Redis metrics show no document, awareness, rate-limit, or connection activity for the
    version-2 room. Confirm Durable Object metrics show WebSocket upgrades, incoming messages,
    SQLite writes, and alarm activity; leave sockets idle and verify hibernation keeps duration
    within expectation.
11. Temporarily set `COLLABORATION_WEBSOCKET_PERSISTENCE=redis`, create a separate WebSocket room,
    and verify it reports persistence version 1 and uses Redis/QStash legacy durability. Then set
    `COLLABORATION_DEFAULT_TRANSPORT=upstash-realtime`, create another room, and verify it opens SSE
    plus authenticated HTTP writes. Restore both defaults afterward; stored room versions do not
    change.
12. Verify no Redis URL or token appears in browser requests, responses, or built assets. End live
    only after pending updates flush, and export the owner recovery JSON before retention expires.

## Transport spike and release gate

The creation route synchronously initializes the named room object from the creator's edge before
the room becomes active, passing the bounded location hint derived from that request's Cloudflare
continent/coordinates. This makes the first creator request the deliberate placement request; do
not prewarm new room IDs from a centralized operator or cron location. Durable Object placement is
fixed afterward, so run the smoke flow at 1, 5, and 20 simultaneous editors with same-file and
different-file edits, one-minute offline recovery, reconnect storms, duplicated delivery, role
changes, and a near-limit initial snapshot. Run both creator-nearby pairs and intercontinental
pairs, and capture:

- P50/P95/P99 editor-enqueue, socket-send, durable-insert, acknowledgement, broadcast, and
  remote-apply latency, correlated by update ID.
- WebSocket and Realtime reconnect plus bootstrap duration.
- Durable Object placement/edge region for each participant pair; compare the same workload with
  creators in each primary user geography.
- SQLite operations for version 2 and Redis commands/bandwidth for persistence version 1.
- Snapshot/update bytes, update-tail length, duplicate rate, and compaction duration.
- Worker CPU, Durable Object request units/duration, and D1/R2 operations.
- Divergence, rejected writes, dropped updates, duplicate handling, and stale awareness.

Compare rooms at the same load and retain the Realtime fallback until the hybrid meets the
product's room-size, latency, reconnect, and cost targets. A failed spike changes the provider
adapter, not the Yjs document, workspace projection, permissions, recording, or asset contracts.

## Logs, dashboards, and alerts

The Worker emits structured `collaboration_update`, `collaboration_websocket_update`,
`collaboration_sqlite_compaction`, `collaboration_qstash_queued`,
`collaboration_qstash_disabled`, `collaboration_qstash_publish_failed`, and
`collaboration_maintenance` records without source text, snapshots, cursor payloads, credentials,
or SCR3 bytes. The WebSocket update record includes persistence, durable insert, acknowledge,
broadcast, total duration, update count, duplicate state, and update ID. Build dashboards for:

- Update count, accepted bytes, duplicates, `429`, `403`, and `413` responses.
- Bootstrap, WebSocket upgrade, Realtime `5xx`, abnormal close, and connection-rate rejections.
- Active Durable Object sockets, incoming frame request units, duration/hibernation, wakeups, and
  per-room message-rate rejections.
- SQLite alarm scheduling, compaction attempts, successful generations, duration, and failures;
  retain the equivalent QStash view for version-1 rooms.
- Cleanup jobs, SQLite stores or Redis keys deleted, R2 assets deleted, and rooms marked purged.
- D1/R2/Redis/QStash errors and QStash retry/dead-letter activity.

Alert on sustained update or bootstrap `5xx`, any repeated compaction/cleanup failure, unexpected
document/asset quota growth, Redis command or bandwidth budget thresholds, and QStash signature
failures. Correlate by opaque room ID only; never add document content or invitation tokens.

## Failure and recovery

- Durable Object SQLite write unavailable: version-2 clients retain unacknowledged Yjs updates,
  reconnect with capped jittered backoff, and are never acknowledged before the output-gated
  transaction commits.
- Redis unavailable: persistence-version-1 clients reconnect with capped jittered backoff and
  retain unsent local Yjs changes. Version-2 rooms continue without Redis.
- WebSocket or Durable Object interruption: clients retain unacknowledged Yjs updates, reconnect
  with capped jittered backoff, and use snapshot plus update tail before replaying the outbox.
- Realtime interruption: bootstrap snapshot plus update tail closes the subscription race; repeated
  Yjs events are idempotent.
- QStash delivery unavailable after publication: editing remains available and QStash retries the
  idempotent legacy-compaction or cleanup job. SQLite compaction alarms do not depend on QStash.
- QStash missing or unavailable while publishing: legacy compaction falls back inline. A cleanup
  job is not scheduled, so alert on `collaboration_qstash_disabled` and
  `collaboration_qstash_publish_failed`, restore the configuration/service, and republish the same
  room/closed-at job before its retention deadline.
- R2 asset unavailable: text editing continues and the UI shows a recoverable placeholder. Retry
  hydration after R2 recovers.
- Owner browser/recorder loss: use existing browser-local recording recovery. Collaboration
  services cannot recover SCR3 because they never receive it.
- Room recovery: before the seven-day purge, the owner can download the snapshot/update export.
  After purge, the collaboration document and private room assets are intentionally unavailable.

## Rollback

To stop assigning SQLite to new WebSocket rooms while retaining that transport, set
`COLLABORATION_WEBSOCKET_PERSISTENCE=redis`. To stop assigning the WebSocket transport entirely,
set `COLLABORATION_DEFAULT_TRANSPORT=upstash-realtime`. Keep the Durable Object binding, class
export, SQLite data, WebSocket routes, and Redis schema available for all existing rooms. Do not
mutate a room's D1 transport or persistence version: switching either value without migrating its
history can split or erase accepted state.

Persistence-version-2 rooms require their Durable Object SQLite history; version-1 rooms require
their Redis history. Both require R2 assets until closed, exported if needed, and retained for
seven days. Do not reuse collaboration credentials for application caching during rollback. Any
future provider change must preserve the protocol/document schema and explicitly migrate history;
silently creating an empty replacement room is data loss.
