# Testing course — course guide

A 32-lesson testing course narrated in Burmese. Its core is web.dev's
[Learn Testing](https://web.dev/learn/testing) course by Sam Thorogood et al. (text CC BY 4.0, code
Apache 2.0), adapted with attribution: the ideas follow its pages, every example is new, each scene
cites its pages in `sources`, and the CC BY credit is in each YAML's header and each lesson's draft
description, never in the audio. [Vitest](https://vitest.dev/) is the tool throughout, as on web.dev,
and its docs (MIT) are the reference for every API shown. A TDD module and an AI-age module carry the
thesis: an AI assistant can write plausible code very fast, so the hard part moves from writing code
to verifying it, and a test suite you own is the specification every change must meet. Their sources
(Beck, Fowler, Google, Anthropic, METR, OpenAI researchers, Stack Overflow, DORA) give ideas and facts
only, in our own words; each fact was checked at its primary source on 5 November 2026 (`facts.md`).

The running example is the Yangon tea shop of the CSS, accessibility, TypeScript and AI courses,
ရွှေလက်ဖက်ရည်ဆိုင် ("Shwe Tea House" where Latin text is needed). Every lesson is a studio
LessonScript in `src/studio/scripts/testing-course-*.yaml` (locale `my-MM`, `lessonType: javascript`)
and every one is hands-on: the shop's code starts with a realistic problem or a feature to build, real
Vitest 5.1.0 runs on it in the WebContainer, and a Vitest panel in the preview shows the real report as
the code changes. Whiteboards carry the diagrams; there is no slide deck. Lessons are 8 to 10 minutes
each, about 5 hours 5 minutes in total at 70 ms per character (studio-compile-check).

The Burmese has **not** been reviewed by Chan yet, and no lesson has been rendered in /studio yet.

## Lessons

| #   | Script                                    | Title                                | ≈ min |
| --- | ----------------------------------------- | ------------------------------------ | ----- |
| 1   | `testing-course-01-why-we-test`           | Test ဘာကြောင့် ရေးကြလဲ                  | 9.8   |
| 2   | `testing-course-02-first-vitest-test`     | Vitest နဲ့ ပထမဆုံး test                  | 9.8   |
| 3   | `testing-course-03-matchers`              | Matcher တွေနဲ့ failure ဖတ်နည်း            | 9.8   |
| 4   | `testing-course-04-assert-numbers-errors` | assert၊ ဂဏန်းနဲ့ error စစ်နည်း            | 9.5   |
| 5   | `testing-course-05-describe-aaa`          | describe၊ AAA နဲ့ test နာမည်ပေးခြင်း     | 9.5   |
| 6   | `testing-course-06-hooks-isolation`       | Hook တွေနဲ့ test isolation              | 8.5   |
| 7   | `testing-course-07-watch-filter`          | Watch mode နဲ့ test ရွေး run ခြင်း       | 9.8   |
| 8   | `testing-course-08-test-for`              | test.for နဲ့ table test                | 8.3   |
| 9   | `testing-course-09-async`                 | Async code ကို test လုပ်ခြင်း             | 9.8   |
| 10  | `testing-course-10-tdd-cycle`             | TDD နဲ့ red၊ green၊ refactor           | 9.2   |
| 11  | `testing-course-11-tdd-test-list`         | TDD လက်တွေ့၊ test list နဲ့ ခြေလှမ်းငယ်       | 9.9   |
| 12  | `testing-course-12-tdd-bug-fix`           | Bug ကို test နဲ့ ပြင်ခြင်း                 | 8.4   |
| 13  | `testing-course-13-test-types`            | Test အမျိုးအစားနဲ့ testing pyramid       | 9.9   |
| 14  | `testing-course-14-what-to-test`          | ဘာကို test လုပ်မလဲ                        | 9.6   |
| 15  | `testing-course-15-test-doubles`          | Test double တွေနဲ့ vi.fn                | 9.9   |
| 16  | `testing-course-16-mocking-modules-fetch` | spyOn၊ vi.mock နဲ့ fetch               | 9.8   |
| 17  | `testing-course-17-fake-timers`           | Fake timer နဲ့ အချိန်ကို ထိန်းခြင်း           | 9.8   |
| 18  | `testing-course-18-test-environment`      | Test environment၊ Node နဲ့ DOM         | 9.6   |
| 19  | `testing-course-19-dom-testing`           | Testing Library နဲ့ DOM test           | 9.9   |
| 20  | `testing-course-20-component-testing`     | React component ကို test လုပ်ခြင်း        | 9.7   |
| 21  | `testing-course-21-snapshots-legacy`      | Snapshot နဲ့ code ဟောင်း                | 9.9   |
| 22  | `testing-course-22-testable-code`         | Test လုပ်ရလွယ်တဲ့ code ရေးခြင်း             | 9.2   |
| 23  | `testing-course-23-static-analysis`       | Static analysis၊ ESLint နဲ့ TypeScript | 9.9   |
| 24  | `testing-course-24-coverage`              | Code coverage က ဘာကို ပြလဲ              | 9.4   |
| 25  | `testing-course-25-pitfalls-flaky`        | Test ထောင်ချောက်တွေနဲ့ flaky test         | 9.9   |
| 26  | `testing-course-26-config`                | Vitest ကို config လုပ်ခြင်း               | 8.7   |
| 27  | `testing-course-27-ci`                    | CI နဲ့ pull request check              | 9.9   |
| 28  | `testing-course-28-choosing-tools`        | Test framework နဲ့ tool ရွေးခြင်း        | 9.2   |
| 29  | `testing-course-29-ai-verification`       | AI ရေးတဲ့ code ကို test နဲ့ စစ်ခြင်း         | 9.9   |
| 30  | `testing-course-30-tdd-with-ai`           | AI assistant နဲ့ TDD                   | 9.2   |
| 31  | `testing-course-31-test-quality`          | Test ကောင်းမကောင်း စစ်ခြင်း              | 9.9   |
| 32  | `testing-course-32-philosophy-recap`      | Testing ရဲ့ ရည်ရွယ်ချက်နဲ့ အနှစ်ချုပ်            | 9.5   |

Every title is `Testing course NN: <title>`. The 10 modules: **Testing အခြေခံ** (foundations, 1–6) ·
**Vitest နဲ့ နေ့စဉ် အလုပ်** (everyday Vitest, 7–9) · **Test-driven development** (10–12) ·
**ဘာကို ဘယ်လို test လုပ်မလဲ** (what to test, 13–14) · **Test double တွေ** (test doubles, 15–17) ·
**Browser ဘက်က code ကို test လုပ်ခြင်း** (the browser side, 18–20) ·
**ရှိပြီးသား code နဲ့ အလုပ်လုပ်ခြင်း** (working with real code, 21–23) ·
**Test suite ကို ကျန်းမာအောင် ထိန်းခြင်း** (a healthy suite, 24–28) ·
**AI ခေတ်မှာ testing** (the AI age, 29–31) · **နိဂုံး** (closing, 32).

## Source coverage

| web.dev page and its sections                                                          | Lessons                                            |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Welcome: topics and scope; React or Lit; the philosophy                                | 1, 2; 19, 20; 14, 32                               |
| What testing is: definition, manual vs automated; libraries, names, AAA; scale; quiz   | 1; 2, 4, 5, 7, 12; 13; 4                           |
| Where tests run: the `test` script; manual runs and watch; presubmit, CI, rolling back | 2; 7, 10; 25, 27, 32                               |
| Testing environment: runtime, emulated browser APIs, real browsers, quiz               | 18 (also 22, 26, 28)                               |
| Test types: unit to end-to-end, smoke, visual, API, other types; regression; coverage  | 13 (also 14, 18, 21, 26); 12; 24                   |
| What to test: priorities; legacy scaffolding; approach; TDD; opaque and clear box      | 13, 14; 21; 5, 14; 10, 12; 14, 22                  |
| Component testing: the component, a quick test, mocking `fetch` and imports, context   | 20 (and 16)                                        |
| Static analysis: ESLint, browser-support plugins, type checking                        | 23                                                 |
| Assertions and tools: helpers, Chai's `assert`, fluent style, grouping, lifecycle      | 3, 4, 5, 6 (and 2, 28)                             |
| Appendix: Vitest as a test runner; React as a component model                          | 2, 28; 20                                          |
| Coming soon: pitfalls; test doubles; libraries and utilities; choosing a framework     | 25; 15–17; 19, 28, 31; 28                          |
| Coming soon: problem-driven testing; in practice; philosophy; writing testable code    | 16, 17, 19, 25; 13, 15, 16, 18, 20, 32; 14, 32; 22 |

**Vitest** is taught where the course needs it: setup, `vitest` and `vitest run` (2); matchers and
reading failures (1–3); `assert`, `toBeCloseTo` and `toThrow` (4); `describe` and `expect.soft` (5);
hooks and `test.extend` fixtures (6); watch mode, `.only` / `.skip` / `.todo` and filters (7);
`test.for` and `test.each` (8); async tests and timeouts (9); `vi.fn` (15); `vi.spyOn`, `vi.mock` and
`vi.stubGlobal` (16); fake timers (17); environments (18); Testing Library (19); React components
(20); snapshots (21); ESLint (23); istanbul coverage (24); debugging and `--repeats` (25); config
(26); CI behaviour and `allowOnly` (27); porting from Jest (28); agent support (29, 30); fast-check
(31). Skipped as niche: benchmarks, sharding, custom matchers, in-source tests, tags, the Vitest UI.

**TDD.** Lesson 10: its origin (Kent Beck, Extreme Programming, the late 1990s), the two rules, red
for the right reason, Fake It, Triangulate, Obvious Implementation, refactoring on green. 11: a test
list as `test.todo` lines and Canon TDD's named mistakes. 12: a bug fixed test-first, with its
regression test. 17, 22, 29 and 32 work test-first again, 21 contrasts characterization tests with
spec values, and 30 does TDD with an AI assistant.

**The AI age.** Lesson 1 states the thesis and module 9 goes deep. Every number names who measured
it and when, says so where it was self-reported, and is drawn with its source and year:

- **1:** Stack Overflow 2026: 73 % of people who use AI coding assistants use them daily (D12); 2025:
  66 % name answers that are "almost right, but not quite" their top frustration (D11).
- **17:** Anthropic's Claude Opus 5.5 system card (September 2026): on tasks that could not be done as
  given, attempted reward hacks came three to six times as often, measured during training (D07).
- **27, 29, 32:** DORA 2025: AI improves throughput, often at the cost of stability without a solid
  foundation, and amplifies a team's strengths and weaknesses; DORA 2024: robust testing remains
  crucial (D13, no percentages).
- **29:** Stack Overflow 2026's 48 % who trust AI when they can easily validate the answer (D12);
  special-casing documented in 2025 by Anthropic, OpenAI researchers and METR, no product blamed (D05,
  D06, D09, D10); Claude Code's advice to give agents a pass/fail check (D02); METR's early-2025 trial
  (19 % longer while believing about 20 % faster) with its 2026 caveat (D16); Anthropic's December
  2025 staff survey (D15); Vitest's agent support (A03, A04, A21, A29, D17).
- **30:** Anthropic's April 2025 test-first workflow (D01), Kent Beck's June 2025 augmented coding
  (D04), a revert test based on OpenAI researchers' March 2025 definition of cheating (D09),
  instructions that help a little at best (D06, D10) and guardrails (D03, D18). **31:** Stack
  Overflow 2026's 58.1 % who use AI for writing or improving tests (D12).

**Where web.dev is out of date.** Its pages date from January 2024 (Vitest 1.2), so the lessons
teach November 2026 facts without naming web.dev aloud (B16 lists what still holds):

- Browser Mode is stable and can mock modules (B01, B14; 18). `afterAll(vi.unstubAllGlobals)` leaks
  into later tests of the same file: fixed with `afterEach` in 16, with `unstubGlobals` in 26 (B02).
- Node 22+ has `fetch` and `WebSocket`; jsdom is an optional install, "over a decade old", and the
  "60fps" quiz detail is dropped (B03–B06; 18).
- Vitest is downloaded about three times as often as Jest on npm, and downloads are installs, not
  people (B07; 2, 28); watch mode is the default only in an interactive terminal (B08; 2, 7, 29).
- `test()` inside `test()` is an error (B09; 5); two assertion samples are wrong (B10; 4); the first
  message needs a template literal (B11; 1); `vitest run` is the documented form (B12; 2).
- GitHub's starter workflow tests Node 18 and 20, which Vitest 5 rejects, and still pins the `@v4`
  actions; lesson 27 runs Node 24 with the current `@v7` (B13; 27). Vitest now points
  to Mock Service Worker, named but not installed (B15; 16, 20, 28). Vitest 5's own changes and
  TypeScript 6's `strict` default (23) are followed too.

**Drawn, said or read, not run**, because the recording cannot show it or the WebContainer did not
verify it: real browsers driven by Playwright or WebdriverIO and Browser Mode (13, 18, 28; 26 reads an
e2e spec), the per-file environment comment and the jsdom swap (18), snapshot updates (21), a failing
coverage threshold (24), TypeScript's check (23), a CI run (27) and Stryker (31). Not said at all: Web
Test Runner (facts.md has no current status) and the quiz's `requestAnimationFrame` point (happy-dom,
the course's DOM, was not checked for it, and web.dev's "60fps" must not be repeated).

