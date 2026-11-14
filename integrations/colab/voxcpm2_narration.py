# The source of voxcpm2_narration.ipynb, one "# %%" block per cell.
# Build the notebook with: bun scripts/build-voxcpm2-colab-notebook.ts
# Never edit the .ipynb by hand; edit this file (or narration_batch.py) and rebuild.

# %% [markdown]
# # Burmese narration for Next Editor, made on Colab
#
# The Next Editor studio narrates Burmese lessons with VoxCPM2. This notebook makes that
# narration on a Colab GPU instead of the project's hosted one.
#
# 1. In the studio: **Workflow → pick the lessons → Narrate on Google Colab → Export requests**.
#    It downloads `narration-requests-….json`.
# 2. Here: **Runtime → Change runtime type → T4 GPU** (or a faster GPU), then **Runtime → Run all**.
#    Step 5 asks for the file from step 1.
# 3. In the studio: **Import audio…** and choose the `audio-….zip` files this notebook wrote
#    (or the zip Google Drive makes when you download their folder).
#
# After that, renders of those lessons find every dialog in the browser and ask no speech
# service for it.
#
# **A session can end at any moment.** Colab does not promise how long a free session lasts.
# With the audio saved to Google Drive (the default), nothing is lost but the last few dialogs:
# run the notebook again with the same request file and it goes on from the takes already
# written. Keep this tab open while it works, and let step 8 finish before you download the
# audio or disconnect.
#
# **A part is not a lesson.** Each `audio-….zip` holds the next few dozen dialogs, so 36 parts
# are not 36 lessons. Steps 5, 7 and 8 print which lessons have all their audio, and the same is
# kept in `progress.txt` beside the parts. A lesson with some of its audio missing still renders,
# but the studio then asks its hosted voice for the missing dialogs.
#
# The notebook works as a batch you run yourself: it starts no server, opens no tunnel and
# serves nothing, which is what Colab's rules ask for. Use it only with your own voice, or a
# voice you have permission to use.

# %%
#@title 1. Settings { display-mode: "form" }
#@markdown Leave the path empty to upload the request file in step 5. To go on with a pack from an
#@markdown earlier session, paste the path step 5 printed then.
PACK_PATH = ""  #@param {type:"string"}
#@markdown Audio kept only on this runtime is lost when the session ends, finished or not.
SAVE_TO = "Google Drive"  #@param ["Google Drive", "This runtime (lost if the session ends)"]
DRIVE_FOLDER = "next-editor-narration"  #@param {type:"string"}
#@markdown FLAC is lossless and half the size of WAV; the studio reads both.
AUDIO_FORMAT = "flac"  #@param ["flac", "wav"]
#@markdown Takes are written out in parts of at most this many dialogs, so little is lost with a
#@markdown session. A part also ends where a lesson ends, and after ten minutes.
PART_DIALOGS = 25  #@param {type:"integer"}
#@markdown Untested: runs the model in float16, which a T4 computes faster than the model's own
#@markdown bfloat16. Its takes go to a separate `…-float16` folder, so they never mix with the
#@markdown others. Listen to step 6's sample; the studio cannot tell these takes from the hosted
#@markdown voice's once they are imported.
EXPERIMENTAL_FLOAT16 = False  #@param {type:"boolean"}

# %%
#@title 2. Engine settings (generated, nothing to change) { display-mode: "form" }
# @@GENERATED_CONSTANTS@@

# %%
#@title 3. Batch code (generated, nothing to change) { display-mode: "form" }
# @@NARRATION_BATCH@@

# %%
#@title 4. Install VoxCPM
import importlib.metadata
import subprocess
import sys


def installed(package):
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


if installed("voxcpm") != ENGINE["packageVersion"]:
    # Colab's own PyTorch stays: VoxCPM asks only for 2.5 or newer, and replacing a
    # GPU build of PyTorch costs minutes and can leave one that does not see the GPU.
    pins = [f"{name}=={installed(name)}" for name in ("torch", "torchaudio") if installed(name)]
    with open("voxcpm-constraints.txt", "w", encoding="utf-8") as constraints:
        constraints.write("\n".join(pins))
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--quiet",
            f"voxcpm=={ENGINE['packageVersion']}",
            "--constraint",
            "voxcpm-constraints.txt",
        ],
        check=True,
    )
