# Studio Persona Guide — v2

The versioned editorial contract for studio-produced lessons
([agent-lesson-production.md](./agent-lesson-production.md) §8). Scripts are the
highest-leverage artifact; this guide is what the advisory critic
(`src/studio/script/critic.ts`, same version number) lints against and what human
reviewers judge drafts by. Changes bump the version here and in the critic
together.

## Audience and scope

- **Audience:** working developers who know at least one language; no assumed Go
  (or lesson-language) experience beyond what the lesson states.
- **One concept per lesson.** A lesson teaches exactly one idea and shows it
  running. If a scene introduces a second concept, split the lesson.
- **Length:** 20–100 seconds of narration. Prefer the shortest version that still
  lands the idea.

## Voice and pacing

- **Conversational, not read-aloud** (v2): write the way a teacher talks at a
  whiteboard, not the way a manual reads. Use contractions everywhere they are
  natural ("that's", "doesn't", "let's", "here's"); an occasional short
  question that the next sentence answers ("So who owns the String now?") is
  encouraged. The critic enforces this mechanically: uncontracted forms
  ("it is", "does not", "let us", …) raise a `register.read-aloud` note —
  fix every one before rendering.
- Short sentences still rule; target under ~20 words, hard ceiling 24.
  Conversational means natural rhythm, not rambling.
- Address the viewer as "you", and use "let's" for shared actions — the
  narrator is doing this _with_ the viewer.
- Speak while showing: narration should describe what is on screen _as it
  changes_ (markers anchor actions to the words that explain them).
- Numbers from measurement, not vibes: pacing bands live in the critic and were
  seeded conservatively (110–170 wpm for the pocket-tts voice profiles); revise
  them from pilot ratings, not taste debates.

## Terminology and honesty

- Use the language's own terms (`package`, `func`, `int`) verbatim; the
  pronunciation lexicon handles speech, never the display text.
- Every factual claim a viewer could quote needs a source on the scene
  (`sources:` in the script — official specs, docs, or tour pages preferred).
- Never claim the lesson is human-performed. Drafts carry the AI-production
  disclosure in their description; leave it intact.

## Banned phrases

Filler that pads narration or condescends. The critic flags these (v1 list):

> simply, just simply, obviously, of course, easy, easily, as we all know,
> needless to say, delve, in this video, don't worry

"Just" as a verb qualifier ("just a value multiplied…") is fine; "just simply do
X" is not.

## Plain English for a global audience

Learners are often non-native English speakers. Narration must use common,
plain words — if a phrase would need a dictionary or is an idiom, rewrite it:

- No idioms or figures of speech: "runs behind your back", "walks the same
  ground", "who outlives whom", "side by side", "pays nothing for".
- No uncommon word when a common one works: "blunt" → "not what you want",
  "outright" → "completely", "untouched" → "unchanged".
- Do not cite books, chapters, or external material in the spoken narration
  ("Chapter four of the Rust Book…") — citations live in each scene's
  `sources`, not in the audio.

## Code on screen

- Narrate _why_, show _what_: the typed code is visible — read out only the part
  the concept hinges on (the type set, the extra multiply), not every token.
- No fake mistakes unless the lesson explicitly teaches debugging.
- Every runnable checkpoint must actually run; expected output is asserted, not
  narrated on faith (`expect.output`).

## Review gate

The critic proposes; it never approves. A human watches every draft end-to-end
before publishing, checking: concept lands, narration matches what is on screen,
pacing feels intentional, sources support the claims. Record review minutes and
verdicts per docs/studio-m0-runbook.md's metrics table.
