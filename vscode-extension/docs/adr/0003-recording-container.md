# ADR 0003: Recording container — ZIP with external integrity table

Date: 2026-07-20

Status: Accepted

## Context

The finalized `.nextrecording` artifact needs one self-contained file that
holds a manifest, a large append-only event journal, per-document
checkpoint bodies, a seek index, and (later) audio tracks — writable as a
stream during finalization and safely readable when the file is untrusted
(plan §9.5, §13.2).

## Decision

1. **ZIP container** (`yazl` writer / `yauzl` reader, independent
   dependencies): streaming write, per-entry random-access read without
   full extraction, broad tooling support for inspection, and entry-level
   compression. The event journal is copied into the archive verbatim
   (`events.ndjson`), so journal byte offsets recorded in the seek index
   remain meaningful.
2. **Integrity is content-addressed, not container-trusted**: the manifest
   carries SHA-256 digests for every entry, and `integrity.json` addition-
   ally pins the manifest's own hash. Readers verify hashes before any
   content reaches the player; ZIP CRCs are treated as transport checks
   only.
3. **Fail-closed reader**: entry-name validation (no traversal, absolute
   or drive-letter paths, duplicates, non-regular entry types), entry
   count / manifest size / checkpoint size / total-extraction /
   decompression-ratio limits, format-version rejection, and full event
   stream re-validation (schema, contiguous `seq`, nondecreasing `tUs`,
   `session.finalized` tail).
4. **Finalization order** (plan §9.5): stream to a temp path → fsync →
   reopen with the real reader and validate → atomic rename. A crash at
   any point leaves either a recoverable working session or a complete
   valid artifact, never a half-visible one.

## Alternatives considered

- **Directory-as-artifact**: no single shareable file; export and
  integrity semantics get complicated.
- **Custom binary container**: full control but loses inspectability and
  requires bespoke random-access indexing; no measured need at v1 scale
  (250k-event artifact packages and re-reads in seconds — see
  `test/artifact/scale.test.ts`).
- **tar.gz**: no per-entry random access without full decompression,
  which conflicts with lazy checkpoint reads.

## Consequences

- Audio (Phase 8) can be added as `audio/<trackId>.wav` entries with the
  same integrity scheme without a format bump.
- The decompression-ratio bound means extremely compressible legitimate
  entries (>200×) would be rejected; checkpoint text of that shape has not
  been observed, and the limit is centralized (`ARTIFACT_LIMITS`) if
  evidence ever requires tuning.
