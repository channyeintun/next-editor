# Burmese narration with Howard on your own computer

[Howard 0.6B](https://huggingface.co/aungzaythant/Howard-0.6B) is a Burmese
fine-tune of Qwen3-TTS (Apache 2.0). It reads Burmese text aloud, with the
English words inside it spoken as English, as 24 kHz mono audio, and it runs on
the author's own computer. The Studio option is
`မြန်မာ · Howard (on-device)`.

It needs no account flag, no API key and no hosted GPU, so it is offered to
everyone. What it needs is a small server running on the same computer as the
browser, started with one command. Nothing goes through the Worker.

## Request path

1. The author starts qwentts.cpp's `tts-server` with Howard's GGUF files (the
   one command below). It listens on `http://127.0.0.1:8080` and sends
   permissive CORS headers, so a page can call it.
2. The Howard panel asks that server which model it loaded
   (`GET /v1/models`) and shows the answer. Narration is keyed by it.
3. Before the first dialog a render has not kept, the page checks the model
   again and registers the narrator reference as a cloned voice
   (`POST /v1/audio/voices`, the recording as a base64 WAV).
4. Each uncached dialog is one request (`POST /v1/audio/speech`) that names
   that voice and answers with a 24 kHz PCM16 mono WAV. The take then goes
   through the same dialog cache, scheduler, stitcher and captions as every
   other provider.

The narrator recording and the lesson text go to that local server only. The
panel accepts a plain-HTTP loopback address and nothing else
(`127.0.0.1`, `localhost`, `[::1]`).

## Start it: one command

```sh
curl -fsSL https://raw.githubusercontent.com/channyeintun/next-editor/main/scripts/howard.sh | sh
```

The first run downloads the model (1.3 GB) and builds its server, which takes a
few minutes. After that the same command starts the server at once. Keep the
window open while narration is made: the server holds the model in memory, so
stop it (Ctrl-C) when the narration is done.

The Howard panel in Studio shows this command, with a Copy button, whenever no
server answers.

What the script ([scripts/howard.sh](../scripts/howard.sh)) does:

1. Downloads one talker and the shared codec from the model's `gguf/` folder
   into `~/.howard/models`, and checks each file's SHA-256. A download that was
   cut off continues where it stopped.
2. Fetches qwentts.cpp at the revision the model's own notes pin
   (`2edb35f87b709a070b2d5379f77e5c52a1daa585`) and builds its `tts-server`
   into `~/.howard/qwentts.cpp`. On Apple silicon the build uses the GPU
   (Metal); elsewhere it runs on the CPU.
3. Starts the server on `http://127.0.0.1:8080`.

It needs Git, CMake and a C++ compiler, and says which one is missing. On a
Mac: `xcode-select --install` and `brew install cmake`. On Debian or Ubuntu:
`sudo apt install git cmake build-essential`.

Settings are environment variables, placed before `sh`:

| Variable             | Default     | Use                                                 |
| -------------------- | ----------- | --------------------------------------------------- |
| `HOWARD_TALKER`      | `Q8_0`      | `Q4_K_M` for the smaller 4-bit talker               |
| `HOWARD_PORT`        | `8080`      | another port to listen on                           |
| `HOWARD_HOME`        | `~/.howard` | where the model and the build are kept              |
| `HOWARD_CMAKE_FLAGS` | none        | a GPU build: `-DGGML_CUDA=ON` or `-DGGML_VULKAN=ON` |

```sh
curl -fsSL https://raw.githubusercontent.com/channyeintun/next-editor/main/scripts/howard.sh | HOWARD_TALKER=Q4_K_M sh
```

| File                          |       Bytes | Use                  |
| ----------------------------- | ----------: | -------------------- |
| `Howard-0.6B-Q8_0.gguf`       | 992,615,488 | 8-bit talker         |
| `Howard-0.6B-Q4_K_M.gguf`     | 628,905,024 | smaller 4-bit talker |
| `Howard-12Hz-codec-Q8_0.gguf` | 291,150,624 | codec, for both      |

To remove Howard from the computer, delete `~/.howard`.

### Why not Ollama or LM Studio

Neither can run Howard (checked 2026-11-25):

- Ollama has a speech endpoint since v0.40.8, but only for its own Phonon
  models and the voices built into them. It has no way to load another speech
  model and none to clone a voice from a recording, which is how Howard keeps
  one narrator.
- LM Studio's server has no speech endpoint.

Howard's GGUF files are made for qwentts.cpp, which is what the script builds.

### By hand

On Windows, or to keep the files somewhere else, do the script's three steps
yourself:

```sh
pip install -U huggingface_hub
hf download aungzaythant/Howard-0.6B \
  gguf/Howard-0.6B-Q8_0.gguf gguf/Howard-12Hz-codec-Q8_0.gguf gguf/SHA256SUMS \
  --local-dir howard
(cd howard/gguf && shasum -a 256 --ignore-missing -c SHA256SUMS)

git clone https://github.com/ServeurpersoCom/qwentts.cpp.git
git -C qwentts.cpp checkout 2edb35f87b709a070b2d5379f77e5c52a1daa585
git -C qwentts.cpp submodule update --init --recursive
cmake -S qwentts.cpp -B qwentts.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_BLAS=ON
cmake --build qwentts.cpp/build --target tts-server -j 4

qwentts.cpp/build/tts-server \
  --model howard/gguf/Howard-0.6B-Q8_0.gguf \
  --codec howard/gguf/Howard-12Hz-codec-Q8_0.gguf \
  --host 127.0.0.1 --port 8080 --lang auto
```

The cmake flags above are for Apple silicon. On another system use that
repository's own build scripts (`buildcpu.sh`, `buildcuda.sh`,
`buildvulkan.sh`).

