// Owns session-relative time and sequence assignment (plan §8.2). The only
// module allowed to allocate event sequence numbers.
export class EventClock {
  private readonly originNs: bigint;
  private lastTUs = 0;
  private nextSeq = 0;

  constructor(private readonly nowNs: () => bigint = () => process.hrtime.bigint()) {
    this.originNs = this.nowNs();
  }

  /** Session-relative microseconds right now (no seq allocation). */
  nowUs(): number {
    return Number((this.nowNs() - this.originNs) / 1000n);
  }

  /** Allocate the next envelope stamp. tUs is clamped to be nondecreasing. */
  next(): { seq: number; tUs: number } {
    return this.nextAt(this.nowUs());
  }

  /**
   * Allocate a stamp preferring an earlier observation time (used by
   * viewport coalescing, which retains the first observation timestamp).
   * Still clamped so tUs never decreases across the stream.
   */
  nextAt(preferredTUs: number): { seq: number; tUs: number } {
    const tUs = Math.max(preferredTUs, this.lastTUs);
    this.lastTUs = tUs;
    return { seq: this.nextSeq++, tUs };
  }

  get allocatedCount(): number {
    return this.nextSeq;
  }
}
