import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { voiceMachine, type VoiceMachineEvent } from "./machine";

const ROOM_ID = "0d5f4c72-9a3b-4c1d-8e2f-6a7b8c9d0e1f";

function startVoice(events: VoiceMachineEvent[] = []) {
  const actor = createActor(voiceMachine);
  actor.start();
  for (const event of events) actor.send(event);
  return actor;
}

const toListening: VoiceMachineEvent[] = [
  { type: "SET_AVAILABLE" },
  { type: "JOIN", roomId: ROOM_ID },
  { type: "READY" },
];

describe("voice machine lifecycle", () => {
  it("starts unavailable and becomes idle only when marked available", () => {
    const actor = startVoice();
    expect(actor.getSnapshot().value).toBe("unavailable");
    actor.send({ type: "JOIN", roomId: ROOM_ID });
    expect(actor.getSnapshot().value).toBe("unavailable");
    actor.send({ type: "SET_AVAILABLE" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("joins into listening without any microphone intent", () => {
    const actor = startVoice(toListening);
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("listening");
    expect(snapshot.context.wantsMicrophone).toBe(false);
    expect(snapshot.context.roomId).toBe(ROOM_ID);
  });

  it("reconnects when the initial transport fails before ready", () => {
    const actor = startVoice([
      { type: "SET_AVAILABLE" },
      { type: "JOIN", roomId: ROOM_ID },
      { type: "TRANSPORT_LOST" },
    ]);
    expect(actor.getSnapshot().value).toBe("reconnecting");
    expect(actor.getSnapshot().context.wantsMicrophone).toBe(false);
  });

  it("unmutes through unmuting into live and mutes back to listening", () => {
    const actor = startVoice([...toListening, { type: "UNMUTE" }]);
    expect(actor.getSnapshot().value).toBe("unmuting");
    expect(actor.getSnapshot().context.wantsMicrophone).toBe(true);
    actor.send({ type: "PUBLISHED" });
    expect(actor.getSnapshot().value).toBe("live");
    actor.send({ type: "MUTE" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("listening");
    expect(snapshot.context.wantsMicrophone).toBe(false);
  });

  it("returns to listening with an error when unmute fails, and stays joined", () => {
    const actor = startVoice([...toListening, { type: "UNMUTE" }]);
    actor.send({ type: "UNMUTE_FAILED", code: "microphone-permission-denied" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("listening");
    expect(snapshot.context.errorCode).toBe("microphone-permission-denied");
    expect(snapshot.context.wantsMicrophone).toBe(false);
    // Retry is possible: unmuting again clears the error.
    actor.send({ type: "UNMUTE" });
    expect(actor.getSnapshot().value).toBe("unmuting");
    expect(actor.getSnapshot().context.errorCode).toBeNull();
  });

  it("recovers reconnecting into live only when still publishing", () => {
    const actor = startVoice([...toListening, { type: "UNMUTE" }, { type: "PUBLISHED" }]);
    actor.send({ type: "TRANSPORT_LOST" });
    expect(actor.getSnapshot().value).toBe("reconnecting");
    actor.send({ type: "TRANSPORT_RECOVERED", publishing: true });
    expect(actor.getSnapshot().value).toBe("live");
    actor.send({ type: "TRANSPORT_LOST" });
    actor.send({ type: "MUTE" });
    expect(actor.getSnapshot().context.wantsMicrophone).toBe(false);
    actor.send({ type: "TRANSPORT_RECOVERED", publishing: false });
    expect(actor.getSnapshot().value).toBe("listening");
  });

  it("treats failure as recoverable via retry without touching room identity", () => {
    const actor = startVoice([...toListening, { type: "FAIL", code: "sfu-unavailable" }]);
    expect(actor.getSnapshot().value).toBe("failed");
    expect(actor.getSnapshot().context.errorCode).toBe("sfu-unavailable");
    actor.send({ type: "RETRY" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("joining");
    expect(snapshot.context.errorCode).toBeNull();
    expect(snapshot.context.roomId).toBe(ROOM_ID);
  });
});

describe("voice machine cleanup invariants", () => {
  const activeStates: Array<{ label: string; events: VoiceMachineEvent[] }> = [
    { label: "joining", events: [{ type: "SET_AVAILABLE" }, { type: "JOIN", roomId: ROOM_ID }] },
    { label: "listening", events: toListening },
    { label: "unmuting", events: [...toListening, { type: "UNMUTE" }] },
    { label: "live", events: [...toListening, { type: "UNMUTE" }, { type: "PUBLISHED" }] },
    { label: "reconnecting", events: [...toListening, { type: "TRANSPORT_LOST" }] },
    { label: "failed", events: [...toListening, { type: "FAIL", code: "internal" }] },
  ];

  it.each(activeStates)("LEAVE from $label reaches resource-free idle", ({ events }) => {
    const actor = startVoice(events);
    actor.send({ type: "LEAVE" });
    expect(actor.getSnapshot().value).toBe("leaving");
    actor.send({ type: "CLEANUP_DONE" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.context).toEqual({
      roomId: null,
      unavailableReason: null,
      errorCode: null,
      wantsMicrophone: false,
    });
  });

  it.each(activeStates)("losing the room from $label tears down into unavailable", ({ events }) => {
    const actor = startVoice(events);
    actor.send({ type: "SET_UNAVAILABLE", reason: "no-room" });
    expect(actor.getSnapshot().value).toBe("leaving");
    actor.send({ type: "CLEANUP_DONE" });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("unavailable");
    expect(snapshot.context.unavailableReason).toBe("no-room");
    expect(snapshot.context.roomId).toBeNull();
    expect(snapshot.context.wantsMicrophone).toBe(false);
  });

  it("ignores duplicate cleanup and duplicate leave events", () => {
    const actor = startVoice(toListening);
    actor.send({ type: "LEAVE" });
    actor.send({ type: "LEAVE" });
    actor.send({ type: "CLEANUP_DONE" });
    actor.send({ type: "CLEANUP_DONE" });
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("keeps mute intent changes during reconnect without transitioning", () => {
    const actor = startVoice([...toListening, { type: "TRANSPORT_LOST" }]);
    actor.send({ type: "UNMUTE" });
    expect(actor.getSnapshot().value).toBe("reconnecting");
    expect(actor.getSnapshot().context.wantsMicrophone).toBe(true);
  });

  it("does not join while a previous room is still cleaning up", () => {
    const actor = startVoice(toListening);
    actor.send({ type: "LEAVE" });
    actor.send({ type: "JOIN", roomId: ROOM_ID });
    expect(actor.getSnapshot().value).toBe("leaving");
    actor.send({ type: "CLEANUP_DONE" });
    expect(actor.getSnapshot().value).toBe("idle");
  });
});
