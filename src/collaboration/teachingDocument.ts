import * as Y from "yjs";
import { z } from "zod";
import type { WhiteboardElementJSON, WhiteboardEvent } from "../core/src/whiteboard";
import type { Slide, SlideContentType } from "../types/slides";
import {
  collaborationAssetDescriptorSchema,
  collaborationCurrentSlideCommandSchema,
  collaborationSlideIdSchema,
  MAX_COLLABORATION_SLIDE_ID_LENGTH,
  MAX_COLLABORATION_WHITEBOARD_COORDINATE,
  MAX_YJS_SNAPSHOT_BYTES,
  type CollaborationAssetDescriptor,
} from "./protocol";
import {
  COLLABORATION_ORIGIN,
  COLLABORATION_PROJECT_ROOT,
  type CollaborationTransactionOrigin,
} from "./projectDocument";

export const COLLABORATION_TEACHING_ROOT = "teaching";
export const COLLABORATION_TEACHING_SLIDE_ORDER = "slideOrder";
export const COLLABORATION_TEACHING_SLIDES = "slides";
export const COLLABORATION_TEACHING_PRESENTATION = "presentation";
export const COLLABORATION_TEACHING_WHITEBOARD = "whiteboardElements";

export const MAX_COLLABORATION_TEACHING_SLIDES = 100;
export { MAX_COLLABORATION_SLIDE_ID_LENGTH };
export const MAX_COLLABORATION_SLIDE_PAYLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_COLLABORATION_WHITEBOARD_ELEMENTS = 5_000;
export const MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES = 48 * 1024;
export const MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES = 3 * 1024 * 1024;
export const MAX_COLLABORATION_WHITEBOARD_CANDIDATES_PER_ELEMENT = 64;
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

const whiteboardCoordinateSchema = z
  .number()
  .finite()
  .min(-MAX_COLLABORATION_WHITEBOARD_COORDINATE)
  .max(MAX_COLLABORATION_WHITEBOARD_COORDINATE);
const whiteboardDimensionSchema = z
  .number()
  .finite()
  .min(-MAX_COLLABORATION_WHITEBOARD_COORDINATE)
  .max(MAX_COLLABORATION_WHITEBOARD_COORDINATE);
const whiteboardPointSchema = z.tuple([whiteboardCoordinateSchema, whiteboardCoordinateSchema]);
const whiteboardBindingSchema = z
  .object({
    elementId: z.string().min(1).max(256),
    focus: z.number().finite().min(-10).max(10),
    gap: whiteboardCoordinateSchema,
    fixedPoint: whiteboardPointSchema.optional(),
  })
  .strict();
const whiteboardArrowheadSchema = z
  .enum([
    "arrow",
    "bar",
    "dot",
    "circle",
    "circle_outline",
    "triangle",
    "triangle_outline",
    "diamond",
    "diamond_outline",
    "crowfoot_one",
    "crowfoot_many",
    "crowfoot_one_or_many",
  ])
  .nullable();
const collaborationWhiteboardElementBaseSchema = z
  .object({
    id: z.string().min(1).max(256),
    x: whiteboardCoordinateSchema,
    y: whiteboardCoordinateSchema,
    strokeColor: z.string().min(1).max(128),
    backgroundColor: z.string().min(1).max(128),
    fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]),
    strokeWidth: z.number().finite().min(0).max(1_000),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]),
    roundness: z
      .object({ type: z.number().int().min(1).max(3), value: z.number().finite().optional() })
      .strict()
      .nullable(),
    roughness: z.number().finite().min(0).max(100),
    opacity: z.number().finite().min(0).max(100),
    width: whiteboardDimensionSchema,
    height: whiteboardDimensionSchema,
    angle: z.number().finite().min(-10_000).max(10_000),
    seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    versionNonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    index: z.string().min(1).max(128).nullable(),
    isDeleted: z.boolean(),
    groupIds: z.array(z.string().min(1).max(256)).max(100),
    frameId: z.string().min(1).max(256).nullable(),
    boundElements: z
      .array(z.object({ id: z.string().min(1).max(256), type: z.enum(["arrow", "text"]) }).strict())
      .max(1_000)
      .nullable(),
    updated: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    link: z.string().max(2_048).nullable(),
    locked: z.boolean(),
  })
  .passthrough();
