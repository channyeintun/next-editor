import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Env } from "../env";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import { upsertUserByGoogleSub, type UpsertUserResult } from "../../db/queries";
import { userRowToAuthUser } from "../../db/types";
import { base64UrlDecodeToBytes, base64UrlEncode, randomBase64Url } from "../base64url";
import { isHttps, startSession } from "./session";
import {
  googleIdentityFromClaims,
  verifyGoogleIdToken,
  type VerifiedGoogleIdToken,
} from "./googleIdToken";

const HANDSHAKE_COOKIE = "ne_oauth";
const HANDSHAKE_MAX_AGE_SECONDS = 10 * 60; // just long enough for the Google round trip
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Bounds the code-for-token exchange, body included: a Worker waiting on a
// subrequest has no wall-clock limit, so a stalled Google would otherwise
// leave the sign-in redirect hanging with no message.
const GOOGLE_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
// A One Tap request carries one Google ID token (a JWT of a couple of KB).
const MAX_ONETAP_REQUEST_BYTES = 8 * 1024;

interface HandshakePayload {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

// Rejects anything but a same-origin relative path, so a malicious
// `?returnTo=` can't turn a real login into an open redirect.
//
// Resolved against a placeholder origin rather than prefix-matched. A
// `startsWith("//")` test only catches the protocol-relative form: browsers
// resolve a `Location` header with the WHATWG URL parser, which treats `\` as
// `/` for special schemes, so `/\evil.com` (and `/\/evil.com`, and tab- or
// newline-separated variants) parsed as a host and sent the victim
// cross-origin straight after a genuine Google sign-in. Re-serializing from the
// parser is what makes every one of those forms collapse to a real path.
//
// Resolving also removes dot segments, so a same-origin input such as
// "/.//evil.com" (or "/%2e//", "/..//", "/./\") serializes to the path
// "//evil.com", which a browser reads back as protocol-relative. The result is
// therefore checked too: one pass has to be safe on its own.
export function sanitizeReturnTo(value: string | undefined | null): string {
  if (!value) {
    return "/";
  }
  const placeholder = "https://placeholder.invalid";
  try {
    const resolved = new URL(value, placeholder);
    if (resolved.origin !== placeholder) {
      return "/";
    }
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return /^[/\\]{2}/.test(path) ? "/" : path;
  } catch {
    return "/";
  }
}

// The id_token comes directly from Google's token endpoint over a
// server-to-server HTTPS request we just made ourselves (not passed through
// the browser), so it's trusted without re-verifying its signature — the
// thing a signature check defends against (a forged/tampered token from an
// untrusted party) doesn't apply to a value we just fetched straight from
// Google. Re-add JWKS signature verification here if that trust boundary
// ever changes (e.g. accepting id_tokens from the client directly).
function decodeIdTokenPayload(idToken: string): VerifiedGoogleIdToken {
  const [, payloadSegment] = idToken.split(".");
  if (!payloadSegment) {
    throw new Error("Malformed id_token: missing payload segment");
  }
  return googleIdentityFromClaims(
    JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(payloadSegment))),
  );
}

// Why a Google identity gets no account here: both are about users.email,
// which is UNIQUE, so a new account may only take an address that is its own
// and still free (see upsertUserByGoogleSub).
const REFUSED_SIGN_IN: Record<
  Exclude<UpsertUserResult["status"], "ok">,
  { status: 403 | 409; message: string }
> = {
  "email-in-use": {
    status: 409,
    message:
      "Another Next Editor account already uses this Google account's email address. Sign in with the Google account you used before.",
  },
  "email-unverified": {
    status: 403,
    message:
      "Google hasn't verified this account's email address yet. Verify it with Google, then sign in again.",
  },
};

/** Creates or refreshes the account for a trusted Google identity. */
function upsertGoogleUser(db: D1Database, identity: VerifiedGoogleIdToken) {
  return upsertUserByGoogleSub(db, {
    googleSub: identity.sub,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name: identity.name ?? null,
    avatarUrl: identity.picture ?? null,
  });
}

// Mounted at /api/auth/google in worker/index.ts.
export const googleAuthRoute = new Hono<{ Bindings: Env }>();

// The OAuth client id is public by design (it ships in every GIS snippet on
// the web); exposing it here saves the client bundle from needing its own
// build-time env plumbing.
googleAuthRoute.get("/config", (c) => c.json({ clientId: c.env.GOOGLE_CLIENT_ID }));

