# Claude FDE — course guide

A 56-lesson course, narrated in Burmese, for developers who want to do the work of a **forward
deployed engineer** for Claude: understand how the model behaves, build it into a company's real
systems, and bring the people along until the result can be measured. It runs **about
8 hours 49 minutes** in total (8.7 to 10.4 minutes a lesson, at 70 ms per character by
`studio-compile-check`; rendered audio ran about a sixth shorter than this estimate in the Architect
Path course).

Three ideas run through every lesson:

- before the wording of a prompt, ask what the model can see and who checks the result;
- a product fact is only as good as the page it was read from, and the day it was read;
- deploying the technology is the easier part; changing how people work, and showing in numbers
  whether it really helps, is the job.

The Burmese has **not** been reviewed by Chan yet, apart from two wordings he corrected (lesson 01
and the title of lesson 45; see "Decisions"), and no lesson has been rendered in /studio yet.

## Where the content comes from

The course follows the order of topics of Anthropic's
[Claude Forward Deployed Engineer](https://anthropic-partners.skilljar.com/path/claude-fde)
learning path: ten courses, and one part of this course for each. It is an **independent course**:
lesson 01 says so in the audio.

- **What was read of the path:** its public page, each course's public description and every
  lesson title (through a signed-out browser on 2026-11-20). The lesson bodies need a registered
  account; nobody registered and they were not read. So the path gave the order of topics, and
  nothing in the course translates or paraphrases its lessons.
- **Where the facts come from:** seven research agents wrote eight fact digests on 2026-11-20 from
  Anthropic's public pages (platform.claude.com/docs, code.claude.com/docs, support.claude.com,
  claude.com), modelcontextprotocol.io, agentskills.io and, for Parts 9 and 10, published research
  on productivity and change. Every fact in a digest carries the URL it was read from; anything
  that could not be confirmed is listed as not verified and is not taught. Each scene's `sources:`
  cites the public pages its facts came from.
- **What is ours:** the running example, every explanation, board, table, document and code
  example.

| Path course                            | Part | Lessons | Digest                |
| -------------------------------------- | ---- | ------- | --------------------- |
| AI Capabilities and Limitations        | 1    | 01–07   | ai-behavior           |
| AI Fluency for Builders                | 2    | 08–11   | ai-behavior           |
| Claude Platform & Model Foundations    | 3    | 12–15   | apps-and-models       |
| Claude Platform 101                    | 4    | 16–24   | claude-platform       |
| Claude Code 101                        | 5    | 25–31   | claude-code-basics    |
| Claude Code in Action                  | 6    | 32–37   | claude-code-in-action |
| Introduction to Model Context Protocol | 7    | 38–41   | mcp                   |
| Introduction to agent skills           | 8    | 42–45   | agent-skills          |
| Delivery Methodology                   | 9    | 46–52   | delivery-and-adoption |
| Driving enterprise adoption of Claude  | 10   | 53–56   | delivery-and-adoption |

Two things have owners and are handled with care:

- **The 4D framework** (Delegation, Description, Discernment, Diligence; lessons 08–11) is by Rick
  Dakan, Joseph Feller and Anthropic, released under CC BY-NC-SA 4.0. The lessons use the four
  names as terms, credit the framework in `sources:`, and explain each habit in our own words
  through the running example. Its published definitions and sub-parts are never shown or
  translated.
- **"Structural gain / marginal gain", the four qualification criteria and the Activation /
  Acceleration / Expansion phase names** (Parts 9 and 10) are terms from the path's public
  description. The lessons use the terms and credit the path; every table, checklist and plan is
  written for the running example and never presented as Anthropic's method. Research (the
  productivity J-curve, psychological safety, how developer productivity is measured) is said as
  what a study reports, with the study in `sources:` and no author named in the audio.

## The running example

**နေခြည် Fiber** is a made-up company that sells fibre internet in ရန်ကုန် and မန္တလေး; lesson 01
says so. It has about 62,000 customers and 430 staff, of whom 45 are support agents and 24 are
developers. Support gets about 1,800 tickets a day.

The course opens on **the storm night**: three townships lost their connection, tickets came in at
four times the normal rate, and some support agents drafted replies with a personal chat AI
account. Sixty-four of those replies told customers inside the outage to restart their router. The
model was not broken and nobody was careless: what the model could see, who checks a reply, and
whether it really helps had never been designed.

The learner (ကိုယ်) is the forward deployed engineer sent to work inside the company. Three people
recur: အောင်အောင်, the CTO and sponsor; လှလှ, the support manager; မောင်မောင်, the Billing team lead,
doubtful at first and later the champion.

