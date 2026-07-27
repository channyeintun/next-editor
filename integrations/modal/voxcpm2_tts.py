"""Private VoxCPM2 Web Function for Next Editor Studio.

Deploy this file from the Modal workspace that should pay for inference. Modal
proxy authentication rejects requests before a GPU container starts; the
Cloudflare Worker is the only caller and holds the proxy token pair.
"""

from __future__ import annotations

import base64
import binascii
import io
import tempfile
import wave

import modal

APP_NAME = "next-editor-voxcpm2"
MODEL_ID = "openbmb/VoxCPM2"
MODEL_REVISION = "bffb3df5a29440629464e5e839f4d214c8714c3d"
MODEL_DIR = "/opt/models/VoxCPM2"
VOXCPM_VERSION = "2.0.3"
SAMPLE_RATE = 48_000
CFG_VALUE = 2.0
INFERENCE_TIMESTEPS = 10
MAX_TEXT_CHARS = 2_000
MAX_SEED = 0x7FFFFFFF
REFERENCE_SAMPLE_RATE = 24_000
MIN_REFERENCE_SECONDS = 5
MAX_REFERENCE_SECONDS = 20
MAX_REFERENCE_WAV_BYTES = 44 + REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS * 2
# Delivery is pinned here, server-side, so a lesson's narration cannot drift
# with a client-supplied prompt.
#
# v1 asked for a "warm educator" with a "steady pace" for "technical teaching".
# Every part of that describes a lecture: an educator addresses a room, and a
# steady pace is exactly what reading aloud sounds like, because the rhythm
# comes from the page instead of the thought. The model obliged and recited.
#
# v2 stopped the reciting, but paid for it in mood words — "warm, relaxed",
# "slower on the point that matters", pauses "where someone would stop to
# gather it". The model delivered precisely that: soft, slow, and sleepy.
#
# v3 keeps only the register (one developer talking to one friend) and hands
# rate, energy, and pitch back to the reference recording, which already
# carries the delivery this narration wants. No adjective here sets a mood.
#
# Changing this text REQUIRES bumping `voiceDesignId` in
# src/studio/tts/profiles.ts. That id is what carries the prompt version into
# the TTS request hash; without the bump every already-synthesized dialog keeps
# its old delivery from the browser cache and the change appears to do nothing.
VOICE_DESIGN_PROMPT = (
    "Speak in the reference recording's own delivery — the same speaking rate, "
    "the same energy, the same pitch range — as if that speaker had simply "
    "kept talking. A Burmese software developer telling a friend how something "
    "works, at full conversational speed: alert, direct, and quick to move "
    "from one sentence into the next. Never soft, hushed, drowsy, or drawn "
    "out; never lecturing or reciting"
)


def decode_reference_wav(encoded: object) -> bytes:
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("reference audio is required")
    if len(encoded) > ((MAX_REFERENCE_WAV_BYTES + 2) // 3) * 4:
        raise ValueError("reference audio is too large")
    try:
        reference_wav = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("reference audio is not valid base64") from error

    try:
        with wave.open(io.BytesIO(reference_wav), "rb") as reader:
            frame_rate = reader.getframerate()
            if (
                reader.getnchannels() != 1
                or reader.getsampwidth() != 2
                or frame_rate != REFERENCE_SAMPLE_RATE
                or reader.getcomptype() != "NONE"
            ):
                raise ValueError("reference audio must be a mono 24 kHz PCM16 WAV")
            duration_seconds = reader.getnframes() / frame_rate
            if not MIN_REFERENCE_SECONDS <= duration_seconds <= MAX_REFERENCE_SECONDS:
                raise ValueError(
                    f"reference audio must contain {MIN_REFERENCE_SECONDS}–"
                    f"{MAX_REFERENCE_SECONDS} seconds of speech"
                )
    except (EOFError, wave.Error) as error:
        raise ValueError("reference audio must be a valid WAV") from error
    return reference_wav


def download_model() -> None:
    """Bake an immutable model snapshot into the image for faster cold starts."""
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        local_dir=MODEL_DIR,
    )


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .uv_pip_install(
        f"voxcpm=={VOXCPM_VERSION}",
        "fastapi[standard]==0.116.1",
    )
    .run_function(download_model)
)

app = modal.App(APP_NAME)


@app.cls(
    image=image,
    gpu="L4",
    max_containers=1,
    scaledown_window=60,
    timeout=600,
)
class VoxCpm2Tts:
    @modal.enter()
    def load_model(self) -> None:
        from voxcpm import VoxCPM

        # VoxCPM's optimized path runs a multi-minute torch.compile warm-up on
        # L4 cold starts, which exceeds the Modal Web Function proxy deadline.
        # Eager CUDA inference avoids that 524 while retaining GPU execution.
        self.model = VoxCPM.from_pretrained(
            MODEL_DIR,
            load_denoiser=False,
            optimize=False,
        )
        sample_rate = int(self.model.tts_model.sample_rate)
        if sample_rate != SAMPLE_RATE:
            raise RuntimeError(
                f"Expected VoxCPM2 to output {SAMPLE_RATE} Hz audio, got {sample_rate} Hz"
            )

    @modal.fastapi_endpoint(
        method="POST",
        requires_proxy_auth=True,
        docs=False,
    )
    def synthesize(self, item: dict):
        from fastapi import HTTPException
        from fastapi.responses import Response
        import soundfile as sf
        import torch

        if set(item) != {"text", "seed", "reference_audio_base64"}:
            raise HTTPException(
                status_code=400,
                detail="'text', 'seed', and reference audio are required",
            )

        text = item.get("text")
        seed = item.get("seed")
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=400,
                detail=f"'text' must contain 1-{MAX_TEXT_CHARS} characters",
            )
        if (
            isinstance(seed, bool)
            or not isinstance(seed, int)
            or seed < 0
            or seed > MAX_SEED
        ):
            raise HTTPException(
                status_code=400,
                detail=f"'seed' must be an integer between 0 and {MAX_SEED}",
            )
        try:
            reference_wav = decode_reference_wav(item.get("reference_audio_base64"))
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        # VoxCPM 2.0.3 uses PyTorch's RNG but does not accept a `seed` keyword.
        # Reset it before each request so a shared Studio seed keeps independently
        # generated dialogs reproducible. The same reference recording fixes the
        # speaker identity; the server-pinned prompt fixes delivery. Do not log
        # either the lesson text or reference audio.
        with tempfile.NamedTemporaryFile(suffix=".wav") as reference_file:
            reference_file.write(reference_wav)
            reference_file.flush()
            torch.manual_seed(seed)
            wav = self.model.generate(
                text=f"({VOICE_DESIGN_PROMPT}) {text.strip()}",
                reference_wav_path=reference_file.name,
                cfg_value=CFG_VALUE,
                inference_timesteps=INFERENCE_TIMESTEPS,
            )

        output = io.BytesIO()
        sf.write(output, wav, SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return Response(
            content=output.getvalue(),
            media_type="audio/wav",
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
