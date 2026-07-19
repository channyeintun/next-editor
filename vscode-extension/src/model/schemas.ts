import { z } from "zod";

// Runtime validators for format v1 (plan §7). The TypeScript types in
// events.ts/manifest.ts are the authoring source; these schemas are the
// runtime source, and test/unit/schemas.test.ts pins their equivalence
// (every produced event/manifest parses; type-level assignability is
// asserted for the payload shapes).

const id = z.string().min(1).max(256);
const isoDate = z.string().min(4);
const nonNegInt = z.number().int().nonnegative();
const hash = z.string(); // empty string allowed for synthetic fixtures

const eolMode = z.enum(["LF", "CRLF"]);
const schemeClass = z.enum(["file", "untitled", "remote", "virtual", "other"]);
const patchReason = z.enum(["undo", "redo", "unknown"]);
const selectionKind = z.enum(["mouse", "keyboard", "command", "unknown"]);
const checkpointReason = z.enum(["enrollment", "resume", "mismatch", "interval", "limit", "stop"]);
const tabKind = z.enum([
  "text",
  "textDiff",
  "notebook",
  "notebookDiff",
  "custom",
  "webview",
  "terminal",
  "other",
]);

const contentChange = z.object({
  rangeOffsetUtf16: nonNegInt,
  rangeLengthUtf16: nonNegInt,
  text: z.string(),
});

const selectionRange = z.object({
  anchorOffsetUtf16: nonNegInt,
  activeOffsetUtf16: nonNegInt,
});

const visibleLineRange = z.object({
  startLine: nonNegInt,
  startCharacter: nonNegInt,
  endLine: nonNegInt,
  endCharacter: nonNegInt,
});

const workspaceRoot = z.object({
  rootId: id,
  name: z.string(),
  ordinal: nonNegInt,
});

const documentDescriptor = z.object({
  documentId: id,
  rootId: id.nullable(),
  logicalPath: z.string(),
  displayName: z.string(),
  schemeClass,
  languageId: z.string(),
  eol: eolMode,
  initialVersion: nonNegInt,
  initialCheckpointId: id,
  byteLength: nonNegInt,
  sha256: hash,
});

const checkpointMeta = z.object({
  checkpointId: id,
  documentId: id,
  reason: checkpointReason,
  version: nonNegInt,
  eol: eolMode,
  byteLength: nonNegInt,
  sha256: hash,
});

const tabDescriptor = z.object({
  tabId: id,
  kind: tabKind,
  documentId: id.nullable(),
  label: z.string(),
  isActive: z.boolean(),
  isPinned: z.boolean(),
  isPreview: z.boolean(),
});

const topologySnapshot = z.object({
  groups: z.array(
    z.object({
      groupId: id,
      viewColumn: z.number().int(),
      isActive: z.boolean(),
      activeTabId: id.nullable(),
      tabs: z.array(tabDescriptor),
    }),
  ),
  activeGroupId: id.nullable(),
  fidelity: z.literal("reconstructed-no-geometry"),
  discontinuity: z.boolean(),
});

function envelope<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    seq: nonNegInt,
    tUs: nonNegInt,
    type: z.literal(type),
    payload,
  });
}

export const sessionEventSchema = z.discriminatedUnion("type", [
  envelope(
    "session.started",
    z.object({
      sessionId: id,
      extensionVersion: z.string(),
      vscodeVersion: z.string(),
      platform: z.string(),
      architecture: z.string(),
    }),
  ),
  envelope("roots.snapshot", z.object({ roots: z.array(workspaceRoot) })),
  envelope("document.enrolled", z.object({ descriptor: documentDescriptor })),
  envelope(
    "document.patch",
    z.object({
      documentId: id,
      beforeVersion: nonNegInt,
      afterVersion: nonNegInt,
      reason: patchReason,
      changes: z.array(contentChange),
      beforeHash: hash,
      afterHash: hash,
      eolBefore: eolMode,
      eolAfter: eolMode,
    }),
  ),
  envelope("document.checkpoint", checkpointMeta),
  envelope("document.languageChanged", z.object({ documentId: id, languageId: z.string() })),
  envelope("document.eolChanged", z.object({ documentId: id, eol: eolMode, version: nonNegInt })),
  envelope("document.saved", z.object({ documentId: id, version: nonNegInt })),
  envelope("document.closed", z.object({ documentId: id })),
  envelope("document.resumed", z.object({ documentId: id, version: nonNegInt })),
  envelope(
    "surface.opened",
    z.object({
      surfaceId: id,
      documentId: id,
      groupId: id.nullable(),
      viewColumn: z.number().int().nullable(),
      selections: z.array(selectionRange),
      visibleRanges: z.array(visibleLineRange),
      isActive: z.boolean(),
    }),
  ),
  envelope("surface.closed", z.object({ surfaceId: id })),
  envelope("surface.focused", z.object({ surfaceId: id })),
  envelope(
    "surface.selectionChanged",
    z.object({
      surfaceId: id,
      documentId: id,
      documentVersion: nonNegInt,
      kind: selectionKind,
      selections: z.array(selectionRange),
    }),
  ),
  envelope(
    "surface.viewportChanged",
    z.object({
      surfaceId: id,
      documentId: id,
      documentVersion: nonNegInt,
      visibleRanges: z.array(visibleLineRange),
    }),
  ),
  envelope("topology.snapshot", topologySnapshot),
  envelope("window.focusChanged", z.object({ focused: z.boolean() })),
  envelope(
    "capability.unsupportedSurface",
    z.object({ tabId: id, kind: tabKind, label: z.string() }),
  ),
  envelope("capture.overload", z.object({ queuedEvents: nonNegInt, note: z.string() })),
  envelope(
    "capture.shadowMismatch",
    z.object({
      documentId: id,
      expectedSha256: hash,
      observedSha256: hash,
      version: nonNegInt,
    }),
  ),
  envelope(
    "audio.started",
    z.object({ audioTrackId: id, sampleRate: nonNegInt, channels: nonNegInt }),
  ),
  envelope(
    "audio.calibration",
    z.object({
      audioTrackId: id,
      offsetUs: z.number(),
      drift: z.number(),
      points: nonNegInt,
      uncertaintyUsP50: z.number(),
      uncertaintyUsP95: z.number(),
    }),
  ),
  envelope("audio.discontinuity", z.object({ audioTrackId: id, reason: z.string() })),
  envelope("audio.stopped", z.object({ audioTrackId: id, sampleFrames: nonNegInt })),
  envelope("session.stopping", z.object({ reason: z.enum(["user", "failure", "shutdown"]) })),
  envelope("session.finalized", z.object({ eventCount: nonNegInt, durationUs: nonNegInt })),
  envelope("session.recovered", z.object({ recoveredThroughSeq: z.number().int() })),
  envelope("session.failed", z.object({ message: z.string() })),
  envelope("marker", z.object({ label: z.string() })),
]);

