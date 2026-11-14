# Burmese narration on Google Colab

The studio narrates Burmese lessons with VoxCPM2 on a hosted GPU (Modal, see
[modal-voxcpm2-burmese.md](./modal-voxcpm2-burmese.md)), which bills by the second. This is the
other way to make the same narration: on a Google Colab GPU, as a batch, with the audio imported
into the studio afterwards.

## How it works

Every dialog of a lesson is one speech request, and the studio keeps each request's audio (its
_take_) in the browser under a hash of the request. A render looks the hash up first and asks the
speech service only for takes it does not find. So narration made anywhere else works, as long as it
lands in the browser under the right hashes:

1. **Export.** In the studio's Workflow tab, pick the lessons and choose **Narrate on Google Colab →
   Export requests**. It downloads `narration-requests-<date>.json`: each dialog's text, seed and
   hash, the narrator's reference recording, and the engine settings the takes need. Dialogs this
   browser already keeps are left out.
2. **Synthesize.** Open [the notebook](../integrations/colab/voxcpm2_narration.ipynb) in Colab (the
   link in the studio opens it), choose a GPU runtime, and run all cells. It asks for the request
   file, synthesizes every dialog, and writes `audio-0001.zip`, `audio-0002.zip`, … to
   `My Drive/next-editor-narration/pack-<date>/`. Each zip holds FLAC files named by hash.
3. **Import.** Back in the studio, choose **Import audio…** and pick the zips, or the single zip
   Google Drive makes when you download their folder (a folder you zipped yourself works too). Each
   take is checked the way a render checks a cached take, then filed under its hash. Renders and
   workflows wait until the import has finished, so none of them buys a take that is on its way in.
4. **Check.** With lessons picked, the section says how many of them have all their narration in
   this browser, and how many dialogs a render would still ask the speech service for. When only
   some are whole, **Pick only the … lessons with all their narration** narrows the selection to
   those.
5. **Render.** Start the workflow as usual, with "Narrate every lesson first" on. For the lessons
   that are whole, the narration pass finds every dialog in the browser and finishes at once;
   nothing is sent to Modal.

**A part is not a lesson.** Each `audio-NNNN.zip` holds the next 25 dialogs or so (fewer when ten
minutes pass first, or when a lesson ends), whichever lessons they belong to. A lesson has about 40
dialogs, so 36 parts are about 19 lessons, not 36. A lesson with even one dialog missing still
renders, and the studio then asks the hosted voice for what is missing, at its price. To know
which lessons are whole, read the notebook's output (steps 5, 7 and 8 list them, and each lesson
is named in the log once all its audio is written), `progress.txt` in the Drive folder, or the
studio's count in step 4.

The export and the import must happen in the same browser profile, with the same narrator reference
selected: the hash includes the narrator.

A lesson edited after the export has new hashes for the dialogs that changed. Export again to get
just those; until then a render asks the hosted voice for them.

## What Colab allows

Colab's FAQ lists what may not run on its runtimes, on any plan: among them "file hosting, media
serving, or other web service offerings not related to interactive compute with Colab" and
"connecting to remote proxies". A notebook that the studio calls as a speech service, through a
tunnel, is exactly that, so this feature does not do it. The notebook is a batch a person runs: it
reads a file, writes files, starts no server and opens no tunnel.

The same list has "creating deepfakes", with no definition. Narrating your own lessons in your own
voice, labelled as AI-generated, is not what that word usually means, but Google does not say where
the line is. Use the notebook only with your own voice or one you have permission to use.

The list also has "using multiple accounts to work around access or resource usage restrictions".
A second Google account, opened because the first one is refused a GPU, is that. "Colab stops giving
the account a GPU" below has the ways to go on that the rules allow.

## What to expect

The numbers below are from the one run so far, read from the parts it wrote: a free Colab GPU in
November 2026 (its model was not recorded), with the default settings. It made 843 dialogs of the Architect Path course, 153 minutes of audio. Its first part and its last are 5 hours 18 minutes apart, and the session ended some time after the last.
Step 6 of the notebook synthesizes two dialogs, plays one, and prints the pace and the time the
rest will take, so each run answers these for itself.

- **Fit.** The model's authors give about 8 GB of GPU memory for VoxCPM2. A T4 has about 15 GB
  usable. The run had no failed dialog; its longest take was 27 seconds of audio.
