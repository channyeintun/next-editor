# AI course — course guide

A 20-lesson course on building AI features for the web, narrated in Burmese. It is based on
[web.dev Learn AI](https://web.dev/learn/ai), written by Dr. Janna Lipenkova with editorial
guidance from Alexandra Klepper. Its text is licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and its code Apache 2.0. The course
follows web.dev's module order and covers every teaching section of its 12 pages. It teaches in its
own words and with its own example: the same Yangon tea shop as the CSS, accessibility and
TypeScript courses adds AI features to its website. Every lesson's first scene carries the full
credit line in its `sources`, and every scene cites the web.dev page it draws on.

Lessons are 8 to 10 minutes long (lesson 2 is 7.9), about 3 hours 10 minutes in total at Burmese
VoxCPM2 pace (70 ms per character).

Every lesson is a studio LessonScript in `src/studio/scripts/ai-course-*.yaml`, with locale `my-MM`
and seeds 5101–5120. Concept content is taught on the whiteboard, and tables sit on static cards in
the preview. There is no slide deck: a deck only works in a lesson once it is published to the web,
which is Chan's step. Hands-on lessons run a small JavaScript project in the WebContainer, and an
**AI panel** in the preview shows the inputs, the model's outputs, the scores and the metrics as the
code changes.

Chan has **not** reviewed the Burmese yet, and no lesson has been rendered in /studio yet.

## Lessons

| #   | Script                                   | Title                               | What runs in the preview                                                  | ≈ min |
| --- | ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- | ----- |
| 1   | `ai-course-01-blueprint`                 | Web developer နဲ့ AI system blueprint | concept: boards, plus one static card                                     | 9.9   |
| 2   | `ai-course-02-opportunities`             | AI သုံးဖို့ အခွင့်အလမ်း ရှာခြင်း               | concept: boards, plus the journey-table card                              | 7.9   |
| 3   | `ai-course-03-shape-prototype`           | Idea ကို ပုံဖော်ပြီး prototype လုပ်ခြင်း     | boards, then a rule-based synonym search with recorded query tags         | 9.9   |
| 4   | `ai-course-04-predictive-data`           | Predictive AI နဲ့ data ပြင်ဆင်ခြင်း      | data-preparation steps over the member data (no model)                    | 8.8   |
| 5   | `ai-course-05-predictive-train-evaluate` | Model ကို train ပြီး evaluate လုပ်ခြင်း   | logistic regression trained in the page, threshold buttons, drifted data  | 9.9   |
| 6   | `ai-course-06-generative-tokens`         | Generative AI နဲ့ token               | a toy word model with temperature and max-token buttons, recorded counts  | 9.5   |
| 7   | `ai-course-07-generative-loop`           | Generative AI ရဲ့ loop                | recorded answers of the description helper, plus post-processing rules    | 9.8   |
| 8   | `ai-course-08-privacy`                   | Privacy နဲ့ ကိုယ်ရေး data                | redaction, the payload, consent and labels (no model)                     | 9.5   |
| 9   | `ai-course-09-fairness`                  | Fairness နဲ့ bias                     | a live Transformers.js zero-shot model on paired inputs, the member model | 9.8   |
| 10  | `ai-course-10-trust`                     | Trust နဲ့ transparency                | a naive Bayes sorter with a trust UI                                      | 9.2   |
| 11  | `ai-course-11-platforms`                 | Client-side လား server-side လား     | concept: boards, plus the platform star-table card                        | 9.6   |
| 12  | `ai-course-12-hybrid`                    | Platform ရွေးခြင်းနဲ့ hybrid AI         | two naive Bayes models (router, FAQ), handoff rules, recorded escalations | 9.6   |
| 13  | `ai-course-13-built-in-ai`               | Browser ထဲက built-in AI              | the live built-in AI check (`unavailable`) and a graceful fallback        | 9.3   |
| 14  | `ai-course-14-libraries-runtimes`        | Client-side library နဲ့ runtime       | a live Transformers.js embedding model for semantic search                | 9.4   |
| 15  | `ai-course-15-prompt-components`         | Prompt ရဲ့ အစိတ်အပိုင်းတွေ                  | prompt assembly with a recorded answer for each prompt version            | 9.8   |
| 16  | `ai-course-16-prompting-techniques`      | Prompting နည်းလမ်းတွေ                  | a recorded answer and token count for each technique                      | 8.3   |
| 17  | `ai-course-17-evaluation`                | Evaluation-driven development       | code checks over recorded baseline answers                                | 9.7   |
| 18  | `ai-course-18-judges`                    | Judge တွေနဲ့ prompt တိုးတက်အောင် လုပ်ခြင်း    | checks, recorded v1 and v2 answers, a recorded judge and staff ratings    | 9.8   |
| 19  | `ai-course-19-background-constrained`    | Background AI နဲ့ constrained AI      | recorded review highlights and helper options in clickable UI patterns    | 9.8   |
| 20  | `ai-course-20-open-ended`                | Open-ended AI နဲ့ course အနှစ်ချုပ်       | a recorded conversation in a chat UI, then the closing boards and card    | 10.0  |

Every title is `AI course NN: <title>`.

## Source coverage

| web.dev Learn AI page                  | Lessons                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Welcome, Introduction to AI on the web | 1                                                                                                 |
| Explore use cases                      | 2 (value, opportunities), 3 (shape, failure modes, prototype)                                     |
| Predictive AI                          | 4 (define, prepare), 5 (train, evaluate, deploy, pitfalls)                                        |
| Generative AI                          | 6 (tokens, sampling), 7 (the loop, pitfalls)                                                      |
| AI governance: build responsibly       | 8 (privacy), 9 (fairness), 10 (trust and transparency)                                            |
| Choose your platform                   | 11 (options, criteria), 12 (trade-offs, hybrid AI)                                                |
| The client-side AI stack               | 13 (built-in AI), 14 (libraries, runtimes)                                                        |
| Prompt engineering                     | 15 (components, system and user prompts), 16 (techniques)                                         |
| Evaluation-driven development          | 17 (problem, baseline, metrics), 18 (judges, iterating)                                           |
| UX patterns for web AI                 | 19 (background, constrained), 20 (open-ended, summary)                                            |
| Glossary                               | each term where it is first used, recapped later (lesson 20's closing boards recap the main ones) |

A final check matched all 161 teaching sections to the scenes that teach them. None was missing,
taught wrongly, or taught more confidently than the source allows. The pages' link lists are not
read out, because the audio never names books, authors or URLs. Every web.dev quiz question is
answered somewhere in the course, except one that is skipped on purpose (see below).

The lessons teach November 2026 facts where web.dev is older or loose:

- **Built-in AI is Chrome-first.** Summarizer, Translator and Language Detector are stable in Chrome
  138 and later. The Prompt API reached web pages in Chrome 148. Writer, Rewriter and Proofreader
  are still experimental. Edge is experimenting, and nothing runs on Android or iOS. The model is
  Gemini Nano. (Firefox's negative standards position on the Prompt API is background for the
  course, not something a lesson teaches.)
- **No Burmese.** The Prompt API, Summarizer and Translator do not support Burmese today; Language
  Detector does detect it. For a Myanmar web developer this is a real platform constraint, and
  lessons 11, 13, 15 and 19 say so (lesson 14 recalls it).
- **Temperature** is taught on lesson 6's toy model, and the recordings are greedy (temperature 0).
  The lessons never attribute temperature to the web Prompt API, which does not expose it; only
  server APIs and open models do.
- **Structured output** exists: the Prompt API can constrain its answer to a JSON Schema
  (`responseConstraint`). web.dev lists it among the things built-in AI cannot do.
- **Libraries:** Transformers.js is `@huggingface/transformers` 4.3.2. LiteRT.js is mentioned beside
  TensorFlow.js. WebGPU is not on every platform yet, so lesson 14 teaches keeping a Wasm fallback
  (both live lessons run on Wasm), and WebNN is still an origin trial.
- **The platform star table** uses the values in web.dev's own "Why N stars" notes where the stars
  drawn disagree with them: managed-service privacy 2, self-hosted cost per request 3, and
  server-side user convenience 4.
- **Quiz keys:** two web.dev answer keys contradict the text (platform question 1, generative
  question 2). The course's quizzes use answers that match the text, and the muddled evaluation
  question 2 is skipped.
- **Model names** age monthly, so the narration names families (Gemini, GPT, Claude, Gemma) without
  version numbers. A version appears only on screen, beside a recorded answer.

## How the lessons show AI

The studio preview cannot run a large model, and a lesson must replay exactly in the published
recording. Every result on screen therefore comes from one of five mechanisms, and each lesson says
honestly which one it is.

- **Rules (no model).** Plain JavaScript for redaction, routing, prompt assembly, checks and UI
  patterns. Where it sits beside AI results, its card carries the badge `rules · AI မပါ`.
- **Teaching models trained in the page.** Pinned plain-JavaScript models: naive Bayes over Burmese
  syllables (lessons 10, 12 and 20), logistic regression (lessons 5 and 9) and lesson 6's toy word
  model.
  They are deterministic and instant, replay exactly, and are introduced as teaching models, never
  as what production uses.
- **Transformers.js, live (lessons 9 and 14 only).** Version 4.3.2 from jsDelivr runs two real
  English models in the preview: `Xenova/mobilebert-uncased-mnli` (zero-shot, 27.7 MB) and
  `Xenova/all-MiniLM-L6-v2` (embeddings, 23.7 MB). Each render downloads the model again: 22–40 s
  on a normal day here, about 85 s or more on a slow network. So at least 1,400 narration
  characters (about 98 s at 70 ms per character) follow every download. No Burmese-capable
  model is small enough. Lesson 9 shows why that matters: the zero-shot model's tokenizer turns every
  Burmese word into `[UNK]`, so a Burmese complaint and a Burmese compliment get the same score.
- **The built-in AI check (lesson 13).** The studio preview is a cross-origin iframe with no
  `allow` attribute, so Chrome's permissions policy blocks every built-in AI API there, on any
  machine. Lesson 13 runs the real feature detection, `featurePolicy.allowsFeature` and
  `availability()`. It turns the real `unavailable` result into the lesson: detect the feature,
  know about the iframe permission, and fall back gracefully.
- **Recorded answers.** Generative answers come from Gemma 4 E2B (4-bit GGUF, run with
  node-llama-cpp 3.22.2), recorded ahead of time with greedy decoding. Two separate processes gave
  byte-identical answers. Each workspace holds `data/responses.json` and `data/PROVENANCE.md`, and
  `src/llm.js` replays only the exact recorded messages with the badge
  `recorded · Gemma 4 E2B · greedy`. Any other message shows a notice instead of an answer, so a
  typo can never invent one. The narration says once per lesson that the answers were recorded. It
  never calls the model a large cloud model, even where it plays the server (lesson 12) or the judge
  (lesson 18). A model's mistakes are shown as they happened, never staged.

The **AI panel** is two pinned files that are never typed on screen. `course/runner.js` is a Vite
plugin that bundles the program with esbuild after each pause in typing. `course/panel.js` runs the
bundle in the page and draws the cards the program reports, such as tables, charts, notes, model
cards, answers and metrics, then a Console section. A half-typed file shows a red **Not run** card
and keeps the last good cards dimmed. The panel updates 0.2–0.4 s after an edit and is ordinary DOM,
so it replays exactly: this was checked with the app's own rrweb replayer at 432 and 640 px. Every
setting a lesson changes, such as a threshold, a temperature or a question to the assistant, is a
real button clicked in the preview. Lesson 14 is the one exception: it adds its second search
question by typing it into the code.

The course data is synthetic, and each lesson that uses it says so once. The tea shop's members,
reviews, orders and menu are mostly Burmese, with some English and romanized reviews, and they live
in the hands-on workspaces' `data/` (the concept lessons 2 and 11 keep their tables in `src/`).
People are only လှလှ, အောင်အောင် and မောင်မောင်; the shop owner is unnamed (ဆိုင်ပိုင်ရှင်).

The recording cannot show GPU training, DevTools, a terminal, a built-in AI answer or live
generation, and the lessons never claim it does. They say where those happen and show what the
panel can show.

Narration rules specific to this course:

- No lines about tooling (dev server, installs, downloads, the preview reloading). Downloads are
  named only where they are the topic: lesson 14's model download, and in lesson 19 the first
  download as a cost to the user.
- Code and English prompts are never read aloud; the narration says what each part asks for.
- Numbers are Burmese digits without a thousands separator, and metrics are said as ရာခိုင်နှုန်း.
- Lesson 1 draws the AI system blueprint. Every later lesson starts with a small version of it on
  the whiteboard and highlights the layer it works on, so the learner always knows where they are.
- Every lesson has one quiz moment on the whiteboard: the question, a pause, then the answer and why.
- Technical terms stay in English, as in the earlier courses.

## How it was built and checked

A foundation pass came first. It saved the 12 web.dev pages, checked every version fact on the web,
built the AI panel and proved each mechanism through the studio's own gates with probe lessons. It
also wrote the curriculum, the glossary and the course kit (the tea shop's AI story, datasets and
people).

A pilot then built lessons 1 and 4, and an independent reviewer sharpened the author brief from
them. After that, Opus 5.5 built each remaining lesson in two independent passes:

1. An author wrote the design, the workspace, the YAML and the Burmese narration directly, and
   recorded the lesson's model answers.
2. A separate auditor checked every fact against web.dev and the Chrome, MDN and library docs. It
   checked the narration against what the panel really shows in the verify screenshots, re-recorded
   the answers to confirm they matched, edited the Burmese, and fixed what it found.

Two final passes covered the whole course. The first checked all 19 bridges between lessons and
kept terms consistent. The second checked coverage of every section of every web.dev page, and the
course credit.

Every committed script passes:

- the Director;
- `bun scripts/studio-compile-check.ts`, with 0 warnings;
- a course narration lint, which covers tooling chatter, digits, code characters, written register,
  names, the disclosures for recorded answers, and runtime and download spacing;
- a board check for text that overflows or overlaps on the whiteboard (verify never shows the board);
- a full replay against real Vite and headless Chrome (`bun scripts/studio-verify-lesson.ts`), with
  0 failures and 0 console warnings. All 20 passed it again just before landing.

In that last run, lessons 9 and 14 first failed. They are the two lessons that download a model, and
the connection gave only about 60 KB/s at the time, so neither model finished within the 90-second
wait. Re-run one at a time, both passed (61 s and 56 s); measured afterwards, each model took about
40 s at 0.6 MB/s. **Render lessons 9 and 14 on a fast connection**: on a slow one, the download can
outlast the narration's wait.

## Decisions taken during the build

Each question raised during the build was decided, not left open.

- **No slide deck.** Concept content uses the whiteboard, the blueprint included. Content that
  reads better as a table (lesson 1's keyword-search results, the journey table, the platform star
  ratings, the UX-pattern summary) goes on static panel cards drawn by pinned code. A blueprint-grid
  card was built for lesson 1 and cut, because it pushed the lesson to 10.4 minutes.
- **Generative answers are recorded, never generated live.** The smallest instruct model that runs
  in a browser is 118–137 MB, would download again on every render, and is too weak to teach with.
  Every recording uses greedy decoding, so no lesson compares recordings at two temperatures.
  Lesson 6 shows temperature live on its toy model instead.
- **A platform fix: superseded runs stop before they draw.** A run whose module was still loading
  when a newer run started could draw dead buttons into the fresh page. The panel's run prelude now
  stops a superseded run before any lesson code runs.
- **Lesson 5 clicks the threshold after the fix.** The first model shows no precision/recall
  trade-off on this test set, so the threshold buttons come after the per-visit feature. The
  narration also says honestly that "days since the last visit" gets a negative weight in the final
  three-column model, because the columns overlap.
- **`F1` is said as "F one"**, because the narration uses no Latin digits.
- **Lesson 9 makes the cause of the Burmese gap visible.** It shows the tokenizer's `[UNK]` output,
  and it treats dropping the township column as a fairness decision rather than an accuracy one,
  since the test metrics stay identical either way.
- **Lesson 18's second prompt is presented as not better.** Its checks improve (JSON and length
  pass on all 12 inputs, and one claim still fails), but the judge's 4+ scores (22 → 17) and the
  sample staff ratings (2 → 0) drop, and the lesson says so.
- **Lesson 19 keeps a real slip.** One recorded helper option claims "no milk" when the notes say
  only "no condensed milk". It became the lesson's example of why a person reviews the output.
- **Federated learning** is described correctly: the data stays on the device, and only model
  updates go to the server.
- **Chrome's built-in APIs use two kinds of model.** Translator and Language Detector use expert
  models. The Prompt API and Summarizer use Gemini Nano, and only those carry the hardware
  requirements.
- **web.dev's Prompt API example** is shown adapted in lesson 15, credited under Apache 2.0.

## Pronunciation notes

These are the terms most likely to need a `BURMESE_RESPELLINGS` entry after the first Burmese
render. None of them is in the lexicon yet.

- **Acronyms:** `AI`, `API`, `JSON`, `LLM`, `PII`, `RAG`, `FAQ`, `GPU`, `CPU`, `MMLU`, `U X`,
  `E D D`, `T D D`, `ML ops`, `LLM ops`, `AutoML`, `UNK` (lesson 9).
- **Products and libraries:** `Gemma`, `Gemini Nano`, `Transformers.js`, `TensorFlow.js`,
  `LiteRT.js`, `ONNX`, `MediaPipe`, `WebLLM`, `Hugging Face`, `scikit-learn`.
- **Runtimes:** `WebAssembly`, `WebGPU`, `WebNN`.
- **Terms said often:** `zero shot`, `few shot`, `chain of thought`, `self reflection`,
  `evaluation driven development`, `calibrated trust`, `progressive disclosure`, `graceful
  fallback`, `F one`.
- **Lesson length:** lesson 20 is at the 10.0-minute top of the range. Any addition there needs a
  matching trim.

## Thumbnails

The template is `docs/ai-course-thumbnail.html`. It is the same card as the earlier courses, with
the mascot **Nodi**: a teal model with a crown of nodes, wearing a `0.9` confidence badge. The
template holds each lesson's title, one real line from its final code (or a phrase from the board
in the three whiteboard lessons) and a bubble word. The progress squares are grouped by web.dev's
modules: nine groups, because introduction and use cases share the first. `bun docs/ai-course-thumbnails/render.ts` renders
`docs/ai-course-thumbnails/ai-course-NN-*.png` at 1280×720.

Working files are kept outside the repo in `~/Documents/ai-course-work/`. They include the saved
web.dev pages, the curriculum, glossary, course kit, platform notes, the panel's base workspaces,
the recorder and tools, the coverage table, and per-lesson design notes and audits.
