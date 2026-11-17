// @vitest-environment node
// The `buffer` builtin against Node's own Buffer on the same inputs.
import { inspect } from "node:util";
import * as nodeBuffer from "node:buffer";
import { describe, expect, it } from "vitest";
import bufferModule, { Buffer, SlowBuffer, isAscii, isUtf8, transcode } from "./buffer";

const NodeBuffer = nodeBuffer.Buffer;

const ENCODINGS = [
  "utf8",
  "utf-8",
  "UTF8",
  "ucs2",
  "utf16le",
  "latin1",
  "binary",
  "ascii",
  "hex",
  "base64",
  "base64url",
] as unknown as readonly BufferEncoding[];

const SAMPLE_BYTES = [
  [],
  [0],
  [0x61, 0x62, 0x63],
  [0xe9, 0x41, 0xff, 0x80],
  [0xef, 0xbb, 0xbf, 0x68, 0x69],
  [0xf0, 0x9f, 0x98, 0x80, 0xc3],
  [0xed, 0xa0, 0x80, 0x61],
  [0xfb, 0xff, 0xbf, 0x3e, 0x3f],
  Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff),
];

const SAMPLE_STRINGS = [
  "",
  "hello",
  "héllo wörld €",
  "😀 astral",
  "\ud800 lone",
  "a b+/-_=c",
  "YWJj",
  "YWJjZA",
  "YWJjZA==",
  "abz",
  "deadBEEF",
  "zz",
  "a",
  "ÿĀ",
  "x".repeat(100),
];

function bytes(buffer: Uint8Array): number[] {
  return Array.from(buffer);
}

