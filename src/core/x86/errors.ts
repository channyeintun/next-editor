/**
 * The assembler's error family, in one place.
 *
 * Three classes for what looks like one thing — a message and a source
 * position — reads like an accident until you see what catches them. Each
 * phase throws its own class so the boundary after it can catch *only what
 * that phase meant to raise* and let a genuine bug in this runner (a
 * `TypeError`, a `RangeError`) escape unmasked. `cpu.ts` states the same rule
 * for run time: reporting our own bug as the learner's fault would mislead
 * them and hide it from us.
 *
 * The three are not interchangeable, and two catch sites prove it:
 *
 *   * `AsmEncodeError` is the one with real recovery attached. When the
 *     relaxation loop in `assembler.ts` asks the encoder for bytes and gets
 *     this back, it usually is *not* an error — it is "this jump does not
 *     reach yet, widen it and ask again next pass". `encoder.ts` catches it a
 *     second time to try every candidate form and keep the most useful
 *     complaint. Both of those must swallow encoder verdicts and nothing else;
 *     if the encoder threw the same class as everyone else, an unrelated
 *     failure would be silently absorbed into a retry.
 *   * `AsmSyntaxError` marks "the text is not assembly" as opposed to "the
 *     program is". `assemble` catches it around `parse` alone, which is the
 *     only place it can legitimately arrive from.
 *
 * `AsmError` is the one the outside sees. `assemble` re-raises the other two
 * as this before they leave, so a caller has a single thing to test — which is
 * exactly what `run.ts` and the playground client do to decide between a caret
 * diagnostic and a crash report. Making the phase errors subclasses keeps that
 * `instanceof AsmError` guard honest even if some future call site reaches the
 * lexer or the encoder from outside the two try blocks: the learner still gets
 * their diagnostic instead of "the assembler stopped unexpectedly".
 *
 * `AsmDecodeError` deliberately stays out of this family, in `decoder.ts`. It
 * carries a run-time address rather than a line and a column, so it cannot be
 * formatted with a caret and has nothing to gain from the shared base.
 */

/** A problem with the program, at a source position, fit to show a learner. */
export class AsmError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = "AsmError";
    this.line = line;
    this.column = column;
  }
}

/** Raised by the lexer and the parser; caught by `assemble` around `parse`. */
export class AsmSyntaxError extends AsmError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = "AsmSyntaxError";
  }
}

/**
 * Raised by the encoder. Caught inside the encoder to pick between forms, and
 * by the relaxation loop, where it often means "widen and retry" rather than
 * "reject". Nothing outside those two places should treat it as fatal on its
 * own.
 */
export class AsmEncodeError extends AsmError {
  constructor(message: string, line: number, column: number) {
    super(message, line, column);
    this.name = "AsmEncodeError";
  }
}
