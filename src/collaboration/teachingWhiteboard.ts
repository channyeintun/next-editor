import * as Y from "yjs";
import * as z from "zod";
import {
  compareWhiteboardElementOrder,
  type WhiteboardElementJSON,
  type WhiteboardEvent,
} from "../core/src/whiteboard";
import { MAX_COLLABORATION_WHITEBOARD_COORDINATE } from "./protocol";
import {
  COLLABORATION_ORIGIN,
  getOrCreateChildMap,
  type CollaborationTransactionOrigin,
} from "./projectDocument";
import {
  COLLABORATION_TEACHING_WHITEBOARD,
  CollaborationTeachingError,
  assertTeachingUpdateFitsSnapshot,
  getCollaborationTeachingRoot,
  isCollaborationTeachingInitialized,
} from "./teachingRoot";

// The room whiteboard: the element schema and, per element ID, a Yjs array of
// serialized candidates from which every reader picks the same winner (the
// Excalidraw version rules, with tombstones for hard removals). Never imports
// teachingDocument.

export const MAX_COLLABORATION_WHITEBOARD_ELEMENTS = 5_000;
export const MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES = 48 * 1024;
export const MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES = 3 * 1024 * 1024;
export const MAX_COLLABORATION_WHITEBOARD_CANDIDATES_PER_ELEMENT = 64;

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

const textEncoder = new TextEncoder();

function serializeWhiteboardElement(element: WhiteboardElementJSON): {
  serialized: string;
  bytes: number;
} {
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
  const bytes = textEncoder.encode(serialized).byteLength;
  if (bytes > MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES) {
    throw new CollaborationTeachingError("A whiteboard element is too large to share");
  }
  return { serialized, bytes };
}

function serializedElement(element: WhiteboardElementJSON): string {
  return serializeWhiteboardElement(element).serialized;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareProgressiveWhiteboardStroke(
  left: WhiteboardElementJSON,
  right: WhiteboardElementJSON,
): number {
  // During one pointer gesture Excalidraw may append freehand points before it
  // advances version/versionNonce. Prefer the monotonic longer snapshot so the
  // deterministic serialized fallback cannot lock the room to the first chunk.
  if (left.type !== "freedraw" || right.type !== "freedraw" || left.isDeleted || right.isDeleted) {
    return 0;
  }
  const leftPoints = Array.isArray(left.points) ? left.points.length : 0;
  const rightPoints = Array.isArray(right.points) ? right.points.length : 0;
  return leftPoints - rightPoints;
}

/** Validates an element; `bytes` is the size of its serialized form. */
function normalizeWhiteboardElement(value: unknown): {
  element: WhiteboardElementJSON;
  bytes: number;
} {
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
  const { serialized, bytes } = serializeWhiteboardElement(parsed.data);
  return { element: JSON.parse(serialized) as WhiteboardElementJSON, bytes };
}

export function validateCollaborationWhiteboardElement(value: unknown): WhiteboardElementJSON {
  return normalizeWhiteboardElement(value).element;
}

function compareWhiteboardElements(
  left: WhiteboardElementJSON,
  right: WhiteboardElementJSON,
): number {
  return (
    left.version - right.version ||
    left.versionNonce - right.versionNonce ||
    Number(left.isDeleted) - Number(right.isDeleted) ||
    compareProgressiveWhiteboardStroke(left, right) ||
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
  /** The size of `serialized`, which the whiteboard history limit counts. */
  bytes: number;
  /** The size of the serialized element, which the scene limit counts; 0 for a tombstone. */
  elementBytes: number;
}

/**
 * The candidates parsed by the latest full read of a whiteboard map, by their
 * serialized string. Parsing is a pure function of the string, so reusing one
 * is exact. Every whiteboard delta (one per 100 ms while someone draws) makes
 * the drawing client, each peer and the room read the whole board, and only
 * the changed records hold new strings; a read keeps only the strings it saw,
 * so the cache never outgrows the board. Cached candidates are shared by every
 * projection, so they are frozen.
 */
const parsedWhiteboardCandidates = new WeakMap<
  object,
  ReadonlyMap<string, SerializedCollaborationWhiteboardCandidate>
>();

interface WhiteboardCandidateRead {
  previous: ReadonlyMap<string, SerializedCollaborationWhiteboardCandidate> | undefined;
  current: Map<string, SerializedCollaborationWhiteboardCandidate>;
}

function beginWhiteboardCandidateRead<T>(whiteboard: Y.Map<T>): WhiteboardCandidateRead {
  return { previous: parsedWhiteboardCandidates.get(whiteboard), current: new Map() };
}

function finishWhiteboardCandidateRead<T>(
  whiteboard: Y.Map<T>,
  read: WhiteboardCandidateRead,
): void {
  parsedWhiteboardCandidates.set(whiteboard, read.current);
}

function freezeJsonValue<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeJsonValue(child);
    Object.freeze(value);
  }
  return value;
}