print("voxcpm", installed("voxcpm"), "· torch", installed("torch"))

# %%
#@title 5. Open the request pack
import json
import os
import shutil
import tempfile

IN_COLAB = "google.colab" in sys.modules
USE_DRIVE = IN_COLAB and SAVE_TO == "Google Drive"

# Before the pack is opened: a pack from an earlier session is on Drive.
if IN_COLAB and (USE_DRIVE or PACK_PATH.strip().startswith("/content/drive")):
    from google.colab import drive

    drive.mount("/content/drive")



def require_output_folder():
    """Stop before work is written to a folder that only looks like Google Drive."""
    if USE_DRIVE and not os.path.ismount("/content/drive"):
        raise SystemExit("Google Drive is not mounted. Run step 5 again, then this cell.")


if PACK_PATH.strip():
    pack_path = PACK_PATH.strip()
    if not os.path.isfile(pack_path):
        raise SystemExit(
            f"{pack_path} was not found. Check the path, or empty PACK_PATH and upload the request file."
        )
elif IN_COLAB:
    from google.colab import files

    print("Choose the narration-requests-….json file the studio exported.")
    uploaded = files.upload()
    if not uploaded:
        raise SystemExit("No file was chosen. Run this cell again.")
    pack_path = next(iter(uploaded))
else:
    raise SystemExit("Set PACK_PATH in step 1 to the request pack's path.")

with open(pack_path, encoding="utf-8") as source:
    pack = load_pack(json.load(source), ENGINE, LIMITS)

if USE_DRIVE:
    output_root = os.path.join("/content/drive/MyDrive", DRIVE_FOLDER.strip() or "next-editor-narration")
else:
    output_root = os.path.abspath("narration")
# The float16 experiment gets a folder of its own: its takes must never count as
# finished for a run with the model's own number format, or the other way round.
OUT_DIR = os.path.join(
    output_root, pack_folder_name(pack) + ("-float16" if EXPERIMENTAL_FLOAT16 else "")
)
os.makedirs(OUT_DIR, exist_ok=True)

# The pack is kept beside its audio, so a later session can open it from there.
saved_pack = os.path.join(OUT_DIR, "requests.json")
if os.path.abspath(pack_path) != os.path.abspath(saved_pack):
    shutil.copyfile(pack_path, saved_pack)

REFERENCE_PATH = os.path.join(tempfile.gettempdir(), "narrator-reference.wav")
with open(REFERENCE_PATH, "wb") as reference_file:
    reference_file.write(pack.reference_wav)

todo, progress = pack_state(pack, OUT_DIR)
write_progress(OUT_DIR, progress)
print(
    f"{counted(len(pack.dialogs), 'dialog')} of {counted(len(progress.lessons), 'lesson')};"
    f" {len(todo)} still to synthesize."
)
print(describe_lessons(progress))
print(f"The audio goes to: {OUT_DIR}")
if USE_DRIVE:
    print(f"To go on in a later session, set PACK_PATH in step 1 to: {saved_pack}")
else:
    print(
        "This runtime's disk goes when the session ends: every take not downloaded in step 8 by"
        " then is lost, and a later session starts from the first dialog. Choose Google Drive in"
        " step 1 to keep them."
    )

# %%
#@title 6. Load the model and try two dialogs
import io
import zipfile

import soundfile
import torch
from huggingface_hub import snapshot_download
from voxcpm import VoxCPM

require_output_folder()
if not torch.cuda.is_available():
    raise SystemExit("This runtime has no GPU. Runtime > Change runtime type > T4 GPU, then run all again.")
print("GPU:", torch.cuda.get_device_name(0))

