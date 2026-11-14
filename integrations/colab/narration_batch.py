"""Batch synthesis of a Next Editor narration request pack.

The studio exports the VoxCPM2 speech requests of one or many lessons as a JSON
"request pack" (src/studio/narrationPack/requestPack.ts). This module turns a
pack into audio: one take per dialog, named by the hash the pack gave it, in
zip parts the studio imports (src/studio/narrationPack/audioImport.ts).

It runs as one cell of the Colab notebook beside it (voxcpm2_narration.ipynb,
which is generated from this file), and has no server and no tunnel: a person
runs the notebook and it writes files. Everything here but `make_synthesizer`
is plain Python, so it is tested without a GPU (narration_batch_test.py).

The work can stop at any moment (Colab ends sessions without warning), so it
is written to be run again: finished takes are found in the parts already
written and skipped.
"""

import base64
import binascii
import io
import math
import os
import re
import time
import wave
import zipfile
from dataclasses import dataclass, field, replace

PACK_FORMAT = "next-editor-narration-requests"
PACK_VERSION = 1
# A take's name: the dialog cache's SHA-256 key for it, lowercase hex.
HASH_PATTERN = re.compile(r"[0-9a-f]{64}")
PART_PATTERN = re.compile(r"audio-(\d{4,})\.zip")
AUDIO_FORMATS = {"flac": "FLAC", "wav": "WAV"}
# The studio throws away a take with no sample above this share of full scale.
SILENCE_PEAK = 0.004
# What to do when the output folder stops answering.
STORAGE_HINT = "If the audio goes to Google Drive, run step 5 again: it mounts Drive again"
# Kept beside the parts: which lessons have all their audio, in words.
PROGRESS_FILE = "progress.txt"
PARTS_NOTE = (
    "A part (audio-0001.zip, audio-0002.zip, ...) holds a few dozen dialogs, not one lesson:"
    " the number of parts does not say how many lessons are finished."
)


class PackError(ValueError):
    """The request pack cannot be synthesized as it is; the message says why."""


@dataclass(frozen=True)
class Dialog:
    hash: str
    lesson: str
    text: str
    seed: int
    # Later lessons of the pack that say this same dialog: one take serves them all.
    shared_with: tuple[str, ...] = ()

    @property
    def lessons(self) -> tuple[str, ...]:
        """Every lesson that needs this take, the one the pack files it under first."""
        return (self.lesson, *self.shared_with)


@dataclass(frozen=True)
class Pack:
    created_at: str
    reference_wav: bytes
    dialogs: tuple[Dialog, ...]


def _reference_wav_of(reference: object, limits: dict) -> bytes:
    if not isinstance(reference, dict) or not isinstance(reference.get("wavBase64"), str):
        raise PackError("the pack has no narrator reference recording")
    try:
        reference_wav = base64.b64decode(reference["wavBase64"], validate=True)
    except (binascii.Error, ValueError) as error:
        raise PackError("the narrator reference is not valid base64") from error
    try:
        with wave.open(io.BytesIO(reference_wav), "rb") as reader:
            rate = reader.getframerate()
            if (
                reader.getnchannels() != 1
                or reader.getsampwidth() != 2
                or reader.getcomptype() != "NONE"
                or rate != limits["referenceSampleRate"]
                or rate != reference.get("sampleRate")
            ):
                raise PackError(
                    f"the narrator reference must be a mono {limits['referenceSampleRate']} Hz PCM16 WAV"
                )
            seconds = reader.getnframes() / rate
    except (EOFError, wave.Error) as error:
        raise PackError("the narrator reference is not a valid WAV") from error
    if not limits["minReferenceSeconds"] <= seconds <= limits["maxReferenceSeconds"]:
        raise PackError(
            f"the narrator reference must hold {limits['minReferenceSeconds']}-"
            f"{limits['maxReferenceSeconds']} seconds of speech, not {seconds:.1f}"
        )
    return reference_wav


def _dialog_of(item: object, position: int, limits: dict) -> Dialog:
    where = f"dialog {position}"
    if not isinstance(item, dict):
        raise PackError(f"{where} is not an object")
    digest, text, seed, lesson = item.get("hash"), item.get("text"), item.get("seed"), item.get("lesson")
    if not isinstance(digest, str) or not HASH_PATTERN.fullmatch(digest):
        raise PackError(f"{where} has no valid request hash")
    if not isinstance(text, str) or not text.strip() or len(text.strip()) > limits["maxTextChars"]:
        raise PackError(f"{where} must have 1-{limits['maxTextChars']} characters of text")
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= limits["maxSeed"]:
        raise PackError(f"{where} must have a seed between 0 and {limits['maxSeed']}")
    lesson = lesson if isinstance(lesson, str) and lesson else "lesson"
    shared = item.get("sharedWith")
    return Dialog(
        hash=digest,
        lesson=lesson,
        text=text.strip(),
        seed=seed,
        shared_with=_merged((), shared if isinstance(shared, list) else [], lesson),
    )


