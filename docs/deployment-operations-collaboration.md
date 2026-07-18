# Collaboration Deployment and Operations

Status: implementation complete; deployed three-profile and load validation pending

Live collaboration has one production topology:

- a same-origin Hono Worker authenticates room HTTP and WebSocket requests;
- D1 stores rooms, memberships, invitations, roles, audit events, and asset metadata;
- one hibernating Durable Object per room owns the binary WebSocket session and SQLite Yjs log;
- Durable Object Alarms compact each room's update tail;
- R2 stores private content-addressed workspace assets and immutable normalized slide payloads;
- QStash schedules the seven-day purge of closed room data and assets.

There is no Redis, Realtime SSE, HTTP document-update, JSON awareness, or binary-protocol downgrade
path. Collaboration protocol version 2 and binary envelope version 3 are mandatory.

## Required Cloudflare resources

- Workers application and Static Assets binding.
- D1 database bound as `DB`.
- R2 bucket bound as `BUCKET`.
- `CollaborationRoomDurableObject` bound as `COLLABORATION_ROOMS` with SQLite enabled.
- Workers KV bound as `CACHE` for public catalog caching; it is not collaboration storage.

Apply all D1 migrations in `infra/db/migrations/`. Migrations 0008 and 0009 constrain rooms to the
Cloudflare WebSocket transport and Durable Object SQLite persistence.

## Secrets and variables

The ordinary authentication variables remain required:

```text
PUBLIC_URL=https://nexteditor.dev
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SESSION_SECRET=...
```

QStash is optional in local development and required in production for delayed closed-room purge:

```text
QSTASH_TOKEN=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...
```

Do not expose any of these values through `VITE_*` variables. The browser receives only its
first-party session cookie and the room protocol identifiers.

The direct Monaco/Yjs binding can be disabled for diagnosis with
`VITE_COLLABORATION_Y_MONACO=false`. The binary transport itself has no downgrade flag.

## Deployment order

1. Apply D1 migrations.
2. Deploy the Durable Object class migration and binding.
3. Deploy the Worker routes and static client from the same revision.
4. Confirm the room creation request initializes its named Durable Object from the creator's edge.
5. Confirm the WebSocket upgrade includes `binaryProtocolVersion=3`; missing or mismatched values
   must return `409`.
6. Confirm the owner-only teaching initialization route verifies registered slide assets and
   atomically installs the optional schema-1 teaching subtree. Repeat the exact request and confirm
   the idempotent retry succeeds without replacing the deck or losing an interleaved workspace
   update.
7. Create, use, close, export, and purge a disposable room before opening collaboration broadly.

The creator's request supplies a bounded location hint derived from Cloudflare continent and
coordinate metadata. Durable Object placement is fixed after first access, so do not prewarm new
room IDs from a centralized cron or operator location.

## Functional smoke test

Use three signed-in browser profiles: owner, editor, and viewer. This validation is still pending
for the current implementation and must be completed before broad rollout:

1. The owner creates a room containing text files, at least one binary workspace asset, a deck,
   and a whiteboard scene. Confirm the slide manager closes and presentation-only mode begins as
   soon as room creation starts, before asset uploads finish.
2. Confirm workspace and normalized slide assets upload before the room URL is exposed, teaching
   initialization succeeds only after their R2 registrations exist, and slide payload bytes are
   absent from the Yjs snapshot. Confirm clients reject same-length payload corruption by digest
   and reuse one verified download for manifests that share the same payload hash.
3. Join as an editor and viewer. Confirm all three synchronize through binary state-vector frames.
4. Type normally, paste 64 KiB, use multi-cursor and IME input, format the document, rename a file,
   add/delete files, and edit different files concurrently.
5. Confirm the viewer is read-only and a role downgrade takes effect on the existing socket.
6. Disconnect an editor for one minute, edit offline, reconnect, and verify convergence without a
   full HTTP bootstrap.
7. Switch the shared slide and concurrently upsert/delete whiteboard elements. Confirm all three
   converge, the room deck stays presentation-only, and the viewer can pan/zoom but cannot edit.
8. From both non-owner profiles, follow exact owner/editor sessions through editor, slides, and
   whiteboard. Confirm viewports apply, whiteboard wins if both modal surfaces are open, first
   intentional local input stops following, target leave/TTL stops it, and reconnect suspends then
   resumes only the same session within the grace window.
9. Start recording as host. Confirm room-wide slide/whiteboard content changes are recorded once,
   follower-applied views remain local view events, and SCR3 bytes remain browser-local.
10. Export the room as owner, close it, and confirm connected clients receive the close control.
11. Verify the signed QStash cleanup job is scheduled for seven days later and removes both
    workspace and slide assets after retention expires.

## Performance and release gate

Run 1, 5, and 20 simultaneous editors with creator-nearby and intercontinental pairs. Capture:

- Monaco change to provider enqueue;
- socket send to Durable Object receive;
- SQLite transaction duration;
- acknowledgement and broadcast duration;
- remote Yjs/model apply duration;
- p50/p95/p99 end-to-end latency, bytes per edit, duplicates, reconnect bytes, and DO CPU.

Acceptance requirements:

- no durability or ordering regression;
- ordinary edits never wait on an external storage network hop;
- no project-wide collaboration projection during ordinary typing;
- at most one coalesced WebContainer write per path per batching window;
- document and awareness payloads remain binary;
- reconnect and corrupt-frame limits fail closed.

## Observability

Retain structured logs for:

- connection attempts and close codes;
- durable insert, acknowledgement, broadcast, and total update duration;
- room/update quotas and rejected viewer writes;
- state-vector synchronization failures;
- alarm compaction duration and retained tail size;
- asset upload/download integrity failures;
- aggregate teaching initialization and follow start/stop/surface-kind outcomes, without participant
  or session identifiers;
- QStash publish, signature, retry, and purge outcomes.

Never log Yjs payloads, workspace content, invitation tokens, session cookies, asset bytes, or SCR3
recordings.

## Failure behavior

- Durable Object unavailable: room creation or connection fails with `503`; no alternate transport
  is selected.
- SQLite append failure: do not acknowledge or broadcast the update; keep the client update queued
  for bounded reconnect retries.
- Protocol mismatch: reject the WebSocket upgrade or frame; do not reinterpret it as JSON.
- D1 unavailable: reject membership-sensitive operations and new upgrades.
- R2 unavailable: preserve existing descriptors, reject or retry teaching initialization, surface
  a retryable asset error, and never substitute slide or workspace bytes into Yjs.
- QStash unavailable: closing the room still succeeds, but alert that delayed cleanup was not
  scheduled.

## Rollback

Rollback means deploying the previous application revision while preserving the Durable Object
binding, SQLite data, D1 metadata, and R2 assets. It does not mean switching a room to another
transport or persistence layer.

Because there is no binary-envelope compatibility protocol, deploy the Worker and browser client
together. Never roll back only one side from v3 to v2. If a bad release must be withdrawn, close
affected rooms or require clients to reload onto the matching revision rather than accepting mixed
protocol behavior. A previous schema-1 client may ignore the optional `project.teaching` subtree,
but it must preserve that subtree byte-for-byte; rollback is unsafe if the target revision rebuilds
or drops unknown project fields.
