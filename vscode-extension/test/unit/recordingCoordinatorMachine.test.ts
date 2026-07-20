import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { recordingCoordinatorMachine } from "../../src/capture/recordingCoordinatorMachine";

function startMachine() {
  const actor = createActor(recordingCoordinatorMachine);
  actor.start();
  return actor;
}

describe("recordingCoordinatorMachine", () => {
  it("owns the complete successful lifecycle and stop reason", () => {
    const actor = startMachine();
    actor.send({ type: "START", sessionId: "session-1" });
    expect(actor.getSnapshot().value).toBe("preparing");

    actor.send({
      type: "PREPARED",
      sessionId: "session-1",
      pendingOverloadBytes: null,
    });
    expect(actor.getSnapshot().value).toBe("recording");

    actor.send({
      type: "STOP",
      sessionId: "session-1",
      reason: "user",
    });
    expect(actor.getSnapshot().value).toBe("stopping");
    expect(actor.getSnapshot().context.stopReason).toBe("user");

    actor.send({ type: "DRAINED", sessionId: "session-1" });
    expect(actor.getSnapshot().value).toBe("finalizing");
    actor.send({ type: "FINALIZED", sessionId: "session-1" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.sessionId).toBeNull();
    actor.stop();
  });

  it("ignores stale completions and duplicate starts", () => {
    const actor = startMachine();
    actor.send({ type: "START", sessionId: "current" });
    actor.send({ type: "START", sessionId: "duplicate" });
    actor.send({
      type: "PREPARED",
      sessionId: "stale",
      pendingOverloadBytes: null,
    });
    expect(actor.getSnapshot().value).toBe("preparing");
    expect(actor.getSnapshot().context.sessionId).toBe("current");

    actor.send({
      type: "PREPARED",
      sessionId: "current",
      pendingOverloadBytes: 1234,
    });
    expect(actor.getSnapshot().value).toBe("recording");
    expect(actor.getSnapshot().context.pendingOverloadBytes).toBe(1234);
    actor.stop();
  });

  it("routes active failures through cleanup before returning idle", () => {
    const actor = startMachine();
    actor.send({ type: "START", sessionId: "session-1" });
    actor.send({
      type: "PREPARE_FAILED",
      sessionId: "session-1",
      message: "disk unavailable",
    });
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.failureMessage).toBe("disk unavailable");

    actor.send({ type: "CLEANED", sessionId: "session-1" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.sessionId).toBeNull();
    expect(actor.getSnapshot().context.failureMessage).toBe("disk unavailable");
    actor.stop();
  });

  it("supports crash-test abandonment without entering finalization", () => {
    const actor = startMachine();
    actor.send({ type: "START", sessionId: "session-1" });
    actor.send({
      type: "PREPARED",
      sessionId: "session-1",
      pendingOverloadBytes: null,
    });
    actor.send({ type: "ABANDON", sessionId: "session-1" });
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });
});
