#!/bin/sh
# Howard 0.6B, Burmese text-to-speech, on this computer in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/channyeintun/next-editor/main/scripts/howard.sh | sh
#
# The first run downloads the model and builds its server (qwentts.cpp's
# tts-server); later runs start the server at once. The Studio option
# "မြန်မာ · Howard (on-device)" calls it on http://127.0.0.1:8080.
# Guide: docs/howard-on-device-burmese.md
#
# Settings, as environment variables:
#   HOWARD_TALKER       Q8_0 (default, 993 MB) or Q4_K_M (629 MB)
#   HOWARD_PORT         the port to listen on (default 8080)
#   HOWARD_HOME         where the files are kept (default ~/.howard)
#   HOWARD_CMAKE_FLAGS  extra build flags, such as -DGGML_CUDA=ON or -DGGML_VULKAN=ON

set -eu

HOWARD_HOME=${HOWARD_HOME:-"$HOME/.howard"}
HOWARD_PORT=${HOWARD_PORT:-8080}
HOWARD_TALKER=${HOWARD_TALKER:-Q8_0}
HOWARD_CMAKE_FLAGS=${HOWARD_CMAKE_FLAGS:-}

# The model files, at the revision this script was tested with, and their SHA-256.
MODEL_URL="https://huggingface.co/aungzaythant/Howard-0.6B/resolve/e599d7f8fd1744dba6f2eb6a3a4a35bf4009620e/gguf"
CODEC_FILE="Howard-12Hz-codec-Q8_0.gguf"
CODEC_SHA256="1883beeed99348fc35e23dd225e9082f93f6f8c109330a33d935baa8acdbfd94"
case "$HOWARD_TALKER" in
  Q8_0) TALKER_SHA256="6405f6d2a525a97242cd87f90bd57eecb7b866222f3b659041b71270f1f211e9" ;;
  Q4_K_M) TALKER_SHA256="4b5a1e6ecf107392e6bf66aceb608f181a588c5a7f6685b74557d85beeb94c01" ;;
  *)
    echo "howard: HOWARD_TALKER must be Q8_0 or Q4_K_M, not \"$HOWARD_TALKER\"" >&2
    exit 1
    ;;
esac
TALKER_FILE="Howard-0.6B-$HOWARD_TALKER.gguf"

# The runtime revision the model's own notes pin.
RUNTIME_URL="https://github.com/ServeurpersoCom/qwentts.cpp.git"
RUNTIME_REV="2edb35f87b709a070b2d5379f77e5c52a1daa585"

say() {
  printf 'howard: %s\n' "$*"
}

fail() {
  printf 'howard: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "\"$1\" is needed and was not found. $2"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    sha256sum "$1" | cut -d ' ' -f 1
  fi
}

# Download one model file unless a verified copy is here. A download that was
# cut off is taken up where it stopped.
fetch_model() {
  file=$1
  expected=$2
  target="$HOWARD_HOME/models/$file"
  if [ -f "$target" ]; then
    return 0
  fi
  # A whole file left from a run that stopped before it was checked.
  if [ -f "$target.part" ] && [ "$(sha256_of "$target.part")" = "$expected" ]; then
    mv "$target.part" "$target"
    return 0
  fi
  say "downloading $file"
  curl -fL --retry 5 --retry-delay 2 -C - -o "$target.part" "$MODEL_URL/$file"
  actual=$(sha256_of "$target.part")
  if [ "$actual" != "$expected" ]; then
    rm -f "$target.part"
    fail "$file did not arrive whole (its SHA-256 is wrong). Run the command again."
  fi
  mv "$target.part" "$target"
}

# Build tts-server at the pinned revision unless that build is here.
build_server() {
  source_dir="$HOWARD_HOME/qwentts.cpp"
  server="$source_dir/build/tts-server"
  stamp="$source_dir/build/howard-build"
  wanted="$RUNTIME_REV $HOWARD_CMAKE_FLAGS"
  if [ -x "$server" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$wanted" ]; then
    return 0
  fi

  if [ "$(uname -s)" = "Darwin" ]; then
    hint="Install Xcode's tools with: xcode-select --install"
    cmake_hint="Install it with: brew install cmake"
  else
    hint="On Debian or Ubuntu: sudo apt install git build-essential"
    cmake_hint="On Debian or Ubuntu: sudo apt install cmake"
  fi
  need git "$hint"
  need c++ "$hint"
  need cmake "$cmake_hint"

  say "building the server (a few minutes, once)"
  if [ ! -d "$source_dir/.git" ]; then
    git init -q "$source_dir"
    git -C "$source_dir" remote add origin "$RUNTIME_URL"
  fi
  # Only the pinned revision is fetched; a host that refuses that gets the whole history.
  git -C "$source_dir" fetch -q --depth 1 origin "$RUNTIME_REV" 2>/dev/null ||
    git -C "$source_dir" fetch -q origin
  git -C "$source_dir" checkout -q --detach "$RUNTIME_REV"
  git -C "$source_dir" submodule update -q --init --recursive --depth 1 2>/dev/null ||
    git -C "$source_dir" submodule update -q --init --recursive

  # Apple silicon runs the model on the GPU (Metal). Elsewhere the plain build
  # runs on the CPU; HOWARD_CMAKE_FLAGS turns on a GPU backend.
  platform_flags=""
  if [ "$(uname -s)" = "Darwin" ]; then
    platform_flags="-DGGML_METAL=ON -DGGML_BLAS=ON"
  fi
  # The flags are split into words on purpose.
  # shellcheck disable=SC2086
  cmake -S "$source_dir" -B "$source_dir/build" -DCMAKE_BUILD_TYPE=Release \
    $platform_flags $HOWARD_CMAKE_FLAGS >"$HOWARD_HOME/build.log" 2>&1 ||
    fail "the build could not be set up. See $HOWARD_HOME/build.log"
  cmake --build "$source_dir/build" --target tts-server -j 4 >>"$HOWARD_HOME/build.log" 2>&1 ||
    fail "the build failed. See $HOWARD_HOME/build.log"
  printf '%s\n' "$wanted" >"$stamp"
}

need curl "It is part of macOS and of most Linux systems."
mkdir -p "$HOWARD_HOME/models"

# A server already on this port is left alone.
if curl -fsS -m 2 "http://127.0.0.1:$HOWARD_PORT/v1/models" >/dev/null 2>&1; then
  say "a server already answers on http://127.0.0.1:$HOWARD_PORT. Nothing to start."
  exit 0
fi

fetch_model "$TALKER_FILE" "$TALKER_SHA256"
fetch_model "$CODEC_FILE" "$CODEC_SHA256"
build_server

say "serving $TALKER_FILE on http://127.0.0.1:$HOWARD_PORT"
say "keep this window open while narration is made. Ctrl-C stops it."
exec "$HOWARD_HOME/qwentts.cpp/build/tts-server" \
  --model "$HOWARD_HOME/models/$TALKER_FILE" \
  --codec "$HOWARD_HOME/models/$CODEC_FILE" \
  --host 127.0.0.1 --port "$HOWARD_PORT" --lang auto
