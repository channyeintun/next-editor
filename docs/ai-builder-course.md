# AI Builder — course guide

A 32-lesson course, narrated in Burmese, for people who want to build real products with AI coding
agents without first becoming programmers. It teaches the engineering that stays with the builder
when an agent writes the code: understanding the problem, requirements and scope, acceptance
criteria, writing for people and for agents, breaking work down, thinking in systems and data,
recording trade-offs, verifying what the agent produced, debugging, shipping safely, running and
paying for what you ship, and designing the "factory" (the harness) that builds the product. The
thesis, set in lesson 1 and closed in lesson 32: generating code is cheap now; **intent, judgment and
verification** are the builder's job — and code was always only one part of software engineering.

The seed is **The New SDLC** (Burmese edition), Chan's translation of Google's book, in
[channyeintun/The-New-SDLC](https://github.com/channyeintun/The-New-SDLC). The course is not a
walk-through of the book: it uses the book's ideas (the vibe coding ↔ agentic engineering spectrum,
context engineering, the new SDLC, the factory model, harness engineering, conductor and
orchestrator, the 80 % problem, the economics) in our own words, never its sentences, figures, tables,
tool lists or statistics, and credits it in every scene's `sources`. Most lessons go beyond the book
(problem statements, user stories, scope, edge cases, acceptance criteria, specs, working with people,
data, decision records, version control, security, release, operations); each of those rests on pages
that were opened and checked on 8 November 2026 and are cited in the scene that uses them. No source
is named in the audio.

The running example is the Yangon tea shop of the CSS, accessibility, TypeScript, AI and Testing
courses, ရွှေလက်ဖက်ရည်ဆိုင်. Its owner, who has no name and is always called ဆိုင်ပိုင်ရှင် (the
owner), wants customers to order ahead and pick up (ကြိုမှာ), because the morning queue sends regulars
away. The narrator and learner, ကိုယ်, build the app for her with an
AI agent and never write code. လှလှ runs the counter, အောင်အောင် is a member who comes every morning,
and မောင်မောင် is a student with a cheap phone and a Burmese keyboard.

Every lesson is a studio LessonScript in `src/studio/scripts/ai-builder-*.yaml` (locale `my-MM`,
`lessonType: javascript`). Lessons are 8 to 10 minutes each, **about 4 hours 59 minutes** in total
at 70 ms per character (studio-compile-check). The Burmese has **not** been reviewed by Chan yet, and
no lesson has been rendered in /studio yet.

## Lessons

