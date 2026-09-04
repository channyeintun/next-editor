import { describe, expect, it } from "vitest";
import { assemble } from "./assembler";
import { decodeInstruction } from "./decoder";
import { CONDITION_CODES, formsFor } from "./isa";

/**
 * Encoder and decoder, checked against each other.
 *
 * These two read the same table from opposite ends, and the failure mode when
 * they disagree is the worst kind: the program runs, prints something, and is
 * wrong. A wrong ModRM field means an instruction that operates on a different
 * register than the source names, and nothing else in the system would notice.
 *
 * So every instruction in the corpus below is assembled, then decoded straight
 * back out of the bytes that were produced, and the decoder has to name the
 * same instruction and consume exactly as many bytes as were written. The
 * corpus is deliberately shaped to reach every addressing form — extended
 * registers, all four operand widths, SIB with and without a base, rip-relative
 * addressing, and the high-byte registers that REX forbids.
 */

const CORPUS = [
  "mov rax, rbx",
  "mov eax, ebx",
  "mov ax, bx",
  "mov al, bl",
  "mov ah, bl",
  "mov r15, r14",
  "mov r8d, r9d",
  "mov r10w, r11w",
  "mov r12b, r13b",
  "mov sil, dil",
  "mov rax, 1",
  "mov rax, -1",
  "mov rax, 0x1122334455667788",
  "mov eax, 0x12345678",
  "mov byte [rdi], 7",
  "mov word [rdi], 7",
  "mov dword [rdi], 7",
  "mov qword [rdi], 7",
  "mov [rax], rbx",
  "mov [rax+8], rbx",
  "mov [rax+1000], rbx",
  "mov [rbp], rax",
  "mov [rsp], rax",
  "mov [rsp+16], rax",
  "mov [r12], rax",
  "mov [r13], rax",
  "mov [rax+rbx], rcx",
  "mov [rax+rbx*8], rcx",
  "mov [rax+rbx*4+64], rcx",
  "mov [r8+r9*2+8], r10",
  "mov rax, [rel target]",
  "lea rax, [rbx+rcx*2+4]",
  "lea rdi, [rel target]",
  "movzx eax, byte [rsi]",
  "movzx rax, word [rsi]",
  "movsx eax, byte [rsi]",
  "movsxd rax, dword [rsi]",
  "xchg rax, rbx",
  "xchg [rbx], rax",
  "xchg rax, [rbx]",
  "test rax, [rbx]",
  // Aliases: the decoder answers with the primary name for each of these.
  "sal rax, 1",
  "jz _start",
  "jnae _start",
  "setnz al",
  "cmovz rax, rbx",
  "loopz _start",
  "add rax, rbx",
  "add rax, 1",
  "add rax, 100000",
  "add al, 5",
  "add byte [rdi], 5",
  "adc rax, rbx",
  "sub rsp, 40",
  "sbb rax, rbx",
  "and rax, 0xff",
  "or rax, rbx",
  "xor rax, rax",
  "cmp rax, rbx",
  "cmp qword [rdi], 0",
  "test rax, rax",
  "test al, 1",
  "not rax",
  "neg rax",
  "mul rbx",
  "imul rbx",
  "imul rax, rbx",
  "imul rax, rbx, 7",
  "imul rax, rbx, 1000",
  "div rbx",
  "idiv rbx",
  "inc rax",
  "dec rax",
  "inc byte [rdi]",
  "shl rax, 1",
  "shl rax, 5",
  "shl rax, cl",
  "shr rax, cl",
  "sar rax, cl",
  "rol rax, 4",
  "ror eax, 4",
  "push rbp",
  "push r12",
  "push 10",
  "push 100000",
  "push qword [rax]",
  "pop rbp",
  "pop r15",
  "ret",
  "leave",
  "nop",
  "syscall",
  "cbw",
  "cwde",
  "cdqe",
  "cwd",
  "cdq",
  "cqo",
  "sete al",
  "setne byte [rdi]",
  "setg al",
  "cmove rax, rbx",
  "cmovge rax, rbx",
  "cmovb eax, ebx",
  "jmp rax",
  "call rax",
  "call qword [rax]",
];

