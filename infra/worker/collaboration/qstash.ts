import { z } from "zod";
import { collaborationIdSchema } from "../../../src/collaboration/protocol";
import type { Env } from "../env";

const QSTASH_PUBLISH_ORIGIN = "https://qstash.upstash.io";
const CLOCK_TOLERANCE_SECONDS = 5;

export const collaborationMaintenanceJobSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("compact-room"),
      roomId: collaborationIdSchema,
      expectedGeneration: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cleanup-room"),
      roomId: collaborationIdSchema,
      closedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type CollaborationMaintenanceJob = z.infer<typeof collaborationMaintenanceJobSchema>;

interface QStashClaims {
  iss: string;
  sub: string;
  exp: number;
  nbf: number;
  iat?: number;
  body: string;
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function secureStringEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function verifyWithKey(
  signature: string,
  body: string,
  url: string,
  key: string,
  nowSeconds: number,
): Promise<boolean> {
  try {
    const parts = signature.split(".");
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedHeader)),
    ) as { alg?: unknown; typ?: unknown };
    if (header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")) return false;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      cryptoKey,
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) return false;

    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedPayload)),
    ) as Partial<QStashClaims>;
    if (
      claims.iss !== "Upstash" ||
      claims.sub !== url ||
      typeof claims.exp !== "number" ||
      typeof claims.nbf !== "number" ||
      typeof claims.body !== "string" ||
      nowSeconds > claims.exp + CLOCK_TOLERANCE_SECONDS ||
      nowSeconds < claims.nbf - CLOCK_TOLERANCE_SECONDS ||
      (typeof claims.iat === "number" && nowSeconds < claims.iat - CLOCK_TOLERANCE_SECONDS)
    ) {
      return false;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return secureStringEqual(claims.body, base64UrlEncode(digest));
  } catch {
    return false;
  }
}

export async function verifyQStashSignature(input: {
  signature: string;
  body: string;
  url: string;
  currentSigningKey: string;
  nextSigningKey: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return (
    (await verifyWithKey(
      input.signature,
      input.body,
      input.url,
      input.currentSigningKey,
      nowSeconds,
    )) ||
    (await verifyWithKey(
      input.signature,
      input.body,
      input.url,
      input.nextSigningKey,
      nowSeconds,
    ))
  );
}

function maintenanceDestination(env: Env): string {
  return new URL("/api/collaboration/jobs/maintenance", env.PUBLIC_URL).toString();
}

function deduplicationId(job: CollaborationMaintenanceJob): string {
  return job.kind === "compact-room"
    ? `collab-compact-${job.roomId}-${job.expectedGeneration}`
    : `collab-cleanup-${job.roomId}-${job.closedAt}`;
}

export async function publishCollaborationMaintenanceJob(
  env: Env,
  job: CollaborationMaintenanceJob,
  options: { delay?: string } = {},
): Promise<boolean> {
  if (!env.QSTASH_TOKEN) return false;
  const parsed = collaborationMaintenanceJobSchema.parse(job);
  const destination = maintenanceDestination(env);
  const headers = new Headers({
    Authorization: `Bearer ${env.QSTASH_TOKEN}`,
    "Content-Type": "application/json",
    "Upstash-Deduplication-Id": deduplicationId(parsed),
    "Upstash-Retries": "3",
    "Upstash-Timeout": "30s",
    "Upstash-Redact-Fields": "body",
  });
  if (options.delay) headers.set("Upstash-Delay", options.delay);
  const response = await fetch(
    `${QSTASH_PUBLISH_ORIGIN}/v2/publish/${destination}`,
    { method: "POST", headers, body: JSON.stringify(parsed) },
  );
  if (!response.ok) {
    throw new Error(`QStash rejected collaboration maintenance job (${response.status})`);
  }
  return true;
}

export function collaborationMaintenanceDestination(env: Env): string {
  return maintenanceDestination(env);
}