def _merged(known: tuple[str, ...], more, lesson: str) -> tuple[str, ...]:
    """`known` with the lesson names in `more` it lacks, never `lesson` itself."""
    merged = list(known)
    for name in more:
        if isinstance(name, str) and name and name != lesson and name not in merged:
            merged.append(name)
    return tuple(merged)


def load_pack(data: object, engine: dict, limits: dict) -> Pack:
    """The validated pack. `engine` is what this notebook synthesizes with.

    A take is only the one its hash names when it is made by the engine the
    studio hashed, so a pack that asks for another engine is refused: the
    notebook and the studio are then from different versions of the project.
    """
    if not isinstance(data, dict) or data.get("format") != PACK_FORMAT:
        raise PackError("this file is not a Next Editor narration request pack")
    if data.get("version") != PACK_VERSION:
        raise PackError(
            f"this pack is version {data.get('version')!r} and this notebook reads version {PACK_VERSION}: "
            "open the current notebook from the repository"
        )
    asked = data.get("engine")
    if not isinstance(asked, dict):
        raise PackError("the pack does not say which engine its takes need")
    differences = [
        f"{key}: the pack asks for {asked.get(key)!r}, this notebook has {value!r}"
        for key, value in engine.items()
        if asked.get(key) != value
    ]
    if differences or set(asked) != set(engine):
        raise PackError(
            "this pack and this notebook are from different versions of the project "
            "(open the current notebook from the repository, or export the pack again): "
            + "; ".join(differences or ["the engine settings differ"])
        )
    items = data.get("dialogs")
    if not isinstance(items, list) or not items:
        raise PackError("the pack has no dialogs")
    dialogs: dict[str, Dialog] = {}
    for position, item in enumerate(items, start=1):
        dialog = _dialog_of(item, position, limits)
        first = dialogs.get(dialog.hash)
        if first is None:
            dialogs[dialog.hash] = dialog
        else:
            # One take per hash, and every lesson that asked for it still counts on it.
            dialogs[dialog.hash] = replace(
                first, shared_with=_merged(first.shared_with, dialog.lessons, first.lesson)
            )
    created_at = data.get("createdAt")
    return Pack(
        created_at=created_at if isinstance(created_at, str) else "",
        reference_wav=_reference_wav_of(data.get("reference"), limits),
        dialogs=tuple(dialogs.values()),
    )


def pack_folder_name(pack: Pack) -> str:
    """A folder name for the pack's output that is the same in every session."""
    stamp = re.sub(r"[^0-9A-Za-z]+", "-", pack.created_at).strip("-")
    return f"pack-{stamp}" if stamp else "pack"


def _part_paths(out_dir: str) -> list[tuple[int, str]]:
    parts = []
    for name in os.listdir(out_dir) if os.path.isdir(out_dir) else []:
        match = PART_PATTERN.fullmatch(name)
        if match:
            parts.append((int(match.group(1)), os.path.join(out_dir, name)))
    return sorted(parts)


def finished_hashes(out_dir: str, log=print) -> set[str]:
    """The takes already in the parts written to `out_dir`.

    A part that is not a whole zip is set aside as `.bad`, and its takes are
    synthesized again. A folder that cannot be read at all (a mounted drive that
    dropped) is another matter: that raises, so good parts are not set aside for
    a passing error.
    """
    finished: set[str] = set()
    for _, path in _part_paths(out_dir):
        try:
            # The directory at the end of the file is enough: a part is renamed
            # into place only once it is whole, and reading every take back from
            # a mounted drive would cost minutes at each start.
            with zipfile.ZipFile(path) as part:
                names = part.namelist()
        except zipfile.BadZipFile as error:
            log(f"Setting aside {os.path.basename(path)}: {error}")
            os.replace(path, path + ".bad")
            continue
        except OSError as error:
            raise OSError(f"could not read {path} ({error}). {STORAGE_HINT}") from error
        for name in names:
            stem, _, extension = name.rpartition(".")
            if extension in AUDIO_FORMATS and HASH_PATTERN.fullmatch(stem):
                finished.add(stem)
    return finished


