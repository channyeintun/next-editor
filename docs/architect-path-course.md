# Architect Path — course guide

A 56-lesson course, narrated in Burmese, for the whole career of a software architect: from a
developer who starts to think about architecture, through the first years in the role, to leading
architecture across an organisation. It runs **about 8 hours 54 minutes** in total (8 to 10.5
minutes a lesson, at 70 ms per character by `studio-compile-check`).

Three ideas run through every lesson:

- there is no best answer in architecture, only a trade-off that fits this context;
- _why_ a decision was made is worth more than _how_ it was built;
- an architect's output is decisions other people can understand and act on, which is why every
  lesson ends in a small written artefact.

The Burmese has **not** been reviewed by Chan yet, and no lesson has been rendered in /studio yet.

## Where the ideas come from

The course is built on the ideas of ten books. It is not a walk-through of any of them: it has
its own order (a career, not a table of contents), its own running example, its own diagrams and
its own documents. Ideas are taught in our own words; no sentence, figure, table, rating chart,
case study or code from a book is reused, and where a book offers a list, the lesson teaches the
items that matter for its situation in the course's own grouping. Each scene credits the books
whose ideas it uses in `sources:`. No book or author is named in the audio; lesson 56 shows the
ten titles on two slides as further reading.

| Book                                                                        | Cited in lessons                        |
| --------------------------------------------------------------------------- | --------------------------------------- |
| Fundamentals of Software Architecture, 2nd ed. (Richards, Ford)             | 01–04, 07, 09–22, 41, 45, 47–51, 56     |
| Software Architecture: The Hard Parts (Ford, Richards, Sadalage, Dehghani)  | 03, 13, 15–16, 28–29, 36–41, 45, 56     |
| Designing Data-Intensive Applications, 2nd ed. (Kleppmann, Riccomini)       | 14, 16, 21, 28–35, 42–43, 47, 56        |
| Learning Domain-Driven Design (Khononov)                                    | 20–27, 35–37, 39, 56                    |
| Balancing Coupling in Software Design (Khononov)                            | 07–10, 23, 56                           |
| Building Evolutionary Architectures, 2nd ed. (Ford, Parsons, Kua, Sadalage) | 06–07, 09, 15, 29, 36, 40, 45–46, 55–56 |
| Release It!, 2nd ed. (Nygard)                                               | 29, 42–44, 55–56                        |
| The Software Architect Elevator (Hohpe)                                     | 01–02, 06, 49, 51, 54–56                |
| Facilitating Software Architecture (Harmel-Law)                             | 02, 06, 14, 47, 51–53, 56               |
| The Pragmatic Programmer, 20th Anniversary ed. (Thomas, Hunt)               | 04–07, 11, 20, 51, 55–56                |

Eight public pages are cited where a scene rests on them: the Cynefin framework (lesson 08),
Conway's law (11), eventstorming.com (27), consumer-driven contracts (29), adr.github.io (31),
the fallacies of distributed computing (33), the CAP theorem (34) and the C4 model (49). Each was
opened and checked on 13 November 2026 by the author who cites it.

## The running example

**ခရီးဖော်** is a made-up Yangon company that sells express-bus tickets through an app; lesson 01
says so. Passengers search trips, pick seats and pay with a mobile wallet; bus operators
(ကားလိုင်း) publish trips; counter staff at the terminals sell the same seats. The course opens on
the morning the သင်္ကြန် tickets went on sale: traffic rose to 15 times a normal day, the app was
slow for two hours and 312 seats were sold twice — with no wrong line of code, because nobody had
decided how the system should behave on such a day.

The company grows as the learner's career grows:

| Stage | Lessons | Company                                               | The learner (ကိုယ်)    |
| ----- | ------- | ----------------------------------------------------- | ------------------- |
| 1     | 01–11   | year 2: 6 developers, one app, one database           | senior developer    |
| 2     | 12–27   | year 3: 18 developers in 3 teams, one weekly release  | the first architect |
| 3     | 28–44   | year 5: 45 developers in 6 teams, the first services  | lead architect      |
| 4     | 45–56   | year 7: 90 developers in 12 teams, a parcels business | chief architect     |