function whiteboardCandidateRank(candidate: CollaborationWhiteboardCandidate): number {
  if (candidate.kind === "tombstone") return 2;
  return candidate.element.isDeleted ? 1 : 0;
}

function compareWhiteboardCandidates(
  left: SerializedCollaborationWhiteboardCandidate,
  right: SerializedCollaborationWhiteboardCandidate,
): number {
  const progressiveStrokeOrder =
    left.candidate.kind === "element" && right.candidate.kind === "element"
      ? compareProgressiveWhiteboardStroke(left.candidate.element, right.candidate.element)
      : 0;
  return (
    left.candidate.version - right.candidate.version ||
    left.candidate.versionNonce - right.candidate.versionNonce ||
    whiteboardCandidateRank(left.candidate) - whiteboardCandidateRank(right.candidate) ||
    progressiveStrokeOrder ||
    compareCodeUnits(left.serialized, right.serialized)
  );
}

function serializeWhiteboardCandidate(
  candidate: CollaborationWhiteboardCandidate,
  elementBytes: number,
): SerializedCollaborationWhiteboardCandidate {
  const serialized = JSON.stringify(candidate);
  const bytes = textEncoder.encode(serialized).byteLength;
  if (bytes > MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES + 512) {
    throw new CollaborationTeachingError("A whiteboard element record is too large to share");
  }
  return { candidate, serialized, bytes, elementBytes };
}

function elementWhiteboardCandidate(
  element: WhiteboardElementJSON,
): SerializedCollaborationWhiteboardCandidate {
  const { element: normalized, bytes } = normalizeWhiteboardElement(element);
  return serializeWhiteboardCandidate(
    {
      kind: "element",
      version: normalized.version,
      versionNonce: normalized.versionNonce,
      element: normalized,
    },
    bytes,
  );
}

function tombstoneWhiteboardCandidate(
  previous: CollaborationWhiteboardCandidate,
): SerializedCollaborationWhiteboardCandidate {
  return serializeWhiteboardCandidate(
    {
      kind: "tombstone",
      version:
        previous.version === Number.MAX_SAFE_INTEGER ? previous.version : previous.version + 1,
      versionNonce: Number.MAX_SAFE_INTEGER,
    },
    0,
  );
}

