import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Env } from "../env";
import { createSession } from "../../db/queries";
import {
  getPasskeyCredentialWithUser,
  insertPasskeyCredential,
  listPasskeyCredentials,
  updatePasskeyCredentialAfterAuth,
} from "../../db/passkeyQueries";
import { passkeyRowToSummary, userRowToAuthUser } from "../../db/types";
import { getCurrentUser, setSessionCookie } from "./session";

const RP_NAME = "Next Editor";

// Same transient-signed-cookie pattern as the OAuth handshake in google.ts:
// the challenge has no DB backing, so the cookie itself must be
// tamper-proof, single-use, and short-lived.
const CHALLENGE_COOKIE = "ne_webauthn";
const CHALLENGE_MAX_AGE_SECONDS = 5 * 60;

interface ChallengePayload {
  challenge: string;
  purpose: "register" | "login";
  /** Only set for registration, which requires an authenticated session. */
  userId?: string;
}

// The WebAuthn Relying Party identity. In production both come from
// PUBLIC_URL. In local dev the browser is on some localhost port (vite or
// wrangler) while PUBLIC_URL still points at production, so the request's
// own Origin header wins for localhost — the one hostname WebAuthn treats
// as a secure context over plain http. Trusting the header is safe here:
// a forged "Origin: http://localhost" merely selects rpID "localhost", and
// assertions are still signature-checked against that rpID and a
// server-issued challenge, so it buys an attacker nothing.
function relyingParty(c: Context<{ Bindings: Env }>): { rpID: string; expectedOrigin: string } {
  const requestOrigin = c.req.header("Origin");
  if (requestOrigin && /^http:\/\/localhost(:\d+)?$/.test(requestOrigin)) {
    return { rpID: "localhost", expectedOrigin: requestOrigin };
  }
  const publicUrl = new URL(c.env.PUBLIC_URL);
  return { rpID: publicUrl.hostname, expectedOrigin: publicUrl.origin };
}

async function setChallengeCookie(
  c: Context<{ Bindings: Env }>,
  payload: ChallengePayload,
): Promise<void> {
  await setSignedCookie(c, CHALLENGE_COOKIE, JSON.stringify(payload), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/api/auth/passkey",
    maxAge: CHALLENGE_MAX_AGE_SECONDS,
  });
}

// Reads and immediately invalidates the challenge cookie — each issued
// challenge may be consumed by exactly one verify attempt.
async function takeChallengeCookie(
  c: Context<{ Bindings: Env }>,
  purpose: ChallengePayload["purpose"],
): Promise<ChallengePayload | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth/passkey" });
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as ChallengePayload;
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}

function parseTransports(json: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as AuthenticatorTransportFuture[];
  } catch {
    return undefined;
  }
}

// Mounted at /api/auth/passkey in worker/index.ts.
export const passkeyRoute = new Hono<{ Bindings: Env }>();

// The signed-in user's registered passkeys — lets the account menu show
// whether the account already has one (the WebAuthn ceremony itself can't
// tell the page "you already registered here"; it just fails).
passkeyRoute.get("/credentials", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }
  const credentials = await listPasskeyCredentials(c.env.DB, user.id);
  return c.json({ passkeys: credentials.map(passkeyRowToSummary) });
});

// Registration is adding a passkey to the signed-in account, so both
// register endpoints require a session.
passkeyRoute.post("/register/options", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const { rpID } = relyingParty(c);
  const existing = await listPasskeyCredentials(c.env.DB, user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.username,
    userDisplayName: user.name ?? user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // Lets the authenticator refuse a duplicate registration on a device
    // that already holds a passkey for this account.
    excludeCredentials: existing.map((row) => ({
      id: row.id,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: {
      // The passkey is a full sign-in method on its own (no password/second
      // factor), so it must be discoverable (login sends no allowCredentials)
      // and user-verified (the biometric/PIN is what stands in for a password).
      residentKey: "required",
      userVerification: "required",
    },
  });

  await setChallengeCookie(c, {
    challenge: options.challenge,
    purpose: "register",
    userId: user.id,
  });
  return c.json(options);
});

passkeyRoute.post("/register/verify", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const challenge = await takeChallengeCookie(c, "register");
  // The userId check pins the challenge to the session that requested it —
  // a challenge minted under one account can't register a credential on
  // another (e.g. after a sign-out/sign-in between options and verify).
  if (!challenge || challenge.userId !== user.id) {
    return c.json({ error: "Registration challenge missing or expired. Please try again." }, 400);
  }

  const body = await c.req.json<RegistrationResponseJSON>().catch(() => null);
  if (!body) {
    return c.json({ error: "Malformed registration response." }, 400);
  }

  const { rpID, expectedOrigin } = relyingParty(c);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    return c.json({ error: `Passkey registration failed: ${String(error)}` }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "Passkey registration could not be verified." }, 400);
  }

  const { credential } = verification.registrationInfo;
  await insertPasskeyCredential(c.env.DB, {
    id: credential.id,
    userId: user.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? null,
  });

  return c.json({ verified: true });
});

passkeyRoute.post("/login/options", async (c) => {
  const { rpID } = relyingParty(c);
  // No allowCredentials: sign-in is discoverable-credential only — the
  // browser lists whatever passkeys it holds for this rpID, so the server
  // doesn't need to know who is signing in before the assertion arrives.
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
  });

  await setChallengeCookie(c, { challenge: options.challenge, purpose: "login" });
  return c.json(options);
});

passkeyRoute.post("/login/verify", async (c) => {
  const challenge = await takeChallengeCookie(c, "login");
  if (!challenge) {
    return c.json({ error: "Sign-in challenge missing or expired. Please try again." }, 400);
  }

  const body = await c.req.json<AuthenticationResponseJSON>().catch(() => null);
  if (!body || typeof body.id !== "string") {
    return c.json({ error: "Malformed authentication response." }, 400);
  }

  const match = await getPasskeyCredentialWithUser(c.env.DB, body.id);
  if (!match) {
    return c.json({ error: "Unknown passkey. Sign in with Google and add it again." }, 400);
  }

  const { rpID, expectedOrigin } = relyingParty(c);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: match.credential.id,
        publicKey: isoBase64URL.toBuffer(match.credential.public_key),
        counter: match.credential.counter,
        transports: parseTransports(match.credential.transports),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    return c.json({ error: `Passkey sign-in failed: ${String(error)}` }, 400);
  }

  if (!verification.verified) {
    return c.json({ error: "Passkey sign-in could not be verified." }, 400);
  }

  await updatePasskeyCredentialAfterAuth(
    c.env.DB,
    match.credential.id,
    verification.authenticationInfo.newCounter,
  );

  const session = await createSession(c.env.DB, match.user.id);
  setSessionCookie(c, session.id);
  return c.json({ user: userRowToAuthUser(match.user) });
});