## How the lessons show Vitest

The studio has no terminal action for JavaScript lessons and no test UI in its editor, so every
workspace pins two files that are never typed on screen:

- **`course/vitest-bridge.js`**, a Vite plugin, starts the real Vitest 5.1.0 in watch mode inside the
  dev server. After 1 s without writes (2.5 s while a changed script does not parse) it hands the
  changed files to Vitest's own watch logic, and a custom reporter sends each report over Vite's HMR
  socket. The server listens only after the first run, so the preview opens on a report.
- **`course/panel.js`** draws the report as the **Vitest panel**, laid out like Vitest's terminal
  reporter. It is plain DOM, so it replays exactly: the app's own rrweb replay path reproduced its
  text exactly at 432 and 640 px.

Every value on the panel comes from Vitest, ESLint or the coverage map, and none is a duration (they
differ between renders). Under a status pill (`starting`, `running`, PASS, FAIL), each lesson picks
and orders the sections: **tests** (✓, ×, ↓ skipped, □ todo), **errors** (Failed Suites, Failed Tests
and Unhandled Errors, each with its message, diff and code frame), **summary**, **console**, and
**lint**, **coverage** and **snapshot** in lessons 23, 24 and 21. Lessons 1 and 19 add the
**`#app` region** for testing by hand: the shop's order form, mounted from a copy of `src/` taken
after each run, so it is the code Vitest just tested. It starts over after every `src/` edit, so
clicks come after a scene's last edit.