/** Parses and validates one candidate; the record's element ID is checked by the caller. */
function parseWhiteboardCandidate(serialized: string): SerializedCollaborationWhiteboardCandidate {
  const bytes = textEncoder.encode(serialized).byteLength;
  if (bytes > MAX_COLLABORATION_WHITEBOARD_ELEMENT_BYTES + 512) {
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
      bytes,
      elementBytes: 0,
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
  const { element, bytes: elementBytes } = normalizeWhiteboardElement(object.element);
  if (element.version !== object.version || element.versionNonce !== object.versionNonce) {
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
    bytes,
    elementBytes,
  };
}

function readWhiteboardCandidate(
  id: string,
  value: unknown,
  read: WhiteboardCandidateRead,
): SerializedCollaborationWhiteboardCandidate {
  if (!(value instanceof Y.Array)) {
    throw new CollaborationTeachingError("A whiteboard element record is malformed");
  }
  if (value.length < 1 || value.length > MAX_COLLABORATION_WHITEBOARD_CANDIDATES_PER_ELEMENT) {
    throw new CollaborationTeachingError("A whiteboard element record has invalid history");
  }
  let winner: SerializedCollaborationWhiteboardCandidate | null = null;
  for (const serialized of value.toArray()) {
    if (typeof serialized !== "string") {
      throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
    }
    let candidate = read.current.get(serialized) ?? read.previous?.get(serialized);
    if (!candidate) candidate = freezeJsonValue(parseWhiteboardCandidate(serialized));
    read.current.set(serialized, candidate);
    if (candidate.candidate.kind === "element" && candidate.candidate.element.id !== id) {
      throw new CollaborationTeachingError(
        "A whiteboard element candidate has mismatched identity data",
      );
    }
    if (!winner || compareWhiteboardCandidates(candidate, winner) > 0) winner = candidate;
  }
  if (!winner) throw new CollaborationTeachingError("A whiteboard element record is empty");
  return winner;
}

/** The UTF-8 size of a candidate string, from the read that parsed it when possible. */
function whiteboardCandidateBytes(read: WhiteboardCandidateRead, serialized: string): number {
  return read.current.get(serialized)?.bytes ?? textEncoder.encode(serialized).byteLength;
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
  return Array.from(byId.values()).sort(compareWhiteboardElementOrder);
}

/** `elementBytes` is the total size of the elements' serialized forms. */
function assertWhiteboardSceneBounds(elementCount: number, elementBytes: number): void {
  if (elementCount > MAX_COLLABORATION_WHITEBOARD_ELEMENTS) {
    throw new CollaborationTeachingError("The shared whiteboard has too many elements");
  }
  if (elementBytes > MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES) {
    throw new CollaborationTeachingError("The shared whiteboard exceeds the room scene limit");
  }
}

/** A seed's elements as the room stores them, in scene order and within the scene limits. */
export function normalizeCollaborationWhiteboardSeed(
  elements: readonly WhiteboardElementJSON[],
): WhiteboardElementJSON[] {
  const whiteboardElements = applyCollaborationWhiteboardEvent([], {
    upserts: [...elements],
  });
  assertWhiteboardSceneBounds(
    whiteboardElements.length,
    whiteboardElements.reduce(
      (total, element) => total + serializeWhiteboardElement(element).bytes,
      0,
    ),
  );
  return whiteboardElements;
}

/** The record a seeded element is stored as: a history holding only its own candidate. */
export function collaborationWhiteboardRecord(element: WhiteboardElementJSON): Y.Array<string> {
  return whiteboardCandidateArray(elementWhiteboardCandidate(element));
}

/**
 * The winning elements of a teaching root's whiteboard value, in scene order.
 * A malformed record is skipped rather than failing the projection; the scene
 * limits still apply.
 */
export function projectCollaborationWhiteboard(whiteboardValue: unknown): WhiteboardElementJSON[] {
  const whiteboardElements: WhiteboardElementJSON[] = [];
  let whiteboardElementBytes = 0;
  if (whiteboardValue instanceof Y.Map) {
    const read = beginWhiteboardCandidateRead(whiteboardValue);
    for (const [id, value] of whiteboardValue) {
      try {
        const winner = readWhiteboardCandidate(id, value, read);
        if (winner.candidate.kind === "element") {
          whiteboardElements.push(winner.candidate.element);
          whiteboardElementBytes += winner.elementBytes;
        }
      } catch {
        // Malformed teaching entries are isolated instead of crashing workspace projection.
      }
    }
    finishWhiteboardCandidateRead(whiteboardValue, read);
  }
  // Each winner was validated when it was parsed, and the map holds one per ID.
  const orderedWhiteboard = whiteboardElements.sort(compareWhiteboardElementOrder);
  assertWhiteboardSceneBounds(orderedWhiteboard.length, whiteboardElementBytes);
  return orderedWhiteboard;
}

/**
 * Validates every record and candidate of the whiteboard map, and returns the
 * full candidate history sorted by element ID, which the room fingerprints.
 */
export function readCollaborationWhiteboardHistory(
  whiteboard: Y.Map<unknown>,
): Array<{ id: string; candidates: string[] }> {
  if (whiteboard.size > MAX_COLLABORATION_WHITEBOARD_ELEMENTS) {
    throw new CollaborationTeachingError("The whiteboard element map has too many records");
  }
  let whiteboardBytes = 0;
  const whiteboardHistory: Array<{ id: string; candidates: string[] }> = [];
  const read = beginWhiteboardCandidateRead(whiteboard);
  for (const [id, value] of whiteboard) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) {
      throw new CollaborationTeachingError("A whiteboard element ID is malformed");
    }
    if (!(value instanceof Y.Array)) {
      throw new CollaborationTeachingError("A whiteboard element record is malformed");
    }
    readWhiteboardCandidate(id, value, read);
    const candidates = value.toArray();
    for (const serialized of candidates) {
      if (typeof serialized !== "string") {
        throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
      }
      whiteboardBytes += whiteboardCandidateBytes(read, serialized);
      if (whiteboardBytes > MAX_COLLABORATION_WHITEBOARD_SCENE_BYTES) {
        throw new CollaborationTeachingError(
          "The shared whiteboard history exceeds the room limit",
        );
      }
    }
    whiteboardHistory.push({ id, candidates });
  }
  finishWhiteboardCandidateRead(whiteboard, read);
  whiteboardHistory.sort((left, right) => compareCodeUnits(left.id, right.id));
  return whiteboardHistory;
}

