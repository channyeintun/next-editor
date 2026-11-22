# webnode: measured baseline, 2026-11-19

What webnode measured on the lessons and starters on one day, to compare
later runs against. The rule in the README's "Scope" says a change to webnode
needs a measured gain and may not make these numbers worse: this file is what
"these numbers" were.

Every figure here comes from a recorded run of
`scripts/webnode-scenarios/measure.ts` (its header says exactly what a run
does) or `scripts/webnode-scenarios/editor-check.ts`. The tables were
generated from the recorded runs, not typed.

## How to read the numbers

- **A run** is one headless Chrome of its own (Chrome 157.0.8103.79 through
  playwright-core, `channel: "chrome"`), with a fresh profile unless the table
  says the profile was kept. The webnode scripts are built minified, as a
  deployment ships them. Both engines install from the npm registry.
- **Install s**: the lesson's init command (`pnpm install`), to its exit.
- **Preview s**: from the start of the run command (`pnpm dev`) until the
  preview shows the lesson's page; for a testing lesson, with its first test
  result; for a program without a page, until it has printed its output.
- **Peak MB / End MB**: the sum of the physical footprint of Chrome's renderer
  processes (the figure its task manager shows), sampled four times a second.
  Peak is the highest sum of the run. End is the last one: about 12 s after
  the first preview, after the lesson's final files were written in.
- **Each figure is the median of three runs** unless it says otherwise.
- **The machine**: Apple M1, 8 GB, macOS 26.6.2, Bun 1.4.4, in everyday use
  with other apps open (4.1 of 5.1 GB of swap was in use during the memory
  work). A home uplink whose speed to the npm registry changed a lot over the
  day.
- **How far to trust a difference.** On the same code, End MB moved by about
  ±10 MB between passes on the lessons and ±30 MB on the React starter; Peak MB
  by up to ±40 MB. Install times follow the network: compare them only between
  runs made close together. To judge a change, measure before and after it on
  the same day rather than against this file alone.

## 1. webnode and WebContainer, first visit

WebContainer was removed from the app later the same day, so this section is
the last comparison and cannot be measured again: the script measures webnode
alone now. The bar for a later change is section 2.

Code: commit `a20900e6` (before the two memory changes of the same day, see
section 5). WebContainer is `@webcontainer/api` 1.6.4. For each target the two
engines ran in turn, three runs each, so both saw the same network. Each cell
is webnode / WebContainer.

