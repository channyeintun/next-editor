#!/bin/sh
# Regenerates the M0 studio narration fixture (macOS only: `say` + `afconvert`).
#
# The committed public/studio-fixtures/m0-go-hello.m4a was produced by this
# script; regenerate only when the narration text changes, then update
# NARRATION_DURATION_MS and the caption cue times in
# src/studio/plans/m0GoHello.ts to match the new waveform (afinfo prints the
# duration). M1 replaces this with a real TTS provider adapter + alignment.
set -eu

out_dir="$(dirname "$0")/../public/studio-fixtures"
tmp_aiff="$(mktemp -t studio-narration).aiff"

say -v Samantha -r 130 -o "$tmp_aiff" \
  "Go functions live at the package level, so any file in the package can call them. \
Square here takes an int, and returns an int. \
Let's add a cube function beside it, multiplying value three times. \
Now call cube from main, and print the result. \
Run the program. \
The five squares print first, and then: three cubed is twenty seven."

afconvert -f m4af -d aac -b 64000 "$tmp_aiff" "$out_dir/m0-go-hello.m4a"
rm -f "$tmp_aiff"

afinfo "$out_dir/m0-go-hello.m4a" | grep -E "estimated duration|data format"
