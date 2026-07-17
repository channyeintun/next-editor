import { describe, expect, it } from "vitest";
import { collaborationRoomLocationHintFromCf } from "./roomLocation";

describe("collaboration room placement", () => {
  it.each([
    [{ continent: "NA", longitude: "-122.4" }, "wnam"],
    [{ continent: "NA", longitude: "-73.9" }, "enam"],
    [{ continent: "SA", longitude: "-46.6" }, "sam"],
    [{ continent: "EU", longitude: "-0.1" }, "weur"],
    [{ continent: "EU", longitude: "30.5" }, "eeur"],
    [{ continent: "AS", latitude: "35.7", longitude: "139.7" }, "apac-ne"],
    [{ continent: "AS", latitude: "1.3", longitude: "103.8" }, "apac-se"],
    [{ continent: "AS", latitude: "25.2", longitude: "55.3" }, "me"],
    [{ continent: "AS", latitude: "28.6", longitude: "77.2" }, "apac"],
    [{ continent: "OC", longitude: "151.2" }, "oc"],
    [{ continent: "AF", longitude: "18.4" }, "afr"],
  ] as const)("maps %o near %s", (cf, expected) => {
    expect(collaborationRoomLocationHintFromCf(cf)).toBe(expected);
  });

  it("leaves an unknown edge location to Cloudflare's default placement", () => {
    expect(collaborationRoomLocationHintFromCf(undefined)).toBeUndefined();
    expect(collaborationRoomLocationHintFromCf({ continent: "AN" })).toBeUndefined();
  });
});