| Setup (lessons)                              | Target                                           | Pass      | Install s   | Preview s  | Peak MB     | End MB      |
| -------------------------------------------- | ------------------------------------------------ | --------- | ----------- | ---------- | ----------- | ----------- |
| No dependencies (120)                        | `a11y-course-01-why`                             | 3/3 / 3/3 | – / –       | 0.1 / 4.7  | 128 / 784   | 128 / 784   |
| Vite 5 (49)                                  | `css-course-01-basics`                           | 3/3 / 3/3 | 5.5 / 19.9  | 0.9 / 2.6  | 568 / 1609  | 432 / 1344  |
| Vite 5, TypeScript 6 (31)                    | `typescript-course-07-functions`                 | 3/3 / 2/3 | 9.2 / 33.7  | 1.6 / 4.2  | 616 / 1662  | 507 / 1645  |
| Vite 7, Vitest 5 (26)                        | `testing-course-02-first-vitest-test`            | 3/3 / 3/3 | 7.2 / 24.3  | 1.4 / 3.8  | 570 / 1684  | 465 / 1397  |
| Vite 5, esbuild (20)                         | `ai-course-07-generative-loop`                   | 3/3 / 3/3 | 7.0 / 23.7  | 1.0 / 3.1  | 553 / 1596  | 454 / 1363  |
| Vite 5, dom-accessibility-api, tabbable (13) | `a11y-course-08-keyboard-focus`                  | 3/3 / 3/3 | 7.7 / 25.2  | 0.9 / 2.8  | 593 / 1584  | 468 / 1395  |
| Vite 5, React 19 (11)                        | `react-crash-course-03-state-events`             | 3/3 / 3/3 | 9.0 / 40.3  | 1.4 / 3.4  | 568 / 1531  | 512 / 1378  |
| Vitest, Testing Library DOM, happy-dom (2)   | `testing-course-19-dom-testing`                  | 3/3 / 3/3 | 16.0 / 41.0 | 1.6 / 5.1  | 600 / 1722  | 526 / 1438  |
| Vite 7, plugin-rsc (2)                       | `react-crash-course-12-server-components`        | 3/3 / 3/3 | 8.7 / 31.3  | 2.7 / 9.0  | 664 / 1545  | 636 / 1510  |
| Vite 5, axe-core (2)                         | `a11y-course-18-automated-testing`               | 3/3 / 3/3 | 7.9 / 29.8  | 0.9 / 2.7  | 625 / 1607  | 566 / 1469  |
| Vitest, ESLint 10 (1)                        | `testing-course-23-static-analysis`              | 3/3 / 3/3 | 12.1 / 34.5 | 1.4 / 4.0  | 584 / 1732  | 533 / 1401  |
| Vite 5, Tailwind 4 (1)                       | `css-course-43-tailwind`                         | 3/3 / 3/3 | 16.2 / 54.1 | 1.2 / 3.7  | 637 / 1604  | 504 / 1435  |
| Vitest, Testing Library React (1)            | `testing-course-20-component-testing`            | 3/3 / 3/3 | 15.0 / 47.4 | 1.8 / 5.1  | 705 / 1581  | 598 / 1429  |
| Vite 5, React, TypeScript (1)                | `typescript-course-33-react`                     | 3/3 / 3/3 | 13.3 / 44.3 | 2.0 / 4.5  | 677 / 1873  | 585 / 1789  |
| Vitest, coverage-istanbul (1)                | `testing-course-24-coverage`                     | 3/3 / 3/3 | 13.1 / 35.4 | 1.6 / 9.6  | 667 / 1864  | 558 / 1573  |
| Vitest, fast-check (1)                       | `testing-course-31-test-quality`                 | 3/3 / 3/3 | 8.4 / 26.2  | 1.4 / 4.2  | 586 / 1618  | 487 / 1342  |
| Vite 5, TypeScript, ms (1)                   | `typescript-course-25-modules-declaration-files` | 3/3 / 3/3 | 10.2 / 33.1 | 1.7 / 4.0  | 634 / 1690  | 516 / 1650  |
| Vite 5, TypeScript, zod (1)                  | `typescript-course-32-zod`                       | 3/3 / 3/3 | 10.4 / 36.4 | 1.9 / 4.4  | 664 / 1748  | 563 / 1727  |
| Starter: React (TanStack Start, Vite 8)      | `starter:react`                                  | 3/3 / 3/3 | 40.9 / 90.8 | 3.6 / 12.8 | 1341 / 2795 | 1341 / 2795 |
| Starter: Vue                                 | `starter:vue`                                    | 3/3 / 3/3 | 13.5 / 29.2 | 1.3 / 9.6  | 721 / 1867  | 641 / 1604  |
| Starter: Solid                               | `starter:solid`                                  | 3/3 / 3/3 | 16.1 / 34.6 | 1.5 / 10.2 | 770 / 1857  | 675 / 1633  |
| Starter: Svelte                              | `starter:svelte`                                 | 3/3 / 3/3 | 11.1 / 24.0 | 2.5 / 11.8 | 776 / 1816  | 776 / 1808  |
| Starter: HTML/CSS                            | `starter:htmlCss`                                | 3/3 / 3/3 | 9.8 / 20.2  | 0.9 / 8.6  | 590 / 1755  | 466 / 1529  |
| Starter: HTMX + Express                      | `starter:htmx`                                   | 3/3 / 3/3 | 1.5 / 19.6  | 0.7 / 2.4  | 253 / 1383  | 218 / 1112  |
| Starter: Alpine + Express                    | `starter:alpine`                                 | 3/3 / 3/3 | 1.4 / 20.7  | 0.4 / 2.2  | 254 / 1405  | 219 / 1149  |
| Starter: Express + TypeScript (tsx watch)    | `starter:expressTs`                              | 3/3 / 3/3 | 13.2 / 29.8 | 0.5 / 3.1  | 387 / 1766  | 307 / 1434  |
| Starter: JavaScript (node)                   | `starter:javascript`                             | 3/3 / 3/3 | 0.1 / 4.0   | 0.2 / 0.9  | 175 / 1102  | 175 / 1102  |
| Starter: TypeScript (tsx)                    | `starter:typescript`                             | 3/3 / 3/3 | 9.3 / 23.0  | 0.2 / 1.8  | 321 / 1538  | 321 / 1523  |
| Starter: Kite + Vite                         | `starter:kiteWeb`                                | 3/3 / 3/3 | 10.8 / 20.0 | 1.0 / 8.4  | 848 / 1816  | 608 / 1664  |

