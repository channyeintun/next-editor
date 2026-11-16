// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CookieJar, defaultCookiePath, parseSetCookie, pathMatches } from "./cookieJar";

describe("cookie jar", () => {
  it("parses attributes, preferring Max-Age over Expires", () => {
    expect(
      parseSetCookie(
        "a=1; Path=/x; Max-Age=10; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly",
        0,
      ),
    ).toEqual({ name: "a", value: "1", path: "/x", expires: 10_000, domain: null, httpOnly: true });
    expect(parseSetCookie("nope", 0)).toBeNull();
    expect(parseSetCookie("a=1; Path=relative", 0)?.path).toBeNull();
  });

  it("derives the default path and matches paths like RFC 6265", () => {
    expect(defaultCookiePath("/a/b/c")).toBe("/a/b");
    expect(defaultCookiePath("/a")).toBe("/");
    expect(pathMatches("/api/x", "/api")).toBe(true);
    expect(pathMatches("/apix", "/api")).toBe(false);
    expect(pathMatches("/api/", "/api/")).toBe(true);
  });

  it("stores, replaces, expires and deletes cookies", () => {
    const jar = new CookieJar("app.localhost");
    jar.store(["a=1; Path=/", "b=2; Max-Age=5", "c=3; Domain=other.test"], "/x/y", 0);
    expect(jar.header("/x/z", 1000)).toBe("b=2; a=1");
    expect(jar.header("/", 1000)).toBe("a=1");
    expect(jar.header("/x/z", 6000)).toBe("a=1");
    jar.store(["a=9; Path=/"], "/", 6000);
    expect(jar.header("/", 6000)).toBe("a=9");
    jar.store(["a=; Path=/; Max-Age=0"], "/", 7000);
    expect(jar.header("/", 7000)).toBeNull();
  });

  it("accepts a Domain the host belongs to", () => {
    const jar = new CookieJar("k3-3000.preview.test");
    jar.store(["a=1; Domain=.preview.test; Path=/"], "/", 0);
    expect(jar.header("/", 0)).toBe("a=1");
  });
});
