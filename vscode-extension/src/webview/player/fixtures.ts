// Synthetic benchmark fixtures (plan §11.2). Pure and deterministic: a
// seeded PRNG generates identical streams in Node tests and the webview
// benchmark, so nothing large crosses the host/webview bridge.
import type { ContentChange, SessionEvent } from "../../model/events";

export type BenchmarkFixture = {
  name: string;
  events: SessionEvent[];
  checkpointBodies: Record<string, string>;
  documentIds: string[];
  surfaceIds: string[];
  /** Interesting seek targets: event indexes at roughly even time spacing. */
  seekPoints: number[];
  durationUs: number;
  /** Ground-truth final document texts (reducer must reproduce these). */
  finalTexts: Record<string, string>;
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type GenConfig = {
  name: string;
  seed: number;
  docCount: number;
  surfacesPerDoc: number[];
  groupCount: number;
  durationUs: number;
  eventCount: number;
  initialLines: number;
  lineWidth: number;
  checkpointEveryUs: number | null;
  unicode?: boolean;
  /** Edits cluster near a moving hotspot instead of uniform positions. */
  localizedEdits?: boolean;
};

const ASCII_WORDS = ["const", "function", "return", "editor", "session", "value", "index", "state"];
const UNICODE_WORDS = ["名前", "función", "переменная", "😀🎯", "éàü", "🧵", "データ", "café"];

// Real VS Code offsets never split a surrogate pair; keep synthetic edits
// on code-point boundaries so renderers are measured on realistic input.
function alignToCodePoint(text: string, offset: number): number {
  let aligned = Math.max(0, Math.min(text.length, offset));
  while (
    aligned > 0 &&
    aligned < text.length &&
    (text.charCodeAt(aligned) & 0xfc00) === 0xdc00 // low surrogate
  ) {
    aligned -= 1;
  }
  return aligned;
}

export function generateFixture(config: GenConfig): BenchmarkFixture {
  const rand = mulberry32(config.seed);
  const words = config.unicode ? [...ASCII_WORDS, ...UNICODE_WORDS] : ASCII_WORDS;
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)] as T;

  const events: SessionEvent[] = [];
  const checkpointBodies: Record<string, string> = {};
  let seq = 0;
  let tUs = 0;
  let checkpointCounter = 0;
  // Payloads are fixture-shaped (string IDs, empty hashes); the cast is
  // confined here and validated by the reducer tests.
  const push = (type: SessionEvent["type"], payload: unknown) => {
    events.push({ seq: seq++, tUs, type, payload } as SessionEvent);
  };

  // --- initial state ----------------------------------------------------
  const line = () => Array.from({ length: config.lineWidth }, () => pick(words)).join(" ");
  const texts = new Map<string, string>();
  const documentIds: string[] = [];
  const surfaceIds: string[] = [];
  const surfaceDocuments = new Map<string, string>();

  push("session.started", {
    sessionId: `fixture-${config.name}`,
    extensionVersion: "0.0.0",
    vscodeVersion: "0.0.0",
    platform: "fixture",
    architecture: "fixture",
  });
  push("roots.snapshot", {
    roots: [{ rootId: "root-1", name: "fixture", ordinal: 0 }],
  } as never);

  for (let d = 0; d < config.docCount; d++) {
    const documentId = `doc-${d}`;
    documentIds.push(documentId);
    const text = Array.from({ length: config.initialLines }, line).join("\n");
    texts.set(documentId, text);
    const checkpointId = `cp-init-${d}`;
    checkpointBodies[checkpointId] = text;
    push("document.enrolled", {
      descriptor: {
        documentId,
        rootId: "root-1",
        logicalPath: `src/file-${d}.ts`,
        displayName: `file-${d}.ts`,
        schemeClass: "file",
        languageId: "plaintext",
        eol: "LF",
        initialVersion: 1,
        initialCheckpointId: checkpointId,
        byteLength: text.length,
        sha256: "",
      },
    } as never);
  }

  let surfaceIndex = 0;
  for (let d = 0; d < config.docCount; d++) {
    const count = config.surfacesPerDoc[d] ?? 1;
    for (let s = 0; s < count; s++) {
      const surfaceId = `surface-${surfaceIndex++}`;
      const documentId = `doc-${d}`;
      surfaceIds.push(surfaceId);
      surfaceDocuments.set(surfaceId, documentId);
      push("surface.opened", {
        surfaceId,
        documentId,
        groupId: `group-${surfaceIndex % config.groupCount}`,
        viewColumn: (surfaceIndex % config.groupCount) + 1,
        selections: [{ anchorOffsetUtf16: 0, activeOffsetUtf16: 0 }],
        visibleRanges: [{ startLine: 0, startCharacter: 0, endLine: 30, endCharacter: 0 }],
        isActive: s === 0 && d === 0,
      } as never);
    }
  }

  push("topology.snapshot", {
    groups: Array.from({ length: config.groupCount }, (_, g) => ({
      groupId: `group-${g}`,
      viewColumn: g + 1,
      isActive: g === 0,
      activeTabId: null,
      tabs: [],
    })),
    activeGroupId: "group-0",
    fidelity: "reconstructed-no-geometry",
    discontinuity: false,
  } as never);

  // --- event body ---------------------------------------------------------
  const versions = new Map<string, number>(documentIds.map((id) => [id, 1]));
  const hotspots = new Map<string, number>(documentIds.map((id) => [id, 0]));
  const remaining = config.eventCount - events.length;
  const stepUs = Math.max(1, Math.floor(config.durationUs / Math.max(1, remaining)));
  let lastCheckpointUs = 0;

  for (let i = 0; i < remaining; i++) {
    tUs += stepUs;
    const roll = rand();
    const documentId = documentIds[Math.floor(rand() * documentIds.length)] as string;
    const surfaceId = surfaceIds[Math.floor(rand() * surfaceIds.length)] as string;
    const surfaceDocumentId = surfaceDocuments.get(surfaceId) as string;

    if (roll < 0.55) {
      // Document patch: insert/replace a short run near a position.
      const text = texts.get(documentId) as string;
      let offset: number;
      if (config.localizedEdits) {
        const hotspot = hotspots.get(documentId) as number;
        offset = Math.min(text.length, Math.max(0, hotspot + Math.floor((rand() - 0.5) * 200)));
        if (rand() < 0.02) {
          hotspots.set(documentId, Math.floor(rand() * text.length));
        }
      } else {
        offset = Math.floor(rand() * (text.length + 1));
      }
      offset = alignToCodePoint(text, offset);
      const rawDeleteLen =
        rand() < 0.25 ? Math.min(text.length - offset, Math.floor(rand() * 12)) : 0;
      const deleteLen = alignToCodePoint(text, offset + rawDeleteLen) - offset;
      const insert = rand() < 0.85 ? `${pick(words)} ` : "\n";
      const changes: ContentChange[] = [
        { rangeOffsetUtf16: offset, rangeLengthUtf16: deleteLen, text: insert },
      ];
      const next = text.slice(0, offset) + insert + text.slice(offset + deleteLen);
      texts.set(documentId, next);
      const beforeVersion = versions.get(documentId) as number;
      versions.set(documentId, beforeVersion + 1);
      push("document.patch", {
        documentId,
        beforeVersion,
        afterVersion: beforeVersion + 1,
        reason: "unknown",
        changes,
        beforeHash: "",
        afterHash: "",
        eolBefore: "LF",
        eolAfter: "LF",
      } as never);
    } else if (roll < 0.8) {
      const docOfSurface = texts.get(surfaceDocumentId) as string;
      const anchor = Math.floor(rand() * (docOfSurface.length + 1));
      push("surface.selectionChanged", {
        surfaceId,
        documentId: surfaceDocumentId,
        documentVersion: versions.get(surfaceDocumentId) as number,
        kind: "keyboard",
        selections: [
          {
            anchorOffsetUtf16: anchor,
            activeOffsetUtf16: Math.min(docOfSurface.length, anchor + Math.floor(rand() * 20)),
          },
        ],
      } as never);
    } else if (roll < 0.97) {
      const startLine = Math.floor(rand() * config.initialLines);
      push("surface.viewportChanged", {
        surfaceId,
        documentId: surfaceDocumentId,
        documentVersion: versions.get(surfaceDocumentId) as number,
        visibleRanges: [
          {
            startLine,
            startCharacter: 0,
            endLine: startLine + 30,
            endCharacter: 0,
          },
        ],
      } as never);
    } else {
      push("surface.focused", { surfaceId } as never);
    }

    if (config.checkpointEveryUs !== null && tUs - lastCheckpointUs >= config.checkpointEveryUs) {
      lastCheckpointUs = tUs;
      const checkpointId = `cp-${checkpointCounter++}`;
      const body = texts.get(documentId) as string;
      checkpointBodies[checkpointId] = body;
      push("document.checkpoint", {
        checkpointId,
        documentId,
        reason: "interval",
        version: versions.get(documentId) as number,
        eol: "LF",
        byteLength: body.length,
        sha256: "",
      } as never);
    }
  }

  // Evenly spaced seek targets across the event stream.
  const seekPoints = Array.from({ length: 20 }, (_, i) =>
    Math.floor(((i + 1) / 21) * events.length),
  );

  const finalTexts: Record<string, string> = {};
  for (const [documentId, text] of texts) {
    finalTexts[documentId] = text;
  }

  return {
    name: config.name,
    events,
    checkpointBodies,
    documentIds,
    surfaceIds,
    seekPoints,
    durationUs: tUs,
    finalTexts,
  };
}