| #   | Script                                 | Title                                 | Kind    | ≈ min |
| --- | -------------------------------------- | ------------------------------------- | ------- | ----- |
| 1   | `ai-builder-01-more-than-code`         | Code ရေးတာက အလုပ်ရဲ့ တစ်စိတ်တစ်ပိုင်းပဲ           | preview | 9.9   |
| 2   | `ai-builder-02-how-agents-work`        | Coding agent တွေ ဘယ်လို အလုပ်လုပ်သလဲ           | docs    | 9.7   |
| 3   | `ai-builder-03-vibe-to-agentic`        | Vibe coding ကနေ agentic engineering ဆီ | docs    | 8.1   |
| 4   | `ai-builder-04-problem-first`          | Solution မတိုင်ခင် problem                | docs    | 8.8   |
| 5   | `ai-builder-05-requirements`           | Requirement တွေကို ရှာဖွေ ရေးသားခြင်း       | docs    | 9.8   |
| 6   | `ai-builder-06-scope-mvp`              | Scope နဲ့ MVP                           | docs    | 8.7   |
| 7   | `ai-builder-07-edge-cases`             | Edge case နဲ့ assumption                | docs    | 8.8   |
| 8   | `ai-builder-08-acceptance-criteria`    | Acceptance criteria နဲ့ ပြီးတယ် ဆိုတာ ဘာလဲ   | docs    | 9.4   |
| 9   | `ai-builder-09-writing-a-spec`         | Spec တစ်စောင် ရေးခြင်း                   | docs    | 9.9   |
| 10  | `ai-builder-10-context-engineering`    | Context engineering နဲ့ AGENTS.md       | docs    | 9.8   |
| 11  | `ai-builder-11-briefing-an-agent`      | Agent ကို task တစ်ခု အပ်ခြင်း               | docs    | 9.7   |
| 12  | `ai-builder-12-working-with-people`    | လူတွေနဲ့ ဆက်သွယ် ပြောဆိုခြင်း                   | docs    | 9.7   |
| 13  | `ai-builder-13-decomposition`          | အလုပ်ကြီးကို အပိုင်းလေးတွေ ခွဲခြင်း               | docs    | 9.7   |
| 14  | `ai-builder-14-how-software-fits`      | Software ရဲ့ အစိတ်အပိုင်းတွေ                  | docs    | 9.2   |
| 15  | `ai-builder-15-data-thinking`          | Data ကို စနစ်တကျ တွေးခြင်း                 | docs    | 9.6   |
| 16  | `ai-builder-16-tradeoffs-decisions`    | Trade-off နဲ့ decision record           | docs    | 9.1   |
| 17  | `ai-builder-17-simplicity`             | ရိုးရှင်းအောင် ထိန်းခြင်း                     | docs    | 8.7   |
| 18  | `ai-builder-18-the-80-percent-problem` | 80% problem                           | preview | 9.5   |
| 19  | `ai-builder-19-testing-without-code`   | Code မရေးဘဲ test လုပ်ခြင်း                | preview | 9.7   |
| 20  | `ai-builder-20-reviewing-agent-work`   | Agent ရဲ့ အလုပ်ကို review လုပ်ခြင်း            | docs    | 8.8   |
| 21  | `ai-builder-21-debugging`              | Scientist လို debug လုပ်ခြင်း              | preview | 9.9   |
| 22  | `ai-builder-22-evals`                  | AI feature တွေအတွက် eval                 | docs    | 8.9   |
| 23  | `ai-builder-23-version-control`        | Version control နဲ့ save point          | docs    | 9.3   |
| 24  | `ai-builder-24-security-privacy`       | Security နဲ့ privacy အခြေခံ              | docs    | 9.8   |
| 25  | `ai-builder-25-release`                | Environment နဲ့ release                 | docs    | 8.9   |
| 26  | `ai-builder-26-running-it`             | Production မှာ app ကို စောင့်ကြည့်ခြင်း       | docs    | 9.2   |
| 27  | `ai-builder-27-cost`                   | AI development ရဲ့ ကုန်ကျစရိတ်              | docs    | 9.7   |
| 28  | `ai-builder-28-the-harness`            | Agent ရဲ့ harness                       | docs    | 8.9   |
| 29  | `ai-builder-29-conductor-orchestrator` | Conductor နဲ့ orchestrator              | docs    | 9.8   |
| 30  | `ai-builder-30-factory-maintenance`    | Factory model နဲ့ maintenance           | docs    | 9.1   |
| 31  | `ai-builder-31-ship-and-learn`         | Ship လုပ်ပြီး user ဆီက သင်ယူခြင်း            | docs    | 9.8   |
| 32  | `ai-builder-32-your-path`              | ရှေ့ဆက်မယ့် လမ်း                            | docs    | 9.5   |

Modules: **1 The new job** (1–3) · **2 Understand the problem** (4–7) · **3 Communicate** (8–12) ·
**4 Think like an engineer** (13–17) · **5 Verify** (18–22) · **6 Ship safely** (23–27) · **7 Build
the factory** (28–30) · **8 Product and growth** (31–32).

## Source coverage

Every chapter of the book lands somewhere; the rest of each lesson is new material.