| Part | Lessons | When                     | What is happening                                             |
| ---- | ------- | ------------------------ | ------------------------------------------------------------- |
| 1–3  | 01–15   | weeks 1–2                | understanding the model; the four decisions before any prompt |
| 4    | 16–24   | weeks 3–5                | the Reply assistant prototype on the Claude Platform          |
| 5–6  | 25–37   | weeks 6–8                | Claude Code with the Billing team; a trial on 140 report jobs |
| 7–8  | 38–45   | weeks 8–9                | an MCP server for tickets and outages; skills for procedures  |
| 9    | 46–52   | weeks 9–10, then 30 days | the 30-day activation and its Delivery Plan Pack              |
| 10   | 53–56   | after Day 30             | adopting Claude across the company                            |

## Lessons

### Part 1 · FDE နဲ့ AI ရဲ့ သဘာဝ

| #   | Script                                  | Title                           | ≈ min |
| --- | --------------------------------------- | ------------------------------- | ----- |
| 01  | `claude-fde-01-what-is-an-fde`          | FDE ဆိုတာ ဘာလဲ                     | 10.4  |
| 02  | `claude-fde-02-what-ai-means`           | AI ဆိုတာ ဘာကို ပြောတာလဲ              | 10.0  |
| 03  | `claude-fde-03-next-token-prediction`   | Next token prediction           | 9.1   |
| 04  | `claude-fde-04-knowledge`               | Model ရဲ့ knowledge               | 8.8   |
| 05  | `claude-fde-05-working-memory`          | Working memory နဲ့ context window | 8.7   |
| 06  | `claude-fde-06-steerability`            | Steerability                    | 9.1   |
| 07  | `claude-fde-07-when-properties-collide` | မထင်မှတ်တဲ့ output ကို ခွဲခြားခြင်း       | 10.1  |

### Part 2 · Builder အတွက် AI fluency

| #   | Script                            | Title                     | ≈ min |
| --- | --------------------------------- | ------------------------- | ----- |
| 08  | `claude-fde-08-4d-and-delegation` | 4D framework နဲ့ Delegation | 10.1  |
| 09  | `claude-fde-09-description`       | Description               | 9.1   |
| 10  | `claude-fde-10-discernment`       | Discernment               | 8.9   |
| 11  | `claude-fde-11-diligence`         | Diligence                 | 8.9   |

### Part 3 · Prompt မရေးခင် ဆုံးဖြတ်ချက် လေးခု

| #   | Script                              | Title                    | ≈ min |
| --- | ----------------------------------- | ------------------------ | ----- |
| 12  | `claude-fde-12-entry-points`        | Entry point ကို ရွေးချယ်ခြင်း | 10.2  |
| 13  | `claude-fde-13-capability-features` | Capability feature များ  | 9.5   |
| 14  | `claude-fde-14-choosing-a-model`    | Model ကို ရွေးချယ်ခြင်း       | 9.3   |
| 15  | `claude-fde-15-context-and-memory`  | Context နဲ့ memory         | 9.4   |

### Part 4 · Claude Platform

| #   | Script                                    | Title                 | ≈ min |
| --- | ----------------------------------------- | --------------------- | ----- |
| 16  | `claude-fde-16-first-api-call`            | ပထမဆုံး API call        | 9.2   |
| 17  | `claude-fde-17-tokens-cost-latency`       | Token, cost နဲ့ latency | 10.0  |
| 18  | `claude-fde-18-agent-loop`                | Agent loop            | 9.1   |
| 19  | `claude-fde-19-tool-use`                  | Tool use              | 8.7   |
| 20  | `claude-fde-20-thinking`                  | Thinking နဲ့ effort     | 8.8   |
| 21  | `claude-fde-21-server-tools`              | Built-in tool များ    | 9.2   |
| 22  | `claude-fde-22-skills-and-mcp-on-the-api` | API ပေါ်က Skills နဲ့ MCP | 10.0  |
| 23  | `claude-fde-23-context-management`        | Context management    | 10.2  |
| 24  | `claude-fde-24-managed-agents`            | Managed Agents        | 9.6   |

### Part 5 · Claude Code အခြေခံ

| #   | Script                                   | Title                       | ≈ min |
| --- | ---------------------------------------- | --------------------------- | ----- |
| 25  | `claude-fde-25-what-is-claude-code`      | Claude Code ဆိုတာ ဘာလဲ         | 9.1   |
| 26  | `claude-fde-26-permissions`              | ပထမဆုံး prompt နဲ့ permission   | 9.0   |
| 27  | `claude-fde-27-explore-plan-code-commit` | Explore, plan, code, commit | 10.2  |
| 28  | `claude-fde-28-context-in-claude-code`   | Claude Code ထဲက context      | 9.3   |
| 29  | `claude-fde-29-claude-md`                | CLAUDE.md                   | 8.9   |
| 30  | `claude-fde-30-subagents`                | Subagent များ               | 8.9   |
| 31  | `claude-fde-31-hooks`                    | Hook များ                   | 9.1   |

