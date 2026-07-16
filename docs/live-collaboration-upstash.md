# Live Collaboration — Upstash Deployment Evaluation

Status: selected for the initial implementation spike; implementation in progress

Companion documents:

- [Live Collaboration Feature Plan](./live-collaboration.md) defines the provider-neutral product,
  CRDT, editor, recording, and protocol contracts.
- [Cloudflare-native Deployment](./live-collaboration-cloudflare.md) evaluates a room service built
  with Cloudflare Durable Objects.

This document evaluates whether the existing Upstash relationship should be extended from the
optional Redis cache into the live-collaboration data plane. It covers Upstash Redis, Realtime,
and QStash. It does not change the core decisions in the feature plan: Yjs remains the merge
engine, awareness remains logically ephemeral, and SCR3 remains a single-writer recording and
replay format owned by the room host's browser.

Pricing and product behavior in this document were checked on 2026-07-16. They must be verified
again before production capacity is purchased.

## Recommendation

Upstash can support a small-room collaboration MVP, but the three services have different roles:

| Service          | Appropriate collaboration role                                                                  | Recommendation                           |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Upstash Redis    | CRDT update streams, compacted snapshots, presence TTLs, idempotency keys, and rate-limit state | Strong fit, using a dedicated database   |
| Upstash Realtime | Redis Streams and Pub/Sub exposed to browsers through Server-Sent Events                        | Selected for the initial transport spike |
| QStash           | Snapshot compaction, cleanup, exports, invitations, and recovery jobs                           | Background work only                     |

Realtime should not be adopted merely because Redis is already present. Its SSE downstream and
HTTP upstream model must first pass a realistic multi-client performance and cost spike. If it
does not pass, retain the provider-neutral WebSocket protocol and use a WebSocket room service;
Upstash Redis can still be that service's persistence layer.

Do not operate Realtime beside a WebSocket data plane without a specific requirement. Two live
transports add connection lifecycle, ordering, observability, and failure cases without improving
CRDT convergence.

Option A does not require Durable Objects: Realtime and Redis supply the live transport and room
history, while the Worker enforces authorization. Browser-local recording does not affect that
choice and is not a reason to add a Durable Object.

## Implementation status

The first Option A foundation is implemented:

- [`protocol.ts`](../src/collaboration/protocol.ts) defines versioned, size-bounded Yjs update
  envelopes, exact room-channel parsing, and owner/editor/viewer write policy.
- [`0004_collaboration_rooms.sql`](../infra/db/migrations/0004_collaboration_rooms.sql) adds the D1
  room and membership control plane.
- [`collaboration.ts`](../infra/worker/routes/collaboration.ts) adds authenticated room creation,
  room lookup, owner/editor update publication, viewer write rejection, and membership-checked
  Realtime SSE subscriptions.
- [`realtime.ts`](../infra/worker/collaboration/realtime.ts) creates a dedicated, fail-closed Redis
  client and typed Realtime schema. It deliberately applies no stream trimming before snapshot
  compaction exists.
- [`CollaborationRealtimeProvider.tsx`](../infra/client/collaboration/CollaborationRealtimeProvider.tsx)
  configures the same-origin, cookie-authenticated Realtime endpoint for later provider actors.
- [`projectDocument.ts`](../src/collaboration/projectDocument.ts) defines the versioned Yjs project
  tree, stable file IDs, deterministic sibling collision names, orphan/cycle recovery, and a
  path-based workspace projection.
- [`0005_collaboration_access.sql`](../infra/db/migrations/0005_collaboration_access.sql) and the
  collaboration routes add expiring, revocable invitation tokens, idempotent claims, room limits,
  member listing, role changes, removal, and owner-controlled room closure.
- [`documentStore.ts`](../infra/worker/collaboration/documentStore.ts) persists an initial snapshot,
  deduplicates durable updates, serves paginated snapshot-plus-tail bootstrap data, and compacts an
  immutable stream cutoff without dropping concurrently appended updates.