- Boot (not in the table): 71 ms on webnode, 5743 ms on WebContainer.
- webnode passed 87 of 87 runs. WebContainer passed 85 of 87 in the first
  pass; both failures were npm registry socket timeouts (one is the 2/3 above).
- `testing-course-02-first-vitest-test` and
  `react-crash-course-12-server-components` first ran during a registry stall
  that hit both engines (webnode installs of 287 s and 113 s, WebContainer one
  timeout and 175 s). The table has their re-run.
- After each lesson's final files were written in, the preview's text was the
  same on both engines, for every lesson.

## 2. webnode on the deployed code, first visit

Code: commit `2ac90ae7`, deployed that evening as runtime build `mwn9j7yp`
(with both changes of section 5). webnode alone, three runs, a fresh profile
each. **This is the table to compare memory against.**

| Target                                           | Pass | Install s | Preview s | Peak MB | End MB |
| ------------------------------------------------ | ---- | --------- | --------- | ------- | ------ |
| `a11y-course-01-why`                             | 3/3  | –         | 0.2       | 119     | 119    |
| `css-course-01-basics`                           | 3/3  | 5.7       | 0.9       | 580     | 419    |
| `typescript-course-07-functions`                 | 3/3  | 9.0       | 1.7       | 627     | 493    |
| `testing-course-02-first-vitest-test`            | 3/3  | 6.7       | 1.4       | 552     | 462    |
| `ai-course-07-generative-loop`                   | 3/3  | 5.0       | 1.0       | 554     | 441    |
| `a11y-course-08-keyboard-focus`                  | 3/3  | 5.3       | 0.9       | 586     | 454    |
| `react-crash-course-03-state-events`             | 3/3  | 7.6       | 1.3       | 552     | 488    |
| `testing-course-19-dom-testing`                  | 3/3  | 13.8      | 2.3       | 575     | 500    |
| `react-crash-course-12-server-components`        | 3/3  | 21.6      | 2.9       | 642     | 639    |
| `a11y-course-18-automated-testing`               | 3/3  | 6.2       | 1.0       | 587     | 544    |
| `testing-course-23-static-analysis`              | 3/3  | 12.5      | 1.4       | 561     | 525    |
| `css-course-43-tailwind`                         | 3/3  | 13.9      | 1.1       | 604     | 480    |
| `testing-course-20-component-testing`            | 3/3  | 16.5      | 1.8       | 643     | 548    |
| `typescript-course-33-react`                     | 3/3  | 14.3      | 2.0       | 633     | 567    |
| `testing-course-24-coverage`                     | 3/3  | 19.1      | 1.6       | 620     | 539    |
| `testing-course-31-test-quality`                 | 3/3  | 8.9       | 1.4       | 559     | 471    |
| `typescript-course-25-modules-declaration-files` | 3/3  | 9.8       | 1.7       | 588     | 506    |
| `typescript-course-32-zod`                       | 3/3  | 17.9      | 2.0       | 634     | 552    |
| `starter:react`                                  | 3/3  | 51.6 \*   | 2.9       | 1266    | 1266   |
| `starter:vue`                                    | 3/3  | 34.5 \*   | 1.5       | 683     | 595    |
| `starter:solid`                                  | 3/3  | 64.5 \*   | 1.6       | 719     | 632    |
| `starter:svelte`                                 | 3/3  | 53.2 \*   | 2.5       | 739     | 735    |
| `starter:htmlCss`                                | 3/3  | 19.4 \*   | 1.0       | 555     | 445    |
| `starter:htmx`                                   | 3/3  | 33.0 \*   | 0.8       | 213     | 195    |
| `starter:alpine`                                 | 3/3  | 29.4 \*   | 0.4       | 232     | 200    |
| `starter:expressTs`                              | 3/3  | 78.6 \*   | 0.5       | 414     | 275    |
| `starter:javascript`                             | 3/3  | 0.1       | 0.2       | 157     | 157    |
| `starter:typescript`                             | 3/3  | 34.9 \*   | 0.2       | 306     | 306    |
| `starter:kiteWeb`                                | 3/3  | 34.9 \*   | 1.1       | 786     | 596    |

