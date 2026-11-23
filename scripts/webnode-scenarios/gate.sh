#!/bin/bash
# The gate before a deploy: every scenario below, one at a time, in headless
# Chrome on the working tree. A scenario passes only when each of its steps
# held (the harness prints PASS and exits 0); anything else fails the gate.
#
#   bash scripts/webnode-scenarios/gate.sh                every scenario
#   bash scripts/webnode-scenarios/gate.sh term express   only these
#
# WEBNODE_HARNESS_PORT and WEBNODE_HARNESS_OUT name the port and the build
# directory (5199 and node_modules/.cache/webnode-gate unless set);
# WEBNODE_HARNESS_FS=kernel and WEBNODE_HARNESS_MINIFY=1 are passed on.
# GATE_LOGS names the directory the logs go to. GATE_WRAPPER names a command
# each harness run goes through (a lock that limits how many browsers run at
# once, for example). Exit status: the number of scenarios that failed.
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SCENARIOS="term term-cat term-jobs term-resize express preview-tab vite-react ts-starter react-ports fsbench sharedfs-stress starters lessons"
[ $# -gt 0 ] && SCENARIOS="$*"
export WEBNODE_HARNESS_PORT=${WEBNODE_HARNESS_PORT:-5199}
export WEBNODE_HARNESS_OUT=${WEBNODE_HARNESS_OUT:-node_modules/.cache/webnode-gate}
cd "$REPO" || exit 99
LOGS=${GATE_LOGS:-$REPO/node_modules/.cache/webnode-gate-logs}
mkdir -p "$LOGS"
failed=""
for name in $SCENARIOS; do
  log="$LOGS/$name.log"
  start=$(date +%s)
  $GATE_WRAPPER bun scripts/webnode-harness.ts script "$HERE/$name.ts" > "$log" 2>&1
  code=$?
  if [ $code -eq 0 ] && grep -q "^PASS $name.ts$" "$log"; then
    echo "PASS $name ($(( $(date +%s) - start )) s, $(grep -c '^ok ' "$log") steps)"
  else
    failed="$failed $name"
    echo "FAIL $name (exit $code, $(( $(date +%s) - start )) s): $log"
    sed -n '/^FAIL /,$p' "$log" | head -40
  fi
done
if [ -z "$failed" ]; then
  echo "gate: every scenario passed"
  exit 0
fi
echo "gate: failed:$failed"
exit $(echo $failed | wc -w)
