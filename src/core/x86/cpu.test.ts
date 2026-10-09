import { describe, expect, it } from "vite-plus/test";
import { signBit } from "./cpu";
import { CONDITION_CODES, INSTRUCTION_FORMS } from "./isa";

describe("signBit", () => {
  it("matches shifting the top bit down, for any value and size", () => {
    // A fixed-seed generator, so a failure names the same inputs every run.
    let seed = 0x2545f491;
    const nextWord = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return BigInt(seed >>> 0);
    };
    for (const size of [1, 2, 4, 8]) {
      const shift = BigInt(size * 8 - 1);
      for (let index = 0; index < 10_000; index += 1) {
        // Up to 96 bits, either sign: wider than any operand on purpose.
        const magnitude = (nextWord() << 64n) | (nextWord() << 32n) | nextWord();
        const value = (nextWord() & 1n) === 1n ? -magnitude : magnitude;
        expect(signBit(value, size)).toBe(((value >> shift) & 1n) === 1n);
      }
      expect(signBit(1n << shift, size)).toBe(true);
      expect(signBit((1n << shift) - 1n, size)).toBe(false);
      expect(signBit(-1n, size)).toBe(true);
    }
  });
});

describe("condition forms", () => {
  it("carry the code their mnemonic names, for every Jcc, SETcc and CMOVcc", () => {
    const byName = new Map(
      CONDITION_CODES.flatMap(({ code, names }) => names.map((name) => [name, code] as const)),
    );
    const conditional = INSTRUCTION_FORMS.filter((form) => /^(j|set|cmov)/.test(form.mnemonic));
    const unconditional = conditional.filter((form) => form.mnemonic === "jmp");
    for (const form of unconditional) expect(form.condition).toBeUndefined();
    for (const form of conditional.filter((candidate) => candidate.mnemonic !== "jmp")) {
      const [, family, name] = /^(j|set|cmov)(.+)$/.exec(form.mnemonic)!;
      expect(form.condition).toEqual({ family, code: byName.get(name) });
    }
    expect(conditional.length - unconditional.length).toBe(16 * (2 + 1 + 3));
  });
});
