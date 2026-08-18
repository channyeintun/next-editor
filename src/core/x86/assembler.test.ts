import { describe, expect, it } from "vitest";
import { assemble, AsmError } from "./assembler";
import { formatListing } from "./run";

/**
 * Encoding fidelity. Every expectation here is the byte sequence NASM produces
 * for the same line, which is the only standard that matters: a lesson that
 * shows `48 83 c0 01` beside `add rax, 1` is teaching a fact about the machine,
 * and a byte out of place makes it a lie.
 */

function bytesOf(source: string): string {
  const program = assemble(`section .text\nglobal _start\n_start:\n${source}\n`);
  return program.listing
    .flatMap((row) => row.bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

describe("instruction encoding", () => {
  it.each([
    ["mov rax, 1", "48 c7 c0 01 00 00 00"],
    ["mov eax, 1", "b8 01 00 00 00"],
    ["mov al, 65", "b0 41"],
    ["mov rax, 0x123456789", "48 b8 89 67 45 23 01 00 00 00"],
    ["mov r8, r9", "4d 89 c8"],
    ["mov rbp, rsp", "48 89 e5"],
    ["mov al, [rbx]", "8a 03"],
    ["mov [rsp+8], rax", "48 89 44 24 08"],
    ["mov byte [rdi], 65", "c6 07 41"],
    ["xor rdi, rdi", "48 31 ff"],
    ["xor eax, eax", "31 c0"],
    ["add rax, 1", "48 83 c0 01"],
    ["add rax, 1000", "48 05 e8 03 00 00"],
    ["sub rsp, 32", "48 83 ec 20"],
    ["cmp al, 'a'", "3c 61"],
    ["test rax, rax", "48 85 c0"],
    ["inc rcx", "48 ff c1"],
    ["dec qword [rbx]", "48 ff 0b"],
    ["neg rax", "48 f7 d8"],
    ["not rdx", "48 f7 d2"],
    ["imul rax, rbx", "48 0f af c3"],
    ["imul rax, rbx, 10", "48 6b c3 0a"],
    // NASM shorthand: no two-operand multiply by an immediate exists, so this
    // is the three-operand form with the destination written twice.
    ["imul rax, 7", "48 6b c0 07"],
    ["shl rax, 3", "48 c1 e0 03"],
    ["shr rax, 1", "48 d1 e8"],
    ["sar eax, cl", "d3 f8"],
    ["lea rax, [rbx+rcx*4+16]", "48 8d 44 8b 10"],
    ["lea rdi, [rsp]", "48 8d 3c 24"],
    ["movzx eax, byte [rsi]", "0f b6 06"],
    ["movsx rax, byte [rsi]", "48 0f be 06"],
    ["push rbp", "55"],
    ["push r12", "41 54"],
    ["pop rbp", "5d"],
    ["ret", "c3"],
    ["leave", "c9"],
    ["syscall", "0f 05"],
    ["nop", "90"],
    ["cqo", "48 99"],
    ["cdq", "99"],
    ["sete al", "0f 94 c0"],
    ["cmovge rax, rbx", "48 0f 4d c3"],
    ["idiv rcx", "48 f7 f9"],
    ["div ecx", "f7 f1"],
    ["mov ax, 1", "66 b8 01 00"],
  ])("assembles %s", (source, expected) => {
    expect(bytesOf(source)).toBe(expected);
  });

  it("picks the short jump when the target is close", () => {
    const program = assemble(`section .text
global _start
_start:
    xor rax, rax
.loop:
    inc rax
    cmp rax, 10
    jne .loop
    ret
`);
    const bytes = program.listing.flatMap((row) => row.bytes);
    // jne .loop as a two-byte form: 0x75 then a negative displacement.
    expect(bytes).toContain(0x75);
    expect(bytes).not.toContain(0x0f);
  });

  it("widens a jump that cannot reach in one byte", () => {
    const filler = Array.from({ length: 100 }, () => "    add rax, 1000").join("\n");
    const program = assemble(`section .text
global _start
_start:
    jne far
${filler}
far:
    ret
`);
    const first = program.listing[0];
    // 0x0f 0x85 is the long form of jne.
    expect(first.bytes.slice(0, 2)).toEqual([0x0f, 0x85]);
  });

  it("resolves a forward reference to a label", () => {
    const program = assemble(`section .text
global _start
_start:
    jmp done
    nop
done:
    ret
`);
    const [jump] = program.listing;
    expect(jump.bytes[0]).toBe(0xeb);
    // Past the one-byte nop.
    expect(jump.bytes[1]).toBe(0x01);
  });

  it("places sections on their own pages, .text first", () => {
    const program = assemble(`section .data
    value dq 7
section .text
global _start
_start:
    ret
`);
    // .text always leads, whatever order the source declares. .rodata is empty
    // here and so occupies no page of its own, which is why .data lands on the
    // page right after .text rather than two pages along.
    expect(program.entry).toBe(0x401000n);
    expect(program.symbols.get("value")).toBe(0x402000n);
  });

  it("gives .rodata and .data separate pages when both hold something", () => {
    const program = assemble(`section .rodata
    fixed dq 1
section .data
    counter dq 0
section .text
global _start
_start:
    ret
`);
    expect(program.symbols.get("fixed")).toBe(0x402000n);
    expect(program.symbols.get("counter")).toBe(0x403000n);
  });

  it("computes $ - label for a string's length", () => {
    const program = assemble(`section .data
    msg    db "hello", 10
    msglen equ $ - msg
section .text
global _start
_start:
    ret
`);
    expect(program.symbols.get("msglen")).toBe(6n);
  });

  it("hangs local labels off the label above them", () => {
    const program = assemble(`section .text
global _start
_start:
.loop:
    ret
other:
.loop:
    ret
`);
    expect(program.symbols.has("_start.loop")).toBe(true);
    expect(program.symbols.has("other.loop")).toBe(true);
  });

  it("keeps db strings and numbers in one run of bytes", () => {
    const program = assemble(`section .data
    msg db "hi", 10, 0
section .text
global _start
_start:
    ret
`);
    const data = program.segments.find((segment) => segment.name === ".data");
    expect([...(data?.bytes ?? [])]).toEqual([0x68, 0x69, 0x0a, 0x00]);
  });

  it("reserves .bss space without storing bytes for it", () => {
    const program = assemble(`section .bss
    buffer resb 64
section .text
global _start
_start:
    ret
`);
    expect(program.bssEnd - program.bssStart).toBe(64n);
    expect(program.segments.some((segment) => segment.name === ".bss")).toBe(false);
  });

  it("renders a listing beside the source", () => {
    const source = `section .text
global _start
_start:
    ret
`;
    expect(formatListing(assemble(source), source)).toContain("00401000  c3");
  });
});

describe("assembler diagnostics", () => {
  const failing = (source: string): AsmError => {
    try {
      assemble(source);
    } catch (cause) {
      return cause as AsmError;
    }
    throw new Error("expected the assembler to reject this");
  };

  it("rejects an undefined symbol", () => {
    expect(failing("section .text\nglobal _start\n_start:\n jmp nowhere\n").message).toContain(
      '"nowhere" is not defined',
    );
  });

  it("rejects an unknown mnemonic", () => {
    expect(failing("section .text\nglobal _start\n_start:\n mvo rax, 1\n").message).toContain(
      "not an instruction",
    );
  });

  it("rejects a memory store with no stated size", () => {
    expect(failing("section .text\nglobal _start\n_start:\n mov [rax], 1\n").message).toContain(
      "size of this memory access is not stated",
    );
  });

  it("rejects mismatched register widths", () => {
    expect(failing("section .text\nglobal _start\n_start:\n mov rax, ebx\n").message).toContain(
      "cannot be used with these operands",
    );
  });

  it("rejects ah beside a register that needs REX", () => {
    expect(failing("section .text\nglobal _start\n_start:\n mov ah, r8b\n").message).toContain(
      "ah, ch, dh and bh",
    );
  });

  it("rejects rsp as a scaled index", () => {
    expect(
      failing("section .text\nglobal _start\n_start:\n mov rax, [rbx+rsp*2]\n").message,
    ).toContain("rsp cannot be a scaled index");
  });

  it("rejects a program with no _start", () => {
    expect(failing("section .text\n nop\n").message).toContain("_start");
  });

  it("names the line and column", () => {
    const error = failing("section .text\nglobal _start\n_start:\n    jmp nowhere\n");
    expect(error.line).toBe(4);
    expect(error.column).toBe(9);
  });
});
