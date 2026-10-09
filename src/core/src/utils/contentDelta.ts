// ============================================================================
// Text content deltas: the diff-match-patch codec wrappers and the compact
// Monaco edit form. Editor frames (frameDelta.ts), the chat track (chatDelta.ts)
// and the coding agent all encode text with them; nothing here knows about
// frames.
// ============================================================================

import type { ContentDelta, ContentEditDelta } from "./deltaTypes";
import { encodeAppendDelta, getDmpCodec } from "../../dmp/dmpCodec";
import {
  applyTextEditChanges,
  applyTextEditEvent,
  type TextEditChange,
  type TextEditEvent,
} from "../textEdit";

const contentTextEncoder = new TextEncoder();
const contentTextDecoder = new TextDecoder();
const MAX_CONTENT_EDIT_CHANGES = 64;
const MAX_CONTENT_EDIT_CODE_UNITS = 256 * 1024;
// The content-edit integrity hash is 32-bit FNV-1a; recordings store it, so
// these are part of the ContentEditDelta format.
const FNV1A32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

function hasBoundedContentEditChanges(value: unknown): value is readonly TextEditChange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTENT_EDIT_CHANGES) {
    return false;
  }

  let changedCodeUnits = 0;
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const change = candidate as Partial<TextEditChange>;
    if (
      typeof change.offset !== "number" ||
      !Number.isSafeInteger(change.offset) ||
      change.offset < 0 ||
      typeof change.deleteLength !== "number" ||
      !Number.isSafeInteger(change.deleteLength) ||
      change.deleteLength < 0 ||
      typeof change.text !== "string"
    ) {
      return false;
    }
    changedCodeUnits += change.deleteLength + change.text.length;
    if (!Number.isSafeInteger(changedCodeUnits) || changedCodeUnits > MAX_CONTENT_EDIT_CODE_UNITS) {
      return false;
    }
  }
  return true;
}

/** FNV-1a over UTF-16 code units, without allocating an encoded full-string copy. */
function hashContentEditText(value: string): number {
  let hash = FNV1A32_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= codeUnit & 0xff;
    hash = Math.imul(hash, FNV1A32_PRIME);
    hash ^= codeUnit >>> 8;
    hash = Math.imul(hash, FNV1A32_PRIME);
  }
  return hash >>> 0;
}

export class ContentEditBaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentEditBaseMismatchError";
  }
}

export interface CreatedContentEditDelta {
  base: string;
  content: string;
  delta: ContentEditDelta;
}

/**
 * Converts a validated, ordinary Monaco change into the compact replay form.
 * Full-document replacement and large edit batches intentionally return null,
 * retaining the DMP fallback for bulk/programmatic changes.
 */
export function createContentEditDelta(
  base: string,
  event: TextEditEvent,
): CreatedContentEditDelta | null {
  if (!hasBoundedContentEditChanges(event.changes)) return null;

  const onlyChange = event.changes.length === 1 ? event.changes[0] : undefined;
  if (
    onlyChange &&
    event.beforeLength > 0 &&
    onlyChange.offset === 0 &&
    onlyChange.deleteLength === event.beforeLength
  ) {
    return null;
  }

  const content = applyTextEditEvent(base, event);
  if (content === null || content === base) return null;

  return {
    base,
    content,
    delta: {
      version: 1,
      beforeLength: base.length,
      afterLength: content.length,
      beforeHash: hashContentEditText(base),
      afterHash: hashContentEditText(content),
      changes: event.changes.map((change) => ({ ...change })),
    },
  };
}

/**
 * True when `created` was made for exactly the `base` → `content` change, so a
 * frame can store its compact delta in place of a dmp diff.
 */
export function contentEditDeltaMatches(
  base: string,
  content: string,
  created: CreatedContentEditDelta,
): boolean {
  const { delta } = created;
  return (
    created.base === base &&
    created.content === content &&
    delta.version === 1 &&
    delta.beforeLength === base.length &&
    delta.afterLength === content.length &&
    Number.isSafeInteger(delta.beforeHash) &&
    Number.isSafeInteger(delta.afterHash)
  );
}

export function applyContentEditDelta(base: string, delta: ContentEditDelta): string {
  if (
    delta.version !== 1 ||
    !Number.isSafeInteger(delta.beforeLength) ||
    !Number.isSafeInteger(delta.afterLength) ||
    delta.beforeLength < 0 ||
    delta.afterLength < 0 ||
    !Number.isSafeInteger(delta.beforeHash) ||
    !Number.isSafeInteger(delta.afterHash) ||
    delta.beforeHash < 0 ||
    delta.beforeHash > 0xffffffff ||
    delta.afterHash < 0 ||
    delta.afterHash > 0xffffffff ||
    !hasBoundedContentEditChanges(delta.changes)
  ) {
    throw new Error("content edit delta is malformed or uses an unsupported version");
  }
  if (base.length !== delta.beforeLength || hashContentEditText(base) !== delta.beforeHash) {
    throw new ContentEditBaseMismatchError(
      "content edit delta base mismatch — edits applied against the wrong base content",
    );
  }

  const content = applyTextEditChanges(base, delta.changes, delta.afterLength);
  if (content === null) throw new Error("content edit delta contains invalid edits");
  if (hashContentEditText(content) !== delta.afterHash) {
    throw new Error("content edit delta result failed its integrity check");
  }
  return content;
}

/**
 * Creates a content delta representing the change from prev to next.
 * Returns null if content is identical.
 */
export function createContentDelta(prev: string, next: string): ContentDelta | null {
  if (prev === next) return null;

  const delta = getDmpCodec().diffDelta(
    contentTextEncoder.encode(prev),
    contentTextEncoder.encode(next),
  );
  return { delta };
}

/**
 * Creates the codec-compatible delta for an append-only text update without
 * invoking the Myers diff. The wire payload contains one equal op for the
 * existing UTF-8 bytes and one insert op for only the appended suffix, while
 * retaining the codec's mandatory base-integrity check. The bytes are written by
 * {@link encodeAppendDelta}, which lives in the codec binding beside the Rust
 * wire format it mirrors.
 */
export function createAppendContentDelta(base: string, appended: string): ContentDelta | null {
  if (appended.length === 0) return null;
  const baseLastCodeUnit = base.charCodeAt(base.length - 1);
  const appendedFirstCodeUnit = appended.charCodeAt(0);
  if (
    baseLastCodeUnit >= 0xd800 &&
    baseLastCodeUnit <= 0xdbff &&
    appendedFirstCodeUnit >= 0xdc00 &&
    appendedFirstCodeUnit <= 0xdfff
  ) {
    // TextEncoder must see a surrogate pair together. Encoding its halves in
    // separate equal/insert operations would turn both into replacement chars.
    return null;
  }

  return {
    delta: encodeAppendDelta(contentTextEncoder.encode(base), contentTextEncoder.encode(appended)),
  };
}

/**
 * Reconstructs content by applying a delta to base content. `base` must equal
 * the `prev` the delta was created against (the same contract the prior
 * prefix/suffix model relied on); the codec throws otherwise.
 */
export function applyContentDelta(base: string, delta: ContentDelta): string {
  const rebuilt = getDmpCodec().applyDelta(contentTextEncoder.encode(base), delta.delta);
  return contentTextDecoder.decode(rebuilt);
}
