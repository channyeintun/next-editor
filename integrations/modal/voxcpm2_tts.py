"""Private VoxCPM2 Web Function for Next Editor Studio.

Deploy this file from the Modal workspace that should pay for inference. Modal
proxy authentication rejects requests before a GPU container starts; the
Cloudflare Worker is the only caller and holds the proxy token pair.
"""

from __future__ import annotations

import io

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

        self.model = VoxCPM.from_pretrained(MODEL_DIR, load_denoiser=False)
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

        if set(item) != {"text", "seed"}:
            raise HTTPException(status_code=400, detail="'text' and 'seed' are required")

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

        # VoxCPM 2.0.3 uses PyTorch's RNG but does not accept a `seed` keyword.
        # Reset it before each request so a shared Studio seed keeps independently
        # generated dialogs in the same voice. Do not log the lesson text.
        torch.manual_seed(seed)
        wav = self.model.generate(
            text=text.strip(),
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
