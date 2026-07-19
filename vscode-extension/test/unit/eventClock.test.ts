import { describe, expect, it } from "vitest";
import { EventClock } from "../../src/capture/EventClock";

describe("EventClock", () => {
  it("allocates contiguous sequence numbers", () => {
    const clock = new EventClock();
    expect(clock.next().seq).toBe(0);
    expect(clock.next().seq).toBe(1);
    expect(clock.next().seq).toBe(2);
  });

  it("produces nondecreasing timestamps", () => {
    let now = 1000n;
    const clock = new EventClock(() => now);
    const first = clock.next();
    now = 5000n;
    const second = clock.next();
    expect(second.tUs).toBeGreaterThanOrEqual(first.tUs);
  });

  it("clamps preferred earlier timestamps to remain nondecreasing", () => {
    let now = 0n;
    const clock = new EventClock(() => now);
    now = 10_000_000n; // 10ms later
    const a = clock.next();
    expect(a.tUs).toBe(10_000);
    // A coalesced event prefers an earlier observation time; it must clamp.
    const b = clock.nextAt(2_000);
    expect(b.tUs).toBe(10_000);
    expect(b.seq).toBe(a.seq + 1);
    // But an earlier preferred time with no later emission is honored.
    const clock2 = new EventClock(() => 0n);
    const c = clock2.nextAt(5_000);
    expect(c.tUs).toBe(5_000);
  });
});
