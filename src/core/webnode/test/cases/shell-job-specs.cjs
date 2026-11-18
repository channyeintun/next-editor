// The shell's job specs, `jobs` options, a trap on WINCH, a closed standard
// input and `touch -a`/`-m`, through the real kernel. Each line must print
// under webnode's sh what the real /bin/sh prints, and end with the same
// status. Standard error is left out: bash names the pids of the jobs a
// signal ended and prefixes its messages with the line, and macOS's tools
// word a closed standard input in words of their own; a status says enough.
const fs = require("fs");
const { spawnSync } = require("child_process");

const scripts = [
  // Every job spec form names its job.
  'sleep 3 & sleep 4 & sleep 5 & kill %-; wait %2; echo "$?"; kill %%; wait %3; echo "$?"; kill %+x; wait %1; echo "$?"',
  'sleep 3 & sleep 4 & kill %?4; wait %2; echo "$?"; kill \'%sleep 3\'; wait %1; echo "$?"',
  'sleep 3 & kill %; wait %1; echo "$?"; sleep 3 & kill %-; wait %1; echo "$?"',
  'sleep 1 & sleep 2 & kill %sl; echo "$?"; kill %?; echo "$?"; kill %nope %0; echo "$?"; kill %nope %1; echo "$?"; kill %2',
  'sleep 0.3 & disown %+; jobs; echo "$?"; sleep 0.3 & disown %sle; jobs; echo "$?"; sleep 0.3 & disown sleep; jobs; echo "$?"',
  'sleep 1 & sleep 0.3 & disown %sleep; echo "$?"; disown %?0.3; echo "$?"; jobs; kill %1',
  'sleep 1 & sleep 1 & wait %sl; echo "$?"; wait sleep; echo "$?"; jobs %sl; echo "$?"; jobs %- %+; kill %1 %2',
  'fg; echo "$?"; bg %1; echo "$?"',
  // A disowned job's pid: `wait` answers 0 at once.
  'sleep 2 & p=$!; disown; wait $p; echo "w=$?"; (sleep 2; exit 3) & q=$!; disown %1; wait $q; echo "w=$?"; kill $p $q',
  // jobs -p, -l, -r, -s, -n.
  'sleep 1 & a=$!; sleep 2 & b=$!; [ "$(jobs -p)" = "$a\n$b" ] && echo pids; [ "$(jobs -l %1)" = "$(printf "[1]- %5d Running                 sleep 1 &" $a)" ] && echo long; jobs -r; jobs -s; jobs -s %1; jobs -n; echo n; jobs -n; echo n2; kill %1 %2',
  'start=$(date +%s); sleep 3 & sleep 3 & jobs -p | xargs kill; wait; echo "st=$?"; [ $(( $(date +%s) - start )) -lt 2 ] && echo at-once',
  'jobs -z; echo "$?"',
  // A trap on a signal that does nothing by default runs; none for CHLD.
  'trap "echo got" WINCH; trap "echo exit-trap" EXIT; kill -s WINCH $$; echo after',
  'trap "echo got" URG; kill -s URG $$; trap "echo got" CHLD; kill -s CHLD $$; echo after',
  // A standard input that is closed: each tool fails.
  'for c in cat head wc sort tee uniq tail "tr a b"; do seq 1 3 | $c <&- >/dev/null 2>&1; echo "$c $?"; done',
  'read x <&- 2>/dev/null; echo "read $?"',
];

for (const script of scripts) {
  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  console.log(JSON.stringify([script, result.status, result.stdout]));
}

// touch -a and -m change one time each, also with -d and -r.
const dir = fs.mkdtempSync("touch-case-");
const at = (name) => {
  const stat = fs.statSync(`${dir}/${name}`);
  const shown = (ms) => (Math.abs(ms - Date.now()) < 60000 ? "now" : Math.round(ms / 1000));
  return [shown(stat.atimeMs), shown(stat.mtimeMs)];
};
const D1 = "2001-01-01T00:00:00";
const D2 = "2002-02-02T00:00:00";
const D3 = "2004-01-01T00:00:00";
const touched = spawnSync(
  "sh",
  [
    "-c",
    [
      `cd ${dir}`,
      `touch -d ${D1} a m am da dm ref; touch -d ${D3} r ra rm; touch -a a; touch -m m; touch -am am`,
      `touch -a -d ${D2} da; touch -m -d ${D2} dm; touch -m -d ${D2} ref`,
      "touch -r ref r; touch -a -r ref ra; touch -m -r ref rm; touch -a -c missing; echo c=$?",
    ].join("; "),
  ],
  { encoding: "utf8" },
);
console.log(JSON.stringify([touched.status, touched.stdout]));
for (const name of ["a", "m", "am", "da", "dm", "r", "ra", "rm"]) {
  console.log(name, JSON.stringify(at(name)));
}
console.log("missing", fs.existsSync(`${dir}/missing`));
fs.rmSync(dir, { recursive: true });