describe("buffer: encodings match Node", () => {
  it("toString in every encoding", () => {
    for (const sample of SAMPLE_BYTES) {
      const ours = Buffer.from(sample);
      const theirs = NodeBuffer.from(sample);
      for (const encoding of ENCODINGS) {
        expect(ours.toString(encoding), `${encoding} ${sample.join(",")}`).toBe(
          theirs.toString(encoding),
        );
        expect(ours.toString(encoding, 1, 3)).toBe(theirs.toString(encoding, 1, 3));
      }
      expect(ours.toString()).toBe(theirs.toString());
      expect(ours.toLocaleString()).toBe(theirs.toString());
    }
  });

  it("decodes a large buffer as utf8 through TextDecoder", () => {
    const text = "Zürich 😀 ".repeat(20000);
    const raw = NodeBuffer.from(text);
    raw[5] = 0xff;
    expect(Buffer.from(raw).toString()).toBe(raw.toString());
  });

  it("from, byteLength and isEncoding", () => {
    for (const string of SAMPLE_STRINGS) {
      for (const encoding of ENCODINGS) {
        expect(bytes(Buffer.from(string, encoding)), `${encoding} ${string}`).toEqual(
          bytes(NodeBuffer.from(string, encoding)),
        );
        expect(Buffer.byteLength(string, encoding)).toBe(NodeBuffer.byteLength(string, encoding));
      }
    }
    for (const name of [...ENCODINGS, "", "foo", "BASE64URL", undefined, 1]) {
      expect(Buffer.isEncoding(name as string)).toBe(NodeBuffer.isEncoding(name as string));
    }
  });

  it("write with offsets, lengths and encodings", () => {
    for (const string of SAMPLE_STRINGS) {
      for (const encoding of ENCODINGS) {
        for (const [offset, length] of [
          [0, 10],
          [2, 3],
          [1, 1],
          [5, 0],
        ]) {
          const ours = Buffer.alloc(12, 0xaa);
          const theirs = NodeBuffer.alloc(12, 0xaa);
          expect(
            ours.write(string, offset, length, encoding),
            `${encoding} ${string} ${offset} ${length}`,
          ).toBe(theirs.write(string, offset, length, encoding));
          expect(bytes(ours)).toEqual(bytes(theirs));
        }
        const ours = Buffer.alloc(7);
        const theirs = NodeBuffer.alloc(7);
        expect(ours.write(string, encoding)).toBe(theirs.write(string, encoding));
        expect(bytes(ours)).toEqual(bytes(theirs));
      }
    }
  });

  it("write and toString throw Node's errors", () => {
    const capture = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        const e = error as Error & { code?: string };
        return { name: e.name, code: e.code, message: e.message };
      }
      return null;
    };
    const ours = Buffer.alloc(4);
    const theirs = NodeBuffer.alloc(4);
    expect(capture(() => ours.toString("nope"))).toEqual(
      capture(() => theirs.toString("nope" as never)),
    );
    expect(capture(() => ours.write("a", -1))).toEqual(capture(() => theirs.write("a", -1)));
    expect(capture(() => ours.write("a", 0, 2, "nope"))).toEqual(
      capture(() => theirs.write("a", 0, 2, "nope" as never)),
    );
    expect(capture(() => ours.equals("x" as never))).toEqual(
      capture(() => theirs.equals("x" as never)),
    );
    expect(capture(() => Buffer.from("a", "nope"))).toEqual(
      capture(() => NodeBuffer.from("a", "nope" as never)),
    );
  });

  it("fill with every encoding", () => {
    for (const encoding of ENCODINGS) {
      for (const value of ["YWJj", "abcd", "é"]) {
        const ours = Buffer.alloc(9);
        const theirs = NodeBuffer.alloc(9);
        let ourError: unknown = null;
        let theirError: unknown = null;
        try {
          ours.fill(value, encoding);
        } catch (error) {
          ourError = error;
        }
        try {
          theirs.fill(value, encoding);
        } catch (error) {
          theirError = error;
        }
        expect(ourError === null, `${encoding} ${value}`).toBe(theirError === null);
        expect(ourError === null ? bytes(ours) : null).toEqual(
          theirError === null ? bytes(theirs) : null,
        );
      }
    }
    expect(bytes(Buffer.alloc(5, "YWI", "base64url"))).toEqual(
      bytes(NodeBuffer.alloc(5, "YWI", "base64url")),
    );
  });

  it("indexOf, lastIndexOf and includes", () => {
    const data = [0x61, 0x62, 0x63, 0x61, 0x62, 0x00, 0x61, 0x62, 0x63, 0x64];
    const ours = Buffer.from(data);
    const theirs = NodeBuffer.from(data);
    const needles: unknown[] = [
      "ab",
      "abc",
      "",
      "zz",
      0x61,
      0x161,
      -1,
      new Uint8Array([0x62, 0x63]),
      NodeBuffer.from("ab"),
    ];
    const offsets: unknown[] = [undefined, 0, 1, 3, -2, -100, 100, "latin1", null, Number.NaN];
    for (const needle of needles) {
      for (const offset of offsets) {
        expect(
          ours.indexOf(needle as never, offset as never),
          `${String(needle)} ${String(offset)}`,
        ).toBe(theirs.indexOf(needle as never, offset as never));
        expect(ours.lastIndexOf(needle as never, offset as never)).toBe(
          theirs.lastIndexOf(needle as never, offset as never),
        );
        expect(ours.includes(needle as never, offset as never)).toBe(
          theirs.includes(needle as never, offset as never),
        );
      }
    }
    expect(ours.indexOf("YWI", 0, "base64url")).toBe(theirs.indexOf("YWI", 0, "base64url"));
    expect(ours.indexOf("6162", 2, "hex")).toBe(theirs.indexOf("6162", 2, "hex"));
    const wide = Buffer.from("abcabc", "ucs2");
    const wideNode = NodeBuffer.from("abcabc", "ucs2");
    for (const offset of [0, 1, 3, 6, -4]) {
      expect(wide.indexOf("bc", offset, "ucs2")).toBe(wideNode.indexOf("bc", offset, "ucs2"));
      expect(wide.lastIndexOf("bc", offset, "ucs2")).toBe(
        wideNode.lastIndexOf("bc", offset, "ucs2"),
      );
    }
  });

  it("the native slice and write methods", () => {
    const sample = [0x68, 0xe9, 0x6c, 0x6c, 0x6f, 0xff, 0x00];
    const ours = Buffer.from(sample);
    const theirs = NodeBuffer.from(sample) as unknown as Record<
      string,
      (...a: unknown[]) => unknown
    >;
    for (const name of ["latin1", "utf8", "ascii", "hex", "base64", "base64url", "ucs2"]) {
      const slice = `${name}Slice`;
      const write = `${name}Write`;
      const ourMethods = ours as unknown as Record<string, (...a: unknown[]) => unknown>;
      expect(ourMethods[slice](), `${slice}`).toBe(theirs[slice]());
      expect(ourMethods[slice](1, 4)).toBe(theirs[slice](1, 4));
      const target = Buffer.alloc(6) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const nodeTarget = NodeBuffer.alloc(6) as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      const input = name === "hex" ? "a1b2c3" : name.startsWith("base64") ? "aGVsbG8" : "héllo";
      expect(target[write](input, 1), `${write}`).toBe(nodeTarget[write](input, 1));
      expect(target[write](input, 0, 3)).toBe(nodeTarget[write](input, 0, 3));
      expect(bytes(target as unknown as Uint8Array)).toEqual(
        bytes(nodeTarget as unknown as Uint8Array),
      );
    }
  });

  it("BigInt readers and writers, including the lowercase aliases", () => {
    const ours = Buffer.alloc(8);
    const theirs = NodeBuffer.alloc(8);
    ours.writeBigUint64LE(0x0102030405060708n);
    theirs.writeBigUint64LE(0x0102030405060708n);
    expect(bytes(ours)).toEqual(bytes(theirs));
    expect(ours.readBigUint64BE()).toBe(theirs.readBigUint64BE());
    ours.writeBigUint64BE(0xfffffffffffffff0n);
    theirs.writeBigUint64BE(0xfffffffffffffff0n);
    expect(ours.readBigInt64LE(0)).toBe(theirs.readBigInt64LE(0));
    expect(ours.readBigUint64LE(0)).toBe(theirs.readBigUint64LE(0));
  });

  it("equals and compare take plain Uint8Arrays", () => {
    const a = Buffer.from("abc");
    expect(a.equals(new Uint8Array([0x61, 0x62, 0x63]))).toBe(true);
    expect(a.equals(new Uint8Array([0x61]))).toBe(false);
    const cases: [number[], number[], number[]][] = [
      [[1, 2, 3], [1, 2, 4], []],
      [[1, 2, 3], [1, 2], []],
      [
        [1, 2, 3],
        [0, 2, 3],
        [1, 3, 1, 3],
      ],
      [
        [1, 2, 3],
        [9, 9],
        [0, 0, 0, 0],
      ],
      [
        [1, 2, 3],
        [9, 9],
        [0, 1, 0, 0],
      ],
    ];
    for (const [x, y, args] of cases) {
      expect(Buffer.from(x).compare(new Uint8Array(y), ...args)).toBe(
        NodeBuffer.from(x).compare(new Uint8Array(y), ...args),
      );
      expect(Buffer.compare(new Uint8Array(x), new Uint8Array(y))).toBe(
        NodeBuffer.compare(new Uint8Array(x), new Uint8Array(y)),
      );
    }
    expect(() => Buffer.compare("a" as never, a)).toThrow(/buf1/);
  });

  it("copyBytesFrom, of, poolSize", () => {
    const view = new Uint16Array([1, 2, 3, 0xffff]);
    for (const args of [[], [1], [1, 2], [5], [0, 10]] as number[][]) {
      expect(bytes(Buffer.copyBytesFrom(view, ...args))).toEqual(
        bytes(NodeBuffer.copyBytesFrom(view, ...args)),
      );
    }
    const copy = Buffer.copyBytesFrom(view);
    view[0] = 9;
    expect(copy[0]).toBe(1);
    expect(Buffer.isBuffer(copy)).toBe(true);
    expect(() => Buffer.copyBytesFrom("x" as never)).toThrow(/TypedArray/);
    const of = Buffer.of(1, 2, 300);
    expect(Buffer.isBuffer(of)).toBe(true);
    expect(bytes(of)).toEqual([1, 2, 44]);
    expect(Buffer.poolSize).toBe(8192);
  });

  it("inspects like Node", () => {
    expect(inspect(Buffer.from("hello"))).toBe(inspect(NodeBuffer.from("hello")));
    expect(inspect(Buffer.alloc(60))).toBe(inspect(NodeBuffer.alloc(60)));
    expect(inspect(Buffer.alloc(51))).toBe(inspect(NodeBuffer.alloc(51)));
    expect(inspect(Buffer.alloc(0))).toBe(inspect(NodeBuffer.alloc(0)));
    const ours = Buffer.from("ab") as Buffer & { foo?: number };
    const theirs = NodeBuffer.from("ab") as nodeBuffer.Buffer & { foo?: number };
    ours.foo = 1;
    theirs.foo = 1;
    expect(inspect(ours)).toBe(inspect(theirs));
    bufferModule.INSPECT_MAX_BYTES = 2;
    try {
      expect(inspect(Buffer.from("hello"))).toBe("<Buffer 68 65 ... 3 more bytes>");
    } finally {
      bufferModule.INSPECT_MAX_BYTES = 50;
    }
    expect(() => {
      bufferModule.INSPECT_MAX_BYTES = -1;
    }).toThrow(/INSPECT_MAX_BYTES/);
  });

  it("stays a Uint8Array subclass", () => {
    const buffer = Buffer.from("abc", "base64url");
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(Buffer.isBuffer(buffer.subarray(1))).toBe(true);
    expect(Buffer.isBuffer(Buffer.concat([buffer, new Uint8Array([1])]))).toBe(true);
  });
});