| Workspace    | Adds to vite 7.3.7 + vitest 5.1.0                                                | Lessons    | Cold install | Edit → report |
| ------------ | -------------------------------------------------------------------------------- | ---------- | ------------ | ------------- |
| `base`       | —                                                                                | the others | 28.7–29.7 s  | 1.57–1.68 s   |
| `base-dom`   | happy-dom 21.0.4, @testing-library/dom 10.4.2, user-event 14.6.8, jest-dom 7.0.1 | 18, 19     | 42.3–107.9 s | 2.73–3.12 s   |
| `base-react` | react and react-dom 19.3.1, @testing-library/react 16.3.3, the DOM set           | 20         | 50.3–51.6 s  | 2.72–3.03 s   |
| `base-lint`  | eslint 10.13.0, @eslint/js 10.0.1                                                | 23         | 31.0–44.7 s  | 1.52–1.60 s   |
| `base` plus  | @vitest/coverage-istanbul 5.1.0 (24) or fast-check 4.10.2 (31)                   | 24, 31     | 155.6 s      | 1.58–1.87 s   |

Versions are exact, with no lockfile (Node 24.22.2 and pnpm 8.15.6). Times are from real WebContainer
runs on an 8 GB Mac (the last row in one run, both browser slots busy); install time is network noise
first, package count second. A `vitest.config.js` edit redraws the panel in 1.5–1.7 s, no reload.

