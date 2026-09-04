import { describe, expect, it } from "vitest";
import { assemble } from "./assembler";
import { AsmDecodeError, decodeInstruction } from "./decoder";

/**
 * Regressions for the ways the encoder and decoder used to disagree with the
 * machine.
 *
 * Every case here was once accepted or decoded quietly and wrongly: bytes that
 * addressed somewhere else than the source said, or an opcode executed at a
 * width no form in the table declares. A wrong byte is worse than a rejected
 * line, because the program still runs.
 */

const wrap = (body: string) => `section .text\nglobal _start\n_start:\n${body}\n`;

const bytesOf = (source: string) =>
  assemble(wrap(source))
    .listing.flatMap((row) => row.bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");

const assembleLine = (source: string) => () => assemble(wrap(source));

const decode = (...bytes: number[]) => decodeInstruction(new Uint8Array(bytes), 0, 0n);

describe("displacements the machine sign-extends", () => {
  it("rejects a bare absolute address above the signed 32-bit range", () => {
    // `48 8b 04 25 00 00 00 80` reads 0xffffffff80000000, not 0x80000000.
    expect(assembleLine("mov rax, [0x80000000]")).toThrow(/signed 32-bit/);
    expect(assembleLine("mov qword [0xC0000000], rax")).toThrow(/signed 32-bit/);
  });

  it("still takes an absolute address the disp32 can name", () => {
    expect(bytesOf("mov rax, [0x401000]")).toBe("48 8b 04 25 00 10 40 00");
    expect(bytesOf("mov rax, [0x7fffffff]")).toBe("48 8b 04 25 ff ff ff 7f");
  });

  it("round-trips a bare absolute address through the decoder", () => {
    const decoded = decode(0x48, 0x8b, 0x04, 0x25, 0x00, 0x10, 0x40, 0x00);
    expect(decoded.operands[1]).toMatchObject({
      kind: "memory",
      base: null,
      index: null,
      displacement: 0x401000n,
    });
  });

  it("rejects an out-of-range displacement on an index with no base", () => {
    // These used to assemble to `[rbx*2+0]` and `[rbx*2-0x80000000]`.
    expect(assembleLine("mov rax, [rbx*2+0x100000000]")).toThrow(/signed 32-bit/);
    expect(assembleLine("mov rax, [rbx*2+0x80000000]")).toThrow(/signed 32-bit/);
  });

  it("still takes an index with no base and a displacement in range", () => {
    expect(bytesOf("mov rax, [rbx*2+0x10]")).toBe("48 8b 04 5d 10 00 00 00");
  });

  it("rejects rsp in the index slot when the parser's swap cannot help", () => {
    expect(assembleLine("mov rax, [rsp+rsp]")).toThrow(/rsp cannot be a scaled index/);
  });
});

describe("decoding bytes no form in the table claims", () => {
  it("rejects 0x63 without REX.W instead of running the 64-bit form", () => {
    // Real hardware reads this as `movsxd ebx, eax`, a 32-bit move.
    expect(() => decode(0x63, 0xd8)).toThrow(AsmDecodeError);
    expect(() => decode(0x63, 0xd8)).toThrow(/4-byte form of 0x63/);
  });

  it("rejects a 16-bit movzx rather than executing the 32-bit one", () => {
    expect(() => decode(0x66, 0x0f, 0xb7, 0xc0)).toThrow(/2-byte form of 0xf 0xb7/);
  });

  it("still decodes the forms that do exist", () => {
    expect(decode(0x48, 0x63, 0xd8)).toMatchObject({ mnemonic: "movsxd", length: 3 });
    expect(decode(0x0f, 0xb7, 0xc0)).toMatchObject({ mnemonic: "movzx", length: 3 });
  });

  it("names an implicit register from the register file", () => {
    // `cmp al, 'a'` and `sar eax, cl`: the register is named by the form, not
    // encoded in the bytes.
    expect(decode(0x3c, 0x61).operands[0]).toMatchObject({ kind: "register", index: 0, size: 1 });
    expect(decode(0xd3, 0xf8).operands[1]).toMatchObject({ kind: "register", index: 1, size: 1 });
  });
});

describe("a size keyword written on the immediate", () => {
  it.each([
    ["mov [rax], byte 1", "c6 00 01"],
    ["mov [rax], dword 1", "c7 00 01 00 00 00"],
    ["mov [rax], word 1", "66 c7 00 01 00"],
    ["cmp [rax], byte 1", "80 38 01"],
    ["add [rdi], dword 5", "83 07 05"],
  ])("%s assembles like the same width written before the bracket", (source, expected) => {
    expect(bytesOf(source)).toBe(expected);
  });

  it("leaves a statement with no memory operand alone", () => {
    // NASM shrinks a plain `dword 1` to the imm8 form too; only `strict` would
    // hold the long one, and this assembler has no `strict`.
    expect(bytesOf("add rax, dword 1")).toBe("48 83 c0 01");
    expect(bytesOf("push dword 3")).toBe("6a 03");
  });

  it("still asks for a width when nothing states one", () => {
    expect(assembleLine("mov [rax], 1")).toThrow(/size of this memory access is not stated/);
  });
});

describe("the did-you-mean suggestion", () => {
  it.each([
    ["mvo rax, 1", "mov"],
    ["psh rax", "push"],
    ["see al", "sete"],
    ["cmp1 rax, 1", "cmp"],
    ["jnz1 _start", "jnz"],
    ["lae rax, [rbx]", "lea"],
  ])("%s suggests the nearest mnemonic", (source, expected) => {
    expect(assembleLine(source)).toThrow(`did you mean ${expected}?`);
  });

  it("says nothing when nothing is close", () => {
    expect(assembleLine("printf rax")).toThrow(/is not an instruction this runner knows$/);
  });
});

describe("encoding choices that have to stay stable", () => {
  it("breaks a tie between equal-length forms toward the one isa.ts declares first", () => {
    // `48 8b c3` is the same three bytes; NASM emits the MR form and so do we.
    expect(bytesOf("mov rax, rbx")).toBe("48 89 d8");
    expect(bytesOf("xor eax, eax")).toBe("31 c0");
  });

  it("still emits REX for the registers that are unreachable without it", () => {
    expect(bytesOf("mov sil, 65")).toBe("40 b6 41");
    expect(bytesOf("mov spl, dil")).toBe("40 88 fc");
    expect(bytesOf("push r12")).toBe("41 54");
  });
});