const collaborationWhiteboardElementSchema = z.discriminatedUnion("type", [
  collaborationWhiteboardElementBaseSchema.extend({ type: z.literal("rectangle") }),
  collaborationWhiteboardElementBaseSchema.extend({ type: z.literal("diamond") }),
  collaborationWhiteboardElementBaseSchema.extend({ type: z.literal("ellipse") }),
  collaborationWhiteboardElementBaseSchema.extend({
    type: z.literal("text"),
    fontSize: z.number().finite().positive().max(10_000),
    fontFamily: z.number().int().positive().max(100),
    text: z.string().max(MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES),
    textAlign: z.enum(["left", "center", "right"]),
    verticalAlign: z.enum(["top", "middle", "bottom"]),
    containerId: z.string().min(1).max(256).nullable(),
    originalText: z.string().max(MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES),
    autoResize: z.boolean(),
    lineHeight: z.number().finite().positive().max(100),
  }),
  collaborationWhiteboardElementBaseSchema.extend({
    type: z.literal("line"),
    points: z.array(whiteboardPointSchema).max(20_000),
    lastCommittedPoint: whiteboardPointSchema.nullable(),
    startBinding: whiteboardBindingSchema.nullable(),
    endBinding: whiteboardBindingSchema.nullable(),
    startArrowhead: whiteboardArrowheadSchema,
    endArrowhead: whiteboardArrowheadSchema,
  }),
  collaborationWhiteboardElementBaseSchema.extend({
    type: z.literal("arrow"),
    points: z.array(whiteboardPointSchema).max(20_000),
    lastCommittedPoint: whiteboardPointSchema.nullable(),
    startBinding: whiteboardBindingSchema.nullable(),
    endBinding: whiteboardBindingSchema.nullable(),
    startArrowhead: whiteboardArrowheadSchema,
    endArrowhead: whiteboardArrowheadSchema,
    elbowed: z.boolean(),
  }),
  collaborationWhiteboardElementBaseSchema.extend({
    type: z.literal("freedraw"),
    points: z.array(whiteboardPointSchema).max(20_000),
    pressures: z.array(z.number().finite().min(0).max(1)).max(20_000),
    simulatePressure: z.boolean(),
    lastCommittedPoint: whiteboardPointSchema.nullable(),
  }),
  collaborationWhiteboardElementBaseSchema.extend({
    type: z.literal("frame"),
    name: z.string().max(512).nullable(),
  }),
]);

export const collaborationTeachingSlideIdSchema = collaborationSlideIdSchema;

