# TypeScript course — course guide

A 34-lesson TypeScript course narrated in Burmese, built on Matt Pocock's
[Total TypeScript Essentials](https://www.totaltypescript.com/books/total-typescript-essentials)
(all 16 chapters) and three of the free [Total TypeScript tutorials](https://www.totaltypescript.com/tutorials)
(Solving TypeScript Errors, React with TypeScript, Zod; the Beginner's TypeScript tutorial covers
the same ground as the book's chapters 4–5, so it is not cited separately). The book has no open
licence, so the lessons teach its ideas in their own words with their own examples (the same Yangon
tea shop as the CSS and accessibility courses, ရွှေလက်ဖက်ရည်ဆိုင်), and credit it in each scene's
`sources`. Lessons are short — 8 to 10 minutes each (lesson 8 is 7.9), about 5 hours 23 minutes in total at Burmese
VoxCPM2 pace (70 ms per character).

Every lesson is a studio LessonScript in `src/studio/scripts/typescript-course-*.yaml` (locale
`my-MM`, `lessonType: typescript`), and every one is hands-on: a small TypeScript project runs with
Vite in the WebContainer, starts with realistic problems in it, and the learner watches errors,
types and the program's output change as the code is fixed. Whiteboards carry the diagrams; there
is no slide deck.

The Burmese has **not** been reviewed by Chan yet, and no lesson has been rendered in /studio yet.

## Lessons

| #   | Script                                            | Title                                         | ≈ min |
| --- | ------------------------------------------------- | --------------------------------------------- | ----- |
| 1   | `typescript-course-01-why-typescript`             | TypeScript ဆိုတာ ဘာလဲ                            | 8.2   |
| 2   | `typescript-course-02-editor-superpowers`         | Editor က ဘယ်လို ကူညီပေးလဲ                           | 9.6   |
| 3   | `typescript-course-03-pipeline`                   | TypeScript က JavaScript ဖြစ်လာပုံ                | 9.9   |
| 4   | `typescript-course-04-basic-types`                | Type annotation နဲ့ အခြေခံ type တွေ               | 9.3   |
| 5   | `typescript-course-05-object-types`               | Object type နဲ့ type alias                      | 9.7   |
| 6   | `typescript-course-06-arrays-tuples`              | Array၊ tuple နဲ့ type argument                  | 9.9   |
| 7   | `typescript-course-07-functions`                  | Function တွေကို type ပေးခြင်း                     | 9.8   |
| 8   | `typescript-course-08-unions-literals`            | Union နဲ့ literal type                          | 7.9   |
| 9   | `typescript-course-09-narrowing`                  | Narrowing                                     | 9.9   |
| 10  | `typescript-course-10-unknown-never`              | unknown နဲ့ never                               | 8.9   |
| 11  | `typescript-course-11-discriminated-unions`       | Discriminated union                           | 9.6   |
| 12  | `typescript-course-12-interfaces-intersections`   | Interface နဲ့ intersection                      | 8.9   |
| 13  | `typescript-course-13-dynamic-keys`               | Dynamic key တွေနဲ့ Record                        | 10.0  |
| 14  | `typescript-course-14-utility-types`              | Partial၊ Pick၊ Omit                           | 9.2   |
| 15  | `typescript-course-15-mutability`                 | Mutability နဲ့ readonly                         | 9.8   |
| 16  | `typescript-course-16-as-const`                   | as const                                      | 9.6   |
| 17  | `typescript-course-17-classes`                    | Class တွေ                                      | 10.0  |
| 18  | `typescript-course-18-inheritance`                | Class inheritance                             | 10.0  |
| 19  | `typescript-course-19-typescript-only-features`   | TypeScript မှာပဲ ရှိတဲ့ feature တွေ                  | 9.7   |
| 20  | `typescript-course-20-keyof-typeof`               | keyof၊ typeof နဲ့ indexed access                | 8.2   |
| 21  | `typescript-course-21-derived-utilities`          | Function ကနေ type ထုတ်ယူခြင်း                     | 9.5   |
| 22  | `typescript-course-22-satisfies-assertions`       | satisfies၊ as နဲ့ error ပိတ်ခြင်း                  | 9.9   |
| 23  | `typescript-course-23-weird-objects`              | ထူးဆန်းတဲ့ အပိုင်း 1၊ object တွေ                      | 9.9   |
| 24  | `typescript-course-24-weird-functions`            | ထူးဆန်းတဲ့ အပိုင်း 2၊ type world နဲ့ function တွေ       | 9.8   |
| 25  | `typescript-course-25-modules-declaration-files`  | Module၊ script နဲ့ declaration file             | 10.0  |
| 26  | `typescript-course-26-tsconfig`                   | tsconfig ကို ပြင်ဆင်ခြင်း                          | 9.7   |
| 27  | `typescript-course-27-generic-types`              | Generic type                                  | 9.2   |
| 28  | `typescript-course-28-template-conditional-types` | Template literal type နဲ့ conditional type      | 9.2   |
| 29  | `typescript-course-29-mapped-types`               | Mapped type                                   | 9.9   |
| 30  | `typescript-course-30-generic-functions`          | Generic function                              | 9.9   |
| 31  | `typescript-course-31-predicates-overloads`       | Type predicate၊ assertion function နဲ့ overload | 9.9   |
| 32  | `typescript-course-32-zod`                        | Zod နဲ့ runtime validation                      | 8.1   |
| 33  | `typescript-course-33-react`                      | React နဲ့ TypeScript                            | 10.0  |
| 34  | `typescript-course-34-solving-errors`             | TypeScript error တွေကို ဖြေရှင်းခြင်း               | 10.0  |

Every title is `TypeScript course NN: <title>`.

## Source coverage

| Source                                         | Lessons                                                   |
| ---------------------------------------------- | --------------------------------------------------------- |
| Ch. 1 Kickstart                                | 1                                                         |
| Ch. 2 IDE Superpowers                          | 2 (and 34)                                                |
| Ch. 3 TypeScript in the Development Pipeline   | 3                                                         |
| Ch. 4 Essential Types and Annotations          | 4 (basics, `any`), 5 (objects), 6 (arrays), 7 (functions) |
| Ch. 5 Unions, Literals, and Narrowing          | 8, 9, 10 (`unknown`, `never`), 11 (discriminated unions)  |
| Ch. 6 Objects                                  | 12 (interfaces), 13 (dynamic keys), 14 (utility types)    |
| Ch. 7 Mutability                               | 15, 16 (`as const`)                                       |
| Ch. 8 Classes                                  | 17, 18                                                    |
| Ch. 9 TypeScript-only Features                 | 19                                                        |
| Ch. 10 Deriving Types                          | 20, 21                                                    |
| Ch. 11 Annotations and Assertions              | 22                                                        |
| Ch. 12 The Weird Parts                         | 23, 24                                                    |
| Ch. 13 Modules, Scripts, and Declaration Files | 25                                                        |
| Ch. 14 Configuring TypeScript                  | 26                                                        |
| Ch. 15 Designing Your Types                    | 27, 28, 29                                                |
| Ch. 16 The Utils Folder                        | 30, 31                                                    |
| Zod tutorial (zod.dev v4)                      | 32                                                        |
| React with TypeScript tutorial (react.dev)     | 33                                                        |
| Solving TypeScript Errors tutorial             | 34                                                        |

The lessons teach November 2026 facts where the book is older:

- **TypeScript 7.0** (July 2026) is the native Go compiler, with full builds about 10× faster. It
  keeps 6.0's checks and defaults.
- **TypeScript 6.0** changed defaults. `strict` is on, `target` is the current ES version and
  `types` is `[]`. It also deprecated `target: es5`, `moduleResolution: node`, `baseUrl` and
  `outFile`.
- **Node.js 22.18+ and 24** run `.ts` files by stripping types. That is why `erasableSyntaxOnly`
  (TS 5.8) is taught in lesson 19.
- **Inferred type predicates** arrived in TS 5.5 (lessons 10 and 31).
- **Vite** strips types without checking them (lesson 3, which says "Vite and esbuild" generically,
  because current Vite uses Oxc).

## How the lessons show the type checker

The studio editor shows no TypeScript squiggles or hovers; Monaco's diagnostics are off on purpose.
Every workspace therefore pins two small files that are never typed on screen:

- **`course/checker.js`**, a Vite plugin. It runs the real TypeScript compiler (a LanguageService)
  inside the dev server and checks the whole project with its own `tsconfig.json` after every
  change.
- **`course/panel.js`**, which draws the result as a dark **TypeScript panel** in the preview.

The panel has these sections:

- **Errors**: exactly what `tsc` would print, with relative paths and line and column.
- **Types**: the answer to every `// ^?` query comment. This is the TypeScript Playground's
  twoslash syntax, and it stands in for hovering.
- **Output**: the program's `console.log` lines. The program is run in the page after every check,
  and type errors don't stop it, as with real `tsc` output.
- **JavaScript output** and **Declaration output**, on request: what TypeScript emits for a file.

The panel is ordinary DOM, so it replays exactly in the published lesson. This was checked with the
app's own rrweb replayer at 432 and 640 px.

The compiler is **TypeScript 6.0.3**, the last JavaScript-based release. 7.0 is native Go and cannot
run in a WebContainer, but it has the same checks, defaults and messages. Only lesson 3 mentions
the panel's version, in one sentence. Lesson 25 uses ms 2.1.3, lesson 32 zod 4.6.7 and lesson 33 React 19.3.1. All
dependencies are pinned exactly, with no lockfile (`pnpm install`).

The lessons never claim a squiggle, hover, autocomplete or terminal the recording cannot show. They
say what VS Code does, show the panel's equivalent, and invite the learner to try it in their own
editor.

Narration rules specific to this course:

- No lines about tooling (dev server, installs, the preview reloading).
- People are only လှလှ, အောင်အောင် and မောင်မောင်.
- Numbers are Burmese digits without a thousands separator.
- Code is described, not read aloud.
- Error codes are named at most once, to help the learner search.
- Technical terms stay in English, as in the earlier courses.

## How it was built and checked

Opus 5.5 built each lesson in two independent passes:

1. An author wrote the design, the workspace, the YAML and the Burmese narration directly.
2. A separate auditor checked every fact against the book, the TypeScript Handbook and the TSConfig
   reference, and checked the narration against what the panel really shows in the verify
   screenshots. It also edited the Burmese, checked coverage, and fixed what it found.

A final pass then checked all 33 bridges between lessons, and kept terms, prices and repeated
explanations consistent across the course.

Every committed script passes:

- the Director;
- `bun scripts/studio-compile-check.ts`, with 0 warnings at 55, 70 and 95 ms per character;
- a course narration lint, which covers tooling chatter, digits, code characters, written
  register, names and runtime spacing;
- a full replay against real Vite and headless Chrome (`bun scripts/studio-verify-lesson.ts`), with
  0 failures and 0 console warnings, run again on all 34 just before landing.

`npx vp test run src/studio/plans/index.test.ts` is green. The panel was also run inside a real
WebContainer: a cold `pnpm install` took 44–62 s, and an edit reached the panel 0.1–0.3 s after the
write.

## Decisions taken during the build

The audits raised six questions, and each was decided rather than left open.

- **Lessons 4 and 7 keep their announced test line.** Each types one line that is wrong on purpose,
  shows the error, then comments it out. Lessons can only add code, never delete it, so a
  commented-out experiment is the honest way to show a rule being enforced.
- **Lesson 8 ends with one error still on screen.** The narration says why it stays: a string from a
  form needs a check the learner has not learned yet. That check is lesson 9's narrowing.
- **The `|` symbol is called "pipe"** (lesson 8), as developers say it. It is introduced once as
  `pipe လို့ ခေါ်တဲ့ ဒေါင်လိုက် မျဉ်း သင်္ကေတ`.
- **Lesson 25 shows `declare module` live** with `ms@2.1.3`, a real npm package that ships no
  types (only that version: its prereleases ship types, so the pin is exact). The panel shows the
  real "Could not find a declaration file for module 'ms'" error while the program still runs.
  The narration names `@types/ms` as the usual fix. Then `src/types/ms.d.ts` declares the default
  export, which clears the error and turns the query's `any` into `number`. Its workspace adds
  `course/modules-ms.js` so the panel's runner can load the package.
- **Identifier spelling in narration follows the glossary.** Type names stay whole (`ReactNode`,
  `MouseEvent`, `Partial`), as the utility types do. Glued keywords, hooks and props are split
  for the voice (`key of`, `use State`, `on Click`).
- **Lesson 34 names Total TypeScript aloud** in its "where to go next" sentence. It is a pointer for
  the learner, not a citation, so the course lint allows that one scene.

Version numbers in the narration are written the way Burmese reads a decimal (`၂၂ ဒသမ ၁၈`,
`၅ ဒသမ ၅`, `၅ ဒသမ ၈`), and TypeScript versions as `TypeScript ၆` / `TypeScript ၇`. That way
the voice can't misread a dot.

The lead's final re-verify found one timing-dependent failure, in lesson 33. A prop typed key by
key (`onCli…`) is valid TSX, so the in-page run rendered it and React logged a warning. That edit
is now a single insert.

## Pronunciation notes

These are the words most likely to need a `BURMESE_RESPELLINGS` entry after the first Burmese
render. The narration already spells the risky ones for the voice: `T S C`, `T S config`,
`D T S`, `at types`, `key of`, `type of`, `read only`, `instance of`, `use State`,
`on Click`.

- **Remaining candidates:** `JSDoc`, `NaN`, `JSON`, `Zod`, `npm`, `KBZPay`, `QR`,
  `Object.freeze` (lesson 16) and `Readonly`.
- **Single letters:** `T` (lesson 30) and `e` (lesson 4).
- **The panel's fit:** the first screen holds at most 3 errors, 4 types and 6 output lines at the
  moments the narration discusses them. It was measured at the studio's 432 px preview width.
- **Lesson length:** lessons 13, 17, 18, 25, 33 and 34 are at the 10.0-minute top of the range.

## Thumbnails

The template is `docs/typescript-course-thumbnail.html`. It is the same card as the CSS and
accessibility courses, with the mascot **Tee**: a blue value inside a dashed purple type outline,
wearing a `: T` badge. The template holds each lesson's title, one real line from its final code
and a bubble word. `bun docs/typescript-course-thumbnails/render.ts` renders
`docs/typescript-course-thumbnails/NN-*.png` at 1280×720.

Working files are kept outside the repo in `~/Documents/typescript-course-work/`: the curriculum,
glossary, platform notes, the panel's base workspaces, the tools, and per-lesson design notes and
audits.
