import { describe, expect, it } from "vitest";
import { canRecordInLiveRoom, liveRoomEndBlockReason } from "./recordingPolicy";

describe("live collaboration recording policy", () => {
  it("allows standalone recording and host recording, but never participant recording", () => {
    expect(canRecordInLiveRoom(true, false, false)).toBe(true);
    expect(canRecordInLiveRoom(true, true, true)).toBe(true);
    expect(canRecordInLiveRoom(true, true, false)).toBe(false);
    expect(canRecordInLiveRoom(false, true, true)).toBe(false);
  });

  it("requires recording finalization and accepted updates before live can end", () => {
    expect(liveRoomEndBlockReason(true, false)).toContain("finalize");
    expect(liveRoomEndBlockReason(false, true)).toContain("synchronize");
    expect(liveRoomEndBlockReason(false, false)).toBeNull();
  });
});
