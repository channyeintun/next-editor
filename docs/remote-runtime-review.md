# Remote Runtime implementation review

**Review date:** 2026-07-16  
**Normative source:** [`remote-runtime-design.md`](./remote-runtime-design.md)  
**Delivery scope:** the isolated [`remote-runtime/`](../remote-runtime/README.md) package described
by [`remote-runtime-implementation-plan.md`](./remote-runtime-implementation-plan.md). Editor and
existing `infra/` integration remain explicitly deferred by that plan.

## Verdict

The package follows the intended high-level split (thin TypeScript client, RCP, one Go agent, and
a Cloudflare Container Durable Object), but the initial review found correctness and isolation
defects that made the standalone implementation unsafe to call complete. The findings below were
fixed as part of this review. Bounded TypeScript, Worker, and in-process Go checks pass; Docker,
`wrangler dev`, staging, and soak evidence is still required before rollout.

## Findings and resolutions

### RR-01 — Critical — Agent data could overtake its control response

`fs.readFile`, `export`, and `proc.spawn` started producer goroutines before `session.handle` wrote
the corresponding `ok` frame. A fast process could therefore send output or `proc.exit` before the
client knew the channel/PID and installed its listeners. The result was a fatal unknown-channel
error or an `exit` promise that never resolved.

**Resolution:** agent operations now return a deferred producer callback. `session.handle` writes
and size-checks the response first, then starts streaming. A fast-process integration regression
asserts that the spawn response is the first frame.

### RR-02 — Critical — Filesystem jail and mount extraction had symlink escape paths

The write/mount path resolver checked only the parent whenever a path was allowed to be missing.
If the final component already existed as a symlink, `os.WriteFile` or mount extraction could follow
it outside the workspace. ZIP extraction also followed symlinks created by earlier archive members,
unpacked directly into the live workspace, and did not enforce expanded archive/file limits.
Conversely, the jail rejected the absolute `workdir` path returned by the agent itself.

**Resolution:** following operations validate the final component, while entry operations (`rm`
and `rename`) use an explicit no-follow-final resolver. Workspace-scoped absolute paths are
accepted. Mounts extract into a sibling staging directory, reject duplicate/deep/oversized entries
and traversal through archive symlinks, then merge without following destination symlinks. Export
now caps individual and aggregate sizes and closes each source file promptly.

### RR-03 — High — Preview error forwarding did not work in production

`forwardPreviewErrors` was ignored. The message listener compared every event to a preview URL
rendered with port `8600`; production uses a different origin for each port, so legitimate messages
from (for example) port 8080 were rejected. Payload validation also accepted incomplete message
shapes.

**Resolution:** the SDK installs an origin-scoped error/unhandled-rejection forwarder (plus
`console.error` unless `"exceptions-only"` was requested), sends it separately from the user's
script so `type="importmap"` remains valid, validates the full message shape and session id, and
renders the expected origin from the message's actual port.

### RR-04 — High — Preview WebSocket/HMR upgrades were dropped

The Durable Object decorated every preview response by constructing a new `Response`, but did not
carry over `response.webSocket`. This breaks the WebSocket passthrough required by Vite and other
dev-server HMR clients. Script injection also only handled documents containing an explicit
`<head>`, and script-end escaping was case-sensitive.

**Resolution:** 101 responses retain the WebSocket handle while receiving the preview security
headers. HTML without a head gets a document-end fallback, only the first head is injected, and
`</script` escaping is case-insensitive. A unit regression checks WebSocket-handle preservation.

### RR-05 — High — Provisioning could leak sessions and ignored `workdirName`

`POST /sessions` recorded an active quota row but configuration did not start or health-check the
container. A client that never reached the WebSocket left an active row without a running container
whose stop hook could finalize it. `workdirName` was discarded, and the configured timeout/start
environment existed only in one Durable Object instance. On the client, a failed WebSocket hello
did not delete the already-provisioned session.

**Resolution:** configuration persists and reapplies the session settings, starts the container,
waits for agent port 8600 using `/healthz`, and passes a validated
`REMOTE_RUNTIME_WORKSPACE`. Docker defaults now allow that environment to select the workspace.
Explicit teardown uses container destruction. Failed SDK boot/hello and failed provisioning both
initiate authenticated reservation cleanup (with idle reclaim as the backstop); this is covered by
client and Durable Object regressions.

