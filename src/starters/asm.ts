import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure x86-64 assembly lesson starter: one NASM-syntax file that assembles and
 * runs in the page on an explicit Run action.
 *
 * Nothing here is proxied. The assembler and the machine are first-party
 * TypeScript in `src/core/x86`, so there is no service, no sign-in and no rate
 * limit — and no linker either, which is why the whole lesson lives in
 * `main.asm`. Structure comes from labels and `call`, the way it does in
 * assembly anyway.
 *
 * The program below is the shape almost every first assembly program takes: a
 * string in `.data`, `write` to print it, `exit` to stop. It is deliberately
 * written the long way — the syscall number, the file descriptor, the pointer
 * and the length each moved into their own register — because that sequence is
 * the whole lesson, and a shorter version would hide it. Its output is quoted
 * in its own comments and is exactly what the runner prints.
 */
export function createStarterAsmWorkspace(): WorkspaceProject {
  const files = {
    "main.asm": createWorkspaceFile(
      "main.asm",
      `; x86-64 assembly lesson workspace
;
; Press Run to assemble main.asm and execute it. Everything happens in this
; page — the assembler and the machine are part of the editor, so there is no
; network, no filesystem and no standard library. What the program can do, it
; does by asking the operating system directly.
;
; This runner speaks NASM syntax and the Linux system-call convention, so the
; same file assembles and runs unchanged on a real Linux machine with:
;
;     nasm -f elf64 main.asm && ld -o main main.o && ./main

section .data
    ; db lays bytes down exactly as written. 10 is a newline.
    msg     db  "Hello from the machine!", 10
    ; $ is the address of this line, so this is "how far we have come" —
    ; the length of msg, worked out by the assembler rather than by counting.
    msglen  equ $ - msg

    prompt  db  "rax now holds: "
    promptlen equ $ - prompt

section .bss
    ; Reserved space, zero-filled, with no bytes stored in the program itself.
    digits  resb 24

section .text
    global _start

; A program with no C library starts here. There is no main, and nothing
; called us, so there is nowhere to return to — the program has to exit itself.
_start:
    ; write(1, msg, msglen)
    ;
    ; A system call is a promise about registers: rax says which call, and
    ; rdi, rsi, rdx carry the first three arguments. syscall hands control to
    ; the kernel, which puts its answer back in rax.
    mov     rax, 1              ; 1 is write
    mov     rdi, 1              ; 1 is standard output
    mov     rsi, msg            ; the bytes
    mov     rdx, msglen         ; how many
    syscall

    ; Now something the machine computes rather than something we typed.
    mov     rax, 6
    imul    rax, 7              ; rax = 42

    call    print_number

    ; exit(0). Nothing after this runs.
    mov     rax, 60
    xor     rdi, rdi            ; xor with itself is the shortest way to zero
    syscall

; ---------------------------------------------------------------------------
; print_number — print the value in rax as decimal digits, then a newline.
;
; Dividing by ten gives one digit at a time, and gives them backwards, so the
; digits are written into the buffer from its end towards its start.
; ---------------------------------------------------------------------------
print_number:
    push    rbp
    mov     rbp, rsp

    ; Say what is coming, so the number has a label.
    push    rax                 ; write clobbers rax, so keep the number
    mov     rax, 1
    mov     rdi, 1
    mov     rsi, prompt
    mov     rdx, promptlen
    syscall
    pop     rax

    lea     rdi, [digits+23]    ; the last byte of the buffer
    mov     byte [rdi], 10      ; put the newline there first
    mov     rcx, 10             ; the divisor, and it stays there

.next_digit:
    dec     rdi                 ; step back one byte
    xor     rdx, rdx            ; div reads rdx:rax, so clear the high half
    div     rcx                 ; rax = rax / 10, rdx = rax % 10
    add     dl, '0'             ; a remainder of 7 becomes the character '7'
    mov     [rdi], dl
    test    rax, rax            ; anything left?
    jnz     .next_digit

    ; rdi points at the first digit. The length is the distance from there to
    ; the end of the buffer.
    lea     rdx, [digits+24]
    sub     rdx, rdi
    mov     rsi, rdi
    mov     rax, 1
    mov     rdi, 1
    syscall

    pop     rbp
    ret

; Running this prints:
;
;   Hello from the machine!
;   rax now holds: 42
`,
    ),
  };

  return {
    id: "asm-workspace",
    name: "Assembly Lesson",
    lessonType: "asm",
    entryFilePath: "main.asm",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