| Book chapter                                                              | Lessons                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Introduction                                                              | 1                                                                                  |
| From syntax to intent (agents, vibe coding)                               | 1, 2, 3                                                                            |
| The vibe coding ↔ agentic engineering spectrum                            | 3, 22                                                                              |
| Context engineering (six kinds of context, static vs dynamic, skills)     | 9, 10, 27, 28                                                                      |
| The new SDLC (phase by phase)                                             | 4–9, 14–16, 18, 19, 25, 30                                                         |
| The factory model                                                         | 11, 30                                                                             |
| Harness engineering                                                       | 24, 26, 28                                                                         |
| The developer's changing role (conductor, orchestrator, the 80 % problem) | 7, 11, 13, 18, 29                                                                  |
| Coding agents in practice (editor, terminal, background)                  | 2, 29                                                                              |
| Building production-ready agents                                          | 22 (evals), 26 (observability); the product-specific CLI walkthrough is not taught |
| The economics of AI development                                           | 6, 17, 21, 27                                                                      |
| Where to start                                                            | 10, 19, 20, 32                                                                     |
| Conclusion                                                                | 1, 30, 32                                                                          |

The book's statistics are not used. The one study the course cites is METR's 2025 experiment
(lesson 18), stated as measured — experienced developers expected to be faster with early-2025 AI
tools, were measured 19 % slower, and still felt faster — with the authors' own limits on the claim.

## How the lessons work

**The learner's artefacts are documents.** The course builds one project "binder", typed live in the
editor as the lessons go: `docs/problem.md` (4), `docs/requirements.md` (5–7, 21), `docs/spec.md` with
acceptance criteria AC-1 to AC-6 (8, 9, 21), `AGENTS.md` (10, 17, 21, 24, 28), a task brief and an
example plan (11), `docs/updates.md` (12), `docs/plan.md` (13, 17, 29), `docs/system-map.md` (14),
`docs/data.md` (15), `docs/decisions.md` with ADR-001 to ADR-003 (16, 17), `docs/test-plan.md` (19, 21),
`docs/review-checklist.md` (20), `docs/bugs.md` (21), `docs/evals.md` (22), `docs/security.md` (24),
`docs/release-checklist.md` (25), `docs/runbook.md` (26), `docs/costs.md` (27), `docs/harness.md` (28),
`docs/next.md` (31) and the learner's own `my-plan.md` (32). Each lesson pins every document exactly as
the lesson before it left it, so the binder grows without a seam; lessons 30 and 32 show all of it in
the explorer. Documents use simple English headings with Burmese bodies, the way Burmese teams write;
`AGENTS.md` is English (short, read by the agent every session — lesson 27 adds the token reason).
The narration says what a line decides or protects and never reads a document aloud.

**The whiteboard carries every idea** — diagrams drawn as they are named, colour with one job each
(blue the product, violet the agent, green right, red risk, orange the step in focus), and one quiz
per lesson with a reasoned answer. There is no slide deck.

