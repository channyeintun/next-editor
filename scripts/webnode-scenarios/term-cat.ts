// A built-in that reads the terminal, and background jobs ended by job number
// and by pid. Every step throws when it does not hold, and is read after the
// echo of the line that was typed.
import type { HarnessApi } from "../webnode-harness";

/** A new prompt, with nothing but its own line before it. */
const PROMPT = /^[^\r\n]*❯/;
/** What bash prints, before its next prompt, for a job a signal ended. */
const NOTICE = String.raw`\[1\]\+ +Terminated {14}sleep 30\r\n`;

export default async function (api: HarnessApi) {
  const term = await api.terminal("jsh");
  await term.expect("prompt", /❯/);

  await term.enter("cat");
  await term.enter("line one");
  await term.expect("cat prints the line it read", /^line one\r\n/);
  await term.keys("\x04");
  await term.expect("Ctrl+D ends cat", PROMPT);
  await term.run("with status 0", "echo eof $?", /^eof 0\r\n/);

  await term.run("a background job is announced", "sleep 30 &", /^\[1\] \d+\r\n/);
  await term.run(
    "jobs lists it; kill and wait end it by its job number",
    "jobs; kill %1; wait %1; echo job $?",
    new RegExp(String.raw`^\[1\]\+ +Running +sleep 30 &\r\n${NOTICE}job 143\r\n`),
  );
  const byPid = await term.run(
    "a job is killed and waited for by its pid",
    "sleep 30 & echo pid=$!; kill $!; wait $!; echo byPid $?",
    new RegExp(String.raw`^\[1\] (\d+)\r\npid=(\d+)\r\n${NOTICE}byPid 143\r\n`),
  );
  api.check(
    "$! is the pid the shell announced",
    byPid.groups[0] === byPid.groups[1],
    JSON.stringify(byPid.groups),
  );
  await term.run("no job is left", "jobs; echo none-left", /^none-left\r\n/);
  await term.enter("exit");
  await term.expectExit("exit ends the shell", 0);
}
