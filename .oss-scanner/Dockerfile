# check=skip=SecretsUsedInArgOrEnv
# Build environment for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this image with the repository as the build context, then audits it with
# no network access, so every dependency the build and the tests need is installed here.
FROM node:24-bookworm
# vite.config.ts constructs the PostHog source-map plugins whenever it loads (vitest loads it too), and
# they refuse to start without a project id and API key. Placeholders (not secrets, hence the lint skip on
# line 1) let the config load; no build step here uploads.
ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    VP_GIT_HOOKS=0 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    POSTHOG_PROJECT_ID=0 \
    POSTHOG_API_KEY=unused
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

# The package manager is bun (package.json "packageManager"); vite-plus (`vp`) and vitest run on node.
RUN npm install -g bun@1.3.13

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# A large tarball (posthog-js) can arrive truncated on a slow link; retry before failing the build.
# bun's download cache is dropped in the same layer so the image does not carry the packages twice.
RUN for attempt in 1 2 3; do \
      bun install --frozen-lockfile && rm -rf /root/.bun/install/cache && exit 0; \
      echo "bun install failed (attempt $attempt), retrying"; rm -rf node_modules; sleep 10; \
    done; exit 1

# Production build without the PostHog source-map upload: those two plugins need deploy secrets and
# network access, and nothing else depends on them. Everything else (React Compiler, Brotli sidecars,
# the prerendered landing page, the Rust dmp codec, which is committed as WASM) builds as in deploys.
RUN printf '%s\n' \
      'import base from "./vite.config.ts";' \
      'const skip = new Set(["posthog-rollup-plugin", "next-editor-posthog-deploy-release"]);' \
      'export default (env) => {' \
      '  const config = base(env);' \
      '  config.plugins = config.plugins.flat().filter((plugin) => !(plugin && skip.has(plugin.name)));' \
      '  return config;' \
      '};' > vite.scanner.config.ts
RUN bun run typecheck && npx vp build --config vite.scanner.config.ts

# The test suites run offline (jsdom; the Worker suite runs in node). A failure is reported, not fatal.
RUN npx vp test run || echo "WARNING: app tests reported failures"
RUN npx vitest run --config infra/worker/vitest.config.ts || echo "WARNING: worker tests reported failures"
