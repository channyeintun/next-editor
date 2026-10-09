/**
 * A script the Director cannot compile into a valid plan. Its own module so the
 * compiler and the pointer choreography it calls can both throw it.
 */
export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}
