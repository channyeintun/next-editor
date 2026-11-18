// A background job stays in the job table, running, whatever the foreground
// does meanwhile: a loop stopped by Ctrl+C, a built-in reading the terminal,
// a program. Every step throws when it does not hold, and is read after the
// echo of the line that was typed.
import type { HarnessApi } from "../webnode-harness";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A new prompt, with nothing but its own line before it. */
const PROMPT = /^[^\r\n]*❯/;
/** What `jobs` prints while the one job runs, and the prompt after it. */
const RUNNING = /^\[1\]\+ +Running +sleep 30 &\r\n[^\r\n]*❯/;

export default async function (api: HarnessApi) {
  const term = await api.terminal("jsh");
  await term.expect("prompt", /❯/);
  await term.run("a background job is announced", "sleep 30 &", /^\[1\] \d+\r\n/);
  await term.run("jobs lists it", "jobs", RUNNING);

  await term.enter("while :; do :; done");
  await pause(700);
  await term.keys("\x03");
  await term.expect("Ctrl+C stops a loop of builtins", /^\^C\r\n[^\r\n]*❯/);
  await term.run("and leaves the job running", "jobs", RUNNING);

  await term.enter("cat");
  await term.enter("x");
  await term.expect("cat prints the line it read", /^x\r\n/);
  await term.keys("\x04");
  await term.expect("Ctrl+D ends cat", PROMPT);
  await term.run("and leaves the job running", "jobs", RUNNING);

  await term.run("a program runs in the foreground", `node -e "setTimeout(()=>{},200)"`, PROMPT);
  await term.run("and leaves the job running", "jobs", RUNNING);

  await term.run("kill ends the job", "kill %1; wait %1; echo job $?", /job 143\r\n/);
  await term.run("no job is left", "jobs; echo none-left", /^none-left\r\n/);
  await term.enter("exit");
  await term.expectExit("exit ends the shell", 0);
}
