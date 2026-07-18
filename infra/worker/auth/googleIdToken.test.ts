import { describe, expect, it } from "vitest";
import { verifyGoogleIdToken, type JwksResponse } from "./googleIdToken";

const NOW = 1_800_000_000_000; // fixed epoch ms
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const KID = "test-key-1";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return encode(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeSigningKey(
  kid: string = KID,
): Promise<{ privateKey: CryptoKey; jwks: JwksResponse }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ kid, kty: jwk.kty!, n: jwk.n!, e: jwk.e! }] },
  };
}

function defaultPayload(): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3600,
    sub: "google-sub-123",
    email: "user@example.com",
    name: "Test User",
    picture: "https://example.com/avatar.png",
  };
}

async function signToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID },
): Promise<string> {
  const headerSegment = encodeJson(header);
  const payloadSegment = encodeJson(payload);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  return `${headerSegment}.${payloadSegment}.${encode(new Uint8Array(signature))}`;
}

describe("verifyGoogleIdToken", () => {
  it("returns the identity claims for a validly signed token", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, defaultPayload());
    const identity = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      fetchJwks: async () => jwks,
      now: NOW,
    });
    expect(identity).toEqual({
      sub: "google-sub-123",
      email: "user@example.com",
      name: "Test User",
      picture: "https://example.com/avatar.png",
    });
  });

  it("accepts the bare accounts.google.com issuer variant", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, { ...defaultPayload(), iss: "accounts.google.com" });
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).resolves.toMatchObject({ sub: "google-sub-123" });
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, defaultPayload());
    const [header, , signature] = token.split(".");
    const forged = `${header}.${encodeJson({ ...defaultPayload(), email: "evil@example.com" })}.${signature}`;
    await expect(
      verifyGoogleIdToken(forged, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).rejects.toThrow(/signature/);
  });

  it("rejects a token for a different audience", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, { ...defaultPayload(), aud: "someone-else" });
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).rejects.toThrow(/audience/);
  });

  it("rejects an expired token but tolerates small clock skew", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const expired = await signToken(privateKey, {
      ...defaultPayload(),
      exp: Math.floor(NOW / 1000) - 120,
    });
    await expect(
      verifyGoogleIdToken(expired, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).rejects.toThrow(/expired/);

    const barelyExpired = await signToken(privateKey, {
      ...defaultPayload(),
      exp: Math.floor(NOW / 1000) - 30,
    });
    await expect(
      verifyGoogleIdToken(barelyExpired, {
        clientId: CLIENT_ID,
        fetchJwks: async () => jwks,
        now: NOW,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects unexpected issuers", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, { ...defaultPayload(), iss: "https://evil.example" });
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).rejects.toThrow(/issuer/);
  });

  it("rejects any algorithm other than RS256", async () => {
    const { privateKey, jwks } = await makeSigningKey();
    const token = await signToken(privateKey, defaultPayload(), { alg: "none", kid: KID });
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, fetchJwks: async () => jwks, now: NOW }),
    ).rejects.toThrow(/algorithm/);
  });

  it("rejects a token signed with a key absent from the JWKS", async () => {
    const { privateKey } = await makeSigningKey();
    const { jwks: otherJwks } = await makeSigningKey("some-rotated-key");
    const token = await signToken(privateKey, defaultPayload());
    await expect(
      verifyGoogleIdToken(token, {
        clientId: CLIENT_ID,
        fetchJwks: async () => otherJwks,
        now: NOW,
      }),
    ).rejects.toThrow(/unknown key/);
  });
});