export const collaborationTeachingSlideManifestSchema = z
  .object({
    id: collaborationTeachingSlideIdSchema,
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

export interface CollaborationTeachingSeedSlide {
  slide: Slide;
  asset: CollaborationAssetDescriptor;
}

export interface CollaborationTeachingSeed {
  slides: readonly CollaborationTeachingSeedSlide[];
  whiteboardElements: readonly WhiteboardElementJSON[];
}

export interface CollaborationTeachingProjection {
  initialized: boolean;
  slideOrder: readonly string[];
  slides: ReadonlyMap<string, CollaborationTeachingSlideManifest>;
  currentSlideId: string | null;
  presentationRevision: number;
  whiteboardElements: readonly WhiteboardElementJSON[];
}

export interface CollaborationTeachingIntegrity {
  projection: CollaborationTeachingProjection;
  immutableFingerprint: string;
  mutableFingerprint: string;
}

/** Enforces the mutations permitted on an already published room teaching tree. */
export function assertCollaborationTeachingTransition(
  before: CollaborationTeachingIntegrity,
  after: CollaborationTeachingIntegrity,
): void {
  if (!before.projection.initialized && after.projection.initialized) {
    throw new CollaborationTeachingError("Teaching surfaces require owner initialization");
  }
  if (!before.projection.initialized) return;
  if (!after.projection.initialized) {
    throw new CollaborationTeachingError("The room teaching surfaces cannot be removed");
  }
  if (before.immutableFingerprint !== after.immutableFingerprint) {
    throw new CollaborationTeachingError("The immutable room presentation cannot be changed");
  }
  if (after.projection.presentationRevision < before.projection.presentationRevision) {
    throw new CollaborationTeachingError("A stale presentation revision cannot be applied");
  }
  if (
    after.projection.currentSlideId !== before.projection.currentSlideId &&
    after.projection.presentationRevision === before.projection.presentationRevision
  ) {
    throw new CollaborationTeachingError(
      "A changed room slide must advance the presentation revision",
    );
  }
}

export class CollaborationTeachingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationTeachingError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function projectRoot(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(COLLABORATION_PROJECT_ROOT);
}

function optionalTeachingRoot(doc: Y.Doc): Y.Map<unknown> | null {
  const teaching = projectRoot(doc).get(COLLABORATION_TEACHING_ROOT);
  return teaching instanceof Y.Map ? teaching : null;
}

export function collaborationTransactionTouchesTeaching(
  doc: Y.Doc,
  transaction: Y.Transaction,
): boolean {
  const sharedRoot = doc.share.get(COLLABORATION_PROJECT_ROOT);
  if (sharedRoot && transaction.changed.get(sharedRoot)?.has(COLLABORATION_TEACHING_ROOT)) {
    return true;
  }
  const root = projectRoot(doc);
  if (transaction.changed.get(root)?.has(COLLABORATION_TEACHING_ROOT)) return true;
  const teaching = optionalTeachingRoot(doc);
  return teaching ? transaction.changedParentTypes.has(teaching) : false;
}

export function collaborationTransactionTouchesOnlyTeaching(
  doc: Y.Doc,
  transaction: Y.Transaction,
): boolean {
  const sharedRoot = doc.share.get(COLLABORATION_PROJECT_ROOT);
  if (!collaborationTransactionTouchesTeaching(doc, transaction)) return false;
  const root = projectRoot(doc);
  const teaching = optionalTeachingRoot(doc);
  if (!teaching) return false;
  for (const [type, keys] of transaction.changed) {
    if (type === root || type === sharedRoot) {
      if (Array.from(keys).some((key) => key !== COLLABORATION_TEACHING_ROOT)) return false;
      continue;
    }
    let ancestor: Y.AbstractType<any> | null = type;
    let belongsToTeaching = false;
    while (ancestor) {
      if (ancestor === teaching) {
        belongsToTeaching = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!belongsToTeaching) return false;
  }
  return true;
}

function childMap<T>(root: Y.Map<unknown>, key: string): Y.Map<T> {
  const current = root.get(key);
  if (current instanceof Y.Map) return current as Y.Map<T>;
  const next = new Y.Map<T>();
  root.set(key, next);
  return next;
}

function childArray<T>(root: Y.Map<unknown>, key: string): Y.Array<T> {
  const current = root.get(key);
  if (current instanceof Y.Array) return current as Y.Array<T>;
  const next = new Y.Array<T>();
  root.set(key, next);
  return next;
}

export function getCollaborationTeachingRoot(doc: Y.Doc): Y.Map<unknown> {
  const root = projectRoot(doc);
  const current = root.get(COLLABORATION_TEACHING_ROOT);
  if (current instanceof Y.Map) return current;
  const teaching = new Y.Map<unknown>();
  root.set(COLLABORATION_TEACHING_ROOT, teaching);
  return teaching;
}

export function isCollaborationTeachingInitialized(doc: Y.Doc): boolean {
  return optionalTeachingRoot(doc)?.get("initialized") === true;
}

function normalizeSlideId(value: string): string {
  const parsed = collaborationTeachingSlideIdSchema.safeParse(value);
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
  const exact = payload.buffer.slice(
    payload.byteOffset,
    payload.byteOffset + payload.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", exact);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decodeCollaborationSlideAsset(
  bytes: Uint8Array,
  manifest: CollaborationTeachingSlideManifest,
): Promise<Slide> {
  await verifyCollaborationSlideAsset(bytes, manifest.asset);
  return decodeCollaborationSlidePayload(bytes, manifest);
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

function serializedElement(element: WhiteboardElementJSON): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(element, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("non-finite number");
      }
      return value;
    });
  } catch {
    throw new CollaborationTeachingError("A whiteboard element is not serializable");
  }
  if (textEncoder.encode(serialized).byteLength > MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES) {
    throw new CollaborationTeachingError("A whiteboard element is too large to share");
  }
  return serialized;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateCollaborationWhiteboardElement(value: unknown): WhiteboardElementJSON {
  let clone: WhiteboardElementJSON;
  try {
    clone = structuredClone(value) as WhiteboardElementJSON;
  } catch {
    throw new CollaborationTeachingError("A whiteboard element is not serializable");
  }
  const parsed = collaborationWhiteboardElementSchema.safeParse(clone);
  if (!parsed.success) {
    throw new CollaborationTeachingError("A whiteboard element is malformed or unsafe");
  }
  return JSON.parse(serializedElement(parsed.data)) as WhiteboardElementJSON;
}

function compareWhiteboardElements(
  left: WhiteboardElementJSON,
  right: WhiteboardElementJSON,
): number {
  return (
    left.version - right.version ||
    left.versionNonce - right.versionNonce ||
    Number(left.isDeleted) - Number(right.isDeleted) ||
    compareCodeUnits(serializedElement(left), serializedElement(right))
  );
}

interface CollaborationWhiteboardElementCandidate {
  kind: "element";
  version: number;
  versionNonce: number;
  element: WhiteboardElementJSON;
}

interface CollaborationWhiteboardTombstoneCandidate {
  kind: "tombstone";
  version: number;
  versionNonce: number;
}

type CollaborationWhiteboardCandidate =
  | CollaborationWhiteboardElementCandidate
  | CollaborationWhiteboardTombstoneCandidate;

interface SerializedCollaborationWhiteboardCandidate {
  candidate: CollaborationWhiteboardCandidate;
  serialized: string;
}

function whiteboardCandidateRank(candidate: CollaborationWhiteboardCandidate): number {
  if (candidate.kind === "tombstone") return 2;
  return candidate.element.isDeleted ? 1 : 0;
}

function compareWhiteboardCandidates(
  left: SerializedCollaborationWhiteboardCandidate,
  right: SerializedCollaborationWhiteboardCandidate,
): number {
  return (
    left.candidate.version - right.candidate.version ||
    left.candidate.versionNonce - right.candidate.versionNonce ||
    whiteboardCandidateRank(left.candidate) - whiteboardCandidateRank(right.candidate) ||
    compareCodeUnits(left.serialized, right.serialized)
  );
}

function serializeWhiteboardCandidate(
  candidate: CollaborationWhiteboardCandidate,
): SerializedCollaborationWhiteboardCandidate {
  const serialized = JSON.stringify(candidate);
  if (
    textEncoder.encode(serialized).byteLength >
    MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES + 512
  ) {
    throw new CollaborationTeachingError("A whiteboard element record is too large to share");
  }
  return { candidate, serialized };
}

function elementWhiteboardCandidate(
  element: WhiteboardElementJSON,
): SerializedCollaborationWhiteboardCandidate {
  const normalized = validateCollaborationWhiteboardElement(element);
  return serializeWhiteboardCandidate({
    kind: "element",
    version: normalized.version,
    versionNonce: normalized.versionNonce,
    element: normalized,
  });
}

function tombstoneWhiteboardCandidate(
  previous: CollaborationWhiteboardCandidate,
): SerializedCollaborationWhiteboardCandidate {
  return serializeWhiteboardCandidate({
    kind: "tombstone",
    version: previous.version === Number.MAX_SAFE_INTEGER ? previous.version : previous.version + 1,
    versionNonce: Number.MAX_SAFE_INTEGER,
  });
}

function parseWhiteboardCandidate(
  id: string,
  serialized: unknown,
): SerializedCollaborationWhiteboardCandidate {
  if (typeof serialized !== "string") {
    throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
  }
  if (
    textEncoder.encode(serialized).byteLength >
    MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES + 512
  ) {
    throw new CollaborationTeachingError("A whiteboard element candidate is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new CollaborationTeachingError("A whiteboard element candidate is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
  }
  const object = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(object.version) ||
    (object.version as number) < 0 ||
    !Number.isSafeInteger(object.versionNonce) ||
    (object.versionNonce as number) < 0
  ) {
    throw new CollaborationTeachingError("A whiteboard element candidate has invalid version data");
  }
  if (object.kind === "tombstone") {
    if (Object.keys(object).some((key) => !["kind", "version", "versionNonce"].includes(key))) {
      throw new CollaborationTeachingError("A whiteboard tombstone contains unsupported fields");
    }
    return {
      candidate: object as unknown as CollaborationWhiteboardTombstoneCandidate,
      serialized,
    };
  }
  if (object.kind !== "element") {
    throw new CollaborationTeachingError("A whiteboard element candidate has an invalid kind");
  }
  if (
    Object.keys(object).some((key) => !["kind", "version", "versionNonce", "element"].includes(key))
  ) {
    throw new CollaborationTeachingError(
      "A whiteboard element candidate contains unsupported fields",
    );
  }
  const element = validateCollaborationWhiteboardElement(object.element);
  if (
    element.id !== id ||
    element.version !== object.version ||
    element.versionNonce !== object.versionNonce
  ) {
    throw new CollaborationTeachingError(
      "A whiteboard element candidate has mismatched identity data",
    );
  }
  return {
    candidate: {
      kind: "element",
      version: element.version,
      versionNonce: element.versionNonce,
      element,
    },
    serialized,
  };
}

function readWhiteboardCandidate(
  id: string,
  value: unknown,
): SerializedCollaborationWhiteboardCandidate {
  if (!(value instanceof Y.Array)) {
    throw new CollaborationTeachingError("A whiteboard element record is malformed");
  }
  if (value.length < 1 || value.length > MAX_COLLABORATION_WHITEBOARD_CANDIDATES_PER_ELEMENT) {
    throw new CollaborationTeachingError("A whiteboard element record has invalid history");
  }
  let winner: SerializedCollaborationWhiteboardCandidate | null = null;
  for (const serialized of value.toArray()) {
    const candidate = parseWhiteboardCandidate(id, serialized);
    if (!winner || compareWhiteboardCandidates(candidate, winner) > 0) winner = candidate;
  }
  if (!winner) throw new CollaborationTeachingError("A whiteboard element record is empty");
  return winner;
}

function whiteboardCandidateArray(
  candidate: SerializedCollaborationWhiteboardCandidate,
): Y.Array<string> {
  const value = new Y.Array<string>();
  value.insert(0, [candidate.serialized]);
  return value;
}

export function applyCollaborationWhiteboardEvent(
  elements: readonly WhiteboardElementJSON[],
  event: Pick<WhiteboardEvent, "upserts" | "removedIds">,
): WhiteboardElementJSON[] {
  const byId = new Map(elements.map((element) => [element.id, element] as const));
  for (const id of event.removedIds ?? []) {
    if (typeof id === "string" && id.length <= 256) byId.delete(id);
  }
  for (const candidate of event.upserts ?? []) {
    const element = validateCollaborationWhiteboardElement(candidate);
    const existing = byId.get(element.id);
    if (!existing || compareWhiteboardElements(element, existing) >= 0) {
      byId.set(element.id, element);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    const leftIndex = typeof left.index === "string" ? left.index : "";
    const rightIndex = typeof right.index === "string" ? right.index : "";
    return compareCodeUnits(leftIndex, rightIndex) || compareCodeUnits(left.id, right.id);
  });
}

function assertWhiteboardSceneBounds(elements: readonly WhiteboardElementJSON[]): void {
  if (elements.length > MAX_COLLABORATION_WHITEBOARD_ELEMENTS) {
    throw new CollaborationTeachingError("The shared whiteboard has too many elements");
  }
  let totalBytes = 0;
  for (const element of elements) {
    totalBytes += textEncoder.encode(serializedElement(element)).byteLength;
    if (totalBytes > MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES) {
      throw new CollaborationTeachingError("The shared whiteboard exceeds the room scene limit");
    }
  }
}

function manifestMap(manifest: CollaborationTeachingSlideManifest): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("id", manifest.id);
  value.set("contentType", manifest.contentType);
  value.set("assetId", manifest.asset.id);
  value.set("assetMimeType", manifest.asset.mimeType);
  value.set("assetSize", manifest.asset.size);
  return value;
}

function readManifest(id: string, value: unknown): CollaborationTeachingSlideManifest | null {
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

export function seedCollaborationTeachingDocument(
  doc: Y.Doc,
  seed: CollaborationTeachingSeed,
  origin: CollaborationTransactionOrigin = COLLABORATION_ORIGIN.teachingSeed,
): void {
  if (isCollaborationTeachingInitialized(doc)) {
    throw new CollaborationTeachingError("The room teaching surfaces are already initialized");
  }
  if (seed.slides.length > MAX_COLLABORATION_TEACHING_SLIDES) {
    throw new CollaborationTeachingError("The room presentation contains too many slides");
  }
  const ids = new Set<string>();
  const normalizedSlides: CollaborationTeachingSeedSlide[] = [];
  for (const candidate of seed.slides) {
    const manifest = collaborationTeachingSlideManifestSchema.parse({
      id: candidate.slide.id,
      contentType: candidate.slide.contentType,
      asset: candidate.asset,
    });
    if (ids.has(manifest.id)) continue;
    ids.add(manifest.id);
    normalizedSlides.push({ slide: candidate.slide, asset: manifest.asset });
  }
  const whiteboardElements = applyCollaborationWhiteboardEvent([], {
    upserts: seed.whiteboardElements,
  });
  assertWhiteboardSceneBounds(whiteboardElements);

  doc.transact(() => {
    const teaching = getCollaborationTeachingRoot(doc);
    if (teaching.get("initialized") === true) {
      throw new CollaborationTeachingError("The room teaching surfaces are already initialized");
    }
    const order = childArray<string>(teaching, COLLABORATION_TEACHING_SLIDE_ORDER);
    const slides = childMap<Y.Map<unknown>>(teaching, COLLABORATION_TEACHING_SLIDES);
    const presentation = childMap<unknown>(teaching, COLLABORATION_TEACHING_PRESENTATION);
    const whiteboard = childMap<Y.Array<string>>(teaching, COLLABORATION_TEACHING_WHITEBOARD);
    if (order.length) order.delete(0, order.length);
    if (normalizedSlides.length)
      order.insert(
        0,
        normalizedSlides.map(({ slide }) => slide.id),
      );
    for (const { slide, asset } of normalizedSlides) {
      slides.set(slide.id, manifestMap({ id: slide.id, contentType: slide.contentType, asset }));
    }
    presentation.set("currentSlideId", normalizedSlides[0]?.slide.id ?? null);
    presentation.set("revision", 0);
    for (const element of whiteboardElements) {
      whiteboard.set(element.id, whiteboardCandidateArray(elementWhiteboardCandidate(element)));
    }
    teaching.set("initialized", true);
  }, origin);
}

export function projectCollaborationTeachingDocument(doc: Y.Doc): CollaborationTeachingProjection {
  const teaching = optionalTeachingRoot(doc);
  if (!teaching || teaching.get("initialized") !== true) {
    return {
      initialized: false,
      slideOrder: [],
      slides: new Map(),
      currentSlideId: null,
      presentationRevision: 0,
      whiteboardElements: [],
    };
  }
  const orderValue = teaching.get(COLLABORATION_TEACHING_SLIDE_ORDER);
  const slidesValue = teaching.get(COLLABORATION_TEACHING_SLIDES);
  const presentationValue = teaching.get(COLLABORATION_TEACHING_PRESENTATION);
  const whiteboardValue = teaching.get(COLLABORATION_TEACHING_WHITEBOARD);
  const slides = new Map<string, CollaborationTeachingSlideManifest>();
  if (slidesValue instanceof Y.Map) {
    for (const [id, value] of slidesValue) {
      const manifest = readManifest(id, value);
      if (manifest) slides.set(id, manifest);
    }
  }
  const slideOrder =
    orderValue instanceof Y.Array
      ? orderValue
          .toArray()
          .filter((id): id is string => typeof id === "string" && slides.has(id))
          .filter((id, index, all) => all.indexOf(id) === index)
          .slice(0, MAX_COLLABORATION_TEACHING_SLIDES)
      : [];
  const currentSlideValue =
    presentationValue instanceof Y.Map ? presentationValue.get("currentSlideId") : null;
  const revisionValue = presentationValue instanceof Y.Map ? presentationValue.get("revision") : 0;
  const whiteboardElements: WhiteboardElementJSON[] = [];
  if (whiteboardValue instanceof Y.Map) {
    for (const [id, value] of whiteboardValue) {
      try {
        const winner = readWhiteboardCandidate(id, value).candidate;
        if (winner.kind === "element") whiteboardElements.push(winner.element);
      } catch {
        // Malformed teaching entries are isolated instead of crashing workspace projection.
      }
    }
  }
  const orderedWhiteboard = applyCollaborationWhiteboardEvent([], { upserts: whiteboardElements });
  assertWhiteboardSceneBounds(orderedWhiteboard);
  return {
    initialized: true,
    slideOrder,
    slides,
    currentSlideId:
      typeof currentSlideValue === "string" && slideOrder.includes(currentSlideValue)
        ? currentSlideValue
        : (slideOrder[0] ?? null),
    presentationRevision:
      Number.isSafeInteger(revisionValue) && (revisionValue as number) >= 0
        ? (revisionValue as number)
        : 0,
    whiteboardElements: orderedWhiteboard,
  };
}

function assertExactKeys(map: Y.Map<unknown>, expected: readonly string[], label: string): void {
  const expectedKeys = new Set(expected);
  for (const key of map.keys()) {
    if (!expectedKeys.has(key)) {
      throw new CollaborationTeachingError(`${label} contains an unsupported field`);
    }
  }
}

export function validateCollaborationTeachingDocument(doc: Y.Doc): CollaborationTeachingIntegrity {
  const rawTeaching = projectRoot(doc).get(COLLABORATION_TEACHING_ROOT);
  const teaching = optionalTeachingRoot(doc);
  const projection = projectCollaborationTeachingDocument(doc);
  if (rawTeaching !== undefined && !teaching) {
    throw new CollaborationTeachingError("The teaching root has an invalid structure");
  }
  if (!teaching) {
    return {
      projection,
      immutableFingerprint: "uninitialized",
      mutableFingerprint: "uninitialized",
    };
  }
  assertExactKeys(
    teaching,
    [
      "initialized",
      COLLABORATION_TEACHING_SLIDE_ORDER,
      COLLABORATION_TEACHING_SLIDES,
      COLLABORATION_TEACHING_PRESENTATION,
      COLLABORATION_TEACHING_WHITEBOARD,
    ],
    "The teaching root",
  );
  if (teaching.get("initialized") !== true) {
    throw new CollaborationTeachingError("A teaching root must be explicitly initialized");
  }
  const order = teaching.get(COLLABORATION_TEACHING_SLIDE_ORDER);
  const slides = teaching.get(COLLABORATION_TEACHING_SLIDES);
  const presentation = teaching.get(COLLABORATION_TEACHING_PRESENTATION);
  const whiteboard = teaching.get(COLLABORATION_TEACHING_WHITEBOARD);
  if (
    !(order instanceof Y.Array) ||
    !(slides instanceof Y.Map) ||
    !(presentation instanceof Y.Map) ||
    !(whiteboard instanceof Y.Map)
  ) {
    throw new CollaborationTeachingError("The teaching root has an invalid structure");
  }
  if (
    order.length !== projection.slideOrder.length ||
    slides.size !== projection.slides.size ||
    projection.slideOrder.length !== projection.slides.size
  ) {
    throw new CollaborationTeachingError("The room slide manifest is malformed");
  }
  for (const [id, value] of slides) {
    if (!(value instanceof Y.Map)) {
      throw new CollaborationTeachingError("A room slide manifest is malformed");
    }
    assertExactKeys(
      value,
      ["id", "contentType", "assetId", "assetMimeType", "assetSize"],
      "A room slide manifest",
    );
    if (!readManifest(id, value)) {
      throw new CollaborationTeachingError("A room slide manifest is malformed");
    }
  }
  assertExactKeys(presentation, ["currentSlideId", "revision"], "The presentation state");
  const rawCurrentSlideId = presentation.get("currentSlideId");
  const rawRevision = presentation.get("revision");
  if (
    (rawCurrentSlideId === null
      ? projection.slideOrder.length > 0
      : typeof rawCurrentSlideId !== "string" ||
        !projection.slideOrder.includes(rawCurrentSlideId)) ||
    !Number.isSafeInteger(rawRevision) ||
    (rawRevision as number) < 0
  ) {
    throw new CollaborationTeachingError("The presentation state is invalid");
  }
  if (whiteboard.size > MAX_COLLABORATION_WHITEBOARD_ELEMENTS) {
    throw new CollaborationTeachingError("The whiteboard element map has too many records");
  }
  let whiteboardBytes = 0;
  const whiteboardHistory: Array<{ id: string; candidates: string[] }> = [];
  for (const [id, value] of whiteboard) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) {
      throw new CollaborationTeachingError("A whiteboard element ID is malformed");
    }
    if (!(value instanceof Y.Array)) {
      throw new CollaborationTeachingError("A whiteboard element record is malformed");
    }
    readWhiteboardCandidate(id, value);
    const candidates = value.toArray();
    for (const serialized of candidates) {
      if (typeof serialized !== "string") {
        throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
      }
      whiteboardBytes += textEncoder.encode(serialized).byteLength;
      if (whiteboardBytes > MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES) {
        throw new CollaborationTeachingError(
          "The shared whiteboard history exceeds the room limit",
        );
      }
    }
    whiteboardHistory.push({ id, candidates });
  }
  whiteboardHistory.sort((left, right) => compareCodeUnits(left.id, right.id));
  const immutableFingerprint = JSON.stringify({
    slideOrder: projection.slideOrder,
    slides: projection.slideOrder.map((id) => projection.slides.get(id)),
  });
  const mutableFingerprint = JSON.stringify({
    currentSlideId: projection.currentSlideId,
    presentationRevision: projection.presentationRevision,
    whiteboardElements: projection.whiteboardElements,
    whiteboardHistory,
  });
  return { projection, immutableFingerprint, mutableFingerprint };
}