\* The registry was slow while the starters ran (right after, `curl` took
13.5 s for one 0.8 MB metadata file): these install times are the network's,
not a baseline. The installer did not change that day; for install times use
webnode's column in section 1.

Boot: 74 ms.

## 3. Every lesson that installs something, once

Code: commit `a20900e6`. All 164 lessons with dependencies, one run each on
webnode (`measure.ts lessons`), each also with its final files written in.

- All 164 pass. (160 passed outright; the other four tripped two assumptions
  of the script, fixed in `22e770d4`, and pass on both engines since.)
- Install: median 6.5 s, longest 14.5 s.
- First preview: median 1.1 s, longest 2.8 s.
- Peak: median 587 MB, highest 669 MB. End: median 467 MB, highest 654 MB.

## 4. Later visits

The browser's profile kept between runs (`PROFILE=<dir>`): a first visit held
110 s so that the prepared forms of the large modules get made and kept, then
three later visits, which the table shows. Both columns install from the
browser's HTTP cache, which is why installs take a second or two.

| Target                                |          | Install s | Preview s | Peak MB | End MB |
| ------------------------------------- | -------- | --------- | --------- | ------- | ------ |
| `css-course-01-basics`                | before   | 0.6       | 0.9       | 527     | 416    |
|                                       | deployed | 0.7       | 0.7       | 364     | 311    |
| `testing-course-02-first-vitest-test` | before   | 1.0       | 1.4       | 532     | 456    |
|                                       | deployed | 1.1       | 1.3       | 451     | 393    |
| `starter:react`                       | before   | 2.3       | 3.0       | 1236    | 1236   |
|                                       | deployed | 2.3       | 2.6       | 1106    | 1106   |

"before" is the same day's code without the kept rewrites (commit `c4c33350`).

## 5. The two memory changes of that day

**The runtime's scripts in ASCII alone** (`9e1cc88b`). Chrome keeps a script
with one character outside ASCII at two bytes a character, and every process
is a worker with its own copy of the process script.