Three people have names, with no prefix: **အောင်အောင်** (CTO; the business and the top floor),
**လှလှ** (product manager; passengers and operators) and **မောင်မောင်** (a developer, later the
Booking team lead; the engine room). Everyone else is named by role. Nobody is the fool:
disagreements are between reasonable people who see different parts of the problem.

## Lessons

Every lesson is a studio LessonScript in `src/studio/scripts/architect-*.yaml` (locale `my-MM`,
`lessonType: javascript`, seed 8100 + lesson number). Titles are prefixed `Architect Path NN:`.

### Part 1 · Architect အမြင်

| #   | Script                              | Title                   | ≈ min |
| --- | ----------------------------------- | ----------------------- | ----- |
| 01  | `architect-01-what-is-architecture` | Architecture ဆိုတာ ဘာလဲ    | 10.4  |
| 02  | `architect-02-the-architects-job`   | Architect ရဲ့ အလုပ်         | 10.2  |
| 03  | `architect-03-trade-offs`           | အရာတိုင်းက trade-off       | 9.3   |
| 04  | `architect-04-breadth-and-depth`    | အကျယ်နဲ့ အနက်               | 9.3   |
| 05  | `architect-05-easier-to-change`     | ပြောင်းရ လွယ်အောင် ဆောက်ခြင်း | 9.3   |
| 06  | `architect-06-reversible-decisions` | ပြန်ပြင်လို့ရတဲ့ ဆုံးဖြတ်ချက်      | 9.8   |

### Part 2 · Module နဲ့ coupling

| #   | Script                           | Title                       | ≈ min |
| --- | -------------------------------- | --------------------------- | ----- |
| 07  | `architect-07-modularity`        | Module, cohesion နဲ့ coupling | 10.2  |
| 08  | `architect-08-complexity`        | Complexity ဘယ်က လာသလဲ         | 9.7   |
| 09  | `architect-09-coupling-strength` | Coupling ရဲ့ အားကို တိုင်းခြင်း     | 9.8   |
| 10  | `architect-10-balanced-coupling` | Coupling ကို ချိန်ညှိခြင်း         | 9.4   |
| 11  | `architect-11-components`        | Component တွေကို ရှာဖွေခြင်း      | 9.2   |

### Part 3 · Architecture characteristic

| #   | Script                                   | Title                               | ≈ min |
| --- | ---------------------------------------- | ----------------------------------- | ----- |
| 12  | `architect-12-characteristics`           | Architecture characteristic ဆိုတာ ဘာလဲ | 10.2  |
| 13  | `architect-13-finding-characteristics`   | Business စကားကနေ characteristic ဆီ   | 9.1   |
| 14  | `architect-14-measuring-characteristics` | Characteristic ကို တိုင်းတာခြင်း          | 9.6   |
| 15  | `architect-15-architecture-quantum`      | Architecture quantum                | 9.0   |

### Part 4 · Architecture style

| #   | Script                                      | Title                         | ≈ min |
| --- | ------------------------------------------- | ----------------------------- | ----- |
| 16  | `architect-16-monolith-or-distributed`      | Monolith လား၊ distributed လား | 9.1   |
| 17  | `architect-17-layered-and-modular-monolith` | Layered နဲ့ modular monolith    | 10.1  |
| 18  | `architect-18-microkernel-and-pipeline`     | Microkernel နဲ့ pipeline        | 9.5   |
| 19  | `architect-19-service-based`                | Service-based architecture    | 9.2   |
| 20  | `architect-20-event-driven`                 | Event-driven architecture     | 9.2   |
| 21  | `architect-21-microservices`                | Microservices                 | 9.1   |
| 22  | `architect-22-choosing-a-style`             | Style တစ်ခုကို ရွေးချယ်ခြင်း         | 10.0  |