function assertTeachingUpdateFitsSnapshot(doc: Y.Doc, additionalBytes: number): void {
  if (Y.encodeStateAsUpdate(doc).byteLength + additionalBytes > MAX_YJS_SNAPSHOT_BYTES) {
    throw new CollaborationTeachingError(
      "The shared teaching state exceeds the room snapshot limit",
    );
  }
}

export function setCollaborationCurrentSlide(
  doc: Y.Doc,
  slideId: string,
  origin: CollaborationTransactionOrigin = COLLABORATION_ORIGIN.localPresentation,
): number {
  const projection = projectCollaborationTeachingDocument(doc);
  const { slideId: id } = collaborationCurrentSlideCommandSchema.parse({ slideId });
  if (!projection.initialized || !projection.slides.has(id)) {
    throw new CollaborationTeachingError("The requested slide is not in the room presentation");
  }
  if (projection.currentSlideId === id) return projection.presentationRevision;
  if (projection.presentationRevision >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationTeachingError("The room presentation revision is exhausted");
  }
  assertTeachingUpdateFitsSnapshot(doc, 2_048);
  const nextRevision = projection.presentationRevision + 1;
  doc.transact(() => {
    const presentation = childMap<unknown>(
      getCollaborationTeachingRoot(doc),
      COLLABORATION_TEACHING_PRESENTATION,
    );
    presentation.set("currentSlideId", id);
    presentation.set("revision", nextRevision);
  }, origin);
  return nextRevision;
}