class LessonProgress:
    """How many of each lesson's dialogs have a take written, in the pack's order.

    The parts in a folder do not show this: a part holds the next few dozen
    dialogs, whichever lessons they belong to. A lesson can be rendered without
    a speech service only once every one of its dialogs has a take.
    """

    def __init__(self, dialogs, finished=()):
        dialogs = list(dialogs)
        self._lessons_of: dict[str, tuple[str, ...]] = {}
        self._total: dict[str, int] = {}
        self._written: dict[str, int] = {}
        self._hashes: set[str] = set()
        # The pack's order is the order of the lessons its dialogs are filed under; a
        # lesson that only shares dialogs with earlier ones comes after them.
        for dialog in dialogs:
            self._total.setdefault(dialog.lesson, 0)
        for dialog in dialogs:
            # A dialog two lessons say is one take, and each of them needs it.
            self._lessons_of[dialog.hash] = dialog.lessons
            for lesson in dialog.lessons:
                self._total[lesson] = self._total.get(lesson, 0) + 1
        self._written = dict.fromkeys(self._total, 0)
        self.add(finished)

    def add(self, hashes) -> list[str]:
        """Count these takes as written; returns the lessons they completed."""
        completed = []
        for digest in hashes:
            if digest in self._hashes:
                continue
            self._hashes.add(digest)
            for lesson in self._lessons_of.get(digest, ()):
                self._written[lesson] += 1
                if self._written[lesson] == self._total[lesson]:
                    completed.append(lesson)
        return completed

    def completes(self, hashes) -> bool:
        """Whether writing these takes would complete a lesson."""
        staged: dict[str, int] = {}
        for digest in set(hashes) - self._hashes:
            for lesson in self._lessons_of.get(digest, ()):
                staged[lesson] = staged.get(lesson, 0) + 1
        return any(
            count == self._total[lesson] - self._written[lesson] for lesson, count in staged.items()
        )

    @property
    def lessons(self) -> list[tuple[str, int, int]]:
        """(lesson, dialogs with a take, dialogs) for every lesson, in the pack's order."""
        return [(lesson, self._written[lesson], total) for lesson, total in self._total.items()]

    @property
    def complete(self) -> int:
        """The number of lessons with a take for every dialog."""
        return sum(1 for _, written, total in self.lessons if written == total)


def counted(number: int, one: str) -> str:
    """`number` with its noun, singular for one: "1 dialog", "2 dialogs"."""
    return f"{number} {one}" if number == 1 else f"{number} {one}s"


def describe_lessons(progress: LessonProgress) -> str:
    """Which lessons have all their audio, for the notebook to print.

    A dialog two lessons share counts for each of them, so the dialogs counted
    here can be more than the takes in the parts.
    """
    lessons = progress.lessons
    if len(lessons) == 1:
        lesson, written, total = lessons[0]
        if written == total:
            return f"The one lesson, {lesson}, has all its audio ({counted(total, 'dialog')})."
        return f"The one lesson, {lesson}, has {written} of its {counted(total, 'dialog')}."
    written = sum(count for _, count, _ in lessons)
    total = sum(count for _, _, count in lessons)
    if progress.complete == len(lessons):
        return f"All {len(lessons)} lessons have all their audio ({counted(total, 'dialog')})."
    lines = [
        f"{progress.complete} of {len(lessons)} lessons have all their audio"
        f" ({written} of {counted(total, 'dialog')})."
    ]
    # Lessons in a row that are complete, or that have nothing, share a line.
    runs: list[tuple[str, list[str]]] = []
    for lesson, count, of in lessons:
        if 0 < count < of:
            runs.append((f"{count} of {counted(of, 'dialog')}", [lesson]))
            continue
        state = "complete" if count == of else "no audio yet"
        if runs and runs[-1][0] == state:
            runs[-1][1].append(lesson)
        else:
            runs.append((state, [lesson]))
    for state, names in runs:
        span = names[0] if len(names) == 1 else f"{names[0]} ... {names[-1]} ({len(names)} lessons)"
        lines.append(f"  {state}: {span}")
    return "\n".join(lines)


