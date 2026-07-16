# Remote runtime hardening and verification

This package enforces the RCP v1 limits in both codecs and the agent: 1 MiB control frames,
256 KiB binary frames, 64 MiB file transfers, 256 MiB mount archives, 64 processes, 128 watches,
and 64 path components. Channel credit is replenished only after bytes are consumed. The Go frame
parser includes a native fuzz target (`FuzzParseBinaryFrame`).

An interrupted RCP session is resumable for 60 seconds. If no valid resume arrives, the agent
rotates the token, terminates retained processes and watchers, and exits so the control plane can
finalize usage instead of extending the session to the general idle-timeout maximum.

Container egress is intentionally enabled in v1 so `go get`, module downloads, and application HTTP
requests work. Isolation comes from one Cloudflare Container per session, a non-root image user, no
secrets inside the image, jailed filesystem RPCs, signed session WebSockets, runtime allowlisting,
and D1 concurrency/daily-minute quotas.

Focused verification on a small host:

```sh
cd remote-runtime
bun run typecheck
bun run test

cd agent
GOTOOLCHAIN=auto go test -timeout 15s ./...
GOTOOLCHAIN=auto go vet ./...
GOTOOLCHAIN=auto go test -fuzz=FuzzParseBinaryFrame -fuzztime=30s

cd ../worker
bun run typecheck
bun run test
```

Docker/agent conformance:

```sh
REMOTE_RUNTIME_AGENT_WS=ws://127.0.0.1:8600/ws bun run test
```

Full `wrangler dev` conformance:

```sh
REMOTE_RUNTIME_ENDPOINT=http://127.0.0.1:8787/api/runtime \
REMOTE_RUNTIME_AUTH_TOKEN=... \
bun run test
```

The opt-in reconnect soak takes approximately 30 minutes and deliberately drops 180 WebSocket
connections while checking 1,800 ordered output records:

```sh
REMOTE_RUNTIME_SOAK=1 \
REMOTE_RUNTIME_AGENT_WS=ws://127.0.0.1:8600/ws \
bun run test -- conformance/remote-runtime.conformance.test.ts
```

Do not run Docker, Wrangler, fuzz, or soak checks on resource-constrained production hosts. The
standard unit/in-process integration checks remain bounded and foreground-only.
