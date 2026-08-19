# The x86-64 Assembly Runner

How an `asm` lesson runs, and why it runs that way rather than the way
[`robalb/x86-64-playground`](https://github.com/robalb/x86-64-playground) does.

## What ships

`src/core/x86/` is a first-party NASM-syntax assembler and an x86-64 Linux
machine, in TypeScript, running in the page. An `asm` lesson has no proxy, no
service, and no vendored binary.

| Module         | What it is                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| `lexer.ts`     | Tokens, with line and column on every one so diagnostics can point.                   |
| `parser.ts`    | Statements and operands. Memory operands are folded into base/index/scale/disp.       |
| `isa.ts`       | **One** instruction table, read forwards by the encoder and backwards by the decoder. |
| `encoder.ts`   | Mnemonic and operands to machine code, always the shortest encoding.                  |
| `decoder.ts`   | Machine code back to instructions, for execution and disassembly.                     |
| `assembler.ts` | Two-pass layout with branch relaxation; sections, symbols, and a program image.       |
| `memory.ts`    | A sparse page table with real permissions.                                            |
| `cpu.ts`       | Sixteen registers, six flags, and the Linux system-call layer.                        |
| `run.ts`       | Assemble, load a Linux-shaped initial stack, run, report.                             |

The runner **executes the bytes it emitted**. It does not interpret the parsed
statements: each step reads the machine code at `rip` out of memory and decodes
it, so a program that computes a jump target at run time lands on it, and an
encoder bug shows up as wrong behaviour rather than as nothing at all.
`roundTrip.test.ts` assembles a corpus covering every addressing form and
decodes it straight back, which is what keeps the two directions honest. It has
already caught one silent miscompilation: `ah`, `ch`, `dh` and `bh` encode as
ModRM values 4-7, not 0-3, so `mov ah, bl` was assembling as `mov al, bl`.

### What it covers

Moves and the widening moves, `lea`, the eight ALU operations in every operand
form, `test`, the unary group, `inc`/`dec`, `imul` in all three forms,
`mul`/`div`/`idiv`, the shift and rotate group, `push`/`pop`, `call`/`ret`/
`leave`, `jmp`, all sixteen conditions across `jcc`/`setcc`/`cmovcc`, `loop`,
the sign-extension instructions, and `syscall`. Directives: `section`,
`global`, `db`/`dw`/`dd`/`dq`, `resb`/`resw`/`resd`/`resq`, `equ`, `align`,
`default rel`, size keywords, `$` and `$$`, and local labels.

System calls: `read` (0), `write` (1), `brk` (12), `getpid` (39) and `exit`
(60/231). Anything else stops the program **by name** — "the program asked for
system call 2, which this runner does not have" — rather than returning
`-ENOSYS` and letting it take a silent error path.

### What it does not cover

Floating point and SSE, threads, `mmap`, files, and anything else a program with
a C library would reach for. It will not run a binary you did not write here.
For teaching x86-64, that is the intended limit.

## Why not Blink and NASM

`x86-64-playground` is the reference for this feature and its approach was
researched before this one was chosen. It works by compiling
[Blink](https://github.com/jart/blink) — a real x86-64 Linux emulator — to
WebAssembly, and then running **native, statically-linked musl binaries of NASM
and GNU binutils inside that emulator** to assemble and link. It is an elegant
design and the honest way to run arbitrary binaries in a browser.

The verified numbers for what that ships:

| Artifact                          |     Bytes |
| --------------------------------- | --------: |
| `blinkenlib.wasm`                 |   246,871 |
| `blinkenlib.js` (Emscripten glue) |   204,023 |
| `nasm.3.00.elf`                   | 1,808,400 |
| `gnu-as.2.43.50.elf`              | 2,135,928 |
| `gnu-ld.2.43.50.elf`              | 2,790,840 |

Four reasons that shape does not fit here:

1. **Licensing.** Blink is ISC and NASM is BSD-2-Clause, both fine. The
   assembler and linker that actually do the work are GNU binutils, which is
   GPL — and the upstream project ships those binaries with no corresponding
   source offer. This repository is MIT. Vendoring a compliance gap is not a
   thing to copy.
2. **Size.** Roughly 7 MB of artifacts, against a repo whose largest committed
   binary today is a 2.2 MB Wasm compiler. The whole engine here is source.
3. **Errors.** A real emulator answers a bad memory access with a signal, and
   the shell prints "Segmentation fault". This one says _"The program tried to
   write to 0x401000, which is read-only (main.asm:14)"_. For a lesson that
   difference is the product.
4. **The register file.** An assembly lesson is usually _about_ the registers.
   Here they are ordinary values the runner reads after a run and prints; behind
   an emulator they are on the far side of a debugger protocol.

There is a fifth reason specific to this codebase: a recorded lesson must replay
identically forever. A first-party deterministic engine with no service and no
network has nothing that can drift, and `asmCrashCourse.test.ts` proves the
lesson's pinned fixture by **running the program the lesson builds** and
comparing — something none of the other language lessons can do, because their
compilers are remote.

## Alternatives that were checked and rejected

- **Compiler Explorer** (`godbolt.org`) genuinely works: NASM 2.16.01 with real
  `nasm -f elf64` → `ld` → execute, real stdout, real exit codes, open CORS,
  0.3-1.1s. It would have dropped straight into the existing Worker-proxy shape
  the Go, Kotlin, Rust and Zig routes already share. It was rejected because it
  is a donation-funded service with no terms of service, no SLA and no published
  rate limits — the exact dependency the Kite runner exists to avoid.
- **`v86`** is 32-bit only; long mode was never implemented.
- **Unicorn.js** is GPL-2.0, and emulates the CPU only — it would still need an
  assembler shipped alongside it, plus a hand-written syscall layer.
- **`ax` (`ax-x86`)** is the closest in spirit and is AGPL-3.0, unmaintained
  since 2023, and has partial instruction coverage.
- **`@binutils-wasm/gas`** is a real wasm build of GNU as, and is
  GPL-3.0-or-later.
- **CheerpX / WebVM** runs unmodified x86-64 Linux binaries client-side and is
  proprietary, with a paid licence required for any multi-person company.
- **Piston** became whitelist-only in February 2026. **Wandbox** has no
  assembly. **WebContainer** cannot execute native binaries at all.

## Wiring

`asm` is a `WorkspaceLessonType` whose `WorkspaceExecutionKind` is
`asm-playground`, alongside Kite as the second backend that needs no service.
It follows the same six-file shape as every other language:

- `src/runtime/asmPlayground/{types,client,console,files}.ts`
- `src/hooks/useAsmPlaygroundRunner.ts`
- `src/components/AsmPlaygroundRunnerPanel.tsx`
- `src/monaco/asmLanguage.ts`, `src/starters/asm.ts`
- `src/studio/plan.ts` (`asm-playground` runtime kind) and
  `src/studio/playgroundRuntime.ts` (the run adapter)

Two details differ from the others and both are deliberate:

- **Runs are sliced.** The client runs 100,000 instructions, yields to the
  browser, and checks whether a newer run has superseded it. A tight loop
  counting to ten million is a reasonable thing for a learner to write, and
  running it straight through would freeze the tab — including the button that
  could have stopped it.
- **The console carries the register file.** After a run the runner appends the
  registers the program _changed_, four to a line. Not every non-zero register:
  the stack pointer is non-zero before the first instruction runs, and printing
  it would say something about the loader rather than about the program.

## Authoring a lesson

See [lesson-script-authoring.md](./lesson-script-authoring.md) — `asm` is in the
runtime matrix, with its fixture shape and its `registers` field documented
there. `src/studio/scripts/x86-64-assembly-crash-course.yaml` is the worked
example: ten scenes, about fifteen minutes, aimed at someone who has never
written assembly.

It covers, in order: what a register is and what memory is; the sixteen
registers and the **three kinds of rule** about which one to use (the processor
enforces `rsp`, `rcx` and the `rax`/`rdx` pair; Linux asks for `rdi, rsi, rdx,
r10, r8, r9`; everything else is yours); the four width names of a single
register and the rule that writing `eax` clears the top half; sections and
`_start`; `db` and `$ - msg`; the write system call; brackets as "the value at"
against `lea` as "work out an address"; the flags and the jump that reads them;
the stack, and `call`/`ret` as nothing more than a jump that wrote down where it
came from; and `div` choosing `rdx:rax` for you.

The lesson's first draft named the registers without saying what any of them was
for, and a reader's reaction was that they had learned nothing about them. The
completeness the rewrite added is now asserted rather than trusted:
`asmCrashCourse.test.ts` checks that each of those ideas is still in the
narration **and** still demonstrated by the program the typing builds, so a scene
cannot be trimmed for length without the suite noticing.
