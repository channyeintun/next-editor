import { describe, expect, it } from "vitest";
import { AsmPlaygroundClient, AsmPlaygroundServiceError } from "./client";
import { collectAsmPlaygroundFiles } from "./files";
import { parseAsmPlaygroundRunResult } from "./types";

const HELLO = `section .data
    msg db "hi", 10
section .text
global _start
_start:
    mov rax, 1
    mov rdi, 1
    mov rsi, msg
    mov rdx, 3
    syscall
    mov rax, 60
    mov rdi, 3
    syscall
`;

describe("AsmPlaygroundClient", () => {
  it("runs a program and reports what it printed and exited with", async () => {
    const result = await new AsmPlaygroundClient().run({
      files: [{ path: "main.asm", content: HELLO }],
    });

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("hi\n");
    expect(result.exitCode).toBe(3);
    expect(result.instructions).toBeGreaterThan(0);
    // Only what the program touched: rax, rdi, rsi and rdx were written, and
    // the stack pointer — which the loader set and the program never moved —
    // is deliberately absent.
    expect(result.registers?.map((entry) => entry.name)).toEqual(["rax", "rdx", "rsi", "rdi"]);
  });

  it("returns assembler diagnostics rather than throwing", async () => {
    const result = await new AsmPlaygroundClient().run({
      files: [{ path: "main.asm", content: "section .text\nglobal _start\n_start:\n jmp gone\n" }],
    });

    expect(result.status).toBe("assemble-error");
    expect(result.assembleErrors).toContain("main.asm:4");
    expect(result.assembleErrors).toContain('"gone" is not defined');
    expect(result.stdout).toBe("");
  });

  it("reports a fault with the line it happened on", async () => {
    const result = await new AsmPlaygroundClient().run({
      files: [
        { path: "main.asm", content: "section .text\nglobal _start\n_start:\n mov rax, [0]\n" },
      ],
    });

    expect(result.status).toBe("runtime-error");
    expect(result.exitDetail).toContain("main.asm:4");
  });

  it("offers stdin to the program's read", async () => {
    const result = await new AsmPlaygroundClient().run({
      files: [
        {
          path: "main.asm",
          content: `section .bss
    buf resb 16
section .text
global _start
_start:
    xor rax, rax
    xor rdi, rdi
    mov rsi, buf
    mov rdx, 16
    syscall
    mov rdx, rax
    mov rax, 1
    mov rdi, 1
    mov rsi, buf
    syscall
    mov rax, 60
    xor rdi, rdi
    syscall
`,
        },
      ],
      stdin: "typed\n",
    });

    expect(result.stdout).toBe("typed\n");
  });

  it("refuses an empty workspace by name", async () => {
    await expect(new AsmPlaygroundClient().run({ files: [] })).rejects.toBeInstanceOf(
      AsmPlaygroundServiceError,
    );
  });

  it("says which file to name when several exist and none is main.asm", async () => {
    const client = new AsmPlaygroundClient();
    await expect(
      client.run({
        files: [
          { path: "a.asm", content: HELLO },
          { path: "b.asm", content: HELLO },
        ],
      }),
    ).rejects.toThrow(/there is no linker here/);
  });

  it("assembles main.asm when siblings are present", async () => {
    const result = await new AsmPlaygroundClient().run({
      files: [
        { path: "notes.asm", content: "this is not assembly at all" },
        { path: "main.asm", content: HELLO },
      ],
    });

    expect(result.status).toBe("success");
  });

  it("abandons a run that a newer one supersedes", async () => {
    const client = new AsmPlaygroundClient();
    const forever = `section .text
global _start
_start:
    jmp _start
`;

    const first = client.run({ files: [{ path: "main.asm", content: forever }] });
    // Let the first run reach its yield, then take the machine away from it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.dispose();

    await expect(first).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("collectAsmPlaygroundFiles", () => {
  const file = (path: string) => ({ path, name: path, content: "", language: "asm" as const });

  it("sorts main.asm first and ignores everything that is not assembly", () => {
    const collected = collectAsmPlaygroundFiles({
      files: {
        "README.md": file("README.md"),
        "z.asm": file("z.asm"),
        "main.asm": file("main.asm"),
        "boot.s": file("boot.s"),
      },
    });

    expect(collected.map((entry) => entry.path)).toEqual(["main.asm", "boot.s", "z.asm"]);
  });
});

describe("parseAsmPlaygroundRunResult", () => {
  it("rejects a success that also carries diagnostics", () => {
    expect(
      parseAsmPlaygroundRunResult({
        status: "success",
        stdout: "",
        stderr: "",
        assembleErrors: "boom",
      }),
    ).toBeNull();
  });

  it("rejects an assemble-error with no diagnostics", () => {
    expect(
      parseAsmPlaygroundRunResult({ status: "assemble-error", stdout: "", stderr: "" }),
    ).toBeNull();
  });

  it("rejects a runtime-error with no detail", () => {
    expect(
      parseAsmPlaygroundRunResult({ status: "runtime-error", stdout: "", stderr: "" }),
    ).toBeNull();
  });

  it("rejects a register list that is not name/value strings", () => {
    expect(
      parseAsmPlaygroundRunResult({
        status: "success",
        stdout: "",
        stderr: "",
        registers: [{ name: "rax", value: 5 }],
      }),
    ).toBeNull();
  });

  it("accepts a well-formed success", () => {
    expect(
      parseAsmPlaygroundRunResult({
        status: "success",
        stdout: "hi\n",
        stderr: "",
        exitCode: 0,
        instructions: 9,
        registers: [{ name: "rax", value: "60" }],
        flags: {
          carry: false,
          zero: true,
          sign: false,
          overflow: false,
          parity: true,
          adjust: false,
        },
      }),
    ).toMatchObject({ status: "success", exitCode: 0 });
  });
});
