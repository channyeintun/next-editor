import { describe, expect, it } from "vitest";
import { assembleAndRun } from "./run";

/**
 * Whole programs, run the way a learner runs them.
 *
 * Each of these is a program someone would actually write while learning
 * x86-64 — printing, looping, arithmetic that overflows, a function with a
 * stack frame, a syscall that reads. The assertions are on what the program
 * prints and what it exits with, because that is all a learner sees, and on
 * the register file, because that is what a lesson points at while explaining
 * why the printing came out the way it did.
 */

const HELLO = `
section .data
    msg     db  "Hello, x86-64!", 10
    msglen  equ $ - msg

section .text
    global _start

_start:
    mov     rax, 1          ; write
    mov     rdi, 1          ; stdout
    mov     rsi, msg
    mov     rdx, msglen
    syscall

    mov     rax, 60         ; exit
    xor     rdi, rdi
    syscall
`;

describe("running a program", () => {
  it("prints and exits", () => {
    const result = assembleAndRun(HELLO);
    expect(result.status).toBe("success");
    expect(result.stdout).toBe("Hello, x86-64!\n");
    expect(result.exitCode).toBe(0);
  });

  it("carries the exit status the program asked for", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 60
    mov rdi, 42
    syscall
`);
    expect(result.exitCode).toBe(42);
  });

  it("counts with a loop and reports the result in a register", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    xor rax, rax
    mov rcx, 10
.loop:
    add rax, rcx
    dec rcx
    jnz .loop

    mov rdi, rax
    mov rax, 60
    syscall
`);
    // 10 + 9 + … + 1
    expect(result.exitCode).toBe(55);
  });

  it("writes to stderr separately from stdout", () => {
    const result = assembleAndRun(`section .data
    out db "out", 10
    err db "err", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, out
    mov rdx, 4
    syscall

    mov rax, 1
    mov rdi, 2
    mov rsi, err
    mov rdx, 4
    syscall

    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
  });

  it("calls a function through the stack and comes back", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rdi, 6
    mov rsi, 7
    call multiply
    mov rdi, rax
    mov rax, 60
    syscall

multiply:
    push rbp
    mov rbp, rsp
    mov rax, rdi
    imul rax, rsi
    pop rbp
    ret
`);
    expect(result.exitCode).toBe(42);
  });

  it("stores into .bss and reads it back", () => {
    const result = assembleAndRun(`section .bss
    slot resq 1
section .text
global _start
_start:
    mov qword [slot], 99
    mov rdi, [slot]
    mov rax, 60
    syscall
`);
    expect(result.exitCode).toBe(99);
  });

  it("divides with the register pair the hardware uses", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 100
    xor rdx, rdx
    mov rcx, 7
    div rcx
    ; quotient 14 in rax, remainder 2 in rdx
    mov rdi, rdx
    mov rax, 60
    syscall
`);
    expect(result.exitCode).toBe(2);
  });

  it("reads from standard input", () => {
    const result = assembleAndRun(
      `section .bss
    buffer resb 32
section .text
global _start
_start:
    xor rax, rax        ; read
    xor rdi, rdi        ; stdin
    mov rsi, buffer
    mov rdx, 32
    syscall

    mov rdx, rax        ; however many bytes arrived
    mov rax, 1
    mov rdi, 1
    mov rsi, buffer
    syscall

    mov rax, 60
    xor rdi, rdi
    syscall
`,
      { stdin: "echoed\n" },
    );
    expect(result.stdout).toBe("echoed\n");
  });

  it("converts a number to text one digit at a time", () => {
    const result = assembleAndRun(`section .bss
    buffer resb 24
section .text
global _start
_start:
    mov rax, 12345
    lea rdi, [buffer+23]
    mov byte [rdi], 10
    mov rcx, 10

.next:
    dec rdi
    xor rdx, rdx
    div rcx
    add dl, '0'
    mov [rdi], dl
    test rax, rax
    jnz .next

    lea rdx, [buffer+24]
    sub rdx, rdi
    mov rsi, rdi
    mov rax, 1
    mov rdi, 1
    syscall

    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.stdout).toBe("12345\n");
  });

  it("leaves the flags a lesson can point at", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 5
    cmp rax, 5
    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.flags.zero).toBe(true);
    expect(result.flags.carry).toBe(false);
  });

  it("clears the whole 64-bit register when a 32-bit one is written", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rbx, -1
    mov ebx, 1
    mov rdi, rbx
    mov rax, 60
    syscall
`);
    // If the upper half survived, rdi would not be 1 and the exit code would
    // not be 1 either — this is the rule that makes `xor eax, eax` idiomatic.
    expect(result.exitCode).toBe(1);
  });

  it("starts every program with the same stack pointer", () => {
    // A recorded lesson pins the registers a run leaves behind, and the runner
    // reports only what the program *changed* — both of which depend on the
    // stack pointer the loader hands to _start. Pinning it here means a change
    // to the initial stack layout fails loudly instead of quietly shifting
    // every published assembly lesson's console.
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rdi, rsp
    mov rax, 60
    syscall
`);
    expect(result.registers.find((entry) => entry.name === "rsp")?.value).toBe(0x7fff_ffff_ef70n);
  });

  it("reports the registers after the run", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov r15, 0xdead
    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.registers.find((entry) => entry.name === "r15")?.value).toBe(0xdeadn);
  });
});

describe("when a program goes wrong", () => {
  it("reports an assembler error with the source line under a caret", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, nowhere
`);
    expect(result.status).toBe("assemble-error");
    expect(result.diagnostics).toContain("main.asm:4:14: error:");
    expect(result.diagnostics).toContain('"nowhere" is not defined');
    expect(result.diagnostics).toContain("^");
  });

  it("names the address a program touched that is not part of it", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, [0]
`);
    expect(result.status).toBe("runtime-error");
    expect(result.detail).toContain("which is not part of it");
  });

  it("refuses a write into the code", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov qword [_start], 0
`);
    expect(result.detail).toContain("read-only");
  });

  it("says so when the program divides by zero", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 1
    xor rdx, rdx
    xor rcx, rcx
    div rcx
`);
    expect(result.detail).toContain("divided by zero");
  });

  it("stops a loop that never ends, and says which line to look at", () => {
    const result = assembleAndRun(
      `section .text
global _start
_start:
    jmp _start
`,
      { maxInstructions: 5000 },
    );
    expect(result.status).toBe("runtime-error");
    expect(result.detail).toContain("without stopping");
  });

  it("names a system call it does not have", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 2
    syscall
`);
    expect(result.detail).toContain("system call 2");
    expect(result.detail).toContain("write (1)");
  });

  it("keeps whatever was printed before the fault", () => {
    const result = assembleAndRun(`section .data
    msg db "before", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, 7
    syscall
    mov rax, [0]
`);
    expect(result.stdout).toBe("before\n");
    expect(result.status).toBe("runtime-error");
  });
});