def write_progress(out_dir: str, progress: LessonProgress) -> None:
    """Leave the lessons' progress beside the parts, for whoever opens the folder.

    Never raises: the parts are what matters, and a folder that is gone is
    reported by the next part that cannot be written.
    """
    text = "\n".join(
        [
            describe_lessons(progress),
            "",
            PARTS_NOTE,
            "Import every part into the studio. Its Narrate on Google Colab section then shows"
            " which of the lessons you pick still lack audio.",
            "",
        ]
    )
    path = os.path.join(out_dir, PROGRESS_FILE)
    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(path + ".partial", "w", encoding="utf-8") as target:
            target.write(text)
        os.replace(path + ".partial", path)
    except OSError:
        pass


def pack_state(pack: Pack, out_dir: str, log=print) -> tuple[list[Dialog], LessonProgress]:
    """The dialogs with no take in `out_dir` yet, and the lessons' progress.

    Both come from one reading of the parts: on a mounted drive each reading
    opens every part.
    """
    finished = finished_hashes(out_dir, log)
    pending = [dialog for dialog in pack.dialogs if dialog.hash not in finished]
    return pending, LessonProgress(pack.dialogs, finished)


def pending_dialogs(pack: Pack, out_dir: str, log=print) -> list[Dialog]:
    """The pack's dialogs that have no take in `out_dir` yet, in the pack's order."""
    return pack_state(pack, out_dir, log)[0]


def write_part(out_dir: str, takes: list[tuple[str, bytes]], extension: str) -> str:
    """Write these takes as the next `audio-NNNN.zip` part; returns its path.

    The part appears under its name only once it is whole, so a session that
    ends mid-write leaves no half part behind for the studio to trip over.
    """
    os.makedirs(out_dir, exist_ok=True)
    parts = _part_paths(out_dir)
    number = parts[-1][0] + 1 if parts else 1
    path = os.path.join(out_dir, f"audio-{number:04d}.zip")
    partial = path + ".partial"
    # The audio is already compressed (FLAC) or does not compress (PCM): store it.
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_STORED) as part:
        for digest, audio in takes:
            part.writestr(f"{digest}.{extension}", audio)
    os.replace(partial, path)
    return path


def duration(seconds: float) -> str:
    minutes = int(round(seconds / 60))
    hours, minutes = divmod(minutes, 60)
    return f"{hours} h {minutes:02d} min" if hours else f"{minutes} min"


@dataclass
class RunSummary:
    synthesized: int = 0
    # Characters of text in the synthesized dialogs: what the time left is judged by.
    characters: int = 0
    audio_seconds: float = 0.0
    work_seconds: float = 0.0
    failed: list[tuple[Dialog, str]] = field(default_factory=list)
    parts: list[str] = field(default_factory=list)
    # Why the run ended before the last dialog, or None.
    stopped: str | None = None

    @property
    def speed(self) -> float | None:
        """Seconds of work per second of audio, or None before the first take."""
        return self.work_seconds / self.audio_seconds if self.audio_seconds else None


def seconds_for(characters: int, summary: RunSummary) -> float:
    """The time `characters` more of text take at the pace of the run so far."""
    return characters * summary.work_seconds / summary.characters if summary.characters else 0.0


