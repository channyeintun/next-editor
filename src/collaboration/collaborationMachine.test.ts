import { createActor } from "xstate";
import { describe, expect, it } from "vite-plus/test";
import { collaborationConnectionState, collaborationMachine } from "./collaborationMachine";

const SESSION_ID = "20000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "30000000-0000-4000-8000-000000000001";

describe("collaborationMachine", () => {
  it("moves through connect, sync, live, reconnect, and leave", () => {
    const actor = createActor(collaborationMachine).start();
    actor.send({ type: "CONNECT", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("syncing");
    actor.send({ type: "SYNCED", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("live");
    actor.send({ type: "OFFLINE_CHANGES" });
    expect(actor.getSnapshot().context.hasOfflineChanges).toBe(true);
    actor.send({ type: "DISCONNECTED", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("reconnecting");
    actor.send({
      type: "RETRY",
      sessionId: SESSION_ID,
      attemptId: "30000000-0000-4000-8000-000000000002",
    });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "LEAVE" });
    expect(actor.getSnapshot()).toMatchObject({
      value: "disconnected",
      context: { sessionId: null },
    });
  });

  it("ignores late events from a replaced provider attempt", () => {
    const actor = createActor(collaborationMachine).start();
    actor.send({ type: "CONNECT", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    actor.send({ type: "DISCONNECTED", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    const nextAttempt = "30000000-0000-4000-8000-000000000002";
    actor.send({ type: "RETRY", sessionId: SESSION_ID, attemptId: nextAttempt });
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: ATTEMPT_ID });
    expect(actor.getSnapshot().value).toBe("connecting");
    actor.send({ type: "PROVIDER_OPEN", sessionId: SESSION_ID, attemptId: nextAttempt });
    expect(actor.getSnapshot().value).toBe("syncing");
  });
});

describe("collaborationConnectionState", () => {
  it("maps every machine state to itself", () => {
    const states = Object.keys(collaborationMachine.root.states);
    expect(states).toHaveLength(6);
    for (const state of states) expect(collaborationConnectionState(state)).toBe(state);
  });

  it("reads anything else as disconnected", () => {
    for (const value of ["unknown", "constructor", "toString", "", null, undefined, 3, {}]) {
      expect(collaborationConnectionState(value)).toBe("disconnected");
    }
  });
});
