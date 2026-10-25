# Accessibility course — course guide

A 20-lesson web accessibility course narrated in Burmese, built on
[web.dev Learn Accessibility](https://web.dev/learn/accessibility) (text CC BY 4.0, code Apache 2.0;
every module is covered, the optional Glossary feeds the term list and the Quiz is replaced by quiz pages
inside the lessons). Lessons are short — 7 to 10 minutes each, about 3 hours 7 minutes in total at
Burmese VoxCPM2 pace (70 ms per character) — and every fix is something the learner sees change on
screen.

Every lesson is a studio LessonScript in `src/studio/scripts/a11y-course-*.yaml` (locale `my-MM`).
Fifteen are hands-on: the same Yangon tea shop as the CSS course (ရွှေလက်ဖက်ရည်ဆိုင်) runs with
Vite in the WebContainer, each lesson starts from a version of the page with specific, realistic
accessibility problems, and fixes them live. Five are concept lessons (1, 2, 14, 17, 20 — lesson 20
also has a short hands-on part) that teach with pages of one Google Slides deck plus the whiteboard.

The Burmese has **not** been reviewed by Chan yet, and no lesson has been rendered in /studio yet.

## Lessons

| #   | Script                              | Title                                                         | Kind                    | ≈ min |
| --- | ----------------------------------- | ------------------------------------------------------------- | ----------------------- | ----- |
| 1   | `a11y-course-01-why`                | Accessibility course 1: Accessibility ဆိုတာ ဘာလဲ              | concept (deck)          | 9.6   |
| 2   | `a11y-course-02-measure`            | Accessibility course 2: Accessibility ကို ဘယ်လို တိုင်းတာလဲ   | concept (deck)          | 9.3   |
| 3   | `a11y-course-03-accessibility-tree` | Accessibility course 3: Accessibility tree နဲ့ semantic HTML  | hands-on                | 9.9   |
| 4   | `a11y-course-04-aria-rules`         | Accessibility course 4: ARIA ကို ဘယ်အချိန် သုံးမလဲ            | hands-on                | 9.2   |
| 5   | `a11y-course-05-landmarks-headings` | Accessibility course 5: Landmark နဲ့ heading                  | hands-on                | 9.9   |
| 6   | `a11y-course-06-lists-tables`       | Accessibility course 6: List နဲ့ table                        | hands-on                | 8.3   |
| 7   | `a11y-course-07-document`           | Accessibility course 7: Page title နဲ့ ဘာသာစကား               | hands-on                | 9.9   |
| 8   | `a11y-course-08-keyboard-focus`     | Accessibility course 8: Keyboard focus                        | hands-on                | 9.9   |
| 9   | `a11y-course-09-javascript`         | Accessibility course 9: JavaScript နဲ့ accessibility          | hands-on                | 9.8   |
| 10  | `a11y-course-10-images`             | Accessibility course 10: ပုံတွေနဲ့ alt text                   | hands-on                | 8.1   |
| 11  | `a11y-course-11-color-contrast`     | Accessibility course 11: အရောင်နဲ့ contrast                   | hands-on                | 9.9   |
| 12  | `a11y-course-12-motion`             | Accessibility course 12: Animation နဲ့ motion                 | hands-on                | 7.3   |
| 13  | `a11y-course-13-typography`         | Accessibility course 13: ဖတ်ရလွယ်တဲ့ စာသား                    | hands-on                | 9.1   |
| 14  | `a11y-course-14-video-audio`        | Accessibility course 14: Video နဲ့ audio                      | concept (deck + editor) | 9.7   |
| 15  | `a11y-course-15-forms`              | Accessibility course 15: Form တွေ                             | hands-on                | 9.9   |
| 16  | `a11y-course-16-patterns`           | Accessibility course 16: Pattern၊ component နဲ့ design system | hands-on                | 9.3   |
| 17  | `a11y-course-17-design-ux`          | Accessibility course 17: Design နဲ့ UX                        | concept (deck)          | 9.0   |
| 18  | `a11y-course-18-automated-testing`  | Accessibility course 18: Automated testing                    | hands-on (axe)          | 9.6   |
| 19  | `a11y-course-19-manual-testing`     | Accessibility course 19: Manual testing                       | hands-on                | 9.5   |
| 20  | `a11y-course-20-screen-readers`     | Accessibility course 20: Screen reader နဲ့ စမ်းသပ်ခြင်း       | concept + hands-on      | 9.7   |

## web.dev coverage

| web.dev module                           | Lesson                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Welcome; What is digital accessibility   | 1                                                                                |
| How is digital accessibility measured    | 2                                                                                |
| ARIA and HTML                            | 3 (accessibility tree, roles/names/states), 4 (when to use ARIA, the five rules) |
| Content structure                        | 5 (landmarks, headings), 6 (lists, tables)                                       |
| The Document                             | 7                                                                                |
| Keyboard focus                           | 8                                                                                |
| JavaScript                               | 9                                                                                |
| Images                                   | 10                                                                               |
| Color and contrast                       | 11                                                                               |
| Animation and motion                     | 12                                                                               |
| Typography                               | 13                                                                               |
| Video and audio                          | 14                                                                               |
| Forms                                    | 15                                                                               |
| Patterns, components, and design systems | 16                                                                               |
| Design and user experience               | 17                                                                               |
| Automated accessibility testing          | 18                                                                               |
| Manual accessibility testing             | 19                                                                               |
| Assistive Technology testing; Conclusion | 20                                                                               |

