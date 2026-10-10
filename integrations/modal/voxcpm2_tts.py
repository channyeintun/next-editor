"""Private VoxCPM2 narration jobs for Next Editor Studio.

Deploy this file from the Modal workspace that should pay for inference. Modal
proxy authentication rejects requests before any container starts; the
Cloudflare Worker is the only caller and holds the proxy token pair.

A synthesis is a spawned job, not one long HTTP request. A cold L4 start spends
about a minute booting, loading the model, and warming up before the first
generation step, plus however long Modal waits for a free GPU. Cloudflare ends a
Worker subrequest that has not answered within its proxy read timeout (125 s)
with a 524, so a request held open across all of that failed on cold starts.
The Worker submits a job (`POST /jobs`) and polls it (`GET /jobs/{id}`) instead;
each poll waits at most POLL_WAIT_SECONDS here, far inside that timeout.

No `from __future__ import annotations`: FastAPI resolves route annotations
from module globals, and `Request` is imported inside `jobs()` so `modal deploy`
does not need FastAPI installed locally.
"""

import base64
import binascii
import io
import re
import tempfile
import traceback
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
# The page and the Worker share these four in src/studio/tts/voxcpm2Protocol.ts;
# change them there and here together.
MAX_SEED = 0x7FFFFFFF
REFERENCE_SAMPLE_RATE = 24_000
MIN_REFERENCE_SECONDS = 5
MAX_REFERENCE_SECONDS = 20
MAX_REFERENCE_WAV_BYTES = 44 + REFERENCE_SAMPLE_RATE * MAX_REFERENCE_SECONDS * 2
# How long one `GET /jobs/{id}` waits for the result before answering 202.
POLL_WAIT_SECONDS = 20
# Modal FunctionCall ids, e.g. "fc-01K…". Anything else is not a job of ours.
CALL_ID_PATTERN = re.compile(r"fc-[0-9A-Za-z]{1,64}")
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


def parse_synthesis_request(item: object) -> tuple[str, int, bytes]:
    """The validated (text, seed, reference WAV) of a synthesis request.

    Raises ValueError with a message that is safe to return to the caller.
    """
    if not isinstance(item, dict) or set(item) != {"text", "seed", "reference_audio_base64"}:
        raise ValueError("'text', 'seed', and reference audio are required")

    text = item["text"]
    seed = item["seed"]
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > MAX_TEXT_CHARS:
        raise ValueError(f"'text' must contain 1-{MAX_TEXT_CHARS} characters")
    if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0 or seed > MAX_SEED:
        raise ValueError(f"'seed' must be an integer between 0 and {MAX_SEED}")
    return text.strip(), seed, decode_reference_wav(item["reference_audio_base64"])


def wav_response(wav: bytes):
    from fastapi.responses import Response

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


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
        # L4 cold starts, which would outlast the Worker's whole wait for a
        # job. Eager CUDA inference avoids that while retaining GPU execution.
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

    def _render(self, text: str, seed: int, reference_wav: bytes) -> bytes:
        import soundfile as sf
        import torch

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
                text=f"({VOICE_DESIGN_PROMPT}) {text}",
                reference_wav_path=reference_file.name,
                cfg_value=CFG_VALUE,
                inference_timesteps=INFERENCE_TIMESTEPS,
            )

        output = io.BytesIO()
        sf.write(output, wav, SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return output.getvalue()

    @modal.method()
    def generate(self, text: str, seed: int, reference_wav: bytes) -> bytes:
        try:
            return self._render(text, seed, reference_wav)
        except Exception as error:
            # The jobs container has no torch, so a torch exception could not
            # be unpickled there. Log the real traceback here and hand the
            # poller a builtin it can always read.
            traceback.print_exc()
            raise RuntimeError(f"VoxCPM2 generation failed: {type(error).__name__}") from None

    # Legacy synchronous endpoint, kept only so a Worker deployed before /jobs
    # (or rolled back to one) keeps working. Remove it with the
    # VOXCPM2_MODAL_ENDPOINT secret once the jobs path is live.
    @modal.fastapi_endpoint(
        method="POST",
        requires_proxy_auth=True,
        docs=False,
    )
    def synthesize(self, item: dict):
        from fastapi import HTTPException

        try:
            text, seed, reference_wav = parse_synthesis_request(item)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return wav_response(self._render(text, seed, reference_wav))


jobs_image = modal.Image.debian_slim(python_version="3.11").uv_pip_install(
    "fastapi[standard]==0.116.1",
)


@app.function(image=jobs_image, timeout=60)
@modal.concurrent(max_inputs=20)
@modal.asgi_app(requires_proxy_auth=True)
def jobs():
    """Submit and poll narration jobs on a CPU container, never the GPU one.

    Requests are validated here, so a malformed one is rejected without
    starting an L4. Every route answers within POLL_WAIT_SECONDS plus overhead.
    """
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import JSONResponse, Response
    from grpclib.exceptions import StreamTerminatedError

    # Failing to reach Modal's API (after its own sub-second retries) says
    # nothing about the job, which keeps running and can still be collected:
    # answer 503 so the Worker polls the same job again instead of failing.
    unreachable = (
        modal.exception.ConnectionError,
        modal.exception.ServiceError,
        modal.exception.InternalError,
        modal.exception.ResourceExhaustedError,
        StreamTerminatedError,
        OSError,
    )

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def function_call(call_id: str) -> modal.FunctionCall:
        if not CALL_ID_PATTERN.fullmatch(call_id):
            raise HTTPException(status_code=404, detail="unknown synthesis job")
        return modal.FunctionCall.from_id(call_id)

    @web.post("/jobs", status_code=202)
    async def submit(request: Request):
        try:
            item = await request.json()
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid JSON body") from None
        try:
            text, seed, reference_wav = parse_synthesis_request(item)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        call = await VoxCpm2Tts().generate.spawn.aio(text, seed, reference_wav)
        return {"call_id": call.object_id}

    @web.get("/jobs/{call_id}")
    async def result(call_id: str):
        call = function_call(call_id)
        # Modal's own timeout errors are not builtin TimeoutErrors, so the
        # "not finished yet" case below cannot swallow them. Results stay
        # readable for 7 days and reading does not consume them, so a poll
        # whose response was lost can simply be repeated.
        try:
            wav = await call.get.aio(timeout=POLL_WAIT_SECONDS)
        except modal.exception.OutputExpiredError:
            raise HTTPException(status_code=410, detail="synthesis result expired") from None
        except modal.exception.FunctionTimeoutError:
            raise HTTPException(
                status_code=500, detail="synthesis exceeded the GPU time limit"
            ) from None
        except modal.exception.NotFoundError:
            raise HTTPException(status_code=404, detail="unknown synthesis job") from None
        except TimeoutError:
            return JSONResponse({"status": "pending"}, status_code=202)
        except unreachable as error:
            raise HTTPException(
                status_code=503, detail=f"Modal unreachable: {type(error).__name__}"
            ) from None
        except RuntimeError as error:
            raise HTTPException(status_code=500, detail=str(error)) from None
        except modal.exception.Error as error:
            raise HTTPException(
                status_code=500, detail=f"synthesis failed: {type(error).__name__}"
            ) from None
        return wav_response(wav)

    @web.delete("/jobs/{call_id}")
    async def cancel(call_id: str):
        # Frees the single L4 from a job the Worker gave up on. The container
        # itself stays up, so the next job does not pay another cold start.
        await function_call(call_id).cancel.aio()
        return Response(status_code=204)

    return web
