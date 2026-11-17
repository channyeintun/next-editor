// @vitest-environment node
// One rule for which names are this machine, shared by dns, net and http.
import { describe, expect, it } from "vitest";
import { isLocalHost } from "./ip";

describe("isLocalHost", () => {
  it("treats *.localhost as loopback, as dns.lookup does", () => {
    expect(isLocalHost("api.localhost")).toBe(true);
    expect(isLocalHost("API.Localhost.")).toBe(true);
    expect(isLocalHost("a.b.localhost")).toBe(true);
  });

  it("does not treat look-alike names as loopback", () => {
    expect(isLocalHost("localhost.example.com")).toBe(false);
    expect(isLocalHost("notlocalhost")).toBe(false);
    expect(isLocalHost("example.com")).toBe(false);
  });
});
