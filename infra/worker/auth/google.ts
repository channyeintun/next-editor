import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Env } from "../env";
import { upsertUserByGoogleSub, createSession } from "../../db/queries";
import { setSessionCookie } from "./session";

const HANDSHAKE_COOKIE = "ne_oauth";
const HANDSHAKE_MAX_AGE_SECONDS = 10 * 60; // just long enough for the Google round trip
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface HandshakePayload {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeToString(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function randomBase64Url(byteLength: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

// Rejects anything but a same-origin relative path, so a malicious
// `?returnTo=` can't turn a real login into an open redirect (absolute URLs
// and protocol-relative "//host" paths are both rejected).
function sanitizeReturnTo(value: string | undefined | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

// The id_token comes directly from Google's token endpoint over a
// server-to-server HTTPS request we just made ourselves (not passed through
// the browser), so it's trusted without re-verifying its signature — the
// thing a signature check defends against (a forged/tampered token from an
// untrusted party) doesn't apply to a value we just fetched straight from
// Google. Re-add JWKS signature verification here if that trust boundary
// ever changes (e.g. accepting id_tokens from the client directly).
function decodeIdTokenPayload(idToken: string): GoogleIdTokenPayload {
  const [, payloadSegment] = idToken.split(".");
  if (!payloadSegment) {
    throw new Error("Malformed id_token: missing payload segment");
  }
  return JSON.parse(base64UrlDecodeToString(payloadSegment));
}

// Mounted at /api/auth/google in worker/index.ts.
export const googleAuthRoute = new Hono<{ Bindings: Env }>();

googleAuthRoute.get("/login", async (c) => {
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await pkceChallengeFromVerifier(codeVerifier);
  const returnTo = sanitizeReturnTo(c.req.query("returnTo"));

  const payload: HandshakePayload = { state, codeVerifier, returnTo };
  await setSignedCookie(c, HANDSHAKE_COOKIE, JSON.stringify(payload), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
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

  const handshake = JSON.parse(handshakeJson) as HandshakePayload;
  if (handshake.state !== returnedState) {
    return c.text("OAuth error: state mismatch. Please try signing in again.", 400);
  }

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
  });

  if (!tokenResponse.ok) {
    return c.text(`OAuth error: Google token exchange failed (${tokenResponse.status}).`, 502);
  }

  const tokens = (await tokenResponse.json()) as { id_token?: string };
  if (!tokens.id_token) {
    return c.text("OAuth error: Google's response had no id_token.", 502);
  }

  const idTokenPayload = decodeIdTokenPayload(tokens.id_token);
  const user = await upsertUserByGoogleSub(c.env.DB, {
    googleSub: idTokenPayload.sub,
    email: idTokenPayload.email,
    name: idTokenPayload.name ?? null,
    avatarUrl: idTokenPayload.picture ?? null,
  });

  const session = await createSession(c.env.DB, user.id);
  setSessionCookie(c, session.id);

  return c.redirect(handshake.returnTo, 302);
});