### Part 5 · Domain ကို နားလည်ခြင်း

| #   | Script                                 | Title                                 | ≈ min |
| --- | -------------------------------------- | ------------------------------------- | ----- |
| 23  | `architect-23-subdomains`              | Core, supporting, generic subdomain   | 9.0   |
| 24  | `architect-24-bounded-contexts`        | Ubiquitous language နဲ့ bounded context | 9.1   |
| 25  | `architect-25-context-maps`            | Context map                           | 8.9   |
| 26  | `architect-26-business-logic-patterns` | Business logic ကို ဘယ်လို တည်ဆောက်မလဲ         | 9.1   |
| 27  | `architect-27-eventstorming`           | EventStorming                         | 10.2  |

### Part 6 · Data

| #   | Script                                   | Title                        | ≈ min |
| --- | ---------------------------------------- | ---------------------------- | ----- |
| 28  | `architect-28-data-systems`              | Data system တွေရဲ့ trade-off    | 9.9   |
| 29  | `architect-29-schema-evolution`          | Schema evolution နဲ့ contract  | 9.5   |
| 30  | `architect-30-replication`               | Replication                  | 9.3   |
| 31  | `architect-31-sharding`                  | Sharding                     | 9.5   |
| 32  | `architect-32-transactions`              | Transaction နဲ့ isolation      | 10.1  |
| 33  | `architect-33-distributed-trouble`       | Distributed system ရဲ့ ဒုက္ခများ | 9.1   |
| 34  | `architect-34-consistency-and-consensus` | Consistency နဲ့ consensus      | 10.2  |
| 35  | `architect-35-streams-and-derived-data`  | Event stream နဲ့ derived data  | 9.4   |

### Part 7 · Distributed architecture

| #   | Script                               | Title                          | ≈ min |
| --- | ------------------------------------ | ------------------------------ | ----- |
| 36  | `architect-36-breaking-the-monolith` | Monolith ကို ခွဲထုတ်ခြင်း             | 9.5   |
| 37  | `architect-37-service-granularity`   | Service ဘယ်လောက် သေးရမလဲ          | 10.3  |
| 38  | `architect-38-data-ownership`        | Data ကို ဘယ်သူ ပိုင်သလဲ                | 9.6   |
| 39  | `architect-39-sagas`                 | Distributed transaction နဲ့ saga | 9.7   |
| 40  | `architect-40-reuse`                 | Reuse လား၊ ကူးယူမလား             | 9.1   |
| 41  | `architect-41-trade-off-analysis`    | Trade-off analysis လုပ်နည်း       | 9.5   |

### Part 8 · Production

| #   | Script                            | Title                  | ≈ min |
| --- | --------------------------------- | ---------------------- | ----- |
| 42  | `architect-42-how-systems-fail`   | System တွေ ဘယ်လို ပျက်သလဲ    | 10.0  |
| 43  | `architect-43-stability-patterns` | Stability pattern များ | 10.1  |
| 44  | `architect-44-production-ready`   | Production အတွက် design  | 9.2   |

### Part 9 · Evolution နဲ့ governance

| #   | Script                                   | Title                                        | ≈ min |
| --- | ---------------------------------------- | -------------------------------------------- | ----- |
| 45  | `architect-45-evolutionary-architecture` | Evolutionary architecture နဲ့ fitness function | 9.5   |
| 46  | `architect-46-governance-as-code`        | Governance ကို automate လုပ်ခြင်း                 | 9.3   |
| 47  | `architect-47-decision-records`          | Architecture decision record                 | 10.1  |
| 48  | `architect-48-risk`                      | Risk ကို မြင်အောင် ကြည့်ခြင်း                       | 9.4   |
| 49  | `architect-49-diagrams`                  | Diagram နဲ့ တင်ပြခြင်း                           | 9.3   |

### Part 10 · လူနဲ့ အဖွဲ့အစည်း