The recording cannot show a terminal, typed commands, watch-mode keys, the Vitest UI, VS Code's
extension, a debugger, a driven browser or a CI server. Commands are drawn on a board titled
`ကိုယ့် ကွန်ပျူတာရဲ့ terminal` or read in files, and the narration says where the learner would see
the rest. No real AI runs: an assistant's work is start-state code or a pinned diff.

Narration rules specific to this course:

- No tooling lines and no "save"; lesson 1 introduces the panel as real Vitest rerunning by itself,
  later lessons recall it in one clause; the opening fills the runtime gap with content (≥ 1,600
  characters before the first `runtime.waitForReady`, ≥ 2,400 for DOM, React, ESLint and coverage).
- People are only လှလှ, အောင်အောင် and မောင်မောင်; test names are short English; Burmese digits
  without separators, also inside code values (`TEA ဆယ်` for TEA10, `V ၈` for v8).
- Code, test names and messages are described, not read; API names are split for the voice (`to Be`,
  `spy On`); the panel is read in draw order; Expected and Received get colours only in the diff.
- AI claims name who measured and when; Kent Beck is named in 10 and 30, only 32 names places to
  learn more, and wrong code is always the starting problem, never an accident.

## How it was built and checked

Agents built the course in stages, within a budget of 30:

1. **Foundation:** a platform agent built and verified the bridge, panel and workspaces in a real
   WebContainer (`PLATFORM.md`); a research agent checked every fact at its source (`facts.md`); the
   curriculum planned 32 lessons with coverage tables; a reviewer reconciled it with the platform.
2. **The pilot:** one author built lessons 1 and 2 through every gate; the lead approved their Burmese
   as the course's voice, and the pilot notes became binding.
3. **Authors**, one per two lessons, wrote the design, workspace, YAML and Burmese narration directly.
4. **Auditors**, one per four lessons, checked facts and code, coverage and honesty, the Burmese, and
   the learner's flow and mechanics, and fixed what they found.
5. **A continuity pass** read all 32 together (bridges, first uses, prices, names, dated facts,
   coverage) and changed narration in 17 lessons (plus one chapter title and two board labels), but
   no action, mark or code.
6. **The lead** raised the DOM and React retries (lessons 18, 19, 20, plus 24 for uniformity) and
   re-ran every gate on all 32 lessons (`research/lead/final-gates.sh`). That sweep caught one
   intermittent replay failure in lesson 05: the panel froze on an old report because the file
   watcher missed a write. The fix went into the bridge every lesson shares (see Decisions). The lead
   also moved lesson 27 to the current GitHub Actions majors, then re-ran every gate on all 32. The
   re-run caught one more timing slip, in lesson 03: the first check after an edit carried the
   follow-up retry because it sits at a later narration mark. A scan of all 32 found the same pattern
   in lesson 18, and both checks now carry the post-edit retry. **Final result:** all 32 lessons pass
   every gate on the committed files. The director finds them valid with no critique notes, and
   compile-check passes with 0 warnings at 55, 70 and 95 ms per character. The simulator matches
   every `expect.preview` and `expect.file`, verify reports 0 failures and 0 console warnings, and
   the narration lint is clean. The repo's registry test (`src/studio/plans/index.test.ts`) passes
   with all 32, and each lesson was committed with the repo's pre-commit hook running.