def run_batch(
    dialogs: list[Dialog],
    out_dir: str,
    synthesize,
    *,
    extension: str = "flac",
    part_dialogs: int = 25,
    part_seconds: float = 600.0,
    max_consecutive_failures: int = 5,
    lessons: LessonProgress | None = None,
    clock=time.monotonic,
    log=print,
) -> RunSummary:
    """Synthesize `dialogs` into zip parts in `out_dir`.

    `synthesize(dialog)` returns (encoded audio, seconds of audio). A dialog it
    raises on is reported and skipped; several in a row end the run, since the
    cause is then the runtime (out of memory, a lost GPU) and not the dialog.
    Takes are written out every `part_dialogs` dialogs or `part_seconds`
    seconds, and when the run is interrupted, so little is lost with a session.

    With `lessons` (the pack's progress so far), a part is also written when a
    lesson's last take is made, each lesson is named in the log once all its
    audio is written, and the progress is kept in a file beside the parts.
    """
    if extension not in AUDIO_FORMATS:
        raise ValueError(f"unknown audio format {extension!r}")
    summary = RunSummary()
    staged: list[tuple[str, bytes]] = []
    last_write = clock()
    total_characters = sum(len(dialog.text) for dialog in dialogs)
    consecutive_failures = 0

    def write_staged() -> bool:
        """Write the staged takes out. False when the folder cannot be written."""
        nonlocal last_write
        if staged:
            try:
                summary.parts.append(write_part(out_dir, staged, extension))
            except OSError as error:
                # The takes are gone with this run: say so, and do not count them.
                summary.synthesized -= len(staged)
                summary.stopped = (
                    f"could not write to {out_dir} ({error}); the last {len(staged)} take(s)"
                    f" were not saved. {STORAGE_HINT}"
                )
                staged.clear()
                return False
            # The takes are on disk: nothing below may leave them staged, or an
            # interrupt there would write them out a second time on the way out.
            written = [digest for digest, _ in staged]
            staged.clear()
            if lessons is not None:
                for lesson in lessons.add(written):
                    log(
                        f"{lesson}: all its audio is written"
                        f" ({lessons.complete} of {counted(len(lessons.lessons), 'lesson')})."
                    )
                write_progress(out_dir, lessons)
        last_write = clock()
        return True

    try:
        for position, dialog in enumerate(dialogs, start=1):
            started = clock()
            try:
                audio, seconds = synthesize(dialog)
            except Exception as error:  # noqa: BLE001 - one bad dialog must not end the batch
                summary.failed.append((dialog, f"{type(error).__name__}: {error}"))
                log(f"[{position}/{len(dialogs)}] {dialog.lesson}: failed, {type(error).__name__}: {error}")
                consecutive_failures += 1
                if consecutive_failures >= max_consecutive_failures:
                    summary.stopped = f"{consecutive_failures} dialogs failed in a row"
                    break
                continue
            consecutive_failures = 0
            took = clock() - started
            staged.append((dialog.hash, audio))
            summary.synthesized += 1
            summary.audio_seconds += seconds
            summary.work_seconds += took
            summary.characters += len(dialog.text)
            remaining = seconds_for(total_characters - summary.characters, summary)
            log(
                f"[{position}/{len(dialogs)}] {dialog.lesson}: {seconds:.1f} s of audio in {took:.1f} s"
                f" ({summary.speed:.1f}x) · about {duration(remaining)} left"
            )
            if (
                len(staged) >= part_dialogs
                or clock() - last_write >= part_seconds
                or (lessons is not None and lessons.completes(digest for digest, _ in staged))
            ):
                if not write_staged():
                    break
    except KeyboardInterrupt:
        summary.stopped = "interrupted"
    finally:
        write_staged()
    return summary


def describe(summary: RunSummary, out_dir: str) -> str:
    """What a run did, for the notebook to print."""
    lines = [
        f"Synthesized {summary.synthesized} dialogs: {duration(summary.audio_seconds)} of audio"
        f" in {duration(summary.work_seconds)}"
        + (f" ({summary.speed:.1f} s of work per second of audio)." if summary.speed else "."),
        f"Wrote {len(summary.parts)} part(s) to {out_dir}",
    ]
    if summary.failed:
        lines.append(f"{len(summary.failed)} dialog(s) failed and have no take:")
        lines += [f"  {dialog.lesson} {dialog.hash[:12]}: {reason}" for dialog, reason in summary.failed[:10]]
    if summary.stopped:
        lines.append(f"Stopped early: {summary.stopped}. Then run this cell again to go on from here.")
    return "\n".join(lines)


def make_synthesizer(
    model,
    *,
    torch,
    soundfile,
    reference_path: str,
    prompt: str,
    engine: dict,
    extension: str = "flac",
):
    """`synthesize(dialog)` for `run_batch`, as the project's hosted synthesizer does it.

    The same call as integrations/modal/voxcpm2_tts.py: the delivery prompt in
    parentheses before the text, the narrator reference, the seed set before
    each dialog. A GPU of another kind does not reproduce the hosted take
    sample for sample; it is a take of the same request all the same.
    """
    sample_rate = int(engine["sampleRate"])

    def synthesize(dialog: Dialog) -> tuple[bytes, float]:
        torch.manual_seed(dialog.seed)
        wav = model.generate(
            text=f"({prompt}) {dialog.text}",
            reference_wav_path=reference_path,
            cfg_value=float(engine["cfgValue"]),
            inference_timesteps=int(engine["inferenceTimesteps"]),
        )
        if len(wav) == 0:
            raise ValueError("the model returned no audio")
        peak = float(abs(wav).max())
        # NaN compares false with everything, so it would pass the silence test.
        if not math.isfinite(peak):
            raise ValueError("the model returned samples that are not numbers")
        if peak <= SILENCE_PEAK:
            raise ValueError("the model returned silence")
        encoded = io.BytesIO()
        soundfile.write(encoded, wav, sample_rate, format=AUDIO_FORMATS[extension], subtype="PCM_16")
        return encoded.getvalue(), len(wav) / sample_rate

    return synthesize