- An idle shell process: 14.9 → 12.0 MB. An idle `node` process: 15.2 → 12.4 MB
  (ten of each started, the runtime process's footprint divided).

**The rewrites of large modules kept between visits** (`2ac90ae7`): section 4
is its gain. What it costs a first visit:

- Where a run is measured (its end, 12 s after the preview) a first visit is
  unchanged: see the table below.
- A first visit that lasts past a minute has the entries made then, in a
  worker of their own. That lifts memory by 60 to 110 MB for a few seconds.
  Afterwards it settled 17 MB (`css-course-01-basics`: 366 → 383) and 63 MB
  (`starter:react`: 1086 → 1149) above where the visit had come down to, one
  run each, and stayed below the level the visit had at its start (417 and
  1243).

First visits, End / Peak MB:

| Target                                | Before both (`a20900e6`) | ASCII alone (`9e1cc88b`)                  | Deployed (`2ac90ae7`, section 2) |
| ------------------------------------- | ------------------------ | ----------------------------------------- | -------------------------------- |
| `css-course-01-basics`                | 429 / 580                | 419 / 559                                 | 419 / 580                        |
| `testing-course-02-first-vitest-test` | 466 / 572                | 439 / 545, and 451 / 566 in a second pass | 462 / 552                        |
| `starter:react`                       | 1264 / 1264              | 1242 / 1242                               | 1266 / 1266                      |

## 6. Where a dev server's memory goes

`css-course-01-basics` (plain Vite 5), before the two changes, by the
footprint of the runtime frame's renderer process; all renderers together are
about 95 MB more.

- After the install: 57 to 63 MB (the kernel, and `node_modules` in the shared
  filesystem).
- With `pnpm dev` up: about 225 MB more, unchanged over five idle minutes.
- Five processes: `sh -lc pnpm dev`, `pnpm dev`, `sh -c vite …`, Vite, and
  esbuild's service. Each idle process costs about 12 MB since the ASCII change.
- Vite's own heap: about 130 MB while it starts, 20 MB once idle. esbuild's
  service: about 40 MB beside its process.
- The heap a worker used is given back slowly or not at all: a process that
  made 150 MB of objects, dropped them and went idle still cost 150 MB a minute
  later, and after it was killed; a second process then cost 10 MB, using what
  the first had let go. So what a session keeps follows the highest heap it
  reached, which is what the kept rewrites of section 5 lower.

## 7. The deploy of that evening

Worker version `fc77d892`, runtime build `mwn9j7yp`, head `2ac90ae7`.

- `editor-check.ts` (the real editor, its default project, two visits in one
  profile) passed on a local Worker serving `dist/` before the deploy and on
  https://nexteditor.dev after it. On production: first preview after 42.1 s
  (install included), 6 entries (4.4 MB) kept a minute on, the second visit
  asked for 6 of 6.
- Conformance cases, minified build: 75 of 76 locally (the one is
  `npm-lost-reader.cjs`, which depends on which pnpm is first on this
  machine's PATH). Against the production hosts 69 of 76: the six others are
  process-heavy or timed, and pass 6 of 6 against the same built files on a
  local Worker in the same mode (the harness turns the browser's HTTP cache
  off there, so each process start downloads the process script again).

## 8. The Rust rewriter (the same day; deployed that night)

The entries of large modules made at once by a Rust rewriter
(process/loader/rewriter) instead of by sucrase a minute into a first visit.
It took every large module of the three targets (3 of Vite 5's, 7 of the
Vitest lesson's, 7 of the React starter's); none was left to sucrase.

First visits, a fresh profile each, End / Peak MB and first preview:

| Target                                | Deployed (section 2) | With the Rust rewriter |
| ------------------------------------- | -------------------- | ---------------------- |
| `css-course-01-basics`                | 419 / 580, 0.9 s     | 326 / 529, 0.8 s       |
| `testing-course-02-first-vitest-test` | 462 / 552, 1.4 s     | 393 / 530, 1.4 s       |
| `starter:react`                       | 1266 / 1266, 2.9 s   | 1177 / 1218, 2.7 s     |

Later visits in the same profile are as in section 4: 316, 390 and 1141 MB at
the end. A first visit now also keeps its entries at once, so the cost of a
long first visit in section 5 is gone for these targets.

The rewrite itself, on Vite 5's main chunk (2.09 MB): 65 ms with the Rust
rewriter, the loader's other steps included (measured under Bun). sucrase
took 223 ms on a 1.5 MB module (under Node 22), and held some 55 MB of heap
after it.

Deployed as Worker version `d988dd5d`, runtime build `mwnnxh5k`, head
`29c19dc9`. It went out on the harness measurements above, the gate and one
first visit of the real editor on a local Worker serving `dist/` (preview after
63 s): `editor-check.ts` could not finish that night, before or after the
deploy, because `pnpm install` kept stalling on the npm registry.

The scripts: `prepare.js`, the worker that carries the rewriter, is 1.49 MB
and is loaded only when a large module has no entry yet; `process.js` and
`kernel.js` are unchanged in size.

## 9. Where a first preview's time and memory go (2026-11-23)

A survey, not a change: nothing in this section is in the tree. Code: head
`713a5fb2` (webnode as deployed, last changed in `57ceff4a`), with timers
added for the runs and removed after them. They timed, in each process, its
start, the loader's rewrite of each module, the compile of each module's
wrapper and each WebAssembly compile. One run a row, a fresh profile, unless
it says otherwise.

| Target                                | First preview | Until the dev server's first line | Rewrite in its process | Large modules' entries | Wrapper compiles |
| ------------------------------------- | ------------- | --------------------------------- | ---------------------- | ---------------------- | ---------------- |
| `css-course-01-basics`                | 0.85 s        | 162 ms                            | 29 ms, 12 files        | 152 ms                 | 22 ms            |
| `testing-course-02-first-vitest-test` | 1.4 s         | 163 ms                            | 95 ms, 79 files        | 187 ms                 | 36 ms            |
| `typescript-course-07-functions`      | 1.7 s         | 165 ms                            | 261 ms, 18 files       | 157 ms                 | 83 ms            |
| `starter:htmlCss`                     | 0.9 s         | 163 ms                            | 62 ms, 59 files        | 134 ms                 | 27 ms            |
| `starter:react`                       | 2.8 s         | 180 ms                            | 309 ms, 732 files      | 244 ms                 | 111 ms           |

- **Until the dev server's first line** is four process starts in a row:
  `sh -lc pnpm dev`, `pnpm dev`, `sh -c vite …`, then `node`. A process takes
  36 to 40 ms to start: 24 ms until the script's first statement (the worker,
  and the browser compiling the 1.5 MB script, which it does again for every
  worker), 12 ms for the script's own start, 1 ms until it is told what to run.
- **Rewrite** is the loader's work on each module in JavaScript. In the React
  starter 214 of the 309 ms are sucrase on 434 ES modules (4.1 MB); the thread
  that renders on the server spends 116 to 140 ms more on 239 files.
- **`typescript.js` (9.1 MB) is rewritten twice** in every lesson that loads
  TypeScript: 156 ms and 69 ms. A CommonJS file an ES module imports is
  prepared once to learn that it is CommonJS, and that result is dropped
  before the file is loaded. One pass over it is 56 ms finding module syntax,
  75 ms compiling the whole file to learn that it has no top-level `await`,
  and 41 ms looking for `eval`.
- **Large modules' entries** is a first visit: 27 ms for the page's first
  answer, about 70 ms to start the worker that makes them, 28 ms a megabyte to
  rewrite. A later visit takes 17 ms.
- **WebAssembly compiles cost nothing to speak of**: esbuild's module (Go,
  11.7 MB) 10 ms, rolldown's (12.1 MB) 17 ms, lightningcss's (15.8 MB) 16 ms.
  The browser compiles a function when it is first called.

