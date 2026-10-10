import * as Y from "yjs";
import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import type { Slide } from "../types/slides";
import {
  collaborationCurrentSlideCommandSchema,
  type CollaborationAssetDescriptor,
} from "./protocol";
import {
  COLLABORATION_ORIGIN,
  COLLABORATION_PROJECT_ROOT,
  getCollaborationProjectRoot,
  getOrCreateChildMap,
  type CollaborationTransactionOrigin,
} from "./projectDocument";
import {
  COLLABORATION_TEACHING_PRESENTATION,
  COLLABORATION_TEACHING_ROOT,
  COLLABORATION_TEACHING_SLIDE_ORDER,
  COLLABORATION_TEACHING_SLIDES,
  COLLABORATION_TEACHING_WHITEBOARD,
  CollaborationTeachingError,
  assertTeachingUpdateFitsSnapshot,
  getCollaborationTeachingRoot,
  isCollaborationTeachingInitialized,
  optionalTeachingRoot,
} from "./teachingRoot";
import {
  MAX_COLLABORATION_TEACHING_SLIDES,
  collaborationTeachingSlideManifestSchema,
  readSlideManifest,
  slideManifestMap,
  type CollaborationTeachingSlideManifest,
} from "./teachingSlides";
import {
  collaborationWhiteboardRecord,
  normalizeCollaborationWhiteboardSeed,
  projectCollaborationWhiteboard,
  readCollaborationWhiteboardHistory,
} from "./teachingWhiteboard";

// The room's teaching tree as one document: owner seeding, the projection
// every client renders, the validator and transition rules the room enforces,
// and current-slide navigation. Slides and whiteboard rules live in
// teachingSlides and teachingWhiteboard.

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

type TransactionChangedType = Y.AbstractType<Y.YEvent<any>>;

// Yjs transaction maps use the invariant YEvent base type even though the
// concrete shared types use their specialized event types. This is an
// identity-only cast for map lookup and parent traversal.
function asTransactionChangedType(type: Y.AbstractType<any>): TransactionChangedType {
  return type as unknown as TransactionChangedType;
}

export function collaborationTransactionTouchesTeaching(
  doc: Y.Doc,
  transaction: Y.Transaction,
): boolean {
  const sharedRoot = doc.share.get(COLLABORATION_PROJECT_ROOT);
  if (sharedRoot && transaction.changed.get(sharedRoot)?.has(COLLABORATION_TEACHING_ROOT)) {
    return true;
  }
  const root = getCollaborationProjectRoot(doc);
  if (transaction.changed.get(asTransactionChangedType(root))?.has(COLLABORATION_TEACHING_ROOT)) {
    return true;
  }
  const teaching = optionalTeachingRoot(doc);
  return teaching ? transaction.changedParentTypes.has(asTransactionChangedType(teaching)) : false;
}