The gates (AUTHOR-BRIEF.md), run from the course worktree on each built YAML, must all pass (`tools/`
is the work folder's):

- `bun scripts/studio-director.ts`: valid, every ✗ and `sources.missing` fixed, ✎ notes weighed.
- `bun scripts/studio-compile-check.ts`: PASS, ERRORs and dialog-ending and code-character warnings
  fixed; it times the lesson at 55, 70 and 95 ms per character, and every lesson ended at 0 warnings.
- `bun tools/sim.ts`: "every expect.preview / expect.file matched" (real Vitest, no browser).
- `tools/verify.sh --screenshot-dir=…` (`studio-verify-lesson` on real Vite and headless Chrome): 0
  failures of any kind, 0 console errors. It runs actions back to back, so compile-check owns timing.
- `bun tools/lint-narration.ts`: "lint: clean"; it also writes `voice-script.md`.

## Decisions taken during the build

Nothing was left open; every DESIGN.md records its choices as decisions. These shape the whole course:

- **Vite 7.3.7, not 8.3.5:** in the WebContainer, Vite 8's bundler downloads a WASI binding at
  `pnpm dev` and prints `ExperimentalWarning` lines; Vite 7 is ready in 2.6–3.4 s with clean output.
- **happy-dom, not jsdom:** both passed the same checks with Burmese names, but happy-dom installs 26
  fewer packages, sets up about three times faster and has `matchMedia`. Lesson 18 draws the swap.
- **istanbul, not v8:** with v8 the first coverage run never finishes in the WebContainer, though
  local runs and verify pass, so only a render would have found out.
- **A new test goes in as one `block`,** then `editor.select` walks through it: typed line by line, a
  half-written test can parse, and Vitest ran on a half-typed line in lesson 1's first verify run.
- **One insert replaces a line:** at the old line's first non-space character go the new line, a
  newline, the indentation and `// `, so every state parses (lessons can only insert; lesson 3 says
  once that a real project would just delete the old line).
- **The never-used list** (each unverified or failing in the WebContainer): snapshot updates, empty
  inline snapshots, the per-file environment comment, the v8 provider, threshold failures, typecheck
  mode, Browser Mode, the Vitest UI, MSW, an unstubbed `fetch`, a driven browser, a terminal.
- **A 2000 ms retry for DOM and React checks:** DOM and React reports land 2.7–3.3 s after an edit,
  so the brief's 3 × 1500 ms could fail in a slow render. The lead raised every post-edit check in 18,
  19 and 20 to 3 × 2000 ms, and 24's too for uniformity (coverage lands in 1.6–1.9 s).
  `research/lead/expect-gaps.ts` showed at least 7.9 s of slack after each check at 55 ms per
  character, so the longer wait never delays the next action.
- **The bridge double-checks the file watcher:** in one of the lead's replays of lesson 05, the panel
  froze on an old report. The bridge never saw that write or two later ones: the pill never even
  turned `running`. It did not recur in 30 instrumented replays, 15 of them under the same load, so the
  likely cause is macOS FSEvents dropping events under heavy disk I/O, which chokidar 3 does not
  rescan for. The bridge now also compares `src/` and the Vitest config with what it last handed to
  Vitest every 500 ms. A file that changed at least 300 ms ago without a watcher event is treated like
  one, once per file state, with a `[course] the file watcher missed …` line in the runner output.
  `research/lead/bridge-test/fault-test.mjs` passes 12 of 12 checks with the new bridge, and the old
  bridge fails all four missed-write checks. In a real WebContainer, an edit still reached the panel
  in 1.5 s, typing still gave exactly one run, and a write the watcher was told to ignore was caught
  and reported in 2.1 s, with no false catches.
- **Current GitHub Actions in lesson 27:** the workflow types `actions/checkout@v7` and
  `actions/setup-node@v7`. GitHub's starter workflow still shows `@v4`, but GitHub's releases list
  v7.0.1 and v7.1.0 as the latest on 6 November 2026. Both actions moved to the Node 24 runtime in v5,
  and v4 runs on Node 20, which reached end-of-life in April 2026. The narration never names the
  version.
- **Config edits** are `block` inserts of whole option lines (18, 26, 27), because a half-typed config
  stops Vitest. **No TypeScript lesson:** 23 is JavaScript on `base-lint` with TypeScript on the
  whiteboard, because `base-lint` and `base-ts` were never verified together.
- **House style:** `test`, `describe` and `expect` with explicit imports, as Vitest's docs write and
  web.dev advises; `test.for` for new tables (lesson 28 says the course chose it, not Vitest).
- **Copyright and descriptions:** auditors rewrote every close paraphrase of web.dev they found, in 15
  lessons. Each DESIGN.md has a Burmese draft description with the CC BY credit, ready for
  Create draft… (the schema has no description field).

Notable lesson-level decisions:

- **4, 31:** a test file with no test is a Failed Suite, so 4 uses one test file per module and 31's
  property file starts with a `test.todo`. **6:** "Vitest's four basic hooks", since Vitest 5 has more.
- **7:** `-t "lineTotal > adds"`, since `-t` is a regular expression on the full name and the
  curriculum's filter matched nothing. **9:** one test file and no timer, because the bridge reports
  unhandled errors only for the latest run, and only while that run lasts.
- **13:** web.dev's drawer becomes takeaway cups and lids from two suppliers, as no example may be
  lifted from a source. **16:** the audit fixed a rule: a module mock covers the whole file, while
  stubs and spies are undone per test. **19:** the leftover-form problem is drawn, as a failing
  Testing Library query prints the whole DOM. **20:** two added reds give each technique a visible
  change. **22:** the injection test follows the refactor, or it would reach the real `fetch`.
- **23:** a one-insert fix (an early return trips `no-unreachable`), and `noImplicitAny` is on by
  default since TypeScript 6.0. **24:** happy hour is a list lookup, as istanbul counts each `&&`
  operand as a branch. **25:** the flaky test is a free-cup draw, where stubbing `Math.random` fixes
  the real cause; the debugger line adds `--no-file-parallelism`, which Vitest 5.1 requires.
- **26:** corrects the curriculum: with a `vitest.config` file, Vitest ignores `vite.config` unless
  the two are merged. **27:** the workflow and `.gitignore` are literal blocks in the template, as
  dotfiles are not pinned. **30:** a real diff, restored bottom-up so each sentence reads the first
  failure block. **32:** four pointers named aloud: web.dev, Vitest, Testing Library and fast-check.

## Pronunciation notes

The words most likely to need a `BURMESE_RESPELLINGS` entry after the first Burmese render, from the
32 DESIGN.md files (`dev`, `app`, `vite`, `DOM` and `Vitest` are already in the lexicon; Vitest is
said "Veet test"):

- **Names:** `Chai`, `istanbul`, `StrykerJS`, `METR`
  (it says "meter"), `DORA`, `jsdom`.
- **Letters and capitals:** `TDD`, `CI` (and `ci` in `npm ci`), `AI`, `API`, `npm`, `URL`, `HTML`,
  `JSX`, `MSW`, `UI`, `VS Code`, the pill's `PASS` and `FAIL`, `AGENTS`, `DEV`, `RUN`.
- **Short tokens:** `vi`, `if`, `it`, `act`, `then`, `Date`, `queue`, `role`, `git`, `Bun`, and the
  single-letter watch keys (lesson 7) and snapshot keys (21).
- **Risky parts and long words:** `Be` in `to Be`, `By` in `get By Role`, `unstub`, `inspect brk`,
  `counterexample`, `Unhandled`, `triangulate`, `parallelism`, `alarm fatigue`, `stdout`, `json`.

Panel fit and length: the preview is about 432 px wide (≈ 48 characters a line). One failure block,
the tree and the summary fill about 550 px of the 600 px first screen; where more pushes the summary
off, lessons 19 and 26 only assert it, and lessons 8, 21 and 25 reorder their sections to keep what
they read on screen. Frame lines do not wrap, so lines that can fail stay near 52 characters.
compile-check rounds to 0.1 min (lesson 27's "10.0" was 10.05, trimmed to 9.9): the cap is 600,000 ms.

## Thumbnails

The template is `docs/testing-course-thumbnail.html`, the same card as the TypeScript, CSS and
accessibility courses. Its mascot is **Tick**, a round test result drawn for this course (no Vitest or
Vite logo): green with a ✓ badge when its test passes, red with a × badge when it fails, and yellow
with a ? badge while it thinks. Each `LESSONS` entry holds the lesson's number, Burmese title, one
whole real line of its final code (at most 38 characters) under the file's tab, Tick's pose (`happy`,
`joy`, `fail` or `thinking`) and tilt, and a short English bubble; a row of squares grouped by module
marks its place. `bun docs/testing-course-thumbnails/render.ts` renders them all to
`docs/testing-course-thumbnails/NN-*.png` at 1280×720.

## Working files

Working files are kept outside the repo in `~/Documents/testing-course-work/`: the curriculum, course
kit, glossary, platform notes and briefs, the base workspaces, the tools, the probes, the research
(facts, real Vitest messages, TDD and AI notes, the lead's checks), the saved sources, and per lesson
its design notes with the audit and continuity sections, `template.yaml`, `ws/` and verify's shots.
