import { describe, expect, it } from "vite-plus/test";
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

  it("names the /digit a group opcode is missing, not just the opcode", () => {
    // `0xc6 /0` is `mov r/m8, imm8`; the table has no `0xc6 /1`.
    expect(() => decode(0xc6, 0x08)).toThrow(/The byte 0xc6 \/1 is not an instruction/);
    expect(decode(0xc6, 0x00, 0x05)).toMatchObject({ mnemonic: "mov", length: 3 });
  });

  it("names an implicit register from the register file", () => {
    // `cmp al, 'a'` and `sar eax, cl`: the register is named by the form, not
    // encoded in the bytes.
    expect(decode(0x3c, 0x61).operands[0]).toMatchObject({ kind: "register", index: 0, size: 1 });
    expect(decode(0xd3, 0xf8).operands[1]).toMatchObject({ kind: "register", index: 1, size: 1 });
  });
});

describe("decoding prefixes that change the instruction", () => {
  it("rejects 0x66 on the stack forms, which it would make 16-bit", () => {
    // `66 50` is `push ax` on real hardware; these all used to run as the
    // 64-bit form, moving rsp by 8 where the bytes say 2.
    expect(() => decode(0x66, 0x50)).toThrow(AsmDecodeError);
    expect(() => decode(0x66, 0x50)).toThrow(/2-byte form of 0x50/);
    expect(() => decode(0x66, 0x58)).toThrow(/2-byte form of 0x58/);
    expect(() => decode(0x66, 0x6a, 0x01)).toThrow(/2-byte form of 0x6a/);
    expect(() => decode(0x66, 0xff, 0x30)).toThrow(/2-byte form of 0xff \/6/);
    expect(() => decode(0x66, 0x8f, 0x00)).toThrow(/2-byte form of 0x8f \/0/);
    expect(() => decode(0x66, 0xc9)).toThrow(/2-byte form of 0xc9/);
  });

  it("still takes 0x66 where the width comes from the opcode alone", () => {
    expect(decode(0x66, 0x0f, 0x05)).toMatchObject({ mnemonic: "syscall", length: 3 });
    // REX.W outranks 0x66, so this is still the 64-bit `push rax`.
    expect(decode(0x66, 0x48, 0x50)).toMatchObject({ mnemonic: "push", operandSize: 8 });
  });

  it("rejects the address-size prefix instead of ignoring it", () => {
    // `67 8b 03` reads through ebx, not rbx; it used to decode as `8b 03`.
    expect(() => decode(0x67, 0x8b, 0x03)).toThrow(AsmDecodeError);
    expect(() => decode(0x67, 0x8b, 0x03)).toThrow(/address-size prefix \(0x67\)/);
  });

  it("names an unsupported prefix rather than calling it an unknown opcode", () => {
    expect(() => decode(0x64, 0x48, 0x8b, 0x00)).toThrow(/fs segment prefix \(0x64\)/);
    expect(() => decode(0xf3, 0xc3)).toThrow(/rep prefix \(0xf3\)/);
    expect(() => decode(0xf0, 0x48, 0x01, 0x00)).toThrow(/lock prefix/);
  });

  it("still skips the segment overrides 64-bit mode ignores", () => {
    expect(decode(0x2e, 0x8b, 0x03)).toMatchObject({ mnemonic: "mov", length: 3 });
    expect(decode(0x36, 0x48, 0x8b, 0x03)).toMatchObject({ mnemonic: "mov", length: 4 });
  });
});

describe("decoding bytes that stop too soon or run too long", () => {
  it("rejects an instruction cut short as a decode error, not a reader crash", () => {
    // A ModRM byte and a second opcode byte that are not there. These used to
    // escape as a bare RangeError, which the machine had to recognise by class.
    expect(() => decode(0x8b)).toThrow(AsmDecodeError);
    expect(() => decode(0x8b)).toThrow(/runs past the end of the code/);
    expect(() => decode(0x0f)).toThrow(AsmDecodeError);
    expect(() => decode(0x66, 0x48)).toThrow(/runs past the end of the code/);
  });

  it("still says an empty buffer holds no instruction", () => {
    expect(() => decode()).toThrow("There is no instruction here");
  });

  it("rejects an instruction longer than 15 bytes even when more bytes follow", () => {
    // Sixteen operand-size prefixes and a nop decoded as a 17-byte instruction.
    const bytes = [...Array.from({ length: 16 }, () => 0x66), 0x90];
    expect(() => decode(...bytes)).toThrow(AsmDecodeError);
    expect(() => decode(...bytes)).toThrow(/longer than the 15 bytes/);
    // Fourteen prefixes and a two-byte opcode is sixteen bytes, too.
    expect(() => decode(...bytes.slice(0, 14), 0x0f, 0x05)).toThrow(/longer than the 15 bytes/);
  });

  it("still decodes an instruction that is exactly 15 bytes", () => {
    expect(decode(...Array.from({ length: 14 }, () => 0x66), 0x90)).toMatchObject({
      mnemonic: "nop",
      length: 15,
    });
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

describe("a branch that cannot reach its target", () => {
  it.each(["jmp 0x100000000", "jz 0x100000000", "jmp 0x7fffffff00"])(
    "%s says how far its long form reaches, not that a short one was ruled out",
    (source) => {
      // The first layout pass rules the rel8 form out, and its exclusion used to
      // be the complaint reported: "a shorter jump was already ruled out".
      expect(assembleLine(source)).toThrow(/out of reach .* about 2 GB either way$/);
      expect(assembleLine(source)).not.toThrow(/ruled out/);
    },
  );

  it("does not promise a call a longer form it does not have", () => {
    expect(assembleLine("call 0x100000000")).toThrow(/reaches only about 2 GB either way$/);
    expect(assembleLine("call 0x100000000")).not.toThrow(/longer form/);
  });

  it("tells a loop over a long body how far loop reaches, and what to write instead", () => {
    const longLoop = `.top:\n${" nop\n".repeat(130)} loop .top`;
    expect(assembleLine(longLoop)).toThrow(
      "This target is out of reach — it is 132 bytes back, and loop reaches only 128 bytes back or 127 ahead — for a longer loop, count down with dec rcx and jnz",
    );
    expect(assembleLine(longLoop)).not.toThrow(/longer form/);
  });

  it("leaves out the dec/jnz hint for loope, which also tests ZF", () => {
    expect(assembleLine(`loope .far\n${" nop\n".repeat(130)}.far:`)).toThrow(
      /it is 130 bytes ahead, and loope reaches only 128 bytes back or 127 ahead$/,
    );
  });
});
