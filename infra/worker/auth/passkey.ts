import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Env } from "../env";
import { readJsonWithLimit } from "../httpBody";
import {
  deletePasskeyCredential,
  getPasskeyCredentialWithUser,
  insertPasskeyCredential,
  listPasskeyCredentials,
  updatePasskeyCredentialAfterAuth,
} from "../../db/passkeyQueries";
import { passkeyRowToSummary, userRowToAuthUser } from "../../db/types";
import { requireRecentSignIn, requireUser } from "./requireUser";
import { isHttps, startSession } from "./session";

const RP_NAME = "Next Editor";
// A WebAuthn registration or authentication response is a few KB at most.
const MAX_VERIFY_REQUEST_BYTES = 32 * 1024;

// Same transient-signed-cookie pattern as the OAuth handshake in google.ts: the
// challenge has no DB backing, so the cookie carries it, signed so it cannot be
// forged, with its expiry signed in too (the cookie's Max-Age only asks the
// browser to drop it). A verify attempt deletes the cookie, but that is advice to
// the browser as well: a copied verify request can be replayed until the
// challenge expires, a window no wider than the session cookie the same copy of
// the response would carry.
const CHALLENGE_COOKIE = "ne_webauthn";
const CHALLENGE_MAX_AGE_SECONDS = 5 * 60;

// A passkey signs in on its own, has no expiry and outlives every session, so
// adding one must not be open to any session that has merely stayed alive (up
// to 30 days: a borrowed or shared browser, a copied cookie). It needs a
// sign-in from the last few minutes, Google or passkey. The verify step allows
// the challenge's own lifetime on top, so a ceremony started inside the window
// can still finish: no challenge is issued to an older session in the first
// place.
const ENROLLMENT_SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const requireEnrollmentSignIn = requireRecentSignIn(ENROLLMENT_SIGN_IN_WINDOW_MS);
const requireEnrollmentVerifySignIn = requireRecentSignIn(
  ENROLLMENT_SIGN_IN_WINDOW_MS + CHALLENGE_MAX_AGE_SECONDS * 1000,
);

interface ChallengePayload {
  challenge: string;
  purpose: "register" | "login";
  /** Only set for registration, which requires an authenticated session. */
  userId?: string;
  /** Epoch ms after which the challenge is refused. */
  expiresAt: number;
}

// The WebAuthn Relying Party identity, from PUBLIC_URL. The Origin header is
// the client's to choose, so it never moves a deployment's ceremonies off its
// own RP ID: only a local deployment (PUBLIC_URL on localhost, set in
// infra/.dev.vars) takes the request's own localhost origin, because the
// browser may sit on the vite or the wrangler port. localhost is the one
// hostname WebAuthn treats as a secure context over plain http.
function relyingParty<E extends { Bindings: Env }>(
  c: Context<E>,
): { rpID: string; expectedOrigin: string } {
  const publicUrl = new URL(c.env.PUBLIC_URL);
  const requestOrigin = c.req.header("Origin");
  if (
    publicUrl.hostname === "localhost" &&
    requestOrigin &&
    /^http:\/\/localhost(:\d+)?$/.test(requestOrigin)
  ) {
    return { rpID: "localhost", expectedOrigin: requestOrigin };
  }
  return { rpID: publicUrl.hostname, expectedOrigin: publicUrl.origin };
}

async function setChallengeCookie<E extends { Bindings: Env }>(
  c: Context<E>,
  challenge: Omit<ChallengePayload, "expiresAt">,
): Promise<void> {
  const payload: ChallengePayload = {
    ...challenge,
    expiresAt: Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000,
  };
  await setSignedCookie(c, CHALLENGE_COOKIE, JSON.stringify(payload), c.env.SESSION_SECRET, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/api/auth/passkey",
    maxAge: CHALLENGE_MAX_AGE_SECONDS,
  });
}

// Reads the challenge cookie and has the browser drop it, so one ceremony gets
// one verify attempt. Returns null for a missing, forged, expired or
// other-purpose challenge.
async function takeChallengeCookie<E extends { Bindings: Env }>(
  c: Context<E>,
  purpose: ChallengePayload["purpose"],
): Promise<ChallengePayload | null> {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth/passkey" });
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as ChallengePayload;
    const isCurrent = typeof payload.expiresAt === "number" && payload.expiresAt > Date.now();
    return payload.purpose === purpose && isCurrent ? payload : null;
  } catch {
    return null;
  }
}

function parseTransports(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as string[];
  } catch {
    return undefined;
  }
}

// Mounted at /api/auth/passkey in worker/index.ts.
export const passkeyRoute = new Hono<{ Bindings: Env }>();

// The signed-in user's registered passkeys — lets the account menu show
// whether the account already has one (the WebAuthn ceremony itself can't
// tell the page "you already registered here"; it just fails), and lists them
// for review and removal.
passkeyRoute.get("/credentials", requireUser, async (c) => {
  const user = c.get("user");
  const credentials = await listPasskeyCredentials(c.env.DB, user.id);
  return c.json({ passkeys: credentials.map(passkeyRowToSummary) });
});

// Removes one of the signed-in user's passkeys, so it no longer signs in: the
// owner's way to undo a passkey added on a shared computer or by someone else.
// Any live session may remove one (unlike adding), since removal only ever
// takes access away; the owner can still sign in with Google.
passkeyRoute.delete("/credentials/:id", requireUser, async (c) => {
  const user = c.get("user");
  const removed = await deletePasskeyCredential(c.env.DB, user.id, c.req.param("id"));
  if (!removed) {
    return c.json({ error: "passkey not found" }, 404);
  }
  return c.json({ removed: true });
});

// Registration is adding a passkey to the signed-in account, so both
// register endpoints require a session, and a recent sign-in (see
// ENROLLMENT_SIGN_IN_WINDOW_MS).
passkeyRoute.post("/register/options", requireEnrollmentSignIn, async (c) => {
  const user = c.get("user");

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

passkeyRoute.post("/register/verify", requireEnrollmentVerifySignIn, async (c) => {
  const user = c.get("user");

  const challenge = await takeChallengeCookie(c, "register");
  // The userId check pins the challenge to the session that requested it —
  // a challenge minted under one account can't register a credential on
  // another (e.g. after a sign-out/sign-in between options and verify).
  if (!challenge || challenge.userId !== user.id) {
    return c.json({ error: "Registration challenge missing or expired. Please try again." }, 400);
  }

  const read = await readJsonWithLimit(c.req.raw, MAX_VERIFY_REQUEST_BYTES);
  if (read.status === "too-large") {
    return c.json({ error: "request body is too large" }, 413);
  }
  const body = read.status === "ok" ? (read.value as RegistrationResponseJSON | null) : null;
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

  const read = await readJsonWithLimit(c.req.raw, MAX_VERIFY_REQUEST_BYTES);
  if (read.status === "too-large") {
    return c.json({ error: "request body is too large" }, 413);
  }
  const body = read.status === "ok" ? (read.value as AuthenticationResponseJSON | null) : null;
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

  await startSession(c, match.user.id);
  return c.json({ user: userRowToAuthUser(match.user) });
});
