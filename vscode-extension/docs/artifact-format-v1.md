# Recording format v1 — working session and artifact

Status: draft during Phases 4–6; declared stable only when Phase 6 ships a
validated `.nextrecording` writer/reader pair (plan §9.5).

## 1. Common concepts

### 1.1 Event envelope

Every timed event is one JSON object:

```json
{ "seq": 0, "tUs": 0, "type": "session.started", "payload": {} }
```

- `seq`: integer, starts at 0, increases by exactly 1. Authoritative order.
- `tUs`: integer microseconds relative to session start
  (`process.hrtime.bigint()` based; timebase kind `host-monotonic-us`).
  Nondecreasing; ties broken by `seq`.
- `type`: one of the v1 event union below.
- `payload`: type-specific object.

### 1.2 Event union (v1)

`session.started`, `roots.snapshot`, `document.enrolled`,
`document.patch`, `document.checkpoint`, `document.languageChanged`,
`document.eolChanged`, `document.saved`, `document.closed`,
`document.resumed`, `surface.opened`, `surface.closed`, `surface.focused`,
`surface.selectionChanged`, `surface.viewportChanged`, `topology.snapshot`,
`window.focusChanged`, `capability.unsupportedSurface`, `capture.overload`,
`capture.shadowMismatch`, `audio.started`, `audio.calibration`,
`audio.discontinuity`, `audio.stopped`, `session.stopping`,
`session.finalized`, `session.recovered`, `session.failed`, `marker`.

Readers must ignore unknown _optional_ event types without executing
anything, and must reject artifacts whose manifest demands unsupported
required capabilities.

### 1.3 Text model

- All offsets (`rangeOffsetUtf16`, selection anchors) are UTF-16 code
  units, matching the VS Code extension API.
- A `document.patch` carries an atomic ordered change array applied
  against the evolving buffer in array order.
- `beforeHash`/`afterHash` are SHA-256 hex digests of the full document
  text encoded as UTF-8.
- Checkpoint bodies are exact UTF-8 text; delta replay between checkpoints
  must reproduce checkpoint hashes exactly.

### 1.4 Privacy

Descriptors carry root-relative logical paths or display names only —
never absolute paths, URI authorities, query strings, or usernames.

## 2. Working session directory

Location: `<globalStorage>/sessions/<sessionId>/` (plan §9.1).

```text
session.json        # lifecycle metadata, atomically replaced (see below)
events.ndjson       # append-only journal, one envelope per line
checkpoints/<checkpointId>.txt
audio/<audioTrackId>.wav          # Phase 8
recovery.json       # recovery bookkeeping (Phase 7)
finalized.json      # written after successful artifact finalization
```

### 2.1 session.json

```json
{
  "formatVersion": 1,
  "sessionId": "…",
  "state": "preparing | recording | stopping | finalizing | finalized | failed | discarded",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "lastDurableSeq": 123,
  "extensionVersion": "…",
  "vscodeVersion": "…",
  "failure": { "message": "…", "at": "ISO-8601" } | null,
  "artifactPath": "… | null"
}
```

Written via temp-file + fsync + rename in the session directory. The state
machine distinguishes active, interrupted, finalized, failed, and
discarded sessions.

### 2.2 events.ndjson

- Exactly one writer owns the handle; ordered writes only.
- Flush at least every 100 ms or 64 KiB; fdatasync every 1 s and at
  lifecycle boundaries.
- Recovery: one incomplete final line may be discarded. A malformed line
  before the tail ends recovery at the last verified sequence and records
  corruption.
- Replay validation checks: contiguous `seq` from 0, nondecreasing `tUs`,
  schema validity, referenced IDs (documents enrolled before use, surfaces
  opened before use), patch bounds, and every recorded hash.

### 2.3 checkpoints/

`<checkpointId>.txt` — exact UTF-8 body, written atomically **before** the
`document.checkpoint` event is journaled, so a journaled reference always
resolves. Metadata (id, document, seq/time, version, EOL, byte length,
SHA-256) lives in the checkpoint event itself.

Checkpoint policy: enrollment, resume-after-close, shadow mismatch,
pre-drop on limit, clean stop, and adaptive interval (10 s / 500
transactions / 1 MiB inserted, whichever first).

## 3. Finalized artifact (`.nextrecording`)

A ZIP container (plan §9.5), written streaming to a temporary path, synced,
validated by reopening, then atomically renamed.

```text
manifest.json
events.ndjson
index.json
documents/<documentId>/checkpoints/<checkpointId>.txt
audio/<audioTrackId>.wav          # only with audio capability
integrity.json
```

### 3.1 manifest.json (ManifestV1)

See `src/model/manifest.ts`. Key fields: `kind: "next-recording"`,
`formatVersion: 1`, session identity and times, producer info, timebase,
capability flags, applied limits, root/document/tab descriptor tables,
event journal reference with event count, seek index reference, audio
track metadata, and per-entry SHA-256 integrity digests.

### 3.2 index.json (SeekIndexV1)

One-second time buckets; each bucket records the last applicable event
seq, the byte offset of the next event line inside `events.ndjson`, the
nearest checkpoint per document, and the applicable topology snapshot seq.

### 3.3 Reader safety limits (plan §13)

Enforced before extraction: entry count ≤ 100,000; manifest ≤ 2 MiB;
individual checkpoint ≤ 20 MiB; total extracted non-audio ≤ 1 GiB;
per-entry decompression ratio bound; path normalization with rejection of
absolute paths, drive letters, `..` traversal, symlinks, and unsupported
entry types. Hashes verified before content reaches the player.
