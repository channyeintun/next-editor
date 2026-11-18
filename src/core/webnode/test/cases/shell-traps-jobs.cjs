// A shell's traps and jobs through the real kernel: the status an EXIT trap's
// `exit` gives, `$?` after a signal's trap, `wait` and `kill` on background
// jobs, pathname expansion against permission bits, and the paths a
// redirection opens. Each line must print under webnode's sh what the real
// /bin/sh prints, and end with the same status. Standard error is left out:
// bash names the pids of the jobs a signal ended. The lines that look at
// what a directory holds make one of their own: the cases share theirs.
const { spawnSync } = require("child_process");

const scripts = [
  // An `exit` in the EXIT trap names the status; without an operand it keeps it.
  'sh -c \'trap "exit 5" EXIT; true\'; echo "st=$?"',
  'trap "echo bye; exit 9" EXIT; echo run; exit 3',
  'trap "echo bye; exit" EXIT; exit 3',
  'trap "(exit 5)" EXIT; exit 2',
  '(trap "exit 5" EXIT; exit 2); echo "sub=$?"',
  'x=$(trap "exit 5" EXIT; echo in); echo "$x $?"',
  "trap 'echo bye' EXIT; exec echo replaced",
  // `$?` after a signal's trap is what it was before.
  'trap "echo t; false" TERM; kill -TERM $$; echo "st=$?"',
  'trap "echo got" TERM; (sleep 0.3; kill -TERM $$) & sleep 3 & wait $!; echo "st=$?"; kill $!',
  'trap "echo got" TERM; (sleep 0.3; kill -TERM $$) & sleep 3 & wait; echo "st=$?"; kill $!',
  'trap \'kill $child\' TERM; sleep 30 & child=$!; (sleep 0.3; kill -TERM $$) & wait $child; echo "first=$?"; wait $child; echo "second=$?"',
  // wait.
  '(exit 3) & (exit 4) & wait; echo "st=$?"',
  'false & wait; echo "st=$?"',
  '(exit 3) & wait $!; echo "st=$?"',
  'sleep 30 & kill %1; wait; echo "st=$?"',
  'wait 99999; echo "st=$?"',
  'nosuch-command & wait $!; echo "st=$?"',
  // kill.
  'kill -0 $$; echo "self=$?"',
  'kill -0 99999; echo "none=$?"',
  'sleep 30 & kill -9 -- $!; echo "rc=$?"; wait $!; echo "st=$?"',
  'sleep 30 & kill -s TERM -- $!; echo "rc=$?"; wait $!; echo "st=$?"',
  'sleep 30 & kill -0 $!; echo "alive=$?"; kill $!; wait $!; kill -0 $!; echo "gone=$?"',
  "kill -l 15; kill -l 143; kill -l TERM; kill -l 1 2 3",
  // A background pipeline keeps the shell's input; any other background command reads /dev/null.
  "seq 1 3 | { cat | cat & wait; echo end; }",
  "seq 1 3 | { cat & wait; echo end; }",
  // Pathname expansion needs to search a directory, and to read it only for a pattern.
  "mkdir globs; cd globs; mkdir nr nx; echo i > nr/in; echo i > nx/in; chmod 311 nr; chmod 644 nx; echo */in; echo nr/i*; echo n?/in; echo n*/; chmod 755 nr nx; cd ..; rm -r globs",
  // The filesystem resolves a redirection's target: `..` after a linked directory, permissions, an empty name.
  "mkdir -p dd/d/sub; cd dd; ln -s d/sub link; echo outer > x; echo inner > d/x; echo new > link/../y; ls y d/y; cat < link/../x; cd ..; rm -r dd",
  'mkdir perms; cd perms; mkdir -p nx/sub; echo hi > f; chmod 000 nx; echo y > nx/../g; echo "write st=$?"; cat < nx/../f; echo "read st=$?"; ls; chmod 755 nx; cd ..; rm -r perms',
  'echo x > ""; echo "st=$?"',
];

for (const script of scripts) {
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  console.log(JSON.stringify([script, result.status, result.stdout]));
}