describe("buffer: module exports", () => {
  it("has Node's export names", () => {
    const required = [
      "Buffer",
      "SlowBuffer",
      "transcode",
      "isUtf8",
      "isAscii",
      "kMaxLength",
      "kStringMaxLength",
      "btoa",
      "atob",
      "constants",
      "INSPECT_MAX_BYTES",
      "Blob",
      "resolveObjectURL",
      "File",
    ];
    expect(required.filter((name) => !(name in bufferModule))).toEqual([]);
    const missing = Object.keys(nodeBuffer).filter(
      (name) => name !== "default" && name !== "isLatin1" && !(name in bufferModule),
    );
    expect(missing).toEqual([]);
  });

  it("reports Node 22's limits", () => {
    expect(bufferModule.kMaxLength).toBe(nodeBuffer.kMaxLength);
    expect(bufferModule.kStringMaxLength).toBe(nodeBuffer.kStringMaxLength);
    expect(bufferModule.constants).toEqual(nodeBuffer.constants);
  });

  it("Blob, File, atob and btoa are the platform's", () => {
    expect(bufferModule.Blob).toBe(globalThis.Blob);
    expect(bufferModule.File).toBe(globalThis.File);
    expect(bufferModule.atob("aGk=")).toBe(nodeBuffer.atob("aGk="));
    expect(bufferModule.btoa("hi")).toBe(nodeBuffer.btoa("hi"));
    expect(() => bufferModule.resolveObjectURL("blob:x")).toThrow(/resolveObjectURL/);
  });

  it("SlowBuffer allocates", () => {
    const slow = SlowBuffer(4);
    expect(slow.length).toBe(4);
    expect(Buffer.isBuffer(slow)).toBe(true);
  });

  it("isUtf8 and isAscii", () => {
    for (const sample of SAMPLE_BYTES) {
      const view = new Uint8Array(sample);
      expect(isUtf8(view)).toBe(nodeBuffer.isUtf8(view));
      expect(isAscii(view)).toBe(nodeBuffer.isAscii(view));
      expect(isUtf8(view.buffer)).toBe(nodeBuffer.isUtf8(view.buffer));
    }
    expect(() => isUtf8("x" as never)).toThrow(/input/);
  });

  it("transcode", () => {
    const pairs = [
      ["utf8", "latin1"],
      ["utf8", "ascii"],
      ["utf8", "ucs2"],
      ["ucs2", "utf8"],
      ["latin1", "utf8"],
      ["binary", "utf16le"],
    ];
    for (const text of ["héllo €", "plain", "😀x"]) {
      for (const [from, to] of pairs) {
        const source = NodeBuffer.from(text, from as never);
        expect(bytes(transcode(source, from, to)), `${text} ${from}->${to}`).toEqual(
          bytes(nodeBuffer.transcode(source, from as never, to as never)),
        );
      }
    }
    expect(() => transcode(Buffer.from("a"), "utf8", "hex")).toThrow(/Unable to transcode/);
  });
});