| #   | Script                              | Title                        | ≈ min |
| --- | ----------------------------------- | ---------------------------- | ----- |
| 50  | `architect-50-architect-and-team`   | Architect နဲ့ development team | 9.3   |
| 51  | `architect-51-negotiation`          | ညှိနှိုင်းခြင်းနဲ့ ဆက်သွယ်ခြင်း           | 9.2   |
| 52  | `architect-52-advice-process`       | Architecture advice process  | 10.1  |
| 53  | `architect-53-principles-and-radar` | Principle နဲ့ technology radar | 9.4   |
| 54  | `architect-54-the-elevator`         | Architect elevator           | 9.4   |
| 55  | `architect-55-organisation`         | အဖွဲ့အစည်းကို system လို မြင်ခြင်း     | 9.2   |
| 56  | `architect-56-your-path`            | Architect ခရီးလမ်း             | 9.2   |

## How the lessons work

- **Nothing runs.** A lesson's workspace is a small "architect's notebook": a pinned `README.md`
  describing the company at that stage, and one Markdown document the lesson types live — a
  trade-off table, a characteristics worksheet, an ADR, a context map, a risk matrix, a memo to
  the board. The narration says what a line decides; it never reads the screen.
- **The whiteboard carries relations**: flows, comparisons, 2 × 2s, timelines, drawn as they are
  said. Colours keep one job across the course (blue a part of the system, violet flow, green the
  chosen or good, red a failure or cost, orange the thing the board is about).
- **A slide carries a short list** of terms or steps (HTML slides laid out in `vw`/`vh`, one
  `slide.point` per row). Most lessons need none.
- **Each lesson has one question** with two options (the learner pauses, then hears the answer
  and one reason) and **one hand-over**: a small, specific thing to write in the notebook for the
  learner's own system. Lesson 56 has no quiz; the hand-over is its ending.
- **Bridges**: every lesson opens with one sentence recalling the last and closes by naming the
  next.

## How it was built and checked

1. The ten books were turned into private idea digests (one agent per book; the three largest by
   Opus, the rest by Sonnet). The digests and the book text stay outside this repository.
2. The lead designed the curriculum, the company, the Burmese style rules and the tools, wrote
   lesson 01 as the pilot, and Chan confirmed the title.
3. Eleven authors wrote five lessons each (lessons 02–56) against the pilot and the rules.
4. Eight Opus auditors checked every lesson, seven lessons each, for technical truth,
   originality, natural Burmese, words and screen agreeing at every mark, and the lesson's shape.
   They fixed what they found and logged every changed narration sentence.
5. The lead ran a continuity pass over all 56: the recall and next-lesson sentences of every
   neighbouring pair, and the company facts each lesson adds.

Every lesson passes: the Director (valid, no notes), `studio-compile-check` (PASS, 0 warnings),
the course lint (Burmese narration rules, lesson shape, slide layout, workspace), a board-width
check, and a replay of every typed document. `src/studio/plans/index.test.ts` is green with all
56 in place.

What the audits mostly changed: absolutes softened to their real condition; company facts that
clashed between lessons; a proposal described as already done; a quiz answered by the lesson's
own opening; and, in lessons 37, 38, 47 and 50, lists that followed a book's order and were
regrouped in the course's own.

## Decisions taken during the build

- **The title is Architect Path** (confirmed by Chan).
- **The order is a career, not a book.** People and organisation come last because they are the
  work of the leading stage; data and distribution sit in the practising stage.
- **No coding.** An architect's artefacts besides diagrams are written decisions, so that is what
  the learner writes. Lesson 45 pins one read-only example test and calls it an example.
- **Quizzes are never given away.** Where a lesson's own board or document would answer the
  curriculum's quiz, the quiz is asked before the rule is stated, or moved to a fresh case.
