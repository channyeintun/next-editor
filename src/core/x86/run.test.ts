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

  it("grows the heap with brk and stores through the new pointer", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 12         ; brk(0) answers with the current break
    xor rdi, rdi
    syscall
    mov rbx, rax

    lea rdi, [rbx + 4096]
    mov rax, 12
    syscall

    mov qword [rbx], 99
    mov rdi, [rbx]
    mov rax, 60
    syscall
`);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(99);
  });

  it("answers getpid with the same number every time", () => {
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 39
    syscall
    mov rdi, rax
    mov rax, 60
    syscall
`);
    expect(result.exitCode).toBe(1);
  });

  it("hands back -EBADF for a file descriptor it does not have", () => {
    const result = assembleAndRun(`section .data
    msg db "x", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 5          ; not stdin, stdout or stderr
    mov rsi, msg
    mov rdx, 2
    syscall
    mov rdi, rax
    mov rax, 60
    syscall
`);
    // -9 truncated to the low byte of an exit status.
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(247);
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

  it("stops a loop that never ends, and says what to check", () => {
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

  it("says the program ran past its last instruction when it forgets to exit", () => {
    // The zeros padding the last code page decode as `add [rax], al`, so
    // without an explicit end to the code this reported a bad *read* at
    // whatever write left in rax — telling someone who forgot `exit` that they
    // touched a bad address.
    const result = assembleAndRun(`section .data
    msg db "hi", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, 3
    syscall
`);
    expect(result.status).toBe("runtime-error");
    expect(result.stdout).toBe("hi\n");
    expect(result.detail).toContain("ran past its last instruction");
    expect(result.detail).toContain("call exit");
  });

  it("stops a program that prints more than the runner will hold", () => {
    const result = assembleAndRun(
      `section .data
    msg db "ab", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, 3
    syscall
    jmp _start
`,
      { maxOutputBytes: 10 },
    );
    expect(result.status).toBe("runtime-error");
    expect(result.detail).toContain("printed more than this runner will hold");
    // The write that would cross the limit is refused whole, so what arrived is
    // the last write that fitted, not the cap itself.
    expect(result.stdout).toBe("ab\nab\nab\n");
  });

  it("blames rdx, not a printing loop, when write is asked for an absurd count", () => {
    const result = assembleAndRun(`section .data
    msg db "hi", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, -1         ; a stale pointer or a subtraction done backwards
    syscall
    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.status).toBe("runtime-error");
    expect(result.stdout).toBe("");
    expect(result.detail).toContain("check what is in rdx");
    expect(result.detail).not.toContain("printed more than");
  });

  it("caps the heap however many times brk is asked to grow it", () => {
    // Each request is legal on its own; only the total is not. Without a total
    // the loop allocates gigabytes long before the instruction budget ends it.
    const before = process.memoryUsage().arrayBuffers;
    const result = assembleAndRun(`section .text
global _start
_start:
    mov rax, 12
    xor rdi, rdi
    syscall
    mov r12, rax        ; where the heap started
    mov rbx, rax
    mov rcx, 40         ; 40 x 4 MiB asked for, well past the ceiling

.grow:
    lea rdi, [rbx + 0x400000]
    mov rax, 12
    syscall
    mov rbx, rax
    dec rcx
    jnz .grow

    mov rdi, rbx
    sub rdi, r12
    shr rdi, 20         ; how many MiB the heap actually grew
    mov rax, 60
    syscall
`);
    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(64);
    // And asking for the space is not the same as using it: the loop writes
    // nothing, so the pages it reserved should not exist as arrays yet.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("says an over-long run of bytes is not an instruction", () => {
    // Fifteen prefix bytes and then an opcode is longer than any x86
    // instruction may be. The decoder ran off its own fetch window and the raw
    // reader error reached the learner as "Ran off the end of the code".
    const result = assembleAndRun(`section .text
global _start
_start:
    db 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66
    db 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66
    db 0x0f, 0x05
    mov rax, 60
    xor rdi, rdi
    syscall
`);
    expect(result.status).toBe("runtime-error");
    expect(result.detail).toContain("no x86 instruction is longer than the 15 bytes");
  });

  it("puts the caret under the right column on a tab-indented line", () => {
    const result = assembleAndRun("section .text\nglobal _start\n_start:\n\tmov\trax, nowhere\n");
    expect(result.status).toBe("assemble-error");
    const [, echoed, caret] = result.diagnostics!.split("\n");
    // The pad keeps the line's own tabs, so the caret lands on the same column
    // as the token whatever tab width the console renders with.
    expect(echoed).toBe("  \tmov\trax, nowhere");
    expect(caret).toBe("  \t   \t     ^");
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
