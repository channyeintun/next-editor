# Remote Runtime package

This directory is an isolated implementation of the remote runtime described in
`../docs/remote-runtime-design.md`. It is intentionally not wired into the editor or the existing
`infra/` Worker yet.

## Components

- `src/rcp`: the TypeScript RCP codec, channel multiplexer, limits, and error mapping.
- `src/remote`: the standalone `RemoteContainer` client SDK.
- `agent`: the Go process/filesystem/watch/port/proxy agent baked into each image.
- `images`: version-pinned base and language image definitions.
- `worker`: the standalone Cloudflare Worker control plane.

## Focused checks

```sh
cd remote-runtime
../node_modules/.bin/tsc -p tsconfig.json --noEmit
../node_modules/.bin/vitest run

cd agent
GOCACHE=/tmp/next-editor-go-cache GOMODCACHE=/tmp/next-editor-go-mod go test ./...
```

## Images

Cloudflare Containers require `linux/amd64`. Build from this directory so the base Dockerfile can
copy the agent module:

```sh
docker build --platform linux/amd64 -f images/Dockerfile.base -t next-editor-runtime-base:0.1.0 .
docker build --platform linux/amd64 -f Dockerfile.go1.26.5 -t next-editor-runtime-go1.26.5:0.1.0 .
docker build --platform linux/amd64 -f images/Dockerfile.node22 -t next-editor-runtime-node22:0.1.0 .
```

The Go 1.26.5 image should use Cloudflare's `basic` instance type: its 1 GiB memory and 4 GB disk are a
safer starting point for compilation than `lite`. `wrangler deploy` builds and pushes a local
Dockerfile automatically; prebuilt images can instead be pushed with `wrangler containers build
-p`. Docker must be running for either local build path.
