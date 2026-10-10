import * as Y from "yjs";
import { z } from "zod";
import { sha256Hex } from "../shared/sha256Hex";
import type { Slide } from "../types/slides";
import {
  collaborationAssetDescriptorSchema,
  collaborationSlideIdSchema,
  type CollaborationAssetDescriptor,
} from "./protocol";
import { CollaborationTeachingError } from "./teachingRoot";

// The room presentation's slides: the manifest Yjs holds per slide, and the
// content-addressed payload asset each manifest points at (schema, codec,
// digest check and hydration). Never imports teachingDocument.

export const MAX_COLLABORATION_TEACHING_SLIDES = 100;
export const MAX_COLLABORATION_SLIDE_PAYLOAD_BYTES = 5 * 1024 * 1024;
export const COLLABORATION_SLIDE_ASSET_MIME_TYPE =
  "application/vnd.next-editor.slide+json" as const;

const boundedAnimationNumberSchema = z.number().finite().min(-10_000_000).max(10_000_000);
const collaborationDeckStepTrackSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("opacity"),
      from: boundedAnimationNumberSchema,
      to: boundedAnimationNumberSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scale"),
      from: boundedAnimationNumberSchema,
      to: boundedAnimationNumberSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("translate"),
      fromX: boundedAnimationNumberSchema,
      fromY: boundedAnimationNumberSchema,
      toX: boundedAnimationNumberSchema,
      toY: boundedAnimationNumberSchema,
    })
    .strict(),
]);
const collaborationDeckStepsSchema = z
  .array(
    z
      .array(
        z
          .object({
            elementId: z.string().min(1).max(2_048),
            durationMs: z.number().finite().min(0).max(600_000),
            delayMs: z.number().finite().min(-600_000).max(600_000),
            tracks: z.array(collaborationDeckStepTrackSchema).max(32),
          })
          .strict(),
      )
      .max(2_000),
  )
  .max(2_000);

export const collaborationTeachingSlideManifestSchema = z
  .object({
    id: collaborationSlideIdSchema,
    contentType: z.enum(["html", "markdown", "google-svg"]),
    asset: collaborationAssetDescriptorSchema.refine(
      (asset) => asset.mimeType === COLLABORATION_SLIDE_ASSET_MIME_TYPE,
      "invalid collaboration slide asset type",
    ),
  })
  .strict();

export type CollaborationTeachingSlideManifest = z.infer<
  typeof collaborationTeachingSlideManifestSchema
>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function normalizeSlideId(value: string): string {
  const parsed = collaborationSlideIdSchema.safeParse(value);
  if (!parsed.success) throw new CollaborationTeachingError("A slide has an invalid ID");
  return parsed.data;
}

const SLIDE_PAYLOAD_KEYS = new Set([
  "content",
  "name",
  "background",
  "title",
  "steps",
  "sourceUrl",
]);
const SLIDE_KEYS = new Set(["id", "contentType", "order", ...SLIDE_PAYLOAD_KEYS]);

type CollaborationSlidePayload = Omit<Slide, "id" | "contentType" | "order">;

function optionalBoundedString(
  object: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new CollaborationTeachingError(`A slide has an invalid ${key}`);
  }
  return value;
}

function parseSlidePayloadValue(value: unknown): CollaborationSlidePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CollaborationTeachingError("A slide payload is invalid");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !SLIDE_PAYLOAD_KEYS.has(key))) {
    throw new CollaborationTeachingError("A slide payload contains unsupported fields");
  }
  if (typeof object.content !== "string") {
    throw new CollaborationTeachingError("A slide payload is missing its content");
  }
  if (object.steps !== undefined && !Array.isArray(object.steps)) {
    throw new CollaborationTeachingError("A slide payload has invalid build-step data");
  }
  const parsedSteps =
    object.steps === undefined ? undefined : collaborationDeckStepsSchema.safeParse(object.steps);
  if (parsedSteps && !parsedSteps.success) {
    throw new CollaborationTeachingError("A slide payload has invalid build-step data");
  }

  return {
    content: object.content,
    ...(optionalBoundedString(object, "name", 512) === undefined
      ? {}
      : { name: object.name as string }),
    ...(optionalBoundedString(object, "background", 2_048) === undefined
      ? {}
      : { background: object.background as string }),
    ...(optionalBoundedString(object, "title", 2_048) === undefined
      ? {}
      : { title: object.title as string }),
    ...(parsedSteps === undefined ? {} : { steps: parsedSteps.data }),
    ...(optionalBoundedString(object, "sourceUrl", 2_048) === undefined
      ? {}
      : { sourceUrl: object.sourceUrl as string }),
  };
}