export function collaborationTransactionTouchesOnlyTeaching(
  doc: Y.Doc,
  transaction: Y.Transaction,
): boolean {
  const sharedRoot = doc.share.get(COLLABORATION_PROJECT_ROOT);
  if (!collaborationTransactionTouchesTeaching(doc, transaction)) return false;
  const root = getCollaborationProjectRoot(doc);
  const teaching = optionalTeachingRoot(doc);
  if (!teaching) return false;
  const changedRoot = asTransactionChangedType(root);
  const changedTeaching = asTransactionChangedType(teaching);
  for (const [type, keys] of transaction.changed) {
    if (type === changedRoot || type === sharedRoot) {
      if (Array.from(keys).some((key) => key !== COLLABORATION_TEACHING_ROOT)) return false;
      continue;
    }
    let ancestor: Y.AbstractType<any> | null = type;
    let belongsToTeaching = false;
    while (ancestor) {
      if (ancestor === changedTeaching) {
        belongsToTeaching = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!belongsToTeaching) return false;
  }
  return true;
}

function childArray<T>(root: Y.Map<unknown>, key: string): Y.Array<T> {
  const current = root.get(key);
  if (current instanceof Y.Array) return current as Y.Array<T>;
  const next = new Y.Array<T>();
  root.set(key, next);
  return next;
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
  const whiteboardElements = normalizeCollaborationWhiteboardSeed(seed.whiteboardElements);

  doc.transact(() => {
    const teaching = getCollaborationTeachingRoot(doc);
    if (teaching.get("initialized") === true) {
      throw new CollaborationTeachingError("The room teaching surfaces are already initialized");
    }
    const order = childArray<string>(teaching, COLLABORATION_TEACHING_SLIDE_ORDER);
    const slides = getOrCreateChildMap<Y.Map<unknown>>(teaching, COLLABORATION_TEACHING_SLIDES);
    const presentation = getOrCreateChildMap<unknown>(
      teaching,
      COLLABORATION_TEACHING_PRESENTATION,
    );
    const whiteboard = getOrCreateChildMap<Y.Array<string>>(
      teaching,
      COLLABORATION_TEACHING_WHITEBOARD,
    );
    if (order.length) order.delete(0, order.length);
    if (normalizedSlides.length)
      order.insert(
        0,
        normalizedSlides.map(({ slide }) => slide.id),
      );
    for (const { slide, asset } of normalizedSlides) {
      slides.set(
        slide.id,
        slideManifestMap({ id: slide.id, contentType: slide.contentType, asset }),
      );
    }
    presentation.set("currentSlideId", normalizedSlides[0]?.slide.id ?? null);
    presentation.set("revision", 0);
    for (const element of whiteboardElements) {
      whiteboard.set(element.id, collaborationWhiteboardRecord(element));
    }
    teaching.set("initialized", true);
  }, origin);
}

/** The projection of a room whose teaching surfaces the owner has not initialized. */
export const UNINITIALIZED_TEACHING_PROJECTION: CollaborationTeachingProjection = Object.freeze({
  initialized: false,
  slideOrder: Object.freeze([]),
  slides: new Map(),
  currentSlideId: null,
  presentationRevision: 0,
  whiteboardElements: Object.freeze([]),
});

export function projectCollaborationTeachingDocument(doc: Y.Doc): CollaborationTeachingProjection {
  const teaching = optionalTeachingRoot(doc);
  if (!teaching || teaching.get("initialized") !== true) {
    return UNINITIALIZED_TEACHING_PROJECTION;
  }
  const orderValue = teaching.get(COLLABORATION_TEACHING_SLIDE_ORDER);
  const slidesValue = teaching.get(COLLABORATION_TEACHING_SLIDES);
  const presentationValue = teaching.get(COLLABORATION_TEACHING_PRESENTATION);
  const whiteboardValue = teaching.get(COLLABORATION_TEACHING_WHITEBOARD);
  const slides = new Map<string, CollaborationTeachingSlideManifest>();
  if (slidesValue instanceof Y.Map) {
    for (const [id, value] of slidesValue) {
      const manifest = readSlideManifest(id, value);
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
  const orderedWhiteboard = projectCollaborationWhiteboard(whiteboardValue);
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
  const rawTeaching = getCollaborationProjectRoot(doc).get(COLLABORATION_TEACHING_ROOT);
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
    if (!readSlideManifest(id, value)) {
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
  const whiteboardHistory = readCollaborationWhiteboardHistory(whiteboard);
  const immutableFingerprint = JSON.stringify({
    slideOrder: projection.slideOrder,
    slides: projection.slideOrder.map((id) => projection.slides.get(id)),
  });
  // Only teaching initialization compares it, while the room validates every
  // whiteboard update: stringify the whole board only when it is read.
  let mutableFingerprint: string | null = null;
  return {
    projection,
    immutableFingerprint,
    get mutableFingerprint() {
      mutableFingerprint ??= JSON.stringify({
        currentSlideId: projection.currentSlideId,
        presentationRevision: projection.presentationRevision,
        whiteboardElements: projection.whiteboardElements,
        whiteboardHistory,
      });
      return mutableFingerprint;
    },
  };
}

export function setCollaborationCurrentSlide(
  doc: Y.Doc,
  slideId: string,
  origin: CollaborationTransactionOrigin = COLLABORATION_ORIGIN.localPresentation,
): number {
  const projection = projectCollaborationTeachingDocument(doc);
  const { slideId: id } = collaborationCurrentSlideCommandSchema.parse({ slideId });
  // slideOrder, not slides: the projection only reports a current slide that is
  // in the order, so this is what makes a successful call show `id`.
  if (!projection.initialized || !projection.slideOrder.includes(id)) {
    throw new CollaborationTeachingError("The requested slide is not in the room presentation");
  }
  if (projection.currentSlideId === id) return projection.presentationRevision;
  if (projection.presentationRevision >= Number.MAX_SAFE_INTEGER) {
    throw new CollaborationTeachingError("The room presentation revision is exhausted");
  }
  assertTeachingUpdateFitsSnapshot(doc, 2_048);
  const nextRevision = projection.presentationRevision + 1;
  doc.transact(() => {
    const presentation = getOrCreateChildMap<unknown>(
      getCollaborationTeachingRoot(doc),
      COLLABORATION_TEACHING_PRESENTATION,
    );
    presentation.set("currentSlideId", id);
    presentation.set("revision", nextRevision);
  }, origin);
  return nextRevision;
}