export function applyCollaborationWhiteboardDelta(
  doc: Y.Doc,
  event: Pick<WhiteboardEvent, "upserts" | "removedIds">,
  origin: CollaborationTransactionOrigin = COLLABORATION_ORIGIN.localWhiteboard,
): WhiteboardElementJSON[] {
  const projection = projectCollaborationTeachingDocument(doc);
  if (!projection.initialized) {
    throw new CollaborationTeachingError("The room teaching surfaces are not initialized");
  }
  const whiteboard = childMap<Y.Array<string>>(
    getCollaborationTeachingRoot(doc),
    COLLABORATION_TEACHING_WHITEBOARD,
  );
  const winners = new Map<string, SerializedCollaborationWhiteboardCandidate>();
  for (const [id, value] of whiteboard) {
    winners.set(id, readWhiteboardCandidate(id, value));
  }

  const changed = new Map<string, SerializedCollaborationWhiteboardCandidate>();
  for (const id of event.removedIds ?? []) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) continue;
    const previous = winners.get(id);
    if (!previous || previous.candidate.kind === "tombstone") continue;
    const tombstone = tombstoneWhiteboardCandidate(previous.candidate);
    winners.set(id, tombstone);
    changed.set(id, tombstone);
  }
  for (const candidateValue of event.upserts ?? []) {
    const candidate = elementWhiteboardCandidate(candidateValue);
    const id = candidate.candidate.kind === "element" ? candidate.candidate.element.id : "";
    const previous = winners.get(id);
    if (!previous || compareWhiteboardCandidates(candidate, previous) > 0) {
      winners.set(id, candidate);
      changed.set(id, candidate);
    }
  }

  if (winners.size > MAX_COLLABORATION_WHITEBOARD_ELEMENTS) {
    throw new CollaborationTeachingError("The shared whiteboard has too many element records");
  }
  const next = Array.from(winners.values())
    .flatMap(({ candidate }) => (candidate.kind === "element" ? [candidate.element] : []))
    .sort((left, right) => {
      const leftIndex = typeof left.index === "string" ? left.index : "";
      const rightIndex = typeof right.index === "string" ? right.index : "";
      return compareCodeUnits(leftIndex, rightIndex) || compareCodeUnits(left.id, right.id);
    });
  assertWhiteboardSceneBounds(next);

  let additionalBytes = 0;
  for (const candidate of changed.values()) {
    additionalBytes += textEncoder.encode(candidate.serialized).byteLength + 512;
  }
  if (additionalBytes > 0) {
    let historyBytes = 0;
    const existingIds = new Set<string>();
    for (const [id, value] of whiteboard) {
      existingIds.add(id);
      const replacement = changed.get(id);
      if (replacement) {
        historyBytes += textEncoder.encode(replacement.serialized).byteLength;
      } else {
        for (const serialized of value.toArray()) {
          if (typeof serialized !== "string") {
            throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
          }
          historyBytes += textEncoder.encode(serialized).byteLength;
        }
      }
    }
    for (const [id, candidate] of changed) {
      if (!existingIds.has(id)) {
        historyBytes += textEncoder.encode(candidate.serialized).byteLength;
      }
    }
    if (historyBytes > MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES) {
      throw new CollaborationTeachingError("The shared whiteboard history exceeds the room limit");
    }
    assertTeachingUpdateFitsSnapshot(doc, additionalBytes);
  }

  for (const [id, candidate] of changed) {
    // One bounded element per transaction keeps every live Yjs update below
    // the provider's 64 KiB update limit. Replacing only the history visible to
    // this client preserves concurrent candidates that arrive during a merge;
    // projection deterministically selects the Excalidraw-version winner.
    doc.transact(() => {
      const current = whiteboard.get(id);
      if (current instanceof Y.Array) {
        if (current.length) current.delete(0, current.length);
        current.insert(0, [candidate.serialized]);
      } else {
        whiteboard.set(id, whiteboardCandidateArray(candidate));
      }
    }, origin);
  }
  return next;
}

export function collaborationTeachingSlideMimeType(
  _contentType: SlideContentType,
): "application/vnd.next-editor.slide+json" {
  return COLLABORATION_SLIDE_ASSET_MIME_TYPE;
}