This is still infrastructure, not a usable room UI. Monaco/Yjs bindings, awareness, offline update
buffering, QStash scheduling, recording host guards, and room lifecycle UI remain subsequent work.
Realtime must still pass the transport spike in this document before the fallback WebSocket option
is discarded.

## Existing Redis integration is not collaboration infrastructure

The current integration in [`infra/worker/cache.ts`](../infra/worker/cache.ts) is an optional,
fail-open cache in front of selected D1 reads:

- Missing credentials disable the cache.
- Redis errors fall back to D1.
- Cached keys are disposable and expire.
- Cache availability must never affect application correctness.

Collaboration persistence has the opposite contract. Once a room accepts a durable CRDT update,
the service must retain it or surface a connection failure. It cannot silently bypass storage.

If Upstash Redis is selected, create a separate collaboration database and use separate Worker
secrets, for example:

```text
COLLAB_REDIS_REST_URL
COLLAB_REDIS_REST_TOKEN
QSTASH_TOKEN
QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY
```

A separate database provides independent retention, budgets, throughput, incident handling, and
metrics. It also prevents high-frequency room traffic from competing with the gallery cache. The
Redis and QStash credentials are server-only and must never be included in the browser bundle or
room token.

## Option A: Upstash-centric room provider

In this option, Realtime replaces the feature plan's single bidirectional WebSocket with an SSE
subscription downstream and authenticated HTTP writes upstream.

```mermaid
flowchart LR
    ClientA[Client Yjs document] -->|authenticated update POST| Worker[Cloudflare Hono Worker]
    ClientB[Other clients] -->|SSE subscribe| Worker
    Worker -->|session, room, and role checks| D1[(D1)]
    Worker -->|XADD and PUBLISH| Redis[(Dedicated Upstash Redis)]
    Redis -->|Realtime SSE| Worker
    Worker -->|document, awareness, and control events| ClientA
    Worker -->|document, awareness, and control events| ClientB
    QStash[QStash] -->|signed background request| Jobs[Worker job endpoints]
    Jobs --> Redis
    Jobs --> R2[(R2 assets and exports)]
```

Upstash Realtime is implemented with Redis Streams, Pub/Sub, and SSE. Its browser API subscribes
to typed channel events; event emission is a server-side API. Consequently, every browser write
needs an application endpoint that authenticates the user, verifies the room role, validates the
payload, persists the event, and then emits it.

The room provider actor owned by `collaborationMachine` must hide this transport shape from the
rest of the editor. Monaco bindings and Yjs should interact with a provider interface rather than
React-specific Realtime hooks.

## Option B: Redis-backed WebSocket room service

If the Realtime spike does not meet the required update rate or latency, Upstash Redis can remain
useful behind the original WebSocket architecture:

```mermaid
flowchart LR
    Clients[Browser Yjs clients] <-->|authenticated binary WebSocket| Room[Room service]
    Room -->|append updates and publish fan-out| Redis[(Dedicated Upstash Redis)]
    Room -->|rooms, membership, and roles| D1[(D1)]
    QStash[QStash] -->|signed maintenance jobs| Jobs[Worker job endpoints]
    Jobs --> Redis
    Jobs --> R2[(R2 assets and exports)]
```

The room service owns connected sockets, document/awareness/control multiplexing, role changes,
and disconnect cleanup. Redis supplies the update stream, snapshots, cross-instance fan-out when
needed, TTL state, and recovery data. Browser clients never connect to Redis directly.

This option preserves native binary messages and one duplex connection but requires operating a
stateful room service. The [Cloudflare-native deployment](./live-collaboration-cloudflare.md)
implements that room boundary with Durable Objects and their private SQLite storage instead of
Upstash Redis. A conventional Worker or server deployment could use Upstash Redis as the shared
persistence and fan-out layer.

Choose either Option A or Option B for live traffic. QStash background jobs and R2 assets are
compatible with both.

## Service and data ownership