**What a worker costs**, twenty idle ones in a page, each: 2.5 MB with an
empty script, 6.4 MB with the process script loaded and not run, 13.3 MB with
it run. The 6.9 MB of running it is spread over the whole script: no one
module stands out.

**Threads.** rolldown starts 3 threads for the HTML/CSS starter and 12 for
the React one, as it needs them. Each takes about 40 ms to start and 27 ms to
rewrite the same three ES modules again. Twelve idle threads of the napi
runtime's worker script took the page from 149 to 362 MB: 17.8 MB a thread,
before a thread rewrites anything.

**`node_modules` in the filesystem.** React starter: 124.1 MB in 8,445 files,
of which 47.5 MB (38%) had been read once the preview was up; a second
rolldown binding of 12.7 MB is installed and never read. TypeScript lesson:
43.9 MB, 27.0 MB read. Vite 5 lesson: 19.5 MB, 14.9 MB read.

**Two changes tried, three runs each, the two versions in turn:**

| Change                                                     | Target                           | Before                   | After               |
| ---------------------------------------------------------- | -------------------------------- | ------------------------ | ------------------- |
| The dev command and its script started without their shell | `css-course-01-basics`           | preview 841, 851, 880 ms | 764, 771, 800 ms    |
|                                                            |                                  | end 324, 326, 327 MB     | 298, 302, 305 MB    |
| A CommonJS file an ES module imports is prepared once      | `typescript-course-07-functions` | rewrite 265, 272, 283 ms | 195, 203, 211 ms    |
|                                                            |                                  | preview 1569, 1581, 1652 | 1460, 1502, 1557 ms |

