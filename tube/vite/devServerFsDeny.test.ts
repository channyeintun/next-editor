// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// The dev server serves the repo root, so its deny glob is the only thing
// between a request and every secret-bearing file in the checkout. Resolved
// from the real vite.config.ts, the way `vp dev` resolves it.
async function resolvedDenyGlob(): Promise<(path: string) => boolean> {
  const config = await resolveConfig(
    { configFile: `${repoRoot}vite.config.ts`, logLevel: "silent" },
    "serve",
  );
  return (config as unknown as { fsDenyGlob: (path: string) => boolean }).fsDenyGlob;
}

describe("dev server fs.deny", () => {
  it("denies Vite's defaults, the Worker's secrets and local Miniflare state", async () => {
    const denied = await resolvedDenyGlob();

    for (const path of [
      // Vite's own defaults, which a configured deny array replaces.
      ".env",
      ".env.production",
      "certs/localhost.pem",
      "certs/localhost.key",
      ".npmrc",
      ".git/config",
      "tube/.git/HEAD",
      // The Worker's local secrets.
      "infra/.dev.vars",
      "infra/.dev.vars.production",
      // Local D1/R2/KV state written by wrangler dev.
      "infra/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/db.sqlite",
      ".wrangler/tmp/bundle.js",
    ]) {
      expect({ path, denied: denied(`${repoRoot}${path}`) }).toEqual({ path, denied: true });
    }
  }, 60_000);

  it("still serves the app's own files", async () => {
    const denied = await resolvedDenyGlob();

    for (const path of [
      "index.html",
      "src/main.tsx",
      "public/lessons/introduction/introduction.ne",
      "src/types/env.d.ts",
    ]) {
      expect({ path, denied: denied(`${repoRoot}${path}`) }).toEqual({ path, denied: false });
    }
  }, 60_000);
});

describe("local secret files", () => {
  // The Worker's per-environment secret files are never committed either
  // (wrangler dev reads infra/.dev.vars.<environment>), while the example
  // beside them is.
  function isIgnored(path: string): boolean {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  it("ignores every .dev.vars file but the example", () => {
    for (const [path, ignored] of [
      ["infra/.dev.vars", true],
      ["infra/.dev.vars.production", true],
      ["infra/.dev.vars.staging", true],
      ["infra/.dev.vars.example", false],
    ] as const) {
      expect({ path, ignored: isIgnored(path) }).toEqual({ path, ignored });
    }
  });
});
