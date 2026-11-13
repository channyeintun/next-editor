"""Tests for narration_batch.py with a stand-in model: no GPU and nothing to install.

    python3 integrations/colab/narration_batch_test.py
"""

import base64
import io
import os
import sys
import tempfile
import unittest
import wave
import zipfile

# Running the tests must not leave compiled files beside the sources.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import narration_batch as nb  # noqa: E402

ENGINE = {
    "model": "openbmb/VoxCPM2",
    "modelRevision": "rev",
    "packageVersion": "2.0.3",
    "voiceDesignId": "burmese-educator-v3",
    "cfgValue": 2,
    "inferenceTimesteps": 10,
    "sampleRate": 48000,
}
LIMITS = {
    "maxTextChars": 2000,
    "maxSeed": 0x7FFFFFFF,
    "referenceSampleRate": 24000,
    "minReferenceSeconds": 5,
    "maxReferenceSeconds": 20,
}


def reference_wav(seconds=6.0, rate=24000, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(2)
        writer.setframerate(rate)
        writer.writeframes(b"\x01\x00" * int(seconds * rate) * channels)
    return buffer.getvalue()


def digest(number):
    return f"{number:064x}"


def pack_data(count=3, **overrides):
    data = {
        "format": nb.PACK_FORMAT,
        "version": nb.PACK_VERSION,
        "createdAt": "2026-11-14T03:40:42.000Z",
        "engine": dict(ENGINE),
        "reference": {"sampleRate": 24000, "wavBase64": base64.b64encode(reference_wav()).decode()},
        "dialogs": [
            {"hash": digest(i), "lesson": f"lesson-{i % 2}", "text": f" dialog {i} ", "seed": 8100 + i}
            for i in range(1, count + 1)
        ],
    }
    data.update(overrides)
    return data


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class LoadPack(unittest.TestCase):
    def test_reads_a_pack_and_trims_its_text(self):
        pack = nb.load_pack(pack_data(), ENGINE, LIMITS)
        self.assertEqual([d.text for d in pack.dialogs], ["dialog 1", "dialog 2", "dialog 3"])
        self.assertEqual(pack.dialogs[0].seed, 8101)
        self.assertEqual(nb.pack_folder_name(pack), "pack-2026-11-14T03-40-42-000Z")

    def test_keeps_one_take_per_hash(self):
        data = pack_data()
        data["dialogs"].append(dict(data["dialogs"][0], lesson="another"))
        self.assertEqual(len(nb.load_pack(data, ENGINE, LIMITS).dialogs), 3)

    def test_an_integer_setting_matches_the_same_number_as_a_float(self):
        nb.load_pack(pack_data(engine=dict(ENGINE, cfgValue=2.0)), ENGINE, LIMITS)

    def test_refuses_what_it_cannot_synthesize_as_asked(self):
        cases = {
            "not a Next Editor": pack_data(format="something-else"),
            "version": pack_data(version=2),
            "voiceDesignId": pack_data(engine=dict(ENGINE, voiceDesignId="burmese-educator-v4")),
            "different versions": pack_data(engine={k: v for k, v in ENGINE.items() if k != "model"}),
            "no dialogs": pack_data(dialogs=[]),
            "request hash": pack_data(dialogs=[{"hash": "../../etc/passwd", "text": "a", "seed": 1}]),
            "characters of text": pack_data(dialogs=[{"hash": digest(1), "text": "x" * 2001, "seed": 1}]),
            "seed": pack_data(dialogs=[{"hash": digest(1), "text": "a", "seed": True}]),
            "no narrator reference": pack_data(reference=None),
            "not valid base64": pack_data(reference={"sampleRate": 24000, "wavBase64": "***"}),
            "not a valid WAV": pack_data(
                reference={"sampleRate": 24000, "wavBase64": base64.b64encode(b"nope").decode()}
            ),
            "mono 24000 Hz": pack_data(
                reference={
                    "sampleRate": 24000,
                    "wavBase64": base64.b64encode(reference_wav(rate=48000)).decode(),
                }
            ),
            "seconds of speech": pack_data(
                reference={
                    "sampleRate": 24000,
                    "wavBase64": base64.b64encode(reference_wav(seconds=2)).decode(),
                }
            ),
        }
        for message, data in cases.items():
            with self.subTest(message), self.assertRaisesRegex(nb.PackError, message):
                nb.load_pack(data, ENGINE, LIMITS)


class Parts(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.folder.name, "out")
        self.addCleanup(self.folder.cleanup)

    def test_parts_are_numbered_on_and_read_back(self):
        first = nb.write_part(self.out, [(digest(1), b"one"), (digest(2), b"two")], "flac")
        second = nb.write_part(self.out, [(digest(3), b"three")], "flac")
        self.assertEqual(os.path.basename(first), "audio-0001.zip")
        self.assertEqual(os.path.basename(second), "audio-0002.zip")
        self.assertEqual(nb.finished_hashes(self.out), {digest(1), digest(2), digest(3)})
        with zipfile.ZipFile(first) as part:
            self.assertEqual(part.read(f"{digest(1)}.flac"), b"one")
            self.assertEqual(part.getinfo(f"{digest(1)}.flac").compress_type, zipfile.ZIP_STORED)
        self.assertEqual(sorted(os.listdir(self.out)), ["audio-0001.zip", "audio-0002.zip"])
        self.assertFalse([name for name in os.listdir(self.out) if name.endswith(".partial")])

    def test_a_folder_that_does_not_exist_has_no_takes(self):
        self.assertEqual(nb.finished_hashes(self.out), set())

    def test_a_part_that_cannot_be_read_just_now_is_left_in_place(self):
        part = nb.write_part(self.out, [(digest(1), b"one")], "flac")
        real_zipfile = nb.zipfile.ZipFile

        def unreadable(path, *arguments, **options):
            raise OSError(5, "Input/output error")

        nb.zipfile.ZipFile = unreadable
        self.addCleanup(setattr, nb.zipfile, "ZipFile", real_zipfile)
        with self.assertRaisesRegex(OSError, "run step 5 again"):
            nb.finished_hashes(self.out)
        self.assertTrue(os.path.exists(part))
        self.assertFalse(os.path.exists(part + ".bad"))

    def test_a_damaged_part_is_set_aside_and_its_takes_are_pending_again(self):
        pack = nb.load_pack(pack_data(), ENGINE, LIMITS)
        nb.write_part(self.out, [(digest(1), b"one")], "flac")
        damaged = nb.write_part(self.out, [(digest(2), b"two")], "flac")
        with open(damaged, "wb") as part:
            part.write(b"PK\x03\x04 not a whole zip")
        with open(os.path.join(self.out, "requests.json"), "w") as other:
            other.write("{}")
        logged = []
        pending = nb.pending_dialogs(pack, self.out, logged.append)
        self.assertEqual([d.hash for d in pending], [digest(2), digest(3)])
        self.assertTrue(os.path.exists(damaged + ".bad"))
        self.assertIn("Setting aside audio-0002.zip", logged[0])
        # The next part does not reuse the damaged one's number's file.
        self.assertEqual(os.path.basename(nb.write_part(self.out, [(digest(2), b"two")], "flac")), "audio-0002.zip")


class RunBatch(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.folder.name, "out")
        self.addCleanup(self.folder.cleanup)
        self.pack = nb.load_pack(pack_data(count=7), ENGINE, LIMITS)
        self.clock = Clock()
        self.log = []

    def synthesizer(self, fail=(), interrupt_at=None, seconds_each=4.0):
        def synthesize(dialog):
            if dialog.hash == interrupt_at:
                raise KeyboardInterrupt
            if dialog.hash in fail:
                raise RuntimeError("CUDA out of memory")
            self.clock.now += 10.0
            return dialog.text.encode(), seconds_each

        return synthesize

    def run_batch(self, dialogs, **options):
        return nb.run_batch(
            dialogs, self.out, clock=self.clock, log=self.log.append, part_dialogs=3, **options
        )

    def test_writes_a_part_every_few_dialogs_and_the_rest_at_the_end(self):
        summary = self.run_batch(list(self.pack.dialogs), synthesize=self.synthesizer())
        self.assertEqual(summary.synthesized, 7)
        self.assertEqual([os.path.basename(p) for p in summary.parts], ["audio-0001.zip", "audio-0002.zip", "audio-0003.zip"])
        self.assertIsNone(summary.stopped)
        self.assertEqual(summary.speed, 2.5)
        self.assertEqual(summary.characters, sum(len(d.text) for d in self.pack.dialogs))
        self.assertEqual(nb.seconds_for(2 * summary.characters, summary), 140.0)
        self.assertEqual(nb.duration(140.0), "2 min")
        self.assertEqual(nb.duration(3 * 3600 + 5 * 60), "3 h 05 min")
        self.assertEqual(nb.pending_dialogs(self.pack, self.out), [])
        self.assertIn("[7/7]", self.log[-1])
        self.assertIn("(2.5x)", self.log[-1])
        self.assertIn("Synthesized 7 dialogs", nb.describe(summary, self.out))

    def test_writes_a_part_when_enough_time_has_passed(self):
        summary = nb.run_batch(
            list(self.pack.dialogs)[:2],
            self.out,
            self.synthesizer(),
            part_dialogs=100,
            part_seconds=10,
            clock=self.clock,
            log=self.log.append,
        )
        self.assertEqual(len(summary.parts), 2)

    def test_a_dialog_that_fails_is_reported_and_the_batch_goes_on(self):
        summary = self.run_batch(list(self.pack.dialogs), synthesize=self.synthesizer(fail={digest(2)}))
        self.assertEqual(summary.synthesized, 6)
        self.assertEqual([(d.hash, reason) for d, reason in summary.failed], [(digest(2), "RuntimeError: CUDA out of memory")])
        self.assertEqual([d.hash for d in nb.pending_dialogs(self.pack, self.out)], [digest(2)])
        self.assertIn("1 dialog(s) failed", nb.describe(summary, self.out))

    def test_failures_in_a_row_end_the_run_with_what_it_has(self):
        fail = {digest(i) for i in range(3, 8)}
        summary = self.run_batch(
            list(self.pack.dialogs), synthesize=self.synthesizer(fail=fail), max_consecutive_failures=3
        )
        self.assertEqual(summary.stopped, "3 dialogs failed in a row")
        self.assertEqual(summary.synthesized, 2)
        self.assertEqual(nb.finished_hashes(self.out), {digest(1), digest(2)})

    def test_an_interrupt_keeps_what_was_synthesized_and_a_second_run_goes_on(self):
        first = self.run_batch(list(self.pack.dialogs), synthesize=self.synthesizer(interrupt_at=digest(5)))
        self.assertEqual(first.stopped, "interrupted")
        self.assertEqual(first.synthesized, 4)
        pending = nb.pending_dialogs(self.pack, self.out)
        self.assertEqual([d.hash for d in pending], [digest(5), digest(6), digest(7)])
        second = self.run_batch(pending, synthesize=self.synthesizer())
        self.assertEqual(second.synthesized, 3)
        self.assertEqual(nb.pending_dialogs(self.pack, self.out), [])
        self.assertEqual(os.path.basename(second.parts[0]), "audio-0003.zip")

    def test_a_folder_that_stops_taking_writes_ends_the_run_and_says_what_to_do(self):
        real_write = nb.write_part
        writes = []

        def failing_write(out_dir, takes, extension):
            writes.append(len(takes))
            if len(writes) == 2:
                raise OSError(107, "Transport endpoint is not connected")
            return real_write(out_dir, takes, extension)

        nb.write_part = failing_write
        self.addCleanup(setattr, nb, "write_part", real_write)
        summary = self.run_batch(list(self.pack.dialogs), synthesize=self.synthesizer())
        # One good part of three, then the failed write: no second try on the way out.
        self.assertEqual(writes, [3, 3])
        self.assertEqual(summary.synthesized, 3)
        self.assertIn("the last 3 take(s) were not saved", summary.stopped)
        self.assertIn("run step 5 again", summary.stopped)
        self.assertEqual(len(nb.pending_dialogs(self.pack, self.out)), 4)
        self.assertIn("Stopped early: could not write", nb.describe(summary, self.out))

    def test_refuses_an_unknown_audio_format(self):
        with self.assertRaisesRegex(ValueError, "unknown audio format"):
            nb.run_batch([], self.out, self.synthesizer(), extension="mp3")


class FakeWave(list):
    """Stands in for the model's numpy array: len(), abs() and max() are all it is asked."""

    def __abs__(self):
        return FakeWave(abs(sample) for sample in self)

    def max(self):
        return max(iter(self))


class MakeSynthesizer(unittest.TestCase):
    def setUp(self):
        outer = self
        self.calls = []
        self.seeds = []
        self.written = []
        self.wave = FakeWave([0.0, 0.5, -0.25] * 16000)

        class Model:
            def generate(self, **arguments):
                outer.calls.append(arguments)
                return outer.wave

        class Torch:
            @staticmethod
            def manual_seed(seed):
                outer.seeds.append(seed)

        class SoundFile:
            @staticmethod
            def write(target, wav, rate, format, subtype):  # noqa: A002 - soundfile's own name
                outer.written.append((rate, format, subtype))
                target.write(b"encoded")

        self.synthesize = lambda extension="flac": nb.make_synthesizer(
            Model(),
            torch=Torch,
            soundfile=SoundFile,
            reference_path="/tmp/reference.wav",
            prompt="Speak plainly",
            engine=ENGINE,
            extension=extension,
        )
        self.dialog = nb.Dialog(hash=digest(1), lesson="lesson", text="မင်္ဂလာပါ", seed=8101)

    def test_asks_the_model_as_the_hosted_synthesizer_does(self):
        audio, seconds = self.synthesize()(self.dialog)
        self.assertEqual((audio, seconds), (b"encoded", 1.0))
        self.assertEqual(self.seeds, [8101])
        self.assertEqual(
            self.calls,
            [
                {
                    "text": "(Speak plainly) မင်္ဂလာပါ",
                    "reference_wav_path": "/tmp/reference.wav",
                    "cfg_value": 2.0,
                    "inference_timesteps": 10,
                }
            ],
        )
        self.assertEqual(self.written, [(48000, "FLAC", "PCM_16")])
        self.synthesize("wav")(self.dialog)
        self.assertEqual(self.written[-1], (48000, "WAV", "PCM_16"))

    def test_refuses_an_empty_or_silent_take(self):
        self.wave = FakeWave([])
        with self.assertRaisesRegex(ValueError, "no audio"):
            self.synthesize()(self.dialog)
        self.wave = FakeWave([0.001, -0.002])
        with self.assertRaisesRegex(ValueError, "silence"):
            self.synthesize()(self.dialog)
        # What a model that overflowed returns: it must not pass for sound.
        self.wave = FakeWave([float("nan")] * 100)
        with self.assertRaisesRegex(ValueError, "not numbers"):
            self.synthesize()(self.dialog)
        self.wave = FakeWave([0.2, float("inf")])
        with self.assertRaisesRegex(ValueError, "not numbers"):
            self.synthesize()(self.dialog)


if __name__ == "__main__":
    unittest.main()