MODEL_DIR = snapshot_download(
    repo_id=ENGINE["model"], revision=ENGINE["modelRevision"], local_dir="VoxCPM2"
)
config_path = os.path.join(MODEL_DIR, "config.json")
original_config_path = config_path + ".original"
if EXPERIMENTAL_FLOAT16:
    if not os.path.exists(original_config_path):
        shutil.copyfile(config_path, original_config_path)
    with open(original_config_path, encoding="utf-8") as source:
        model_config = json.load(source)
    model_config["dtype"] = "float16"
    with open(config_path, "w", encoding="utf-8") as target:
        json.dump(model_config, target)
elif os.path.exists(original_config_path):
    shutil.copyfile(original_config_path, config_path)

# Eager inference without the denoiser, as the hosted synthesizer runs it: the compiled
# path spends minutes warming up at every start, and the narrator reference is clean.
model = VoxCPM.from_pretrained(MODEL_DIR, load_denoiser=False, optimize=False)
if int(model.tts_model.sample_rate) != ENGINE["sampleRate"]:
    raise SystemExit(f"Expected {ENGINE['sampleRate']} Hz audio from VoxCPM2, got {model.tts_model.sample_rate} Hz.")

synthesize = make_synthesizer(
    model,
    torch=torch,
    soundfile=soundfile,
    reference_path=REFERENCE_PATH,
    prompt=VOICE_DESIGN_PROMPT,
    engine=ENGINE,
    extension=AUDIO_FORMAT,
)

trial = run_batch(todo[:2], OUT_DIR, synthesize, extension=AUDIO_FORMAT, part_dialogs=1)
if todo:
    print(describe(trial, OUT_DIR))
else:
    print("Every dialog already has a take: nothing to try.")
todo, progress = pack_state(pack, OUT_DIR)
# The trial wrote parts too: the progress kept beside them must count those.
write_progress(OUT_DIR, progress)
if trial.synthesized:
    rest = seconds_for(sum(len(dialog.text) for dialog in todo), trial)
    print(f"At this pace the other {len(todo)} dialogs take about {duration(rest)}.")
    # Listen before the long run: this is the voice every dialog gets.
    from IPython.display import Audio, display

    with zipfile.ZipFile(trial.parts[0]) as part:
        samples, rate = soundfile.read(io.BytesIO(part.read(part.namelist()[0])))
    display(Audio(samples, rate=rate))

# %%
#@title 7. Synthesize everything
# Stop it whenever you like (Runtime > Interrupt execution): the takes made so far are
# written out, and running this cell again goes on from there.
require_output_folder()
todo, progress = pack_state(pack, OUT_DIR)
if todo:
    summary = run_batch(
        todo,
        OUT_DIR,
        synthesize,
        extension=AUDIO_FORMAT,
        part_dialogs=PART_DIALOGS,
        lessons=progress,
    )
    print(describe(summary, OUT_DIR))
else:
    print("Every dialog already has a take.")
print(describe_lessons(progress))

# %%
#@title 8. Get the audio
require_output_folder()
part_names = sorted(name for name in os.listdir(OUT_DIR) if PART_PATTERN.fullmatch(name))
megabytes = sum(os.path.getsize(os.path.join(OUT_DIR, name)) for name in part_names) / 1e6
left, progress = pack_state(pack, OUT_DIR)
write_progress(OUT_DIR, progress)
print(f"{len(part_names)} part(s), {megabytes:.0f} MB, in {OUT_DIR}")
print(describe_lessons(progress))
if left:
    print(f"{len(left)} dialog(s) still have no take: run step 7 again.")
    print(PARTS_NOTE)
if USE_DRIVE:
    # Drive takes files in the background; this waits until it has them all.
    print("Sending the last parts to Google Drive. Wait for this cell before you download or disconnect.")
    drive.flush_and_unmount()
    print("Google Drive has every part. To synthesize more, run step 5 again first: it mounts Drive again.")
elif IN_COLAB:
    from google.colab import files

    for name in part_names:
        files.download(os.path.join(OUT_DIR, name))
print(
    "In the studio: Workflow > Narrate on Google Colab > Import audio…, then choose the"
    " audio-….zip files (or the zip Google Drive makes when you download this folder)."
    " Pick the lessons there to see which of them still lack audio before you render."
)
