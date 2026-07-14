import type { AuthClaims } from "./types";

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signature(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))));
}

export async function signToken(secret: string, claims: AuthClaims & { sessionId?: string }): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  return `${payload}.${await signature(secret, payload)}`;
}

export async function verifyToken(secret: string, token: string): Promise<AuthClaims & { sessionId?: string }> {
  const [payload, provided, extra] = token.split(".");
  if (!payload || !provided || extra || await signature(secret, payload) !== provided) throw new Error("invalid token");
  const claims = JSON.parse(new TextDecoder().decode(decodeBase64url(payload))) as AuthClaims & { sessionId?: string };
  if (!claims.userId || !Number.isFinite(claims.exp) || claims.exp < Date.now() / 1000) throw new Error("expired token");
  return claims;
}

export function bearer(request: Request): string {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) throw new Error("missing bearer token");
  return header.slice(7);
}