| Data                                       | System of record                        | Notes                                                   |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------------------- |
| Room identity, owner, members, and roles   | D1                                      | Globally queryable control plane                        |
| Current CRDT snapshot                      | Dedicated Redis, optionally copied R2   | Binary value or encoded snapshot                        |
| CRDT updates after the snapshot            | Redis Stream                            | Durable and replayable                                  |
| Participant awareness                      | Client state plus short-lived Redis TTL | Realtime events alone do not provide presence semantics |
| Host/follow and role-change control events | Realtime channel plus authoritative D1  | Events notify; D1 decides                               |
| Binary project assets                      | R2                                      | CRDT stores only an asset reference                     |
| Optional project export                    | R2                                      | Separate from the host's SCR3 recording                 |
| SCR3 recording                             | Room host's browser                     | Local until the post-session upload modal is confirmed  |
| Compaction and cleanup jobs                | QStash delivery state                   | Destination handlers remain idempotent                  |

## Recording boundary

Only the room host may record. For the MVP, the owner remains host throughout a recorded session.
That host's `editorMachine` records the converged workspace locally and persists recovery state in
the browser. Redis, Realtime, and QStash carry no SCR3 bytes and do not finalize a recording.

Only after live ends does the application present the existing post-recording upload-modal
experience. If the host confirms that modal, the lesson files are uploaded and may later appear
under `/learn`; `/learn` is not an Upstash or collaboration upload path. Any R2 object created by
the existing [upload and publish sequence](./cloudflare-architecture.md#upload--publish-sequence)
belongs to lesson storage, not the collaboration namespace.

Suggested Redis key families:

```text
collab:{roomId}:document                 Redis Stream of durable document events
collab:{roomId}:snapshot                 Latest compacted Yjs snapshot
collab:{roomId}:snapshot-meta            Schema version, generation, and stream cutoff
collab:{roomId}:presence:{sessionId}     Short-lived presence key
collab:{roomId}:role-version             Revocation/version guard for room tokens
collab:{roomId}:compaction-lock          Expiring single-compactor lock
```

Use opaque room IDs in channel and key names. Authorization must compare exact parsed room IDs;
prefix checks such as `channel.startsWith(userId)` are insufficient for room ACLs.

## Connection and synchronization protocol

Realtime history is useful for reconnect catch-up, but it is not a replacement for Yjs state
vector synchronization or periodic snapshots. A new client must not replay the entire lifetime of
a busy room.

An Upstash-centric provider should use this sequence:

1. The browser exchanges its first-party session for a short-lived, room-scoped token containing
   the user ID, tab/session ID, effective role, role version, protocol version, and schema version.
2. The provider opens the room's SSE subscription and buffers live document events.
3. The provider fetches an authenticated bootstrap response containing the latest snapshot,
   snapshot stream cutoff, and updates after that cutoff.
4. It applies the snapshot and update tail, then applies buffered live events. Duplicate Yjs
   updates are safe and must be tolerated.
5. It sends any offline client diff through the authenticated update endpoint.
6. Only after synchronization succeeds does it publish awareness and enable editing.

This ordering closes the race between fetching a snapshot and subscribing to new events. The
provider must keep its own attempt/session ID so events from an obsolete SSE request cannot mutate
a replacement room session.

## Document messages

Yjs updates are binary, whereas Realtime serializes event envelopes as JSON. Encode document
updates as base64 or another explicitly defined textual representation and accept the resulting
size overhead. The server should reject updates above a configured decoded-byte limit before
emitting them.

Batch or merge small Yjs updates before transmission. The batch envelope should include at least:

```text
protocolVersion
documentSchemaVersion
roomId
sessionId
clientUpdateId
baseSnapshotGeneration
updateBase64
```

The server must:

- Verify the room token and current role version.
- Reject viewer writes.
- Rate-limit by room, user, and session.
- Validate encoded and decoded size limits.
- Deduplicate `clientUpdateId` where an upstream HTTP retry is possible.
- Persist before acknowledging the browser.
- Treat repeated or reordered Yjs updates as normal rather than exceptional.

A signed role embedded in a stateless token is not sufficient for immediate role downgrades. The
update endpoint must also consult an authoritative role version or a short-lived Redis membership
cache. The control event disables honest clients immediately; the server-side version check stops
a modified client from continuing to write with an older token.

## Awareness and presence

Realtime writes every emitted event to a Redis Stream. Awareness is therefore only logically
ephemeral unless a separate retention policy is applied.

Use a separate awareness channel/Realtime instance with:

- A small maximum stream length.
- A short expiry.
- Throttled and coalesced cursor/selection updates.
- A timestamp and monotonically increasing session-local revision.
- Client-side expiry of remote state.
- A per-session Redis key with a TTL refreshed by a heartbeat.
- A best-effort explicit leave message, without depending on it for cleanup.

Realtime does not supply a native authoritative participant roster or a disconnect callback that
implements the feature plan's TTL semantics. The roster must be derived from valid heartbeat keys
and locally observed events. Never replay stale awareness as if a participant were still online.

Keep durable document and awareness channels separate. A maximum-length policy suitable for
cursors could destroy required CRDT history if it were accidentally applied to the document
stream.

## QStash responsibilities

QStash is appropriate after an update has already been accepted and made live. It must not sit in
the keystroke acknowledgement path.

Recommended jobs:

- Compact a room after an update-count or byte threshold.
- Sweep rooms whose threshold trigger was missed.
- Delete expired room data and orphaned R2 assets.
- Produce room exports or backups.
- Reconcile abandoned collaboration asset uploads.
- Send invitation email or external webhooks.

Do not use QStash for:

- CRDT update fan-out.
- Cursor or selection messages.
- Participant heartbeats.
- Immediate role changes.
- Uploading or finalizing SCR3 recordings.
- Ordering every edit through a FIFO queue.

A compaction request should contain `roomId` and `expectedGeneration`, use a stable deduplication
ID for publication retries, and be verified with the QStash signing keys. The handler should:

1. Acquire an expiring per-room Redis lock.
2. Load snapshot generation `G` and choose an immutable stream cutoff `C`.
3. Apply only updates through `C`.
4. Conditionally write generation `G + 1` and its state vector/cutoff.
5. Trim only updates included through `C`, never concurrently appended updates.
6. Release the lock.

The handler remains idempotent even though QStash offers a ten-minute publication deduplication
window. A delivery may be retried after the endpoint performed work but its response was lost.

## Cost and throughput considerations

### Development cost: currently $0 within the free-tier limits

The proposed Upstash path can currently be developed and prototyped at no service cost while its
combined traffic stays within these published free-tier allowances:

| Service       | Plan | Price | Published allowance                                                  |
| ------------- | ---- | ----- | -------------------------------------------------------------------- |
| Upstash Redis | Free | $0    | 256 MB data, 10 GB monthly bandwidth, and 500,000 commands per month |
| QStash        | Free | $0    | 1,000 messages per day                                               |

Upstash positions both free plans for prototypes and hobby projects, which matches the expected
development phase of this feature.

Realtime does not add a separate collaboration quota: its connections, keepalives, history reads,
and event emissions consume Redis commands. Therefore, the Redis allowance must cover both the
existing Redis workload and all Realtime activity—or, as recommended here, the complete workload
of a dedicated collaboration database. The $0 estimate is appropriate for development and
prototypes, not an assumption about production cost; usage limits and pricing should be checked
again before launch.

### What consumes the Redis allowance

Realtime is billed through the Redis commands it performs:

- Initial client connection: `SUBSCRIBE` and `XRANGE`.
- Periodic reconnect: `UNSUBSCRIBE`, `XRANGE`, and `SUBSCRIBE`.
- Keepalive: `PUBLISH`.
- Event emission: `XADD` and `PUBLISH`.
- Event emission with stream expiration: `XADD`, `PUBLISH`, and `EXPIRE`.

At ten emitted events per second, document/control traffic alone produces about 36,000 events and
at least 72,000 Redis commands per hour. Running that load for one hour every day produces about
2.16 million commands per month before connection, heartbeat, snapshot, role-check, and awareness
operations. This is why collaboration should not share the existing cache database or its budget.

Upstash's published Realtime guidance says the HTTP/SSE design is not a one-for-one socket
replacement and recommends a socket provider for extremely high-frequency traffic above roughly
15–20 updates per second. A collaborative editor can reach that rate with only a few participants
unless updates and awareness are deliberately batched.

QStash pricing counts each delivery attempt, including retries. A normal background job volume is
small relative to edit traffic, but publishing every edit would be both architecturally incorrect
and needlessly expensive.

## Required transport spike

Before choosing Realtime, exercise the real provider and Yjs payloads at:

- 2, 5, and 10 simultaneous editors.
- Same-file and different-file edits.
- 50–100 ms document batching and throttled awareness.
- One-minute offline edits followed by reconnect.
- Reordered and duplicated delivery.
- Role downgrade while a modified client keeps sending.
- Large initial snapshots and long update tails.

Record:

- P50/P95/P99 accepted-update-to-remote-apply latency.
- SSE reconnect and bootstrap time.
- Redis commands and bandwidth per active room-hour.
- Snapshot size, update bytes, and compaction time.
- CPU and D1/Redis calls made by the upstream update endpoint.
- Divergence, missed updates, duplicates, and stale awareness.

The exact thresholds should follow the intended room size and UX target. A failed spike means the
WebSocket protocol in the main plan remains the correct data plane; it does not invalidate Yjs,
Redis persistence, QStash background work, or any editor integration decision.

## Operational and security requirements

- Keep Redis and QStash credentials in Worker secrets.
- Use a dedicated collaboration database with an explicit budget and alerts.
- Never accept a browser-provided user ID, role, display name, or channel authorization as
  authoritative.
- Do not log source updates, snapshots, cursor positions, or QStash request bodies.
- Define document, update-log, snapshot, awareness, and asset retention separately.
- Rate-limit both HTTP writes and SSE subscriptions.
- Validate QStash signatures against both current and next signing keys.
- Treat Redis unavailability as a room connection failure, not as a cache miss.
- Provide an owner export/recovery path independent of the current compacted snapshot.

## Implementation impact if selected

The option would add:

- A dedicated collaboration Redis factory with strict failure semantics.
- Realtime event schemas and a same-origin SSE route in the Hono Worker.
- Authenticated bootstrap and document-update routes.
- D1 migrations for rooms, memberships, invitations, and role versions.
- A browser provider actor that coordinates SSE, bootstrap, POST writes, offline updates, and
  `collaborationMachine` lifecycle.
- QStash-signed compaction and cleanup routes.
- Separate document, awareness, and control quotas and dashboards.

These are deployment-specific adapter concerns. The shared document schema, Monaco bindings,
workspace projection, playback isolation, and SCR3 recording code should not import Upstash SDKs.

## References

- [Upstash Redis getting started](https://upstash.com/docs/redis/overall/getstarted)
- [Upstash Redis pricing](https://upstash.com/pricing/redis)
- [Upstash Realtime quickstart](https://upstash.com/docs/realtime/overall/quickstart)
- [Realtime client-side usage](https://upstash.com/docs/realtime/features/client-side)
- [Realtime server-side usage](https://upstash.com/docs/realtime/features/server-side)
- [Realtime channels and authorization](https://upstash.com/docs/realtime/features/channels)
- [Realtime authentication middleware](https://upstash.com/docs/realtime/features/middleware)
- [Realtime history](https://upstash.com/docs/realtime/features/history)
- [Realtime deployment and reconnect behavior](https://upstash.com/docs/realtime/features/serverless)
- [Realtime Redis command pricing](https://upstash.com/docs/realtime/overall/pricing)
- [Upstash Realtime design guidance](https://upstash.com/blog/about-upstash-realtime)
- [QStash getting started](https://upstash.com/docs/qstash/overall/getstarted)
- [QStash retry behavior](https://upstash.com/docs/qstash/features/retry)
- [QStash deduplication](https://upstash.com/docs/qstash/features/deduplication)
- [QStash receiver signature verification](https://upstash.com/docs/qstash/sdks/ts/examples/receiver)
- [QStash pricing](https://upstash.com/pricing/qstash)
