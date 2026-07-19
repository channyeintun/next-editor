import type { ContentChange, EolMode } from "../model/events";
import { LIMITS } from "../model/limits";
import { sha256Hex, utf8ByteLength } from "./hash";

export type ShadowTransactionResult =
  | {
      ok: true;
      beforeHash: string;
      afterHash: string;
      beforeVersion: number;
      afterVersion: number;
      eolBefore: EolMode;
      eolAfter: EolMode;
    }
  | {
      ok: false;
      code: "version-mismatch" | "range-out-of-bounds" | "content-mismatch";
      expectedSha256: string;
      observedSha256: string;
    };

// Per-document shadow (plan §8.4). Applies VS Code content changes in
// recorded array order using UTF-16 offsets against the evolving string —
// exactly the semantics of VS Code's mirror text model — then verifies the
// result against the observed full text.
export class DocumentShadow {
  text: string;
  version: number;
  eol: EolMode;
  sha256: string;
  transactionsSinceCheckpoint = 0;
  changedBytesSinceCheckpoint = 0;
  lastCheckpointTUs = 0;

  constructor(text: string, version: number, eol: EolMode, nowTUs: number) {
    this.text = text;
    this.version = version;
    this.eol = eol;
    this.sha256 = sha256Hex(text);
    this.lastCheckpointTUs = nowTUs;
  }

  applyTransaction(
    changes: readonly ContentChange[],
    afterVersion: number,
    observedFullText: string,
    observedEol: EolMode,
  ): ShadowTransactionResult {
    const beforeVersion = this.version;
    const beforeHash = this.sha256;
    const eolBefore = this.eol;

    const fail = (
      code: "version-mismatch" | "range-out-of-bounds" | "content-mismatch",
    ): ShadowTransactionResult => {
      const observedSha256 = sha256Hex(observedFullText);
      const expectedSha256 = this.sha256;
      // Reset to observed VS Code state after any mismatch (plan §8.4.8).
      this.text = observedFullText;
      this.version = afterVersion;
      this.eol = observedEol;
      this.sha256 = observedSha256;
      return { ok: false, code, expectedSha256, observedSha256 };
    };

    if (afterVersion <= beforeVersion) {
      return fail("version-mismatch");
    }

    let next = this.text;
    for (const change of changes) {
      const { rangeOffsetUtf16: offset, rangeLengthUtf16: length, text } = change;
      if (offset < 0 || length < 0 || offset + length > next.length) {
        return fail("range-out-of-bounds");
      }
      next = next.slice(0, offset) + text + next.slice(offset + length);
    }
    if (changes.length === 0 && observedEol !== eolBefore) {
      // An EOL-only transaction arrives with no content changes; rewrite
      // every line terminator the way VS Code does.
      next = next.replace(/\r\n|\r|\n/g, observedEol === "CRLF" ? "\r\n" : "\n");
    }

    if (next !== observedFullText) {
      return fail("content-mismatch");
    }

    this.text = next;
    this.version = afterVersion;
    this.eol = observedEol;
    this.sha256 = sha256Hex(next);
    this.transactionsSinceCheckpoint += 1;
    for (const change of changes) {
      this.changedBytesSinceCheckpoint += utf8ByteLength(change.text);
    }

    return {
      ok: true,
      beforeHash,
      afterHash: this.sha256,
      beforeVersion,
      afterVersion,
      eolBefore,
      eolAfter: this.eol,
    };
  }

  shouldCheckpoint(nowTUs: number): boolean {
    return (
      nowTUs - this.lastCheckpointTUs >= LIMITS.checkpointIntervalUs ||
      this.transactionsSinceCheckpoint >= LIMITS.checkpointMaxTransactions ||
      this.changedBytesSinceCheckpoint >= LIMITS.checkpointMaxChangedBytes
    );
  }

  markCheckpoint(nowTUs: number): void {
    this.transactionsSinceCheckpoint = 0;
    this.changedBytesSinceCheckpoint = 0;
    this.lastCheckpointTUs = nowTUs;
  }
}
