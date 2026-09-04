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
const register = (result: ReturnType<typeof assembleAndRun>, name: string) =>
  result.registers.find((entry) => entry.name === name)?.value;
const rdi = (result: ReturnType<typeof assembleAndRun>) => register(result, "rdi");
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

  it("jl and jg read the sign against the overflow flag, not on their own", () => {
    // -1 < 1 is the easy half. The half an emulator gets wrong is the one where
    // the subtraction overflowed: INT_MIN - 1 leaves SF clear and OF set, and a
    // rule that only looks at the sign answers "not less".
    const easy = assembleAndRun(
      wrap(" mov rax, -1\n cmp rax, 1\n setl dil\n mov rax, 60\n syscall"),
    );
    expect(rdi(easy)).toBe(1n);

    const overflowed = assembleAndRun(
      wrap(" mov eax, 0x80000000\n cmp eax, 1\n setl dil\n mov rax, 60\n syscall"),
    );
    expect(rdi(overflowed)).toBe(1n);

    const greater = assembleAndRun(
      wrap(" mov eax, 0x7fffffff\n add eax, 1\n setg dil\n mov rax, 60\n syscall"),
    );
    // The add overflowed to a negative bit pattern, so SF and OF agree and the
    // signed answer is "greater" even though the bits say otherwise.
    expect(rdi(greater)).toBe(1n);
  });

  it("the one-operand mul answers in ax for bytes and rdx:rax for the rest", () => {
    const byte = assembleAndRun(
      wrap(" mov al, 200\n mov bl, 2\n mul bl\n movzx edi, ax\n mov rax, 60\n syscall"),
    );
    // 400 does not fit in al, so the whole product lands in ax and CF is set.
    expect(rdi(byte)).toBe(400n);

    const carry = assembleAndRun(
      wrap(" mov al, 200\n mov bl, 2\n mul bl\n setc dil\n mov rax, 60\n syscall"),
    );
    expect(rdi(carry)).toBe(1n);

    const wide = assembleAndRun(
      wrap(
        " mov rax, 0x8000000000000000\n mov rbx, 2\n mul rbx\n mov rdi, rdx\n mov rax, 60\n syscall",
      ),
    );
    expect(rdi(wide)).toBe(1n);
  });

  it("the one-operand imul keeps the sign", () => {
    const result = assembleAndRun(
      wrap(" mov al, -3\n mov bl, 5\n imul bl\n movsx rdi, ax\n mov rax, 60\n syscall"),
    );
    expect(rdi(result)).toBe((1n << 64n) - 15n);
  });

  it("neg sets the carry flag for everything but zero", () => {
    const nonZero = assembleAndRun(
      wrap(" mov rax, 3\n neg rax\n setc dil\n mov rax, 60\n syscall"),
    );
    expect(rdi(nonZero)).toBe(1n);

    const zero = assembleAndRun(wrap(" xor rax, rax\n neg rax\n setc dil\n mov rax, 60\n syscall"));
    expect(rdi(zero)).toBe(0n);
  });

  it("movsx sign-extends where movzx pads with zeros", () => {
    const signed = assembleAndRun(wrap(" mov al, -1\n movsx rdi, al\n mov rax, 60\n syscall"));
    expect(rdi(signed)).toBe((1n << 64n) - 1n);

    const zeroed = assembleAndRun(wrap(" mov al, -1\n movzx rdi, al\n mov rax, 60\n syscall"));
    expect(rdi(zeroed)).toBe(255n);
  });

  it("executes an instruction that straddles a page boundary", () => {
    // The decoder is handed a 15-byte window, which only sometimes fits in the
    // page the instruction starts on. 4090 one-byte nops put `mov rdi, 7`
    // across the seam between the first and second code pages.
    const result = assembleAndRun(
      wrap(`${" nop\n".repeat(4090)} mov rdi, 7\n mov rax, 60\n syscall`),
    );
    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(7);
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

  it("runs loop the counted number of times and lands on zero", () => {
    // The byte tests above prove the family assembles; nothing ran one, so the
    // decrement, its 64-bit mask, and where it sits relative to the branch test
    // were free to be wrong. A body that adds tells the count apart.
    const result = assembleAndRun(
      wrap(
        " xor rax, rax\n mov rcx, 5\n.again:\n add rax, 2\n loop .again\n mov rdi, rax\n mov rax, 60\n syscall",
      ),
    );
    expect(rdi(result)).toBe(10n);
    expect(register(result, "rcx")).toBe(0n);
  });

  const SCAN = (mnemonic: string, needle: number) => `section .data
    buf db 7, 7, 7, 9, 7
section .text
global _start
_start:
    mov rsi, buf
    mov rcx, 5
.scan:
    mov al, [rsi]
    inc rsi
    cmp al, ${needle}
    ${mnemonic} .scan

    mov rdi, rsi
    sub rdi, buf
    mov rax, 60
    syscall
`;

  it("loope keeps going only while the comparison keeps matching", () => {
    // The buffer is equal until its fourth byte, so the loop walks three bytes
    // and falls out on the mismatch with the counter still above zero — the
    // only shape that separates loope from plain loop.
    const result = assembleAndRun(SCAN("loope", 7));
    expect(rdi(result)).toBe(4n);
    expect(register(result, "rcx")).toBe(1n);
  });

  it("loopne keeps going only until the comparison matches", () => {
    const result = assembleAndRun(SCAN("loopne", 9));
    expect(rdi(result)).toBe(4n);
    expect(register(result, "rcx")).toBe(1n);
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
    // The 64-bit case above never reaches this rule: 64 masks to 0 and the
    // shared zero-count early exit takes it. Only an 8- or 16-bit operand keeps
    // a count equal to its own width, which is the identity the rotate code
    // special-cases rather than computes.
    const result = assembleAndRun(
      wrap(" mov al, 0x5a\n mov cl, 8\n rol al, cl\n movzx edi, al\n mov rax, 60\n syscall"),
    );
    expect(rdi(result)).toBe(0x5an);
  });

  it("wraps a rotate count past the width instead of ignoring it", () => {
    const result = assembleAndRun(
      wrap(" mov rax, 0x1234\n mov cl, 65\n rol rax, cl\n mov rdi, rax\n mov rax, 60\n syscall"),
    );
    // 65 masks to 1, so this is a rotate by one and not a no-op.
    expect(rdi(result)).toBe(0x2468n);
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