The second was measured in a kept profile (installs from the browser's cache).

**Tried, with no effect:** `UV_THREADPOOL_SIZE`, `TOKIO_WORKER_THREADS`,
`RAYON_NUM_THREADS` and `ROLLDOWN_MAX_BLOCKING_THREADS` set to 1 leave the
React starter at 11 to 13 threads.

## 10. The two changes of 2026-11-23

What section 9 found, done: a CommonJS file is prepared and compiled once
(`73deb77d`), and a program is started without the shell that would only
start it (`7b69e73a`). Measured on the code before both (`6ff80d1b`) and
after both, the two in turn, three runs each, a fresh profile each run (first
visits). Each cell is the median, with the three runs after it.

| Target                           |        | Preview ms              | End MB                  | Peak MB                 |
| -------------------------------- | ------ | ----------------------- | ----------------------- | ----------------------- |
| `css-course-01-basics`           | before | 820 (780, 820, 917)     | 324 (323, 324, 329)     | 519 (518, 519, 530)     |
|                                  | after  | 738 (678, 738, 748)     | 292 (292, 292, 293)     | 473 (462, 473, 477)     |
| `typescript-course-07-functions` | before | 1647 (1638, 1647, 1701) | 482 (446, 482, 487)     | 630 (591, 630, 631)     |
|                                  | after  | 1416 (1378, 1416, 1642) | 419 (409, 419, 427)     | 532 (522, 532, 562)     |
| `starter:react`                  | before | 2878 (one run)          | 1093                    | 1137                    |
|                                  | after  | 2624 (2615, 2624, 2675) | 1114 (1094, 1114, 1120) | 1152 (1130, 1152, 1158) |

- The React starter's memory did not move: two more runs of the old code
  that morning ended at 1152 and 1231 MB (section 9's runs, with the timers),
  so the old code's three are 1093, 1152 and 1231.
- A dev server is now three processes where it was five: `pnpm dev`, the
  server, and what the server starts (esbuild's service under Vite 5 and 7).
- Before these went out: the unit tests (159 files, 4,837 tests), the
  conformance cases on the minified build (75 of 76, and the 76th,
  `npm-lost-reader.cjs`, with pnpm 9 first on the PATH), the twelve scenarios
  of `gate.sh` on the minified build, and `editor-check.ts` on a local Worker
  serving `dist/` (both visits).
- The change to the loader's rewrite (transform.ts) gives the kept entries of
  large modules a new version: a browser that had them makes them once more.

## Measuring again

```bash
# Section 2: every target, three runs each (about half an hour).
bun scripts/webnode-scenarios/measure.ts

# Section 3: every lesson that installs something, once.
RUNS=1 bun scripts/webnode-scenarios/measure.ts lessons

# Section 4: a first visit that lasts, then three later ones, in one profile.
RUNS=1 HOLD=110 PROFILE=node_modules/.cache/webnode-measure/profile bun scripts/webnode-scenarios/measure.ts css-course-01-basics
RUNS=3 PROFILE=node_modules/.cache/webnode-measure/profile bun scripts/webnode-scenarios/measure.ts css-course-01-basics

# Section 7: the real editor on production.
bun scripts/webnode-scenarios/editor-check.ts https://nexteditor.dev
```

`bun scripts/webnode-scenarios/measure.ts --table` prints the table of the
runs recorded last (`node_modules/.cache/webnode-measure/runs.jsonl`;
`MEASURE_RUNS` names another file).
