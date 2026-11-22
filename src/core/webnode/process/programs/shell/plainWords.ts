// Words that mean to a shell exactly what they say: no quoting, expansion,
// pattern, operator or comment in them. A command line made only of such
// words, one space apart, is one command with those words as its arguments.
//
// `sh -c` of such a line whose first word names a program does nothing but
// start that program: the shell then only stands for it (interpreter.ts,
// `runCommandString`). So whoever is about to start that shell can start the
// program itself, with the environment the shell would have given it
// (environment.ts), and save the shell's process: a worker that takes some
// 37 ms to start and 12 MB while the program runs. The shell says which
// lines those are (`loneProgram` in interpreter.ts, which knows the words the
// shell runs itself); the kernel, which has no shell, does it for the
// runtime's own programs alone (kernel/exec.ts).

/** The characters of a word no shell reads anything into (those `shellQuote` leaves unquoted). */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** Whether `word` reaches a program exactly as it is written. */
export function isPlainWord(word: string): boolean {
  return PLAIN_WORD.test(word);
}

/**
 * The words of `line` when it is plain words one space apart and does not
 * start with an assignment (a first word with `=`); null for any other line.
 * It says nothing of what the first word is to a shell: a builtin, a
 * reserved word or a program.
 */
export function plainWords(line: string): string[] | null {
  const words = line.split(" ");
  return words.every(isPlainWord) && !words[0].includes("=") ? words : null;
}
