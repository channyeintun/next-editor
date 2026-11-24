/**
 * `login --local`: one fixed test user and a session for it, written into the
 * D1 database `wrangler dev` keeps on this machine, and the cookie that
 * carries the session. The Worker accepts it as it accepts any sign-in: a
 * session row whose id is the cookie's value and whose expiry is in the
 * future (getLiveSession in infra/db/queries.ts).
 */

/** The D1 database the Worker binds, as infra/wrangler.toml names it. */
export const LOCAL_DATABASE = "next-editor-tube";
/** The config both `wrangler dev` and the driver's wrangler calls use, so they share one local state. */
export const WRANGLER_CONFIG = "infra/wrangler.toml";

/**
 * The test user. Fixed, so a second `login --local` signs in the same account
 * and its local drafts stay its own. The username keeps to [a-z0-9-], as
 * every profile link (/learn/@<username>) needs.
 */
export const LOCAL_STUDIO_USER = {
  id: "00000000-0000-4000-8000-000000057d10",
  googleSub: "local-studio",
  email: "studio-local@localhost.test",
  name: "Studio (local)",
  username: "studio-local",
} as const;

/**
 * How long the driver's local session lasts. The driver's own choice, not the
 * Worker's sign-in rule: the Worker only checks that the expiry is ahead.
 */
export const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The session cookie over http, where it carries no `__Host-` prefix (infra/worker/auth/session.ts). */
export const SESSION_COOKIE = "ne_session";
/** The same cookie as an https site names it. */
export const HOST_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

/** One SQL text literal. Every value here is the driver's own; quoting keeps it so whatever they are. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The statements for `wrangler d1 execute --local --command`: the user when it
 * is not there yet, this user's expired sessions swept as a real sign-in
 * sweeps them, and the new session.
 */
export function localSessionSql(input: { sessionId: string; nowMs: number }): string {
  const user = LOCAL_STUDIO_USER;
  const now = Math.floor(input.nowMs);
  const expires = now + LOCAL_SESSION_TTL_MS;
  // The session names the user by its google_sub, so a user row made by an
  // older login (with another id) is still the one signed in.
  const userId = `(SELECT id FROM users WHERE google_sub = ${literal(user.googleSub)})`;
  return [
    `INSERT INTO users (id, google_sub, email, name, avatar_url, username, created_at) VALUES (${[
      literal(user.id),
      literal(user.googleSub),
      literal(user.email),
      literal(user.name),
      "NULL",
      literal(user.username),
      String(now),
    ].join(", ")}) ON CONFLICT(google_sub) DO NOTHING;`,
    `DELETE FROM sessions WHERE user_id = ${userId} AND expires_at <= ${now};`,
    `INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (${literal(input.sessionId)}, ${userId}, ${now}, ${expires});`,
  ].join("\n");
}

export interface LocalSessionCookie {
  name: string;
  value: string;
  url: string;
  httpOnly: true;
  sameSite: "Lax";
  /** Seconds since the epoch, as a browser cookie's expiry is given. */
  expires: number;
}

/**
 * The cookie for a session on the dev server. Plain http only (the command
 * line refuses anything else): over https the Worker reads only a `__Host-`
 * cookie, and the dev server is http.
 */
export function localSessionCookie(input: {
  site: string;
  sessionId: string;
  nowMs: number;
}): LocalSessionCookie {
  return {
    name: SESSION_COOKIE,
    value: input.sessionId,
    url: input.site,
    httpOnly: true,
    sameSite: "Lax",
    expires: Math.floor((input.nowMs + LOCAL_SESSION_TTL_MS) / 1000),
  };
}

/** The wrangler commands, in order, as argument lists. `--local` is in every one: nothing here reaches the account. */
export function localSessionCommands(sql: string): string[][] {
  return [
    [
      "bunx",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      LOCAL_DATABASE,
      "--local",
      "--config",
      WRANGLER_CONFIG,
    ],
    [
      "bunx",
      "wrangler",
      "d1",
      "execute",
      LOCAL_DATABASE,
      "--local",
      "--config",
      WRANGLER_CONFIG,
      "--command",
      sql,
    ],
  ];
}
