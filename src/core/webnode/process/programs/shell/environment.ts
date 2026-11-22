// The environment a shell starts with, which is what a program it starts sees.
// The shell uses it for itself; whoever starts a program in a shell's place
// (plainWords.ts says when that can be done) gives the program this.
import { DEFAULT_PATH, HOME_DIR, SHELL_PATH, USERNAME } from "../../platform";

/** The environment a new shell starts with: the process's, plus PWD, HOME, PATH, SHELL, USER, SHLVL. */
export function initialEnvironment(
  env: Record<string, string>,
  cwd: string,
): Record<string, string> {
  const next = { ...env };
  next.PWD = cwd;
  next.HOME ??= HOME_DIR;
  next.PATH ??= DEFAULT_PATH;
  next.SHELL ??= SHELL_PATH;
  next.USER ??= USERNAME;
  const level = Number(next.SHLVL ?? "0");
  next.SHLVL = String(Number.isFinite(level) ? level + 1 : 1);
  return next;
}
