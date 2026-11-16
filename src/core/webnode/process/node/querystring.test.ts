// @vitest-environment node
// Differential tests: querystring against Node's own `querystring`.
import nodeQuerystring from "node:querystring";
import { describe, expect, it } from "vitest";
import querystring from "./querystring";

/** Node's querystring with `unescapeBuffer`, which it has but @types/node omits. */
const nodeQs = nodeQuerystring as typeof nodeQuerystring & {
  unescapeBuffer(value: string, decodeSpaces?: boolean): Uint8Array;
};

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const queries = [
  "",
  "a",
  "a=",
  "=b",
  "=",
  "&",
  "&&",
  "a=b",
  "a=b&c=d",
  "a=1&a=2&a=3",
  "a=1&b=2&a=3",
  "a=b=c",
  "a==b",
  "a&b&c",
  "&a=1&",
  "a=%20b",
  "a+b=c+d",
  "%61=%62",
  "a=%zz",
  "a=%",
  "a=%2",
  "a=%e2%82%ac",
  "a=%E2%82",
  "a=%C3%A9&%C3%A9=x",
  "%%%=%%%",
  "a=%F0%9F%98%80",
  "__proto__=1",
  "constructor=2&toString=3",
  "hasOwnProperty=x",
  "foo=bar&baz=qux&baz=quux&corge=",
  "a[]=1&a[]=2",
  "a.b=c",
  "q=node.js+%26+deno",
  "x=1;y=2",
  "a=b#c",
  "ü=ö",
  "a=é",
  "space%20key=value",
  "a=%41%42%43",
  "+++=+++",
  "a=b&&c=d",
];

const objects: Record<string, unknown>[] = [
  {},
  { a: "b" },
  { a: "b", c: "d" },
  { a: ["1", "2"] },
  { a: [] },
  { a: [], b: "c" },
  { a: "" },
  { "": "" },
  { a: 1, b: true, c: false, d: null, e: undefined, f: 12n },
  { a: NaN, b: Infinity, c: -Infinity, d: 1e21, e: -1e21, f: 1.5 },
  { a: { nested: 1 } },
  { a: () => 1 },
  { "a b": "c d" },
  { "!'()*-._~": "!'()*-._~" },
  { emoji: "😀", accent: "é", euro: "€", ascii: "~`!@#$%^&*()_+-={}[]|:;\"'<>,.?/" },
  { a: ["x", 1, true, null] },
  { "\u0000": "\u007f" },
];

describe("querystring matches Node", () => {
  it.each(queries)("parse(%j)", (input) => {
    expect(plain(querystring.parse(input))).toEqual(plain(nodeQs.parse(input)));
    expect(plain(querystring.decode(input))).toEqual(plain(nodeQs.decode(input)));
  });

  it.each(queries)("parse(%j) with custom separators and options", (input) => {
    const custom = input.replace(/&/g, ";;").replace(/=/g, ":");
    expect(plain(querystring.parse(custom, ";;", ":"))).toEqual(
      plain(nodeQs.parse(custom, ";;", ":")),
    );
    expect(plain(querystring.parse(input, "&", "=", { maxKeys: 1 }))).toEqual(
      plain(nodeQs.parse(input, "&", "=", { maxKeys: 1 })),
    );
    expect(plain(querystring.parse(input, "&", "=", { maxKeys: 0 }))).toEqual(
      plain(nodeQs.parse(input, "&", "=", { maxKeys: 0 })),
    );
    const decode = (value: string) => `<${value}>`;
    expect(plain(querystring.parse(input, null, null, { decodeURIComponent: decode }))).toEqual(
      plain(nodeQs.parse(input, undefined, undefined, { decodeURIComponent: decode })),
    );
    const throwing = () => {
      throw new Error("nope");
    };
    expect(plain(querystring.parse(input, null, null, { decodeURIComponent: throwing }))).toEqual(
      plain(nodeQs.parse(input, undefined, undefined, { decodeURIComponent: throwing })),
    );
  });

  it("parses with a null prototype and limits keys to 1000 by default", () => {
    const parsed = querystring.parse("a=1");
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    const many = Array.from({ length: 1500 }, (_, i) => `k${i}=${i}`).join("&");
    expect(Object.keys(querystring.parse(many))).toHaveLength(1000);
    expect(Object.keys(querystring.parse(many, null, null, { maxKeys: -1 }))).toHaveLength(1500);
  });

  it("ignores non-string input", () => {
    for (const input of [undefined, null, 1, {}, []]) {
      expect(plain(querystring.parse(input as string))).toEqual(
        plain(nodeQs.parse(input as string)),
      );
    }
  });

  it.each(objects)("stringify(%o)", (object) => {
    expect(querystring.stringify(object as never)).toBe(nodeQs.stringify(object as never));
    expect(querystring.encode(object as never)).toBe(nodeQs.encode(object as never));
    expect(querystring.stringify(object as never, ";", ":")).toBe(
      nodeQs.stringify(object as never, ";", ":"),
    );
    const encodeURIComponent = (value: string) => value.toUpperCase();
    expect(querystring.stringify(object as never, "&", "=", { encodeURIComponent })).toBe(
      nodeQs.stringify(object as never, "&", "=", { encodeURIComponent }),
    );
  });

  it("stringifies non-objects to an empty string", () => {
    for (const value of [undefined, null, "a=b", 1, true]) {
      expect(querystring.stringify(value as never)).toBe(nodeQs.stringify(value as never));
    }
  });

  it("escapes as Node does", () => {
    const values: unknown[] = [
      "",
      "abc",
      "a b&c=d",
      "é€😀",
      "!'()*-._~",
      5,
      true,
      null,
      undefined,
      { toString: () => "obj value" },
      ["a", "b"],
    ];
    for (const value of values) {
      expect(querystring.escape(value as string)).toBe(nodeQs.escape(value as string));
    }
  });

  it("throws ERR_INVALID_URI for a lone surrogate", () => {
    for (const bad of ["\ud800", "a\ud83d"]) {
      let theirs: { code?: string; name?: string; message?: string } = {};
      try {
        nodeQs.escape(bad);
      } catch (error) {
        theirs = error as typeof theirs;
      }
      expect(() => querystring.escape(bad)).toThrow(
        expect.objectContaining({ code: theirs.code, name: theirs.name, message: theirs.message }),
      );
      expect(() => querystring.stringify({ a: bad })).toThrow(URIError);
    }
  });

  it("unescapes as Node does", () => {
    const values = ["", "abc", "a%20b", "a+b", "%E2%82%AC", "%zz", "%", "%e2%82", "%41%4", "a%2"];
    for (const value of values) {
      expect(querystring.unescape(value)).toBe(nodeQs.unescape(value));
      expect(querystring.unescape(value, true)).toBe(nodeQs.unescape(value));
      expect([...querystring.unescapeBuffer(value)]).toEqual([...nodeQs.unescapeBuffer(value)]);
      expect([...querystring.unescapeBuffer(value, true)]).toEqual([
        ...nodeQs.unescapeBuffer(value, true),
      ]);
    }
  });

  it("uses a replaced unescape for parsing, as Node does", () => {
    const original = querystring.unescape;
    querystring.unescape = (value: string) => `[${value}]`;
    try {
      expect(plain(querystring.parse("a=b"))).toEqual({ "[a]": "[b]" });
    } finally {
      querystring.unescape = original;
    }
  });

  it("has Node's exports", () => {
    expect(Object.keys(querystring).sort()).toEqual(Object.keys(nodeQs).sort());
  });
});