## Use it in Studio

Import a LessonScript whose locale is Burmese (`locale: my-MM`), choose
`မြန်မာ · Howard (on-device)`, and press **Check**. The panel shows
`Howard is running here: Howard-0.6B-Q8_0.gguf`. Then record or upload 3–20
seconds of clear narrator speech and render.

- **The browser may ask first.** On nexteditor.dev, Chrome asks whether the
  site may connect to apps on this device before the first request. Allow it:
  a refusal looks the same as a server that is not running. Under
  `bun run dev` the page is itself on this computer and nothing is asked.
- **Another port.** Start the server with `HOWARD_PORT=8090`, type
  `http://127.0.0.1:8090` in the panel and press Check. The address is kept in
  this browser.
- **The server can be off for a lesson already narrated.** The panel
  remembers the model the server last named, so a render whose dialogs are all
  in the dialog cache needs no server and no model in memory. A dialog that is
  missing stops the build with `Howard: no server answers at …`; start the
  server and render again, and the dialogs already made are kept.

## What keys a take

A dialog is synthesized once and reused while all of these stay the same:

- the model the server names: the talker's file name, or the name given with
  `--alias`. The 8-bit and the 4-bit talker speak differently, so switching
  between them makes new takes, and a render stops if the server now runs
  another talker than the panel showed;
- the narrator reference (its content hash);
- the request settings, fixed in `src/studio/tts/howard/protocol.ts` to the
  ones the model's notes run it with: `language: auto`, `temperature: 0.65`,
  `top_p: 0.90`, `subtalker_temperature: 0.15`;
- the dialog's text and the script's `build.seed`, which goes to the server as
  it is.

## How the voice is cloned

The reference is registered without a transcript, so the server takes the
speaker from the recording alone (its speaker embedding). That is the mode the
stock runtime supports for Howard. Howard's transcript-conditioned cloning
needs the model's `gguf/nonstreaming-icl.patch` and an environment variable;
with a transcript and no patch the stock runtime speaks unrelated words, so
the studio never sends one.

Only clone a voice you have the speaker's permission to use.

## Limits

- Each dialog is one request, spoken whole. The page allows a take ten seconds
  plus three codec frames a character, up to the engine's 2,048 frames (about
  164 s). A take that reaches its allowance did not end on its own, and the
  Director warns that the dialog "ran to the speech engine's length limit":
  split or reword it.
- The server keeps registered voices in memory. After a restart the page
  registers the reference again on its own.
- Offline narration packs (the Colab notebook) carry VoxCPM2 only.