describe("buffer: numeric reads and writes validate like Node", () => {
  type Call = [method: string, ...args: unknown[]];
  const sizes: Record<string, number> = { 8: 1, 16: 2, 32: 4 };
  const reads: Call[] = [];
  const writes: Call[] = [];
  for (const bits of ["8", "16", "32"]) {
    for (const end of bits === "8" ? [""] : ["LE", "BE"]) {
      for (const sign of ["UInt", "Uint", "Int"]) {
        const read = `read${sign}${bits}${end}`;
        const write = `write${sign}${bits}${end}`;
        const size = sizes[bits];
        for (const offset of [undefined, 0, 1, 1.5, -1, 16 - size, 17 - size, NaN, "1", null]) {
          reads.push([read, offset]);
        }
        const max = sign === "Int" ? 2 ** (size * 8 - 1) - 1 : 2 ** (size * 8) - 1;
        const min = sign === "Int" ? -(2 ** (size * 8 - 1)) : 0;
        for (const value of [max, min, max + 1, min - 1, "7", 1.5, NaN]) {
          writes.push([write, value, 0]);
        }
        for (const offset of [undefined, 1.5, -1, 16 - size, 17 - size, "1"]) {
          writes.push([write, 1, offset]);
        }
      }
    }
  }
  for (const name of ["Float", "Double"]) {
    for (const end of ["LE", "BE"]) {
      for (const offset of [undefined, 0, 1.5, -1, 8, 13, "1"]) {
        reads.push([`read${name}${end}`, offset]);
        writes.push([`write${name}${end}`, 1.25, offset]);
      }
      writes.push([`write${name}${end}`, "x", 0]);
    }
  }
  for (const sign of ["UInt", "Int"]) {
    for (const end of ["LE", "BE"]) {
      for (const [offset, length] of [
        [0, 6],
        [10, 6],
        [11, 6],
        [0, 7],
        [0, 0],
        [0, 1.5],
        [undefined, 2],
        [0, undefined],
        [1.5, 2],
        [0, "2"],
      ] as const) {
        reads.push([`read${sign}${end}`, offset, length]);
        writes.push([`write${sign}${end}`, 5, offset, length]);
      }
      writes.push([`write${sign}${end}`, 2 ** 48, 0, 6]);
      writes.push([`write${sign}${end}`, -(2 ** 47) - 1, 0, 6]);
      writes.push([`write${sign}${end}`, 256, 0, 1]);
    }
  }
  for (const end of ["LE", "BE"]) {
    for (const offset of [undefined, 1.5, -1, 8, 9]) {
      reads.push([`readBigUInt64${end}`, offset]);
      reads.push([`readBigInt64${end}`, offset]);
      writes.push([`writeBigUInt64${end}`, 1n, offset]);
      writes.push([`writeBigInt64${end}`, 1n, offset]);
    }
    writes.push([`writeBigUInt64${end}`, -1n, 0]);
    writes.push([`writeBigInt64${end}`, 2n ** 63n, 0]);
  }

  function run(B: typeof NodeBuffer | typeof Buffer, [method, ...args]: Call) {
    const buf = (B as typeof NodeBuffer).from(Array.from({ length: 16 }, (_, i) => i * 17));
    try {
      const result = (buf as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
        ...args,
      );
      return { result, bytes: [...buf] };
    } catch (error) {
      const e = error as Error & { code?: string };
      return { name: e.name, code: e.code, message: e.message };
    }
  }

  it.each([...reads, ...writes])("%s(%o, %o, %o)", (...call) => {
    expect(run(Buffer, call as Call)).toEqual(run(NodeBuffer, call as Call));
  });

  it.each([[-1], [1.5], ["8"], [NaN], [2 ** 53]])("alloc and allocUnsafe(%o)", (size) => {
    for (const method of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
      const outcome = (B: typeof NodeBuffer | typeof Buffer) => {
        try {
          return (B as typeof NodeBuffer)[method](size as number).length;
        } catch (error) {
          const e = error as Error & { code?: string };
          return { name: e.name, code: e.code, message: e.message };
        }
      };
      expect([method, outcome(Buffer)]).toEqual([method, outcome(NodeBuffer)]);
    }
  });
});
