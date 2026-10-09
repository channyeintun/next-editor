import type { PlaygroundAgentStack } from "../playgroundAgentStack";

/** What the coding agent's system prompt says runs an assembly lesson, and its limits. */
export const ASM_AGENT_STACK: PlaygroundAgentStack = {
  lead:
    "Supported stack: x86-64 assembly only, in NASM syntax. This lesson's main.asm " +
    "assembles and runs entirely in this page — the assembler and the x86-64 Linux " +
    "machine are part of the editor, so there is no service, no sign-in and no network " +
    "round trip — when the user presses Run in the Assembly Runner panel; you cannot " +
    "execute code yourself.",
  specifics:
    "There is no linker and no C library, so the whole program lives in main.asm, starts " +
    "at `_start`, and must end by asking the kernel to exit (`mov rax, 60` then " +
    "`syscall`) — falling off the end is a fault. Use the Linux system-call convention: " +
    "the call number in rax, arguments in rdi, rsi, rdx, r10, r8, r9, and the result " +
    "back in rax. Only read (0), write (1), brk (12), getpid (39) and exit (60/231) " +
    "exist here; any other call stops the program. The instruction set covers integer " +
    "work only — moves and the widening moves, lea, the ALU and unary groups, inc/dec, " +
    "imul/mul/div/idiv, shifts and rotates, push/pop, call/ret/leave, jmp, every " +
    "jcc/setcc/cmovcc, loop, the sign-extension instructions and syscall — with no " +
    "floating point, no SSE and no threads. Directives available: section " +
    "(.text/.rodata/.data/.bss), global, db/dw/dd/dq, resb/resw/resd/resq, equ, align, " +
    "`$` and `$$`, size keywords, and local labels like .loop.",
};