### Part 6 · Claude Code ကို လွှတ်ထားနိုင်အောင်

| #   | Script                                       | Title                          | ≈ min |
| --- | -------------------------------------------- | ------------------------------ | ----- |
| 32  | `claude-fde-32-steering-long-sessions`       | Session ရှည်ကို ထိန်းကျောင်းခြင်း      | 10.2  |
| 33  | `claude-fde-33-rules-that-hold`              | တကယ် လိုက်နာတဲ့ စည်းကမ်း               | 10.2  |
| 34  | `claude-fde-34-scheduled-tasks-and-headless` | Scheduled task နဲ့ headless mode | 9.6   |
| 35  | `claude-fde-35-code-review-and-github`       | Code review နဲ့ GitHub Actions   | 9.4   |
| 36  | `claude-fde-36-verifying-unsupervised-runs`  | လွှတ်ထားတဲ့ အလုပ်ကို စစ်ဆေးခြင်း          | 9.6   |
| 37  | `claude-fde-37-plugins`                      | Plugin များ                    | 10.1  |

### Part 7 · Model Context Protocol

| #   | Script                                    | Title                  | ≈ min |
| --- | ----------------------------------------- | ---------------------- | ----- |
| 38  | `claude-fde-38-mcp-architecture`          | MCP ဆိုတာ ဘာလဲ            | 10.0  |
| 39  | `claude-fde-39-mcp-server-tools`          | MCP server နဲ့ tool များ | 9.1   |
| 40  | `claude-fde-40-mcp-resources-and-prompts` | Resource နဲ့ prompt များ | 9.1   |
| 41  | `claude-fde-41-mcp-clients`               | MCP client များ        | 9.1   |

### Part 8 · Agent Skills

| #   | Script                                   | Title                             | ≈ min |
| --- | ---------------------------------------- | --------------------------------- | ----- |
| 42  | `claude-fde-42-what-are-skills`          | Skill ဆိုတာ ဘာလဲ                     | 10.1  |
| 43  | `claude-fde-43-multi-file-skills`        | Skill ကို ဖွဲ့စည်းတည်ဆောက်ခြင်း            | 9.4   |
| 44  | `claude-fde-44-skills-vs-other-features` | Skill လား၊ တခြား feature လား      | 9.0   |
| 45  | `claude-fde-45-sharing-skills`           | Skill ကို မျှဝေခြင်းနဲ့ ပြဿနာကို ရှာဖွေခြင်း | 9.0   |

### Part 9 · Delivery methodology

| #   | Script                                 | Title                         | ≈ min |
| --- | -------------------------------------- | ----------------------------- | ----- |
| 46  | `claude-fde-46-use-case-qualification` | Use case ကို စိစစ်ရွေးချယ်ခြင်း      | 9.0   |
| 47  | `claude-fde-47-pilot-design`           | Pilot ကို design ဆွဲခြင်း          | 10.0  |
| 48  | `claude-fde-48-baseline-and-roi`       | Baseline နဲ့ ROI                | 9.6   |
| 49  | `claude-fde-49-phased-rollout`         | အဆင့်လိုက် rollout                 | 9.3   |
| 50  | `claude-fde-50-champions`              | Champion နဲ့ documentation      | 9.4   |
| 51  | `claude-fde-51-failure-modes`          | ကြိုမြင်ထားသင့်တဲ့ failure mode များ | 9.5   |
| 52  | `claude-fde-52-thirty-day-activation`  | ရက် 30 activation              | 10.3  |

### Part 10 · Enterprise adoption

| #   | Script                                 | Title                              | ≈ min |
| --- | -------------------------------------- | ---------------------------------- | ----- |
| 53  | `claude-fde-53-activation-foundations` | Activation: team နဲ့ provisioning    | 10.1  |
| 54  | `claude-fde-54-activation-culture`     | Activation: culture နဲ့ launch       | 9.1   |
| 55  | `claude-fde-55-acceleration`           | Acceleration: Center of Excellence | 9.1   |
| 56  | `claude-fde-56-expansion`              | Expansion နဲ့ ရှေ့ဆက်ရမယ့် လမ်း            | 9.1   |

## How the lessons work

Nothing runs in this course (`lessonType: javascript`, `initCommand: ""`). A lesson has four
surfaces and uses one at a time:

