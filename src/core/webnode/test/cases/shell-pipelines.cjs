// Shell command lines through the real kernel: pipes between built-in stages,
// one pipeline after another in the same shell (the descriptors are reused),
// early readers, subshells, and the status of a pipeline; what a built-in
// writes to a file through an fd that stays open, read back by its path by
// the next command; a write that fails; what a background command and a
// child shell read of a pipe the shell reads too. Each line must print under
// webnode's sh what the real /bin/sh prints.
const { spawnSync } = require("child_process");

const scripts = [
  "echo first | cat; echo second | cat; echo third | cat",
  'seq 1 3 | tr "\\n" " "; echo',
  '(echo a | grep a); seq 1 5 | sort -nr | head -2 | tr "\\n" " "; echo',
  "echo x | cat | cat | cat | cat",
  'printf "b\\na\\nc\\n" | sort | head -1',
  'x=$(echo hi | tr a-z A-Z); echo "$x"',
  "for i in 1 2 3; do echo $i; done | tail -1",
  'printf "1\\n2\\n3\\n" | while read n; do echo "n=$n"; done',
  'echo "a b" | { read p q; echo "$q $p"; }',
  "{ echo a; echo b; } | grep b",
  "while :; do echo y; done | head -2",
  "echo one | cat; while :; do echo y; done | head -1; echo two | cat",
  'false | true; echo "status $?"; true | false; echo "status $?"',
  '(exit 3) | cat; echo "status $?"; (exit 3); echo "status $?"',
  "set -e; echo a | grep a; echo b | grep -c b; echo done",
  'echo a | grep z; echo "status $?"',
  "echo data | cat > /dev/null; echo kept | cat",
  "echo a; echo b | cat; echo c; echo d | cat; echo e",
  "n=0; for w in a b c; do n=$((n + 1)); echo $w | tr a-c A-C; done; echo $n",
  'echo "to stderr" | cat >&2; echo "to stdout" | cat',
  // Every line written is in the file when the next command reads it: no line shows twice.
  'exec 3>log.txt; echo first >&3; i=0; while [ $i -lt 300 ]; do echo "line $i" >&3; tail -n 1 log.txt; i=$((i+1)); done | uniq -d; exec 3>&-; tail -n 1 log.txt; rm -f log.txt',
  "exec > out.log; echo one; echo two; grep -c . out.log >&2; rm -f out.log",
  'echo data > f.txt; exec 3< f.txt; cat f.txt >&3 2>/dev/null; echo "st=$?"; rm -f f.txt',
  "set -o pipefail; seq 1 20000 | head -n 1 >/dev/null; echo st=$?",
  "set -o pipefail; seq 1 20000 | { read x; }; echo st=$?",
  "echo data | { cat & wait; echo end; }",
  'seq 1 3 | { read a; read b & wait; read c; echo "a=$a c=$c"; }',
  "printf 'x\\ny\\n' | { cat & cat; wait; echo done; }",
  "printf '\\377\\376a\\n' | { read -r a; printf '%s' \"$a\" | wc -c | tr -d ' '; }",
  // A child shell leaves the rest of the pipe to its parent, however it ends.
  'seq 1 6 | { sh -c \'read c; echo "c=$c"\'; read d; echo "d=$d"; }',
  'seq 1 6 | { read a; sh -c \'read c; echo "c=$c"; kill -9 $$\'; read d; echo "a=$a d=$d"; } 2>/dev/null',
  "seq 1 6 | { read a; sh -c 'read c; kill -9 $$'; read d; echo \"a=$a d=$d\"; } 2>/dev/null",
];

for (const script of scripts) {
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  console.log(JSON.stringify([script, result.status, result.stdout, result.stderr]));
}
