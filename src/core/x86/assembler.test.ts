import { describe, expect, it } from "vitest";
import { assemble, AsmError } from "./assembler";
import { parseIntegerLiteral, tokenize } from "./lexer";
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
    // An index with no base is exactly what SIB encodes, and a negative
    // displacement has to keep its sign through the address fold.
    ["mov rax, [rax*2]", "48 8b 04 45 00 00 00 00"],
    ["mov rax, [rbp-8]", "48 8b 45 f8"],
    // A scale multiplies the whole parenthesised sum, constant included.
    ["lea rcx, [(rax+8)*2]", "48 8d 0c 45 10 00 00 00"],
    ["lea rcx, [2*(rbx+4)]", "48 8d 0c 5d 08 00 00 00"],
    // `xchg` and `test` are symmetric, so NASM takes either operand order.
    ["xchg [rbx], rax", "48 87 03"],
    ["xchg rax, [rbx]", "48 87 03"],
    ["xchg al, [rbx]", "86 03"],
    ["xchg rax, rbx", "48 87 d8"],
    ["test [rbx], al", "84 03"],
    ["test rax, [rbx]", "48 85 03"],
    // Every radix spelling NASM has, plus the digit separator.
    ["mov rax, 1fh", "48 c7 c0 1f 00 00 00"],
    ["mov rax, 0b1010_1010", "48 c7 c0 aa 00 00 00"],
    ["mov rax, 1010b", "48 c7 c0 0a 00 00 00"],
    ["mov rax, 0o17", "48 c7 c0 0f 00 00 00"],
    ["mov rax, 17q", "48 c7 c0 0f 00 00 00"],
    ["mov rax, 1_000", "48 c7 c0 e8 03 00 00"],
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