**The preview runs the product in four lessons** (1, 18, 19, 21): a small vanilla-JS pre-order app on
Vite 5.4.21, pinned and never typed, introduced as the first version of the order form an agent
produced, prepared for the lesson. It behaves like typical first-version agent output: the normal
order works (order #101, 2 milk teas, 3,000 ကျပ်), but it accepts a quantity of 0, a pickup time when
the shop is closed and an empty phone number, and a quantity typed in Burmese digits (`၃`) gives a
total of `NaN`. Lesson 1 shows the happy path and one doubt; lesson 18 tries the edges (the 80 %
problem); lesson 19 writes a test plan first and runs it by hand; lesson 21 reproduces မောင်မောင်'s
Burmese-digit bug, writes the bug report, and traces how a requirement that existed (lesson 5) slipped
through because no acceptance criterion carried it. Every preview action is asserted
(`expect.preview`), and all four lessons pass `studio-verify-lesson` against real Vite in Chrome.

**Honesty.** No live agent session is ever faked. Agent output appears only as pinned documents whose
first line says `Example` and which the narration calls an example (lesson 11's plan, lesson 20's
change summary); the AI feature in lesson 22 is described and evaluated on paper, and the narration
says that no model runs in the course. Real products are named only as examples, at most three at a
time, never as recommendations.

## How it was built and checked

The lead wrote the curriculum, the shared kit (the shop, the people, the app's exact behaviour and
the canonical text of every binder document), the platform notes, the glossary and the briefs, and
proved the app in a probe lesson (verify PASS). A pilot author wrote lessons 1 and 4 to set the voice,
an independent auditor fixed them and listed what later authors get wrong (13 points, now binding),
then 15 authors wrote two lessons each, and 8 more auditors fixed them (four lessons each, two for the
last pair), each re-running every gate. A final continuity reader checked all 32 lessons as one course (and fixed 18 of them: two
misspoken quantity limits, a few story slips, and narration about moving around the editor),
and one more agent designed the thumbnails: 27 agents in all. Every finished lesson was landed as its
own commit through the repository's pre-commit hook.

Gates every lesson passes: the director (valid, no critic notes), `studio-compile-check` (PASS, no
warnings, 8–10 minutes at 70 ms per character), the course lint (Chan's narration rules — spoken
register, Burmese digits, no tooling chatter, no source names, the four names without prefixes, a
model is never a person — plus this course's own: documents only, never code, typed; honesty
sentences; every preview input at its own mark), the board-width check, a replay of all typing
against the binder's text, and for the four preview lessons, `studio-verify-lesson` with every
screenshot read against the narration.

## Decisions taken during the build

- **No coding, ever.** Lessons type Markdown documents only; the lint refuses any other file. The app's
  code is present in preview lessons but never typed or read aloud.
- **The binder is canonical.** Shared documents have one exact text; later lessons pin what earlier
  ones leave, and lessons 30 and 32 refresh their full binders from the owning lessons.
- **The deliberate gap.** The Burmese-digit requirement is written in lesson 5 but no edge case or
  acceptance criterion carries it until lesson 21 — the course's example of a requirement lost
  between documents.
- **Story order.** Lesson 11's first brief bundles the order form with its refusals; lesson 13's plan
  splits them into two slices; the app in lessons 18–21 is the first version of the order form, which
  misses the refusals; lesson 20 reviews the agent's later Task 02 change.
- **Only work that touches customer data or payment needs the careful end** of the spectrum
  (lesson 3), and every later lesson keeps that line.
- **Quizzes never leak.** Where a document line is a quiz's answer, it is typed after the quiz; no
  earlier board or sentence carries either option.
- **Words that mislead a listener are avoided:** the adjective လှလှ (heard as the person), `ကိုယ့်ဘာသာ`
  with the agent as subject (ကိုယ် is the learner), a bare `ပတ်` where "week" fits, `ADR တစ်` (said
  `ADR နံပါတ် တစ်`), and narration about the editor itself ("back to the editor").
- **Other courses** are named at most once per lesson where they go deeper: Testing course (19),
  AI course (22), SRE from zero (26), Accessibility course (31); lesson 32's recap points to the
  Testing and AI courses again.

## Pronunciation notes

Candidates for `BURMESE_RESPELLINGS`, to confirm after a render: `AGENTS.md`, `CLAUDE.md`, `MVP`,
`MoSCoW`, `ADR`, `AC`, `TC`, `BUG`, `NaN`, `API`, `MCP`, `SMS`, `vibe coding`, `agentic engineering`,
`Given` / `When` / `Then`, `YAGNI`, `slopsquatting`, `staging`, `runbook`, `orchestrator`, `conductor`,
`harness`, `eval`, `rubric`, `regression`, `metric`. (`rollback` keeps its written form, as decided for
the SRE course.)

## Thumbnails

`docs/ai-builder-thumbnail.html` renders all 32 cards (`bun docs/ai-builder-thumbnails/render.ts`,
PNGs in `docs/ai-builder-thumbnails/`). The mascot is **Clip**, an original purple clipboard with a
builder's hard hat and a pencil; each card shows a real line from a document the lesson types, with
the file name as its tab.

## Working files

The curriculum, kit, glossary, briefs, base workspaces, probe, tools and every lesson's design notes
and audits are outside the repository, in `~/Documents/ai-builder-course-work/`.