export interface CollaborationWhiteboardDeltaResult {
  /** The room's whiteboard after the delta, in scene order. */
  elements: WhiteboardElementJSON[];
  /**
   * Whether the room now shows exactly what the delta asked for: each upsert
   * is (or equals) its element's winner and no removed ID has an element.
   * False when another client's version won, so the caller's canvas does not
   * show the room's result.
   */
  accepted: boolean;
}

export function applyCollaborationWhiteboardDelta(
  doc: Y.Doc,
  event: Pick<WhiteboardEvent, "upserts" | "removedIds">,
  origin: CollaborationTransactionOrigin = COLLABORATION_ORIGIN.localWhiteboard,
): CollaborationWhiteboardDeltaResult {
  // The O(1) check, not a projection: this runs for every local delta while
  // drawing, and the reads below reject a malformed or oversized board anyway.
  if (!isCollaborationTeachingInitialized(doc)) {
    throw new CollaborationTeachingError("The room teaching surfaces are not initialized");
  }
  const whiteboard = getOrCreateChildMap<Y.Array<string>>(
    getCollaborationTeachingRoot(doc),
    COLLABORATION_TEACHING_WHITEBOARD,
  );
  const winners = new Map<string, SerializedCollaborationWhiteboardCandidate>();
  const read = beginWhiteboardCandidateRead(whiteboard);
  for (const [id, value] of whiteboard) {
    winners.set(id, readWhiteboardCandidate(id, value, read));
  }
  finishWhiteboardCandidateRead(whiteboard, read);

  const changed = new Map<string, SerializedCollaborationWhiteboardCandidate>();
  for (const id of event.removedIds ?? []) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256) continue;
    const previous = winners.get(id);
    if (!previous || previous.candidate.kind === "tombstone") continue;
    const tombstone = tombstoneWhiteboardCandidate(previous.candidate);
    winners.set(id, tombstone);
    changed.set(id, tombstone);
  }
  const requested: SerializedCollaborationWhiteboardCandidate[] = [];
  for (const candidateValue of event.upserts ?? []) {
    const candidate = elementWhiteboardCandidate(candidateValue);
    requested.push(candidate);
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
  const next: WhiteboardElementJSON[] = [];
  let nextElementBytes = 0;
  for (const { candidate, elementBytes } of winners.values()) {
    if (candidate.kind !== "element") continue;
    next.push(candidate.element);
    nextElementBytes += elementBytes;
  }
  next.sort(compareWhiteboardElementOrder);
  assertWhiteboardSceneBounds(next.length, nextElementBytes);

  let additionalBytes = 0;
  for (const candidate of changed.values()) {
    additionalBytes += candidate.bytes + 512;
  }
  if (additionalBytes > 0) {
    let historyBytes = 0;
    const existingIds = new Set<string>();
    for (const [id, value] of whiteboard) {
      existingIds.add(id);
      const replacement = changed.get(id);
      if (replacement) {
        historyBytes += replacement.bytes;
      } else {
        for (const serialized of value.toArray()) {
          if (typeof serialized !== "string") {
            throw new CollaborationTeachingError("A whiteboard element candidate is malformed");
          }
          historyBytes += whiteboardCandidateBytes(read, serialized);
        }
      }
    }
    for (const [id, candidate] of changed) {
      if (!existingIds.has(id)) historyBytes += candidate.bytes;
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
  // Both sides are schema-normalized elements, so a request equal to the
  // element already stored still counts as accepted.
  const accepted =
    requested.every(({ candidate }) => {
      if (candidate.kind !== "element") return false;
      const winner = winners.get(candidate.element.id)?.candidate;
      return (
        winner?.kind === "element" &&
        (winner === candidate ||
          JSON.stringify(winner.element) === JSON.stringify(candidate.element))
      );
    }) && (event.removedIds ?? []).every((id) => winners.get(id)?.candidate.kind !== "element");
  return { elements: next, accepted };
}
