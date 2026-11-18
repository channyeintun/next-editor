// What a subshell knows of jobs, what a background command reads, and which
// signals run the EXIT trap of a shell they end, through `sh -c` as a Node
// program runs it: each line prints what /bin/sh prints, and ends as it does.
const { spawn, spawnSync } = require("child_process");

const lines = [
  // A subshell waits for its own jobs only, never for the job it is.
  "((sleep 0.3; echo in) & wait; echo waited) & echo e",
  '(sleep 0.3; echo late) & (wait; echo "w=$?"); echo after',
  'sleep 0.3 & (wait %1; echo "w=$?"; kill %1; echo "k=$?"; jobs; echo "j=$?") 2>/dev/null',
  "sleep 0.3 & jobs | cut -c1-7",
  'sleep 0.3 & x=$(jobs | cut -c1-7; wait; echo "w=$?"); echo "[$x]"',
  // A background command reads /dev/null unless it redirects its input itself.
  "seq 1 3 | { cat <&0 & wait; echo end; }",
  "seq 1 3 | { cat 0<&0 & wait; echo end; }",
  "seq 1 3 | { cat & wait; echo end; }",
  "seq 1 3 | { cat <&0 && true & wait; echo end; }",
  "seq 1 3 | { cat | cat & wait; echo end; }",
  "seq 1 3 | { while read x; do echo got $x; done <&0 & wait; echo end; }",
  "seq 1 3 | { cat <<EOF & wait; echo end; }\nhere\nEOF",
];
for (const signal of ["QUIT", "PROF", "TERM", "USR1", "SEGV"]) {
  lines.push(`trap "echo exit-trap" EXIT; kill -s ${signal} $$; echo no`);
  lines.push(
    `trap "echo exit-trap" EXIT; trap "echo got" ${signal}; kill -s ${signal} $$; echo after`,
  );
}

for (const line of lines) {
  const r = spawnSync("sh", ["-c", line], { encoding: "utf8", timeout: 5000 });
  console.log(JSON.stringify(line), JSON.stringify(r.stdout), r.status, r.signal, r.error?.code);
}

// The job that runs `wait` ends, so the reader of its pipe sees the end.
const start = Date.now();
const child = spawn("sh", ["-c", "((sleep 0.3; echo in) & wait; echo waited) & echo e"]);
let out = "";
child.stdout.on("data", (chunk) => (out += chunk));
child.stdout.on("end", () => {
  console.log("pipe end:", JSON.stringify(out), Math.round((Date.now() - start) / 300) * 300);
});