/** The bytes a `.data` section ends up holding, for the directive tests. */
function dataOf(source: string): string {
  const program = assemble(
    `section .data\n${source}\nsection .text\nglobal _start\n_start:\n ret\n`,
  );
  const data = program.segments.find((segment) => segment.name === ".data");
  return [...(data?.bytes ?? [])].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

describe("directives and data", () => {
  it.each([
    ["dw 0x1234", "34 12"],
    ["dd 0x11223344", "44 33 22 11"],
    ["db -1", "ff"],
    ["db 0xff", "ff"],
    // `$` is the start of the line in NASM, not how far into it this item sits.
    ["msg db 'ab', $ - msg", "61 62 00"],
    ["db $ - $$, $ - $$", "00 00"],
    // The whole escape table, which nothing else in the suite reaches.
    ['db "a\\nb\\tc\\x41\\e\\0\\\\\\"\\\'"', "61 0a 62 09 63 41 1b 00 5c 22 27"],
    // Both quote styles have to agree on a character outside the BMP.
    ['db "\u{1f600}"', "f0 9f 98 80"],
    ["db '\u{1f600}'", "f0 9f 98 80"],
  ])("lays down %s", (source, expected) => {
    expect(dataOf(source)).toBe(expected);
  });

  it("pads with nop in .text and with zeroes everywhere else", () => {
    expect(bytesOf("ret\nalign 16\nret")).toBe(`c3 ${"90 ".repeat(15)}c3`.trim());
    expect(dataOf("db 1\nalign 4\ndb 2")).toBe("01 00 00 00 02");
  });

  it("resolves a data item that names a label defined further down", () => {
    const program = assemble(`section .data
    offset db msg - $$
    msg    db "hi"
section .text
global _start
_start:
    ret
`);
    const data = program.segments.find((segment) => segment.name === ".data");
    expect([...(data?.bytes ?? [])]).toEqual([0x01, 0x68, 0x69]);
  });

  it("resolves a chain of equs that each name the one below", () => {
    const program = assemble(`section .text
global _start
a equ b
b equ c
c equ 5
_start:
    mov rax, a
    ret
`);
    expect(program.symbols.get("a")).toBe(5n);
    expect(bytesOf("mov rax, 5")).toBe("48 c7 c0 05 00 00 00");
    expect(program.listing[0].bytes).toEqual([0x48, 0xc7, 0xc0, 0x05, 0x00, 0x00, 0x00]);
  });

  it("resolves an equ that aliases a label written below it", () => {
    const program = assemble(`section .text
global _start
_start:
    mov rax, exit_point
    ret
exit_point equ done
done:
    ret
`);
    expect(program.listing[0].bytes.slice(3)).toEqual([0x08, 0x10, 0x40, 0x00]);
  });

  it("emits a string longer than the argument limit of a spread", () => {
    // `bytes.push(...entry.bytes)` overflows the call stack somewhere past a
    // hundred thousand arguments, and a RangeError is not a diagnostic.
    const long = "a".repeat(200_000);
    const program = assemble(
      `section .data\n msg db "${long}"\nsection .text\nglobal _start\n_start:\n ret\n`,
    );
    const data = program.segments.find((segment) => segment.name === ".data");
    expect(data?.bytes.length).toBe(200_000);
  });

  it("keeps a whole megabyte of .bss and refuses more", () => {
    const oneMegabyte = assemble(
      `section .bss\n buffer resb 0x100000\nsection .text\nglobal _start\n_start:\n ret\n`,
    );
    expect(oneMegabyte.bssEnd - oneMegabyte.bssStart).toBe(0x100000n);
  });
});

describe("default rel", () => {
  const relative = (operand: string): string =>
    bytesOf(`default rel\n mov rax, ${operand}`).split(" ").slice(0, 3).join(" ");

  it("makes a register-free address rip-relative", () => {
    const program = assemble(`section .data
    value dq 7
section .text
default rel
global _start
_start:
    mov rax, [value]
    ret
`);
    // 48 8b 05 is `mov rax, [rip+disp32]`.
    expect(program.listing[0].bytes.slice(0, 3)).toEqual([0x48, 0x8b, 0x05]);
  });

  it.each(["[rsp+8]", "[rbx]", "[rdi+rcx*4]", "[rbp-8]"])(
    "leaves %s alone, because it names a register",
    (operand) => {
      expect(relative(operand)).not.toBe("48 8b 05");
    },
  );

  it("still rejects an explicit [rel …] that names a register", () => {
    expect(() => assemble("section .text\nglobal _start\n_start:\n mov rax, [rel rbx]\n")).toThrow(
      "rip-relative address cannot also use a register",
    );
  });
});

describe("branch relaxation", () => {
  it("accepts a loop whose body only fits rel8 once the layout has shrunk", () => {
    // Every forward `je` is laid out as its six-byte form on the first pass, so
    // the distance back to `.top` measures far more there than it does once the
    // program has settled. `loop` has no wider form to fall back on.
    const body = Array.from(
      { length: 10 },
      (_, index) => `    cmp rax, ${index}\n    je .skip${index}\n    inc rbx\n.skip${index}:`,
    ).join("\n");
    const program = assemble(`section .text
global _start
_start:
    mov rcx, 5
.top:
${body}
    loop .top
    ret
`);
    const loopRow = program.listing.find((row) => row.bytes[0] === 0xe2);
    expect(loopRow?.bytes.length).toBe(2);
  });
});

describe("integer literals", () => {
  it.each([
    ["0x1f", 31n],
    ["1fh", 31n],
    ["0b1010_1010", 170n],
    ["1010b", 10n],
    ["0o17", 15n],
    ["17q", 15n],
    ["255", 255n],
  ])("reads %s", (text, expected) => {
    expect(parseIntegerLiteral(text)).toBe(expected);
  });

  it.each(["0x", "2b", "9q", "1fg"])("rejects %s", (text) => {
    expect(parseIntegerLiteral(text)).toBeNull();
  });

  it("keeps a word's spelling, because symbol names are case-sensitive", () => {
    expect(tokenize("MOV RAX, Label").map((token) => token.value)).toEqual([
      "MOV",
      "RAX",
      ",",
      "Label",
      "",
    ]);
  });

  it.each([
    ['db "\\q"', "Unknown escape"],
    ['db "\\x4"', "two hex digits"],
  ])("rejects %s", (source, fragment) => {
    expect(() => assemble(`section .data\n ${source}\nsection .text\n_start:\n ret\n`)).toThrow(
      fragment,
    );
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

  /** Wraps a fragment in the smallest program that can carry it. */
  const inProgram = (body: string): string =>
    `section .text\nglobal _start\n_start:\n ret\n${body}\n`;

  it.each([
    ["extern puts", "extern is not available here"],
    ["section .nowhere\n nop", "Unknown section"],
    ["section .data\n buffer resb 4", "only belong in section .bss"],
    ["section .bss\n mov rax, 1", "reserved space only"],
    ["align 15\n nop", "power of two"],
    ["align 0x10000\n nop", "align boundaries above 4096"],
    ["align SIZE\nSIZE equ 16", "align needs a boundary the assembler already knows"],
    ["section .bss\n buffer resb SIZE\nSIZE equ 16", "already knows"],
    ["section .bss\n a resb 0x100000\n b resb 0x100000", "at most 1 MiB"],
    [" mov rax, [rax*rbx]", "Two registers cannot be multiplied"],
    [" mov rax, [rax+ebx]", "same width"],
    [" mov rax, [rel rbx]", "rip-relative address cannot also use a register"],
    [" mov rax, [rax+rbx+rcx]", "at most two registers"],
    [" mov rax, 1/0", "Division by zero"],
    ["section .data\n x db 300", "does not fit in a byte"],
    ["section .data\n x dw 70000", "does not fit in a word"],
    ["a equ a\n mov rax, a", '"a" is defined in terms of itself'],
    ["a equ b\nb equ a\n mov rax, a", "defined in terms of itself"],
    // Each equ squares the one above it, so a handful of lines is enough to
    // build a number no engine should be asked to hold.
    ["a0 equ 0x10000\na1 equ a0*a0\na2 equ a1*a1\na3 equ a2*a2", "far too large"],
  ])("rejects %s", (body, fragment) => {
    expect(failing(inProgram(body)).message).toContain(fragment);
  });

  it("rejects a label that is defined twice", () => {
    expect(failing(inProgram("here:\n ret\nhere:\n ret")).message).toContain(
      "is defined more than once",
    );
  });
});