- **the board**, drawn as it is said, for relations, flows and comparisons;
- **a list slide** for a few terms or steps the narration walks through, with a pointer on each;
- **a screen slide**: a real Claude Code screen with the pointer on the row being described;
- **the file**: what a forward deployed engineer really produces. Documents go in `notebook/`;
  code and configuration sit at the paths they would have in a real project
  (`reply-assistant/` in TypeScript, `billing-service/` with its `CLAUDE.md` and `.claude/` files,
  `ticket-mcp/` in Python, `naychi-plugin/`). Code is typed and explained, never executed; what a
  program printed is shown as a pinned example and called one.

Every lesson has the same shape: a recall and a need at the company, the idea built up, the idea
applied in the file, one question with two options, a hand-over the learner can do with no
account, key or installation, and a recap that points to the next lesson.

## The screenshots

Chan asked for real screenshots where a lesson shows the actual Claude Code UI. There are 31, in
`~/Documents/fde-course-work/screens/`, used by the Claude Code, MCP and skills lessons.

- They are real screens of the installed `claude` CLI (version 2.1.304) in a 100-column terminal,
  captured through a pseudo-terminal and drawn by xterm.js at 1600 × 900.
- **The CLI was never logged in.** Screens that need a model answer (a permission request, a plan,
  a subagent's run) come from a staged conversation: a local stand-in for the API answers from a
  script, with a dummy key. The UI is real; the assistant's words on those screens are scripted.
  The lessons say what such a screen shows and never call it a real session. The token numbers on
  the `context` screen are the stand-in's estimate and are never quoted.
- **No personal data.** Captures ran with an isolated home folder, so no account, settings or
  history could appear; the renderer also masks the account's name, e-mail and home folder and
  fails if any is still visible. Each kept picture was looked at.
- In a lesson a screen is an html slide holding `<img src="{{SCREEN:name}}">`; the build tool
  inlines the picture as a lossless WebP `data:` URL (the slide sandbox allows `data:` images), so
  a lesson is self-contained and needs no hosting.

The model picker screen is not used: the installed CLI lists older versions and prices than the
lessons' own tables.

## What will go out of date

Claude's products change every few weeks. The course was written to make that visible:

- Model versions, prices and limits appear only on screen, with `2026-11`; a model id in code
  carries `// ID as of 2026-11`. The narration names families (Haiku, Sonnet, Opus) and says where
  the current values live.
- Features in beta or preview, or limited to some plans, are called so.
- The screenshots show CLI 2.1.304.

When a lesson is re-rendered much later, check its digest's facts against the docs first.

## How it was built and checked

The lead designed the course (the kit, the glossary, the curriculum, the pilot lesson) and ran the
agents; all agents were Opus.

- 7 research agents wrote the digests; 1 agent captured the screenshots.
- 11 authors wrote five lessons each (lesson 01 is the lead's pilot).
- 8 auditors each took seven lessons and repaired what they found, in this order of importance:
  every product statement and every line of on-screen code against the digest; company facts and
  arithmetic; our own words; the Burmese, read as a listener; whether the screen shows what the
  words are about; the lesson's shape and its bridges to the neighbouring lessons.

No author or auditor needed a second attempt. The audits made 215 fixes across the 56 lessons:
44 to product facts and on-screen code, 52 to company facts, arithmetic and over-strong
claims, 14 where a sentence followed a source too closely, 58 to the Burmese, 30 where
the screen and the words did not match, and 17 to a lesson's shape (mostly a quiz answer given
away earlier in the lesson).

Every lesson passes, after its audit: `studio-director` (valid), `studio-compile-check` (0
warnings), the course lint (narration rules, workspace, slides, lesson shape), the board-fit
check, and a replay of every typed line against the pinned files. The lead re-ran all of these on
every lesson before landing it, and once more on all 56 after the last lint rule was added; every
lesson in the repo parses to the same YAML as its audited build. `npx vp test run
src/studio/plans/index.test.ts src/studio/script` is green (164 tests).

The lessons landed one commit each (`4a6e6a84` … `2ddd65a3`), with two wording fixes to lesson 01
(`876b5f1b`, `ff0f4f03`) and the pronunciation entries (`dca2b64d`).

## Decisions taken during the build

1. **Title** "Claude FDE"; slugs `claude-fde-NN-<topic>`; seed 9300 + NN; 56 lessons in 10 parts,
   one part per path course.
2. **Nothing runs.** A real API call needs a key and a real Claude Code session needs an account;
   a lesson must work for a learner with neither. Code is shown and explained instead.
3. **Verified facts over memory.** Much 2025 knowledge is wrong today (auto mode is Claude Code's
   starting mode; routines are called scheduled tasks; thinking budgets, prefill and forced tool
   choice are rejected by current models; the MCP specification and its Python SDK were reworked;
   the Console Workbench is retired). Authors were told to write from the digests only.
4. **`အကျိုး` only as the verb `အကျိုးရှိ…`.** Chan questioned lesson 01's `အကျိုးကို ဘယ်လို
   တိုင်းမလဲ` and chose `အကျိုးရှိမရှိ`. The glossary and the lint now enforce it; "gain" and
   "return" are said as what changed.
5. **The board of directors is `ဒါရိုက်တာ အဖွဲ့`**, never `ဘုတ်အဖွဲ့`.
6. **The late fee is 3,000 ကျပ်**, because the billing code on the real screens says so.
7. **The Day 30 result misses its target by two days** (17 working days against 15) and the
   decision is still to continue: a result a board can believe.
8. **The engagement** is signed for 12 weeks; the 30-day activation extends it by about three.
9. **No author or research-group names in the audio**; they are in `sources:`.
10. **Pronunciation** (`src/studio/script/lexicon.ts`): `CLAUDE.md` → "Claude M D", `SKILL.md` →
    "skill M D", `4D` → "four D". Slash commands are said as `compact command`; parameters with an
    underscore as separate words (`max tokens`); files other than those two by what they are.
11. **Troubleshooting is `ပြဿနာကို ရှာဖွေ…`, never `ပြဿနာရှာ…`.** Chan corrected lesson 45's
    title, which said `ပြဿနာရှာခြင်း`; the same phrase was spoken once in lesson 45 (and named
    one of its chapters) and once in lesson 35. The glossary and the lint now enforce it.

## Listening notes for the render

- The three lexicon entries above are the lead's choice and have not been heard yet: listen for
  them in lessons 08 (`4D`), 29 (`CLAUDE.md`) and 42 (`SKILL.md`).
- The lexicon says `app` as "up"; it also fires inside `Claude app` (lessons 12–15).
- Initialisms are read letter by letter: `FDE`, `NMS`, `MCP`, `API`, `SDK`, `ROI`, `CoE`, `SSO`,
  `SCIM`.
- English terms that occur most and are worth one listen each: `Reply assistant`, `system prompt`,
  `auto mode`, `context window`, `stop reason`, `tool use`, `hook`, `skill`, `subagent`,
  `plugin`, `cohort`, `baseline`.
- Each lesson's `DESIGN.md` in the work folder lists its own pronunciation candidates.

## Thumbnails

`docs/claude-fde-thumbnail.html` renders all 56 cards (`bun docs/claude-fde-thumbnails/render.ts`, PNGs
in `docs/claude-fde-thumbnails/`, one per lesson, named by the lesson's slug so the studio workflow
matches them). The course has its own look: a two-tone poster. The paper side carries the words (the
lesson number, the part, the title, and one real line of the file the lesson works on, under a tab
with the file's name); the other side is a full-height panel in the part's colour with one drawing in
ink and white (three locked layers for where behaviour comes from, a loop for the agent loop, a
J-curve for the launch). Ten parts have ten panel colours, so the gallery is banded by part; the strip
along the bottom is the course's 56 lessons. Every drawing is original, built from the shapes in the
template's small drawing DSL. Product names appear as plain text only; no logo or brand mark is drawn.

The renderer checks each card before it writes it (`--check` runs the checks alone): the title lines
must join to the lesson's title in its YAML; the file must be one the lesson works on and the line a
real line of it (a line cut short ends in ` …`); a Burmese label in a drawing must be a phrase the
lesson shows; every shape and word must sit inside the drawing's board and a label must fit its
shape; the title and the file line must fit, and Burmese text may not be cut or run into its
neighbours (measured on the glyphs' ink); each PNG's name must match its lesson the way the studio
workflow matches thumbnails.

## Working files

Everything used to build the course is outside the public repo, in
`~/Documents/fde-course-work/`: `PATH-OUTLINE.md` (what was read of the path), `curriculum.md`,
`COURSE-KIT.md`, `GLOSSARY.md`, the author and auditor briefs, `AUDIT-NOTES.md`, `FACTS.md`,
`digests/`, `screens/` (pictures, `MANIFEST.md`, `NOTES.md`), `tools/` and one folder per lesson
under `lessons/` (`template.yaml`, the pinned workspace, `DESIGN.md` with its audit list,
`COMMIT.txt`). To change a lesson, edit its `template.yaml`, rebuild with
`tools/build-lesson.ts`, run the gates, and land it with `tools/land-lesson.ts`.