/** Assemble one instruction on its own, with a label the corpus can reference. */
function assembleOne(source: string): number[] {
  const program = assemble(`section .data
target dq 0
section .text
global _start
_start:
    ${source}
`);
  const row = program.listing.find((entry) => entry.address === program.entry);
  return row?.bytes ?? [];
}

describe("encode then decode", () => {
  it.each(CORPUS)("round-trips %s", (source) => {
    const bytes = assembleOne(source);
    expect(bytes.length).toBeGreaterThan(0);

    const decoded = decodeInstruction(Uint8Array.from(bytes), 0, 0x401000n);
    expect(decoded.length).toBe(bytes.length);

    // The decoder answers with the canonical mnemonic, so an alias in the
    // source (`sal`, `jz`, `setnz`) is expected to come back under its primary
    // name. The widening `movsx` is the one alias this lookup cannot resolve —
    // `movsx` is a primary name too — so it has a test of its own below.
    const canonical = formsFor(source.split(/[\s,]/)[0])[0]?.mnemonic;
    expect(decoded.mnemonic).toBe(canonical);
  });

  it("round-trips every conditional jump under every spelling", () => {
    // Driven off the table rather than a hand-written list, so the alternate
    // spellings — `jz`, `jnae`, `jpe` — are covered alongside the primaries.
    for (const { names } of CONDITION_CODES) {
      for (const condition of names) {
        const bytes = assembleOne(`j${condition} _start`);
        const decoded = decodeInstruction(Uint8Array.from(bytes), 0, 0x401000n);
        expect(decoded.mnemonic).toBe(`j${names[0]}`);
        expect(decoded.length).toBe(bytes.length);
      }
    }
  });

  it("round-trips the widening move, which the corpus lookup cannot name", () => {
    // `movsx` is a primary mnemonic of its own, so `formsFor("movsx")[0]` is not
    // the 0x63 form this line reaches; it needs saying outright.
    const bytes = assembleOne("movsx rax, dword [rsi]");
    const decoded = decodeInstruction(Uint8Array.from(bytes), 0, 0x401000n);
    expect(decoded.mnemonic).toBe("movsxd");
    expect(decoded.length).toBe(bytes.length);
  });

  it("recovers the register a jump-free opcode folded into itself", () => {
    for (const [source, index] of [
      ["push rax", 0],
      ["push rcx", 1],
      ["push rdi", 7],
      ["push r8", 8],
      ["push r15", 15],
    ] as const) {
      const decoded = decodeInstruction(Uint8Array.from(assembleOne(source)), 0, 0x401000n);
      expect(decoded.operands[0]).toMatchObject({ kind: "register", index });
    }
  });

  it("recovers a scaled index and its base", () => {
    const decoded = decodeInstruction(
      Uint8Array.from(assembleOne("mov rcx, [rax+rbx*4+64]")),
      0,
      0x401000n,
    );
    expect(decoded.operands[1]).toMatchObject({
      kind: "memory",
      base: 0,
      index: 3,
      scale: 4,
      displacement: 64n,
    });
  });

  it("keeps ah as a high-byte register when there is no REX prefix", () => {
    const decoded = decodeInstruction(Uint8Array.from(assembleOne("mov ah, bl")), 0, 0x401000n);
    expect(decoded.operands[0]).toMatchObject({ kind: "register", index: 4, high8: true });
  });

  it("reads sil as a low byte, because REX is present", () => {
    const decoded = decodeInstruction(Uint8Array.from(assembleOne("mov sil, dil")), 0, 0x401000n);
    expect(decoded.operands[0]).toMatchObject({ kind: "register", index: 6, high8: false });
  });
});
