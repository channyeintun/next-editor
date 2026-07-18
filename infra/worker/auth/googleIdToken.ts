// Verifies a Google id_token that arrived FROM THE BROWSER (Google One Tap's
// credential callback). Unlike the redirect-flow callback in google.ts —
// which fetches the token server-to-server and can trust it without a
// signature check — a browser-posted JWT is attacker-writable, so it must be
// verified against Google's published JWKS before any claim is believed.

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
// Tolerated clock skew when checking exp/iat, per common JWT practice.
const CLOCK_SKEW_MS = 60 * 1000;

interface GoogleJwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

export interface JwksResponse {
  keys: GoogleJwk[];
}

export interface VerifiedGoogleIdToken {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export interface VerifyGoogleIdTokenOptions {
  clientId: string;
  fetchJwks?: () => Promise<JwksResponse>;
  /** Injectable clock for tests; epoch ms. */
  now?: number;
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padLength));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function base64UrlDecodeToJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(value))) as T;
}

// Google rotates its signing keys every few days. Cached per isolate; a kid
// miss within the TTL forces one refetch so a just-rotated key doesn't fail
// sign-ins until the cache expires.
let cachedJwks: { keys: GoogleJwk[]; fetchedAt: number } | null = null;

async function fetchGoogleJwks(): Promise<JwksResponse> {
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Google JWKS fetch failed (${response.status})`);
  }
  return (await response.json()) as JwksResponse;
}

async function getGoogleJwk(kid: string, now: number): Promise<GoogleJwk | null> {
  if (!cachedJwks || now - cachedJwks.fetchedAt > JWKS_CACHE_TTL_MS) {
    cachedJwks = { keys: (await fetchGoogleJwks()).keys, fetchedAt: now };
  }
  let key = cachedJwks.keys.find((k) => k.kid === kid);
  if (!key) {
    cachedJwks = { keys: (await fetchGoogleJwks()).keys, fetchedAt: now };
    key = cachedJwks.keys.find((k) => k.kid === kid);
  }
  return key ?? null;
}

/**
 * Verifies signature, issuer, audience, and expiry. Throws with a
 * human-readable reason on any failure; returns the identity claims only
 * when every check passes.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleIdTokenOptions,
): Promise<VerifiedGoogleIdToken> {
  const now = options.now ?? Date.now();
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    throw new Error("Malformed id_token: expected three segments");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header: { alg?: string; kid?: string };
  let payload: Partial<VerifiedGoogleIdToken> & { iss?: string; aud?: string; exp?: number };
  try {
    header = base64UrlDecodeToJson(headerSegment);
    payload = base64UrlDecodeToJson(payloadSegment);
  } catch {
    throw new Error("Malformed id_token: undecodable header or payload");
  }

  // Pinning the algorithm defeats both alg:none and key-confusion attacks —
  // Google only ever signs id_tokens with RS256.
  if (header.alg !== "RS256") {
    throw new Error(`Unexpected id_token algorithm: ${header.alg ?? "(none)"}`);
  }
  if (!header.kid) {
    throw new Error("id_token header has no kid");
  }

  const jwk = options.fetchJwks
    ? ((await options.fetchJwks()).keys.find((k) => k.kid === header.kid) ?? null)
    : await getGoogleJwk(header.kid, now);
  if (!jwk) {
    throw new Error("id_token signed with an unknown key");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlDecodeToBytes(signatureSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!signatureValid) {
    throw new Error("id_token signature verification failed");
  }

  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error(`Unexpected id_token issuer: ${payload.iss ?? "(none)"}`);
  }
  if (payload.aud !== options.clientId) {
    throw new Error("id_token audience does not match this app's client id");
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now - CLOCK_SKEW_MS) {
    throw new Error("id_token is expired");
  }
  if (!payload.sub || !payload.email) {
    throw new Error("id_token is missing sub or email");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}