- **Pace.** 2.1 times the audio's length on that free Colab GPU (parts 3 to 36: 153 minutes of audio in 318 minutes), about 125 ms of work for each character of narration. On the hosted GPUs, synthesis takes about as long as the audio on an A10G
  or L40S and about 1.7 to 1.9 times as long on an L4 (from Modal's billing).
- **The float16 switch.** It may be faster on a T4, and it is untested: nobody has published what
  the model sounds like in float16. Its takes go to a separate `pack-<date>-float16` folder, so
  they never mix with the others. Listen to step 6's sample first. Once imported, the studio cannot
  tell these takes from the hosted voice's.
- **Sessions.** Colab's free tier runs a notebook for at most 12 hours, ends idle sessions, and
  rations GPU time without publishing the limits. The one run so far wrote parts for 5 hours 18 minutes before it ended. A long batch takes several sessions. The notebook
  is written for that: it writes a part every 25 dialogs or sooner (when a lesson ends, or ten minutes pass), and run again it goes on from the parts already written. For a later session, paste the path step 5 printed into `PACK_PATH` (or upload
  the same request file again). Keep the tab open while it works.
- **Saving.** Audio saved to Google Drive survives the session. Let step 8 finish before you
  download the folder or disconnect: Drive takes files in the background, and step 8 waits until it
  has them all. The other setting keeps the audio on the runtime only, where a session that ends
  takes all of it along, finished or not.
- **Size.** FLAC takes are well under half the size of WAV: 2.2 MB per minute of speech.

For scale, the 56 Architect Path lessons are 2,368 dialogs, about 7 hours of speech: at the measured
pace, about 15 hours of GPU time, so three sessions as long as the first.

## When something goes wrong

- **"This pack and this notebook are from different versions of the project."** The notebook
  refuses a pack whose engine settings are not its own, because the takes would not be the ones
  their hashes name. Open the current notebook from the repository, or export the pack again.
- **The install step fails, or `import voxcpm` fails.** Colab's Python and PyTorch versions move.
  VoxCPM 2.0.3 asks for Python 3.10 or newer and PyTorch 2.5 or newer; the notebook keeps Colab's
  own PyTorch. Read pip's message for the package that does not install.
- **"This runtime has no GPU."** Runtime → Change runtime type → T4 GPU, then run all again.
- **Colab stops giving the account a GPU** (its message names "usage limits"). The free tier rations
  GPU time and does not publish the limits or when they lift. The parts already on Drive are kept.
  To go on:
  - Wait until Colab gives the account a GPU again, then run all with the same request file. It
    goes on from the parts on Drive.
  - Or buy compute units for the same account and run all again.
  - Or import what is finished, then export the same lessons again. The new request file holds only
    the dialogs still missing. Run it through the notebook in a later session, or skip the export
    and let a normal render ask the hosted voice for just those dialogs.
- **Dialogs fail one after another.** Five in a row end the run: the cause is then the runtime
  (out of memory, a lost GPU), not a dialog. Restart the runtime and run all again.
- **"Could not write to …" or "Google Drive is not mounted."** The Drive folder stopped answering.
  Run step 5 again (it mounts Drive again), then the step that stopped. The takes not yet written
  out are made again; the parts already on Drive are kept.
- **A render synthesizes dialogs although the audio was imported.** The imported parts did not
  hold every dialog of that lesson: a part is a few dozen dialogs, not a lesson (see "A part is not
  a lesson" above). Stop the workflow, pick the lessons again, and read the count under **Narrate on
  Google Colab**: it names the lessons that lack audio. Takes the hosted voice made before you
  stopped are kept, and the next export leaves them out.
- **The import reports files it could not use.** The message names the first file and the reason:
  not 48 kHz mono 16-bit audio, silent, or not a readable zip. Those dialogs have no take; export
  again to get a pack of just the missing ones.
- **"The browser stopped keeping narration."** The browser's storage for the site is full or
  blocked. Free space (old takes live in the site's Cache storage) and import the same files again;
  takes already imported are skipped.

## For maintainers

- The offline narration domain is `src/studio/narrationPack/`: `requestPack.ts` (export),
  `audioImport.ts`, `zipDirectory.ts` and `flac.ts` (import), `coverage.ts` (which picked lessons
  have all their takes here), `offlineNarration.ts` (what is running and how it ended, kept in a
  store so the console can hold renders back during an import), and `OfflineNarrationSection.tsx`
  (the Workflow tab's controls). The requests come from the Director
  (`narrationRequestsOf` in `inPageDirector.ts`) and are never derived a second time.
- Zips are read by their directory, never split from the front: a zip made by a streaming zipper
  (Finder, most folder downloads) does not say where an entry ends until after its data.
- The notebook is generated: `bun scripts/build-voxcpm2-colab-notebook.ts` builds
  `integrations/colab/voxcpm2_narration.ipynb` from `voxcpm2_narration.py` (the cells) and
  `narration_batch.py` (the batch code), and fills in the engine settings from the studio's VoxCPM2
  profile and the delivery prompt from the hosted synthesizer. A test fails when the committed
  notebook is not the build's output, when the hosted synthesizer's own engine settings differ from
  the studio's profile, and when its two calls into VoxCPM (loading the model, synthesizing a
  dialog) differ from the notebook's. After changing the prompt, the profile or either Python file,
  rebuild the notebook.
- The batch code is tested without a GPU: `python3 integrations/colab/narration_batch_test.py`.
- The notebook counts by lesson with `LessonProgress` (in `narration_batch.py`): it ends a part
  where a lesson ends, names each lesson in the log once its audio is written, and rewrites
  `progress.txt` beside the parts after every part.
- A take made on another GPU is not sample-for-sample the hosted one for the same seed. It is a
  take of the same request, filed under the same hash.
