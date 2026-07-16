import { Client, Receiver, type PublishRequest } from "@upstash/qstash";
import { z } from "zod";
import { collaborationIdSchema } from "../../../src/collaboration/protocol";
import type { Env } from "../env";

const CLOCK_TOLERANCE_SECONDS = 5;
const QSTASH_DELIVERY_RETRIES = 3;
const QSTASH_DELIVERY_TIMEOUT = "30s" as const;
const QSTASH_ENVIRONMENT_KEYS = [
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
] as const;

type QStashDelay = NonNullable<PublishRequest["delay"]>;
export type CollaborationQStashEnvironmentKey = (typeof QSTASH_ENVIRONMENT_KEYS)[number];

// Seven days is both the room-retention period and QStash Free's maximum delay.
export const COLLABORATION_CLEANUP_DELAY = "7d" as const satisfies QStashDelay;

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

export type CollaborationMaintenancePublishResult =
  | {
      queued: false;
      missing: CollaborationQStashEnvironmentKey[];
    }
  | {
      queued: true;
      messageId: string;
      deduplicated: boolean;
    };

export function missingCollaborationQStashConfiguration(
  env: Env,
): CollaborationQStashEnvironmentKey[] {
  return QSTASH_ENVIRONMENT_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

export async function verifyQStashSignature(input: {
  signature: string;
  body: string;
  url: string;
  currentSigningKey: string;
  nextSigningKey: string;
  upstashRegion?: string;
}): Promise<boolean> {
  const receiver = new Receiver({
    currentSigningKey: input.currentSigningKey,
    nextSigningKey: input.nextSigningKey,
    devMode: false,
  });

  try {
    return await receiver.verify({
      signature: input.signature,
      body: input.body,
      url: input.url,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      ...(input.upstashRegion ? { upstashRegion: input.upstashRegion } : {}),
    });
  } catch {
    return false;
  }
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
  options: { delay?: QStashDelay } = {},
): Promise<CollaborationMaintenancePublishResult> {
  const missing = missingCollaborationQStashConfiguration(env);
  if (missing.length > 0) return { queued: false, missing };

  // The configuration check above narrows these values at runtime. Keep the
  // explicit guard so an incomplete deployment can never enqueue messages to
  // a receiver that cannot authenticate them.
  const token = env.QSTASH_TOKEN;
  if (!token) return { queued: false, missing: ["QSTASH_TOKEN"] };

  const parsed = collaborationMaintenanceJobSchema.parse(job);
  const client = new Client({
    token,
    devMode: false,
    enableTelemetry: false,
    retry: { retries: 3 },
  });
  const result = await client.publishJSON({
    url: maintenanceDestination(env),
    body: parsed,
    deduplicationId: deduplicationId(parsed),
    retries: QSTASH_DELIVERY_RETRIES,
    timeout: QSTASH_DELIVERY_TIMEOUT,
    label: ["collaboration-maintenance", parsed.kind],
    redact: { body: true },
    ...(options.delay === undefined ? {} : { delay: options.delay }),
  });

  return {
    queued: true,
    messageId: result.messageId,
    deduplicated: result.deduplicated ?? false,
  };
}

export function collaborationMaintenanceDestination(env: Env): string {
  return maintenanceDestination(env);
}