function parseSlideValue(value: unknown): Slide {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CollaborationTeachingError("A slide is invalid");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !SLIDE_KEYS.has(key))) {
    throw new CollaborationTeachingError("A slide contains unsupported fields");
  }
  const id = normalizeSlideId(typeof object.id === "string" ? object.id : "");
  const contentType = object.contentType;
  if (contentType !== "html" && contentType !== "markdown" && contentType !== "google-svg") {
    throw new CollaborationTeachingError("A slide has an invalid content type");
  }
  if (!Number.isSafeInteger(object.order) || (object.order as number) < 0) {
    throw new CollaborationTeachingError("A slide has an invalid order");
  }
  const payload = Object.fromEntries(
    Object.entries(object).filter(([key]) => SLIDE_PAYLOAD_KEYS.has(key)),
  );
  return {
    id,
    contentType,
    order: object.order as number,
    ...parseSlidePayloadValue(payload),
  };
}

export function encodeCollaborationSlidePayload(slide: Slide): Uint8Array {
  const normalized = parseSlideValue(structuredClone(slide));
  const payload = parseSlidePayloadValue(
    Object.fromEntries(Object.entries(normalized).filter(([key]) => SLIDE_PAYLOAD_KEYS.has(key))),
  );
  const bytes = textEncoder.encode(JSON.stringify(payload));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COLLABORATION_SLIDE_PAYLOAD_BYTES) {
    throw new CollaborationTeachingError("A slide payload exceeds the collaboration asset limit");
  }
  return bytes;
}

export function decodeCollaborationSlidePayload(
  bytes: Uint8Array,
  manifest: CollaborationTeachingSlideManifest,
): Slide {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COLLABORATION_SLIDE_PAYLOAD_BYTES) {
    throw new CollaborationTeachingError("A shared slide payload has an invalid size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes)) as unknown;
  } catch {
    throw new CollaborationTeachingError("A shared slide payload is not valid JSON");
  }
  const payload = parseSlidePayloadValue(parsed);
  return {
    id: manifest.id,
    contentType: manifest.contentType,
    order: 0,
    ...payload,
  };
}

export async function collaborationSlidePayloadAssetId(payload: Uint8Array): Promise<string> {
  return sha256Hex(payload);
}

export async function verifyCollaborationSlideAsset(
  bytes: Uint8Array,
  asset: CollaborationAssetDescriptor,
): Promise<Uint8Array> {
  if (bytes.byteLength !== asset.size) {
    throw new CollaborationTeachingError("A shared slide asset has an unexpected size");
  }
  if ((await collaborationSlidePayloadAssetId(bytes)) !== asset.id) {
    throw new CollaborationTeachingError("A shared slide asset failed its content digest check");
  }
  return bytes;
}

export async function hydrateCollaborationSlideManifest(
  manifest: CollaborationTeachingSlideManifest,
  verifiedAssetCache: Map<string, Promise<Uint8Array>>,
  download: () => Promise<Uint8Array>,
): Promise<Slide> {
  const cacheKey = `${manifest.asset.id}:${manifest.asset.size}`;
  let verifiedBytes = verifiedAssetCache.get(cacheKey);
  if (!verifiedBytes) {
    verifiedBytes = download().then((bytes) =>
      verifyCollaborationSlideAsset(bytes, manifest.asset),
    );
    verifiedAssetCache.set(cacheKey, verifiedBytes);
  }
  return decodeCollaborationSlidePayload(await verifiedBytes, manifest);
}

export function normalizeCollaborationTeachingSlides(
  slides: readonly Slide[],
): Array<{ slide: Slide; payload: Uint8Array }> {
  const normalized: Array<{ slide: Slide; payload: Uint8Array }> = [];
  const seen = new Set<string>();
  for (const candidate of [...slides].sort((left, right) => left.order - right.order)) {
    if (normalized.length >= MAX_COLLABORATION_TEACHING_SLIDES) {
      throw new CollaborationTeachingError(
        `A live room can contain at most ${MAX_COLLABORATION_TEACHING_SLIDES} slides`,
      );
    }
    const id = normalizeSlideId(candidate.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const slide = { ...structuredClone(candidate), id, order: normalized.length };
    normalized.push({ slide, payload: encodeCollaborationSlidePayload(slide) });
  }
  return normalized;
}

/** The Yjs map one slide manifest is stored as. */
export function slideManifestMap(manifest: CollaborationTeachingSlideManifest): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("id", manifest.id);
  value.set("contentType", manifest.contentType);
  value.set("assetId", manifest.asset.id);
  value.set("assetMimeType", manifest.asset.mimeType);
  value.set("assetSize", manifest.asset.size);
  return value;
}

/** The manifest stored under `id`, or null when the value is not a valid manifest for it. */
export function readSlideManifest(
  id: string,
  value: unknown,
): CollaborationTeachingSlideManifest | null {
  if (!(value instanceof Y.Map)) return null;
  const result = collaborationTeachingSlideManifestSchema.safeParse({
    id: value.get("id"),
    contentType: value.get("contentType"),
    asset: {
      id: value.get("assetId"),
      mimeType: value.get("assetMimeType"),
      size: value.get("assetSize"),
    },
  });
  return result.success && result.data.id === id ? result.data : null;
}