// Plan §11.2 fixture set.
export function benchmarkFixtureConfigs(): GenConfig[] {
  return [
    {
      name: "small",
      seed: 101,
      docCount: 3,
      surfacesPerDoc: [1, 1, 0],
      groupCount: 2,
      durationUs: 5 * 60 * 1_000_000,
      eventCount: 5_000,
      initialLines: 120,
      lineWidth: 8,
      checkpointEveryUs: 10_000_000,
    },
    {
      name: "multi-surface",
      seed: 202,
      docCount: 10,
      surfacesPerDoc: [2, 2, 1, 1, 1, 1, 1, 1, 1, 1],
      groupCount: 4,
      durationUs: 15 * 60 * 1_000_000,
      eventCount: 25_000,
      initialLines: 200,
      lineWidth: 8,
      checkpointEveryUs: 10_000_000,
    },
    {
      name: "large-file",
      seed: 303,
      docCount: 1,
      surfacesPerDoc: [1],
      groupCount: 1,
      durationUs: 5 * 60 * 1_000_000,
      eventCount: 2_000,
      // ~5 MiB: 8000 lines * ~80 words... tuned below via lineWidth.
      initialLines: 9_000,
      lineWidth: 72,
      checkpointEveryUs: 60_000_000,
      localizedEdits: true,
    },
    {
      name: "edit-burst",
      seed: 404,
      docCount: 2,
      surfacesPerDoc: [1, 1],
      groupCount: 2,
      durationUs: 10 * 1_000_000,
      eventCount: 1_000,
      initialLines: 100,
      lineWidth: 8,
      checkpointEveryUs: null,
    },
    {
      name: "long-session",
      seed: 505,
      docCount: 8,
      surfacesPerDoc: [1, 1, 1, 1, 1, 1, 1, 1],
      groupCount: 2,
      durationUs: 60 * 60 * 1_000_000,
      eventCount: 250_000,
      initialLines: 150,
      lineWidth: 8,
      checkpointEveryUs: 30_000_000,
    },
    {
      name: "unicode",
      seed: 606,
      docCount: 3,
      surfacesPerDoc: [1, 1, 1],
      groupCount: 2,
      durationUs: 3 * 60 * 1_000_000,
      eventCount: 5_000,
      initialLines: 80,
      lineWidth: 6,
      checkpointEveryUs: 10_000_000,
      unicode: true,
    },
  ];
}