- **Facts that hold across the course:** the seat hold is 10 minutes (lesson 03); the commission
  is computed in one place, Settlement (05); search targets are p95 under 1 second and p99 under
  2 seconds (14); the top three characteristics are elasticity, data integrity and deployability
  (13); the style decision is a modular monolith moving step by step to service-based (22);
  Search asks Booking for the seats left and may get a count a few seconds old, while the sale
  always checks the record (28, 34, 38); a unique constraint, a request id on every charge and an
  outbox protect the sale (32, 33, 35).
- **One wallet company throughout.** Lesson 06 plans a second one behind the company's own
  interface; lesson 48 says those talks never ended in an agreement.
- **The radar's rings** are Adopt, Trial, Assess and Hold, as a company's own radar may name
  them. The Thoughtworks page now names its fourth ring Caution, so it is not cited for the names.
- **Lessons 15 and 19 end on nearly the same question** (three services on one database are still
  one deployable unit). Lesson 19 uses it as recall and adds the new point: release independence.
- **Lesson 45's title is 65 characters**; the course lint allows up to 66.
- **Screen text uses Latin digits; narration uses Burmese digits**, decimals with ဒသမ
  (`၉၉ ဒသမ ၉ ရာခိုင်နှုန်း`).

## Listening notes for the render

Words a Burmese voice may misread; listen for them and add lexicon entries where needed:

- Names of parts: `Search`, `Booking`, `Seat inventory`, `Payment`, `Operator`, `Notification`,
  `Settlement`, `Report`, `wallet`, `SMS gateway`, `payment API`, `TicketSold` (said "ticket sold").
- Roles: `architect`, `chief architect`, `CTO`, `product manager`, `team lead`,
  `operations engineer`.
- Core terms: `architecture`, `characteristic`, `component`, `module`, `cohesion`, `coupling`,
  `connascence`, `trade off`, `monolith`, `modular monolith`, `microkernel`, `pipeline`,
  `service based`, `event driven`, `microservices`, `architecture quantum`, `elasticity`,
  `deployability`, `availability`, `scalability`, `data integrity`.
- Domain and data: `subdomain`, `bounded context`, `ubiquitous language`, `context map`,
  `anticorruption layer`, `aggregate`, `EventStorming`, `schema`, `replication`, `read replica`,
  `sharding`, `transaction`, `isolation level`, `read committed`, `serializable`, `write skew`,
  `idempotent`, `linearizability`, `CAP theorem`, `consensus`, `outbox`, `saga`, `granularity`.
- Production and governance: `time out`, `circuit breaker`, `half open`, `bulkhead`,
  `back pressure`, `fitness function`, `ADR`, `technology radar`, `Conway's law`, `Cynefin`.
- Mixed forms: `p95` and `p99` are written as terms and the lexicon says them in English
  ("p ninety-five"); `facade` is spelled the plain English way in narration and on screen and
  should sound as it does in English; `worker A` / `worker B` (lesson 33); the lexicon respells
  `app` as `up`.

Two things to watch on screen: lesson 22 types its ADR title at the end of the first line with no
trailing newline (the document replay passes); and six lessons sit close to the 8,200-character
length ceiling the audits kept to (32, 34, 37, 43, 47, 52), so an edit to them should be
length-neutral.

## Working files

Everything used to build the course lives outside this repository, in
`~/Documents/architect-course-work`: the idea digests, `curriculum.md`, `COURSE-KIT.md` (the
company, the people, boards, slides, lesson shape), `GLOSSARY.md` (the Burmese rules and term
table), `SOURCES.md`, the author and auditor briefs, `FACTS.md` (facts each lesson adds), each
lesson's folder (`template.yaml`, the pinned workspace, `DESIGN.md` with its audit log,
`COMMIT.txt`), and the tools: `build-lesson`, `lint-narration`, `boardwidth`, `sim-docs`,
`timeline`, `gates-all`, `bridges`, `facts`, `guide-table`, `land-lesson`.

To change a lesson: edit its `template.yaml` there, rebuild, run
`bun ~/Documents/architect-course-work/tools/gates-all.ts <n>`, then
`land-lesson.ts prepare <n>` and commit the YAML with its critique.
