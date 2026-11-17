// Shell command lines through the real kernel: pipes between built-in stages,
// one pipeline after another in the same shell (the descriptors are reused),
// early readers, subshells, and the status of a pipeline. Each line must print
// under webnode's sh what the real /bin/sh prints.
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
];

for (const script of scripts) {
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  console.log(JSON.stringify([script, result.status, result.stdout, result.stderr]));
}
