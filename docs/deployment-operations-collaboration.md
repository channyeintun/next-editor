# Collaboration Deployment and Operations

Status: implementation complete; deployed multi-browser and load validation pending

Live collaboration has one production topology:

- a same-origin Hono Worker authenticates room HTTP and WebSocket requests;
- D1 stores rooms, memberships, invitations, roles, audit events, and asset metadata;
- one hibernating Durable Object per room owns the binary WebSocket session and SQLite Yjs log;
- Durable Object Alarms compact each room's update tail;
- R2 stores private content-addressed workspace assets;
- QStash schedules the seven-day purge of closed room data and assets.

There is no Redis, Realtime SSE, HTTP document-update, JSON awareness, or binary-protocol downgrade
path. Collaboration protocol version 2 and binary envelope version 2 are mandatory.

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
5. Confirm the WebSocket upgrade includes `binaryProtocolVersion=2`; missing or mismatched values
   must return `409`.
6. Create, use, close, export, and purge a disposable room before opening collaboration broadly.

The creator's request supplies a bounded location hint derived from Cloudflare continent and
coordinate metadata. Durable Object placement is fixed after first access, so do not prewarm new
room IDs from a centralized cron or operator location.

## Functional smoke test

Use two signed-in browser profiles and a separate viewer invitation:

1. The owner creates a room containing text files and at least one binary asset.
2. Confirm the initial Yjs snapshot already contains the asset descriptor and the R2 bytes upload
   completes before the room URL is exposed.
3. Join as an editor and viewer. Confirm all three synchronize through binary state-vector frames.
4. Type normally, paste 64 KiB, use multi-cursor and IME input, format the document, rename a file,
   add/delete files, and edit different files concurrently.
5. Confirm the viewer is read-only and a role downgrade takes effect on the existing socket.
6. Disconnect an editor for one minute, edit offline, reconnect, and verify convergence without a
   full HTTP bootstrap.
7. Confirm remote selections, participant labels, active-file presence, and follow-host state.
8. Start recording as host; verify collaboration continues while SCR3 bytes remain browser-local.
9. Export the room as owner, close it, and confirm connected clients receive the close control.
10. Verify the signed QStash cleanup job is scheduled for seven days later.

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
- R2 unavailable: preserve the descriptor, surface a retryable asset error, and never substitute
  base64 content into Yjs.
- QStash unavailable: closing the room still succeeds, but alert that delayed cleanup was not
  scheduled.

## Rollback

Rollback means deploying the previous application revision while preserving the Durable Object
binding, SQLite data, D1 metadata, and R2 assets. It does not mean switching a room to another
transport or persistence layer.

Because there is no compatibility protocol, deploy the Worker and browser client together. If a
bad release must be withdrawn, close affected rooms or require clients to reload onto the matching
revision rather than accepting mixed protocol behavior.
