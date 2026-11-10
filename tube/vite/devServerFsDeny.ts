// What the dev server refuses to serve from the repo root it serves
// (vite.config.ts sets no root), wired into server.fs.deny by vite.config.ts.
//
// A configured server.fs.deny array REPLACES Vite's own list: the config
// merge recurses into plain objects only and assigns arrays whole. A list of
// just this project's patterns therefore served /.env (the PostHog personal
// API key), key files, .npmrc and /.git/** to anyone who could reach the
// port. Vite does not export its defaults, so they are restated here, copied
// from the installed Vite (vite-plus-core 1.5.1); re-check them after a Vite
// bump.
const VITE_DEFAULT_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem,key,p12,pfx,cer,der}",
  ".npmrc",
  ".yarnrc.yml",
  "**/.git/**",
];

/**
 * Vite's defaults plus this project's own secrets: the Worker's local
 * secrets (`infra/.dev.vars`, GOOGLE_CLIENT_SECRET, SESSION_SECRET, the
 * QStash signing keys) and the local D1/R2/KV state `wrangler dev` writes
 * under `.wrangler/`. A pattern without a "/" matches at any depth.
 */
export const DEV_SERVER_FS_DENY = [
  ...VITE_DEFAULT_FS_DENY,
  ".dev.vars",
  ".dev.vars.*",
  "**/.wrangler/**",
];
