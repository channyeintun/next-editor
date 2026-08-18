import { describe, expect, it } from "vitest";
import { assemble } from "./assembler";
import { assembleAndRun } from "./run";

/**
 * The corners where an x86 implementation is usually wrong.
 *
 * Each of these is a rule that a reasonable reading of the instruction set
 * would get backwards, and that nothing else in the suite would catch, because
 * a program written by hand rarely lands on them. Two were found here as real
 * bugs and are kept as the regression:
 *
 *   * The byte form of `div` returns its remainder in `ah` — encoding 4, which
 *     lives in register 0. Writing it as "register 0, high byte" indexes four
 *     registers *below* `rax`, which a typed array quietly discards, and the
 *     remainder simply vanished.
 *   * A 64-bit divide reads a **128-bit** dividend out of `rdx:rax`, and the
 *     mask table only knows the four real operand widths. Sign-extending it
 *     through that table produced a fault instead of a quotient.
 *
 * The rest are rules the encoding forces and a reader would not guess: `[rbp]`
 * cannot use the shortest form because `mod=00, rm=101` already means
 * rip-relative, `[r13]` inherits that because its low three bits are also 5,
 * and `[r12]` needs a SIB byte because its low three bits are 4.
 */

const wrap = (body: string) => `section .text\nglobal _start\n_start:\n${body}\n`;
const bytes = (src: string) =>
  assemble(wrap(src))
    .listing.flatMap((r) => r.bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

describe("edges", () => {
  it("$-msg with no spaces", () => {
    const p = assemble(
      `section .data\nmsg db "abc"\nlen equ $-msg\nsection .text\nglobal _start\n_start:\n ret\n`,
    );
    expect(p.symbols.get("len")).toBe(3n);
  });

  it("rbp base forces disp8", () => {
    expect(bytes("mov rax, [rbp]")).toBe("48 8b 45 00");
  });

  it("r13 base forces disp8", () => {
    expect(bytes("mov rax, [r13]")).toBe("49 8b 45 00");
  });

  it("r12 base goes through SIB", () => {
    expect(bytes("mov rax, [r12]")).toBe("49 8b 04 24");
  });

  it("rip-relative with a trailing immediate", () => {
    const p = assemble(
      `section .data\nx dq 0\nsection .text\nglobal _start\n_start:\n mov qword [rel x], 1\n ret\n`,
    );
    const row = p.listing.find((r) => r.address === p.entry)!;
    // 48 c7 05 <disp32> <imm32>: the disp is measured from the end of the
    // whole instruction, immediate included.
    const disp = new DataView(Uint8Array.from(row.bytes).buffer).getInt32(3, true);
    const next = row.address + BigInt(row.bytes.length);
    expect(next + BigInt(disp)).toBe(p.symbols.get("x"));
  });

  it("rotate by a multiple of the width leaves the value alone", () => {
    const r = assembleAndRun(
      wrap(" mov rax, 0x1234\n mov cl, 64\n rol rax, cl\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    // 64 masks to 0 for a 64-bit operand, so this is a no-op.
    expect(r.status).toBe("success");
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(0x1234n);
  });

  it("shr by a large count", () => {
    const r = assembleAndRun(
      wrap(" mov rax, -1\n mov cl, 63\n shr rax, cl\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(1n);
  });

  it("sar keeps the sign", () => {
    const r = assembleAndRun(
      wrap(" mov rax, -8\n sar rax, 2\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe((1n << 64n) - 2n);
  });

  it("adc carries in", () => {
    const r = assembleAndRun(
      wrap(
        " mov rax, -1\n add rax, 1\n mov rbx, 0\n adc rbx, 0\n mov rdi, rbx\n mov rax, 60\n syscall",
      ),
    );
    // -1 + 1 overflows unsigned, so CF is set and adc adds it.
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(1n);
  });

  it("inc leaves the carry flag alone", () => {
    const r = assembleAndRun(
      wrap(" mov rax, -1\n add rax, 1\n inc rbx\n setc dil\n mov rax, 60\n syscall"),
    );
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(1n);
  });

  it("byte division puts the remainder in ah", () => {
    // `movzx rdi, ah` would need REX.W, and REX makes that encoding mean spl —
    // so the 32-bit destination is the only way to read ah, and it
    // zero-extends into rdi for free.
    const r = assembleAndRun(
      wrap(" mov ax, 100\n mov cl, 7\n div cl\n movzx edi, ah\n mov rax, 60\n syscall"),
    );
    // 100 / 7 = 14 remainder 2
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(2n);
  });

  it("idiv truncates toward zero", () => {
    const r = assembleAndRun(
      wrap(" mov rax, -7\n cqo\n mov rcx, 2\n idiv rcx\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    // -3, not -4.
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe((1n << 64n) - 3n);
  });

  it("a read spanning a page boundary works", () => {
    const r = assembleAndRun(`section .bss
    pad resb 4090
    edge resq 1
section .text
global _start
_start:
    mov rax, 0x1122334455667788
    mov [edge], rax
    mov rdi, [edge]
    shr rdi, 56
    mov rax, 60
    syscall
`);
    expect(r.status).toBe("success");
    expect(r.registers.find((x) => x.name === "rdi")?.value).toBe(0x11n);
  });

  it("a local label before any global label is rejected, not misfiled", () => {
    expect(() => assemble("section .text\n.loop:\n ret\n")).toThrow(/no label above it/);
  });
});

/**
 * Bugs an adversarial review found, kept as the regression.
 *
 * Each of these was a real defect in a shipped-looking engine, and each is the
 * kind that a hand-written program is unlikely to walk into by accident — which
 * is exactly why they survived the first suite.
 */
describe("regressions", () => {
  it("assembles loop, which has no long form at all", () => {
    // The first layout pass assumes the widest encoding of everything so later
    // passes can only shrink. `loop` has a one-byte displacement and nothing
    // else, so applying that floor to it discarded its only encoding and made
    // every use a hard error: "a shorter jump was already ruled out".
    expect(bytes("mov rcx, 3\n.again:\n dec rdx\n loop .again")).toBe(
      "48 c7 c1 03 00 00 00 48 ff ca e2 fb",
    );
  });

  it.each([
    ["loop", "e2"],
    ["loope", "e1"],
    ["loopz", "e1"],
    ["loopne", "e0"],
    ["loopnz", "e0"],
  ])("assembles %s", (mnemonic, opcode) => {
    expect(bytes(`.again:\n ${mnemonic} .again`)).toBe(`${opcode} fe`);
  });

  it("takes a symbol defined further down the file as a byte-wide immediate", () => {
    // The placeholder a forward reference stands in for is deliberately large,
    // so the first pass reaches for the widest form. `mov al, SIZE` has no
    // wider form, so the placeholder made it fail — blaming the instruction for
    // an `equ` three lines below it that was perfectly valid.
    const program = assemble(`section .text
global _start
_start:
    mov al, SIZE
    ret
SIZE equ 7
`);
    expect(program.listing[0].bytes).toEqual([0xb0, 0x07]);
  });

  it("rejects a label defined twice instead of quietly keeping the last one", () => {
    expect(() =>
      assemble("section .text\nglobal _start\n_start:\n ret\ndup:\n nop\ndup:\n ret\n"),
    ).toThrow(/defined more than once/);
  });

  it("rejects an equ that collides with a label", () => {
    expect(() =>
      assemble("section .text\nglobal _start\n_start:\n ret\nsize:\n nop\nsize equ 4\n"),
    ).toThrow(/defined more than once/);
  });

  it("reads an instruction whose operand is spelled like a data directive", () => {
    // `db` and friends mark the word before them as a label, but only when that
    // word could be one — `inc` cannot.
    const program = assemble(`section .text
global _start
_start:
    inc rax
    ret
`);
    expect(program.listing[0].bytes).toEqual([0x48, 0xff, 0xc0]);
  });

  it("names an execute fault as an execute fault", () => {
    // A jump into unmapped memory did fail, but only because 0x00 0x00 decodes
    // to `add [rax], al` and then faulted on a data read — so it reported a bad
    // *read* to someone whose *jump* went wrong.
    const result = assembleAndRun(wrap(" mov rax, 0x900000\n jmp rax"));
    expect(result.status).toBe("runtime-error");
    expect(result.detail).toContain("tried to run the bytes at 0x900000");
  });

  it("sets rol's overflow flag from the carry, not from the second-highest bit", () => {
    // After a rotate left by one, OF is the top bit exclusive-or the carry —
    // and the carry is the bit that just wrapped around to the bottom. Using
    // ror's rule instead reported the opposite on the one count the
    // architecture defines OF for.
    const result = assembleAndRun(
      wrap(" mov rax, 0x8000000000000000\n rol rax, 1\n seto dil\n mov rax, 60\n syscall"),
    );
    expect(result.registers.find((entry) => entry.name === "rdi")?.value).toBe(1n);
  });

  it("leaves a value alone when rotated by exactly its width", () => {
    const result = assembleAndRun(
      wrap(" mov rax, 0x1234\n mov cl, 64\n rol rax, cl\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    expect(result.registers.find((entry) => entry.name === "rdi")?.value).toBe(0x1234n);
  });

  it("clears the upper half on a cmov the condition rejected", () => {
    // A 32-bit cmov zero-extends its destination whether or not the move
    // happens. This was already right, and stays covered because it reads like
    // a bug and could be "fixed" into one.
    const result = assembleAndRun(
      wrap(" mov rdi, -1\n xor rax, rax\n cmp rax, 1\n cmove edi, eax\n mov rax, 60\n syscall"),
    );
    expect(result.registers.find((entry) => entry.name === "rdi")?.value).toBe(0xffff_ffffn);
  });
});