// Google One Tap sign-in. The browser posts the CredentialResponse JWT from
// GIS's callback; unlike /callback below, this token crossed an untrusted
// client, so it goes through full JWKS signature verification (see
// googleIdToken.ts) before its claims are believed.
googleAuthRoute.post("/onetap", async (c) => {
  const read = await readJsonWithLimit(c.req.raw, MAX_ONETAP_REQUEST_BYTES);
  if (read.status === "too-large") {
    return c.json({ error: "request body is too large" }, 413);
  }
  const body = read.status === "ok" && isJsonObject(read.value) ? read.value : null;
  const credential = typeof body?.credential === "string" ? body.credential : null;
  if (!credential) {
    return c.json({ error: "Missing credential." }, 400);
  }

  let identity: VerifiedGoogleIdToken;
  try {
    identity = await verifyGoogleIdToken(credential, { clientId: c.env.GOOGLE_CLIENT_ID });
  } catch (error) {
    return c.json({ error: `Google sign-in failed: ${String(error)}` }, 401);
  }

  const result = await upsertGoogleUser(c.env.DB, identity);
  if (result.status !== "ok") {
    const refused = REFUSED_SIGN_IN[result.status];
    return c.json({ error: refused.message }, refused.status);
  }
  await startSession(c, result.user.id);
  return c.json({ user: userRowToAuthUser(result.user) });
});

googleAuthRoute.get("/login", async (c) => {
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await pkceChallengeFromVerifier(codeVerifier);
  const returnTo = sanitizeReturnTo(c.req.query("returnTo"));

  const payload: HandshakePayload = { state, codeVerifier, returnTo };
  await setSignedCookie(c, HANDSHAKE_COOKIE, JSON.stringify(payload), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/api/auth/google",
    maxAge: HANDSHAKE_MAX_AGE_SECONDS,
  });

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", `${c.env.PUBLIC_URL}/api/auth/google/callback`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return c.redirect(authUrl.toString(), 302);
});

googleAuthRoute.get("/callback", async (c) => {
  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const handshakeJson = await getSignedCookie(c, c.env.SESSION_SECRET, HANDSHAKE_COOKIE);
  deleteCookie(c, HANDSHAKE_COOKIE, { path: "/api/auth/google" });

  if (!code || !returnedState || !handshakeJson) {
    return c.text(
      "OAuth error: missing code, state, or expired handshake. Please try signing in again.",
      400,
    );
  }

  // The cookie is signed and self-set, so a parse failure means a corrupted
  // or truncated cookie, not an attack — but it must not escape as a 500.
  let handshake: HandshakePayload;
  try {
    handshake = JSON.parse(handshakeJson) as HandshakePayload;
  } catch {
    return c.text("OAuth error: malformed handshake cookie. Please try signing in again.", 400);
  }
  if (handshake.state !== returnedState) {
    return c.text("OAuth error: state mismatch. Please try signing in again.", 400);
  }

  let tokens: { id_token?: string };
  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${c.env.PUBLIC_URL}/api/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: handshake.codeVerifier,
      }),
      signal: AbortSignal.timeout(GOOGLE_TOKEN_EXCHANGE_TIMEOUT_MS),
    });

    if (!tokenResponse.ok) {
      return c.text(`OAuth error: Google token exchange failed (${tokenResponse.status}).`, 502);
    }

    tokens = (await tokenResponse.json()) as { id_token?: string };
  } catch (error) {
    // A timeout, a network error or an unreadable body: Google never answered
    // usefully, which is this route's 502 rather than an unhandled 500.
    console.error("Google token exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.text("OAuth error: Google token exchange failed (unreachable).", 502);
  }
  if (!tokens.id_token) {
    return c.text("OAuth error: Google's response had no id_token.", 502);
  }

  let idTokenPayload: VerifiedGoogleIdToken;
  try {
    idTokenPayload = decodeIdTokenPayload(tokens.id_token);
  } catch {
    return c.text("OAuth error: Google's id_token could not be decoded.", 502);
  }
  const result = await upsertGoogleUser(c.env.DB, idTokenPayload);
  if (result.status !== "ok") {
    const refused = REFUSED_SIGN_IN[result.status];
    return c.text(`Sign-in refused: ${refused.message}`, refused.status);
  }

  await startSession(c, result.user.id);

  // Re-sanitized rather than trusted from the handshake cookie: this is the
  // value that actually reaches the browser as a Location header, so it is the
  // one that has to be safe regardless of how it was stored.
  return c.redirect(sanitizeReturnTo(handshake.returnTo), 302);
});