export type WireSessionEvent = z.infer<typeof sessionEventSchema>;

/** Validator suitable for JournalReader: returns an error string or null. */
export function validateSessionEventRaw(raw: unknown): string | null {
  const result = sessionEventSchema.safeParse(raw);
  return result.success ? null : result.error.issues[0]?.message || "invalid event";
}

export const audioTrackMetadataSchema = z.object({
  audioTrackId: id,
  entry: z.string(),
  codec: z.literal("pcm-wav"),
  sampleRate: nonNegInt,
  channels: nonNegInt,
  startTUs: nonNegInt,
  calibration: z
    .object({
      coefficients: z.object({ offsetUs: z.number(), drift: z.number() }),
      points: nonNegInt,
      uncertaintyUs: z.object({ p50: z.number(), p95: z.number() }),
    })
    .nullable(),
});

export const manifestSchema = z.object({
  kind: z.literal("next-recording"),
  formatVersion: z.literal(1),
  sessionId: id,
  createdAt: isoDate,
  finalizedAt: isoDate,
  durationUs: nonNegInt,
  producer: z.object({
    extensionVersion: z.string(),
    vscodeVersion: z.string(),
    platform: z.string(),
    architecture: z.string(),
  }),
  timebase: z.object({ kind: z.literal("host-monotonic-us") }),
  capabilities: z.object({
    textDocuments: z.boolean(),
    selections: z.boolean(),
    verticalViewport: z.boolean(),
    topology: z.boolean(),
    audio: z.boolean(),
    unsupportedSurfaceMarkers: z.boolean(),
  }),
  limitsApplied: z.array(z.string()),
  workspaceRoots: z.array(workspaceRoot),
  documents: z.array(documentDescriptor),
  tabs: z.array(tabDescriptor),
  initialTopologyRef: z.object({ eventSeq: nonNegInt }).nullable(),
  eventJournalRef: z.object({ entry: z.string(), eventCount: nonNegInt }),
  seekIndexRef: z.object({ entry: z.string() }),
  audioTracks: z.array(audioTrackMetadataSchema),
  integrity: z.object({ entries: z.record(z.string(), hash) }),
});

export const sessionMetadataSchema = z.object({
  formatVersion: z.literal(1),
  sessionId: id,
  state: z.enum([
    "preparing",
    "recording",
    "stopping",
    "finalizing",
    "finalized",
    "failed",
    "discarded",
  ]),
  createdAt: isoDate,
  updatedAt: isoDate,
  lastDurableSeq: z.number().int().gte(-1),
  extensionVersion: z.string(),
  vscodeVersion: z.string(),
  failure: z.object({ message: z.string(), at: isoDate }).nullable(),
  artifactPath: z.string().nullable(),
});

export const seekIndexSchema = z.object({
  version: z.literal(1),
  bucketUs: z.number().int().positive(),
  durationUs: nonNegInt,
  eventCount: nonNegInt,
  buckets: z.array(
    z.object({
      tUs: nonNegInt,
      upToSeq: z.number().int().gte(-1),
      nextByteOffset: nonNegInt.nullable(),
      checkpoints: z.record(z.string(), id),
      topologySeq: z.number().int().gte(-1),
    }),
  ),
});