Where web.dev is out of date, the lessons teach the current fact: WCAG 2.2 has 86 success criteria
(31 A, 24 AA, 31 AAA — web.dev shows WCAG 2.1's 78); WHO's figure is 1.3 billion people, 1 in 6;
there is no `<rowgroup>` element (it is the role of thead/tbody/tfoot); the WebAIM Million figure is
the February 2026 crawl; the European Accessibility Act applies since 28 June 2025.

## How the lessons show invisible things

Most accessibility fixes change nothing you can see, so every hands-on workspace pins a small,
never-typed `panel.js` (with the npm packages `dom-accessibility-api` and `tabbable`) that draws an
**accessibility panel** at the bottom of the preview, like Chrome DevTools' accessibility tree:

- **tree** — role, accessible name and states of the page's elements, plus the document title and
  language; missing names are flagged.
- **tabs** — numbered badges in real Tab order, plus hidden Tab / Shift+Tab controls that the lesson
  clicks so focus visibly walks the page (Studio cannot press keys).
- **contrast** — WCAG contrast ratios that update after a CSS edit.
- **live** — a log of live-region updates, labelled as a simplified stand-in for a screen reader.
- **axe** — axe-core 4.14 results (lesson 18 only).

The panel is ordinary DOM, so it replays exactly in the published lesson (checked with the app's own
rrweb replayer at two widths). The lessons never claim a key press, a screen reader's voice, an OS
setting (reduced motion, contrast, zoom) or a hover the recording cannot show; they say what a screen
reader _would_ announce, show it in the panel, and invite the learner to try VoiceOver, NVDA or
TalkBack themselves.

Narration rules specific to this course: no lines about tooling (dev server, installs, the preview
opening); people are only မြမြ, လှလှ, အောင်အောင် and မောင်မောင်; numbers are Burmese digits without a
thousands separator; screen-reader output is phrased as "would announce".

## The deck

Concept-lesson pages live in **"Next Editor · Accessibility course"**:
https://docs.google.com/presentation/d/1LSOwZ_xfFr7Ip4ZSgcCFtCq0DnuXok6x56U8-6dA7ys/edit
(79 lesson pages `l01_p01` … `l20_p12`, checked page by page against the lesson plans; the ten
`kit_k*` template pages sit at the end and do no harm). The five deck lessons point at the
placeholder `https://docs.google.com/presentation/d/e/A11Y-COURSE-NOT-PUBLISHED-YET/pub`, so they
cannot render until the deck is published:

1. In the deck: File → Share → Publish to web → Publish, and copy the `…/pub` link.
2. Swap it into the five scripts (or send the link and it will be swapped and committed for you):

```bash
sed -i '' 's#https://docs.google.com/presentation/d/e/A11Y-COURSE-NOT-PUBLISHED-YET/pub#PASTE_PUB_LINK#g' src/studio/scripts/a11y-course-01-why.yaml src/studio/scripts/a11y-course-02-measure.yaml src/studio/scripts/a11y-course-14-video-audio.yaml src/studio/scripts/a11y-course-17-design-ux.yaml src/studio/scripts/a11y-course-20-screen-readers.yaml
```

Deck lessons use `timing.p95Ms` 500 (deck SVG paint stalls); the others use 300.

## How it was built and checked

Opus 5.5 built each lesson in two independent passes: an author wrote the design, the YAML and the
Burmese narration directly; a separate auditor then checked every fact against web.dev, MDN and W3C,
edited the Burmese, checked coverage and the bridges between lessons, and fixed what it found. Every
committed script passes the Director, `bun scripts/studio-compile-check.ts` (0 warnings at 55/70/95
ms per character), a course narration lint, and — for the 15 WebContainer lessons — a full replay
against real Vite and headless Chrome (`bun scripts/studio-verify-lesson.ts`, 0 failures, 0 console
warnings). `npx vp test run src/studio/plans/index.test.ts` is green. The panel was also run inside a
real WebContainer (cold `pnpm install` ≈ 26 s).

## For Chan: what to check in the renders

- **Pronunciation** (confirm by ear, then add `BURMESE_RESPELLINGS` entries if needed): `WCAG`,
  `AA` / `AAA` ("double A" / "triple A"), `NVDA`, `WAI`, `div` (lessons 5, 8, 9, 18), `img`
  (lesson 10, said as the role name), `src` / `src lang` (lesson 14 — "source"?), `ul` / `ol` / `li`,
  `th` / `td`, `colgroup`, `figcaption`, `labelledby` / `describedby`, `iframe`, `Zawgyi`, `WebVTT`,
  `HSL`, `rem`, `ch`, `SVG`, `API`, `ADHD`, and in lesson 13 the single letters `I` and `l`.
- **Lesson 6:** the panel's own scroll and a page scroll are verified headless only — watch that they
  replay.
- **Lesson 18:** axe 4.14 misreads many Burmese words as icon text and skips them for contrast; the
  lesson uses that as a real example of what tools miss. axe's counts depend on the Myanmar fonts of
  the machine that renders (verified on this Mac).
- **Quizzes** in the concept lessons ask the learner to pause the lesson before the answer page.
- **Lesson 3** keeps the old div "button" beside the new real button on purpose (said honestly as a
  comparison); lesson 4 marks its "don't" examples with a labelled dashed box.

## Thumbnails

`docs/a11y-course-thumbnail.html` (same template as the CSS course card; mascot **Ally**, a
focus-ring character with headphones) holds each lesson's title, one real code line and a bubble
word; `bun docs/a11y-course-thumbnails/render.ts` renders `docs/a11y-course-thumbnails/NN-*.png`.

Working files (curriculum, glossary, platform notes, page plans, deck tooling, per-lesson design
notes and audits) are kept outside the repo in `~/Documents/a11y-course-work/`.