### RR-06 — High — Quota admission was race-prone and failures were mislabeled as auth errors

Concurrent quota enforcement used `SELECT COUNT` followed by an unconditional `INSERT`, allowing
simultaneous requests to exceed the limit. The Worker's catch-all converted malformed requests,
D1 outages, and Durable Object failures into `401 EAUTH` responses, obscuring operational errors.

**Resolution:** the D1 reservation is a conditional `INSERT ... SELECT`, so the count and daily
usage predicates are enforced by the mutating statement. Follow-up reads only choose the user-facing
quota message. Authentication, bad input, and internal failures now produce distinct 401, 400, and
500 responses, and a failed DO call finalizes its reservation. The Worker also fails closed with a
configuration error when the HMAC secret is absent or shorter than the documented 32-byte minimum.

### RR-07 — Medium — Limits and reconnect accounting had correctness gaps

Exited processes stayed in the resume map for 60 seconds and were counted against the 64-process
concurrency limit. Delayed kill escalation tested only map membership, so it could signal an already
exited process group. A disconnect during a partially written output chunk buffered the entire
chunk, duplicating the prefix on resume. Client requests bypassed the control-frame size codec,
credit could overflow, and export buffering was unbounded. The resume token itself never expired,
so the documented 60-second resume/reclaim boundary could stretch to the configured one-hour idle
maximum.

**Resolution:** only non-exited processes count as active, escalation checks exit state, partial
writes report their consumed prefix, outbound control frames use the bounded codec, credit growth is
validated on both sides, response frames are size-checked, and exports have file/aggregate/archive
caps. Re-registering an existing watch also no longer fails when the watch table is exactly full.
An unresumed disconnect now rotates the token, terminates retained processes/watchers, and exits the
container after 60 seconds; a valid resume advances the session generation and cancels that reclaim.

### RR-08 — Medium — Compatibility and conformance claims were stronger than the evidence

`RemoteContainer.fs` was forced through `unknown as WebContainer["fs"]`, making the advertised
compile-time compatibility assertion tautological. Several WebContainer filesystem overloads were
not represented, while the checked-in conformance file did not exercise stdin, dynamic resize,
`cwd`, environment conversion, recursive/forced removal, or port-close events.

**Resolution:** `RemoteFs` now implements the actual `FileSystemAPI`, `RemoteProcess` implements
`WebContainerProcess`, and `RemoteContainer` implements the documented `Pick<WebContainer, ...>`.
Buffer-name and Node-style file encoding overloads are implemented and unit-tested. The endpoint
conformance matrix now adds the missing bounded filesystem/process/port behaviors.

## Remaining validation gates

These are environment or integration gates, not silently accepted implementation results:

- Build and smoke the `linux/amd64` Docker image, then run direct `RemoteContainer.attach`
  conformance against it.
- Run `wrangler dev` conformance through `RemoteContainer.boot`, including a real Vite HMR upgrade,
  header/injection checks, idle reclaim, and failed-provision cleanup.
- Run the reconnect soak and staging conformance; verify quota finalization and absence of orphaned
  containers over the documented soak period.
- Complete the manual Cloudflare DNS/TLS/D1/secrets setup and replace the standalone HMAC issuance
  boundary with application authentication during the separately authorized editor/`infra/`
  integration phases.

Until those gates are recorded, the correct status is **standalone implementation hardened;
environment validation pending**, not rollout-ready.

## Verification performed

- SDK/RCP TypeScript compilation: pass (`tsc -p remote-runtime/tsconfig.json --noEmit`).
- SDK/RCP bounded tests: 23 pass; 7 endpoint-dependent cases skip without a configured runtime.
- Worker TypeScript compilation: pass (`tsc -p remote-runtime/worker/tsconfig.json --noEmit`).
- Worker bounded tests: 17 pass.
- Go 1.26.5 agent tests: pass, including localhost WebSocket/proxy integration cases.
- Go agent static analysis: pass (`go vet ./...` within `remote-runtime/agent`).
