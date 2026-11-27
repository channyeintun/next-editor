# Fintech Engineering (Burmese course) — guide

A course of 40 narrated, runnable studio lessons in Burmese for **senior software engineers who
have not worked in fintech and want to get hired there**. It follows the
[Fintech Engineering Handbook](https://w.pitula.me/fintech-engineering-handbook/) by Voytek Pitula.

Playlist id: `fintech-engineering`. Slugs `fintech-NN-<topic>`, titles `Fintech Engineering NN: …`,
locale `my-MM`, seed `9500 + NN`.

## Credit and license

The course is an adaptation of the **Fintech Engineering Handbook** © 2026 Voytek Pitula, licensed
under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
Changes were made: the material was restructured into lessons, translated and retold in Burmese,
and extended with runnable Go programs, diagrams, real cases and interview questions. The author of
the handbook does not endorse this course. Every lesson cites the handbook section it teaches in
its scene `sources`; lessons 01 and 40 say the credit aloud. Put the same credit in the playlist
description.

## What every lesson has

- **Real Go that runs** (Go Playground runner, fixture mode): each `runtime.run`'s pinned output
  was produced by running the lesson's code with the local Go toolchain ten times.
- **Figures that build in steps** in place of the whiteboard: html slides with inline SVG, drawn by
  a small diagram engine, with the pointer aimed at the part being explained.
- **No invented company, people or story.** The mechanism, real systems and standards, and real
  incidents whose numbers were checked against primary sources.
- **One interview question** with the shape of a strong answer, and **one thing to try** in the
  editor.

## Lessons

### Part 1 · The rules of the game

| #   | Lesson                                                   | What it teaches                        | Runs | Figure steps | Minutes |
| --- | -------------------------------------------------------- | -------------------------------------- | ---- | ------------ | ------- |
| 01  | `fintech-01-three-principles` — ငွေကိုင်တဲ့ software ရဲ့ မူ ၃ ချက် | the three principles of money software | 3    | 18           | 9.1     |

### Part 2 · Representing money

| #   | Lesson                                               | What it teaches                        | Runs | Figure steps | Minutes |
| --- | ---------------------------------------------------- | -------------------------------------- | ---- | ------------ | ------- |
| 02  | `fintech-02-floats` — Float နဲ့ ငွေ မတွက်ရတဲ့ အကြောင်း       | why floats cannot hold money           | 4    | 15           | 7.3     |
| 03  | `fintech-03-minor-units` — Minor unit နဲ့ ကိန်းပြည့် ငွေ    | minor units, ISO 4217 and big integers | 3    | 18           | 8.3     |
| 04  | `fintech-04-money-in-json` — JSON ထဲက ငွေပမာဏ          | money at the JSON boundary             | 3    | 16           | 7.6     |
| 05  | `fintech-05-rounding` — Rounding က business ဆုံးဖြတ်ချက် | rounding as a business decision        | 3    | 18           | 9.6     |
| 06  | `fintech-06-money-type` — Money type နဲ့ currency      | the Money type and currency identity   | 3    | 17           | 8.6     |
| 07  | `fintech-07-fx-rates` — FX rate ကို နားလည်ခြင်း          | FX rates                               | 3    | 15           | 7.8     |

### Part 3 · Recording money: the ledger

| #   | Lesson                                                     | What it teaches                       | Runs | Figure steps | Minutes |
| --- | ---------------------------------------------------------- | ------------------------------------- | ---- | ------------ | ------- |
| 08  | `fintech-08-double-entry` — Double-entry ledger            | double-entry bookkeeping              | 3    | 18           | 8.7     |
| 09  | `fintech-09-account-types` — Debit၊ credit နဲ့ account type  | account types, debit and credit       | 3    | 17           | 9.4     |
| 10  | `fintech-10-postings` — Transaction တစ်ခု၊ posting အများ     | one transaction, many postings        | 3    | 16           | 9.5     |
| 11  | `fintech-11-three-times` — Value၊ booking၊ settlement အချိန် | value, booking and settlement time    | 3    | 17           | 9.7     |
| 12  | `fintech-12-audit-trail` — Audit trail                     | audits and audit trails               | 3    | 18           | 9.2     |
| 13  | `fintech-13-event-sourcing` — Event sourcing               | event sourcing                        | 4    | 18           | 9.0     |
| 14  | `fintech-14-immutability` — Immutability နဲ့ hash chain      | immutability and tamper evidence      | 4    | 16           | 9.2     |
| 15  | `fintech-15-reversals` — Reversal နဲ့ correction             | reversals and corrections             | 4    | 18           | 9.0     |
| 16  | `fintech-16-gdpr` — Immutable ledger နဲ့ GDPR                | immutability and the right to erasure | 3    | 16           | 8.1     |

### Part 4 · Executing money flows

| #   | Lesson                                                  | What it teaches                           | Runs | Figure steps | Minutes |
| --- | ------------------------------------------------------- | ----------------------------------------- | ---- | ------------ | ------- |
| 17  | `fintech-17-invariants` — Invariant ကို ထိန်းတဲ့ နည်း ၃ မျိုး    | invariants and three ways to enforce them | 3    | 17           | 9.4     |
| 18  | `fintech-18-funds-reservation` — Funds reservation      | funds reservation                         | 3    | 18           | 9.1     |
| 19  | `fintech-19-overdrafts` — Overdraft ကို ကိုင်တွယ်ခြင်း          | overdrafts                                | 3    | 16           | 7.8     |
| 20  | `fintech-20-idempotency` — Idempotency key              | idempotency keys                          | 4    | 18           | 9.4     |
| 21  | `fintech-21-idempotency-edges` — Idempotency ရဲ့ ခက်တဲ့ အပိုင်း | the hard edges of idempotency             | 3    | 18           | 8.9     |
| 22  | `fintech-22-resumability` — Crash ဖြစ်လည်း ဆက်သွားတဲ့ flow    | resumable money flows                     | 4    | 18           | 8.2     |

### Part 5 · The external world

| #   | Lesson                                                  | What it teaches         | Runs | Figure steps | Minutes |
| --- | ------------------------------------------------------- | ----------------------- | ---- | ------------ | ------- |
| 23  | `fintech-23-consuming-apis` — Provider API ကို မယုံဘဲ သုံးခြင်း | consuming provider APIs | 3    | 18           | 9.5     |
| 24  | `fintech-24-webhooks` — Webhook ကို လက်ခံခြင်း               | handling webhooks       | 3    | 16           | 9.1     |
| 25  | `fintech-25-outbox-cdc` — Outbox နဲ့ CDC                  | the outbox and CDC      | 3    | 17           | 8.5     |
| 26  | `fintech-26-reconciliation` — Reconciliation            | reconciliation          | 3    | 19           | 9.6     |

### Part 6 · Controls and access

| #   | Lesson                                                   | What it teaches                     | Runs | Figure steps | Minutes |
| --- | -------------------------------------------------------- | ----------------------------------- | ---- | ------------ | ------- |
| 27  | `fintech-27-four-eyes` — Four-eyes နဲ့ တာဝန်ခွဲခြင်း           | segregation of duties and four-eyes | 3    | 16           | 9.6     |
| 28  | `fintech-28-access-control` — Access control             | access control                      | 3    | 13           | 8.0     |
| 29  | `fintech-29-change-trail` — Code ကနေ production အထိ trail | the change trail                    | 3    | 18           | 9.7     |

### Part 7 · Testing

| #   | Lesson                                                 | What it teaches                    | Runs | Figure steps | Minutes |
| --- | ------------------------------------------------------ | ---------------------------------- | ---- | ------------ | ------- |
| 30  | `fintech-30-property-testing` — Property-based testing | property-based testing             | 3    | 13           | 9.0     |
| 31  | `fintech-31-testing-menu` — ငွေ system အတွက် test နည်းများ | the testing menu for money systems | 3    | 16           | 9.3     |

### Part 8 · Know your domain

| #   | Lesson                                            | What it teaches                     | Runs | Figure steps | Minutes |
| --- | ------------------------------------------------- | ----------------------------------- | ---- | ------------ | ------- |
| 32  | `fintech-32-card-payments` — Card payment အလုပ်လုပ်ပုံ  | how card payments work              | 3    | 17           | 9.5     |
| 33  | `fintech-33-bank-rails` — Bank rail နဲ့ settlement  | bank rails, accounts and settlement | 3    | 18           | 9.5     |
| 34  | `fintech-34-trading` — Order book နဲ့ trading       | order books and trading terms       | 3    | 16           | 9.5     |
| 35  | `fintech-35-custody-crypto` — Custody နဲ့ crypto    | custody and crypto                  | 3    | 18           | 9.6     |
| 36  | `fintech-36-compliance` — Engineer အတွက် compliance | compliance for engineers            | 3    | 16           | 9.5     |

### Part 9 · End to end

| #   | Lesson                                                                 | What it teaches                        | Runs | Figure steps | Minutes |
| --- | ---------------------------------------------------------------------- | -------------------------------------- | ---- | ------------ | ------- |
| 37  | `fintech-37-flow-withdrawal` — Flow ၁၊ crypto withdrawal               | end to end, a crypto withdrawal        | 3    | 18           | 9.5     |
| 38  | `fintech-38-flow-card-deposit` — Flow ၂၊ card deposit                  | end to end, a card deposit             | 3    | 17           | 9.5     |
| 39  | `fintech-39-flow-conversion` — Flow ၃၊ conversion နဲ့ cashback           | end to end, a conversion with cashback | 3    | 15           | 9.1     |
| 40  | `fintech-40-system-design-interview` — Fintech system design interview | the fintech system design interview    | 3    | 18           | 9.4     |

Total: 40 lessons, about 6 h 0 min estimated at 70 ms per narration character (285738 characters) plus action time, 126 program runs, 675 figure steps.

## Decisions

These were decided while building the course. They are decisions, not open questions.

- **No story frame.** The owner asked for no made-up stories or personas. There is no invented
  company and no named character anywhere. Examples are the mechanism itself, generic roles
  (`user`, `merchant`, `operator`, `auditor`, `provider`) and real, sourced cases. The only people
  named in the audio are the handbook's author (lessons 01 and 40) and authors of books on the
  reading list (lesson 40).
- **Audience.** Senior engineers: nothing about programming is explained, Go is only the notation,
  and every lesson has a "where it gets interesting" part (a trade-off or a failure mode).
- **Go, running for real.** Lesson type `go`, Playground runner in fixture mode. Each fixture is
  the byte-exact output of the lesson's code at that run, produced by the local Go 1.27 toolchain
  ten times per run. Money in code is `int64` minor units (or `math/big`), never a float after
  lesson 02. Programs are deterministic: no `time.Now`, no goroutines (interleavings are written
  out step by step), seeded randomness only.
- **Figures in place of the whiteboard.** The lessons use no whiteboard. Every diagram is an html
  slide with inline SVG built by the course's figure engine: it builds in steps with the
  narration, new parts fade or draw in, and each `slide.point` target is computed from the
  element it points at. Colours have one job each (gold = money, blue = a message, teal = stored
  facts, violet = controls, orange = pending, red = failure, green = correct).
- **Real-world facts were verified first.** Two fact sheets (44 entries, checked against primary
  sources on 2026-11-27) hold the only real numbers, dates, incidents and API behaviours the
  lessons may state, each with a "safe claim" wording. Partly verified entries are taught only in
  their verified part and with their hedges ("about", "alleged", "proposed"). The real cases used:
  the Vancouver Stock Exchange index (05), the USDC de-peg of March 2023 (06), Wirecard and FTX
  (10, 12), Synapse (26), Citibank / Revlon and Bybit (27, 35), Knight Capital (29), Ronin and the
  Ethereum Classic reorganisations (35); API behaviour from Stripe's documentation (20, 21, 24,
  32, 38).
- **No third-party screenshots.** Screens of other companies' products were not copied. What is
  real on screen is the program's live output, and API shapes and SQL shown as code on figures.
- **The interview angle is honest.** Each lesson ends with a question of the kind fintech
  interviews ask (`မေးလေ့ရှိပါတယ်`), never attributed to a company, and three points of a strong
  answer plus what the candidate would do.
- **The ledger is taught in two steps.** Lesson 08 uses the direction view (`Entry{From, To,
  Amount}`); from lesson 09 on, entries are debits and credits on typed accounts named
  `<kind>:<name>` (`asset:bank`, `liability:user:1042`, `revenue:fees`, …), shared by every later
  lesson.
- **Narration.** Burmese written directly, in the spoken register, with fintech and engineering
  terms kept in English and glossed once. Numbers are Burmese digits or words; a standard's own
  number (ISO 4217, SHA-256) is written as the name. Currency symbols are never written.
- **Changes from the curriculum that were kept** because they teach more: lesson 01's try-it makes
  an invented and a lost amount cancel so the total check passes while both balances are wrong;
  lesson 08's third run posts a duplicate entry to show that a zero total does not catch it;
  lesson 15 links a correction with `Corrects` and looks the reverse link up, so the original
  record is never edited; lesson 30 generates sequences on a wallet with holds, where the bug needs
  three operations in a row; lesson 32 shows each fee where the money flows; lesson 40 has a
  runnable try-it before the paper exercise.
- **Not advice.** Nothing in the course is legal, compliance or financial advice; legal statements
  are limited to what the fact sheets support.

Not done: the studio renders with the Burmese voice (the owner's step), the
`fintech-engineering` playlist, publishing, and any lexicon respelling (wait for a render).

## Rendering

Not rendered yet. Render in `/studio` with the Burmese voice as usual. The lessons have no live
preview and every run is a fixture, so the studio's full-speed render applies to all 40 (the
driver's commands are in `docs/studio-m0-runbook.md`). Figures carry short CSS entrance
animations and a moving dot on some money arrows; they play in the lesson player when a slide
appears, and were checked in Chrome inside the same sandbox and content security policy the slide
frame uses. What only a render can show is still open: the pacing against the real voice, and how
the voice says the English terms.

## Thumbnails

One 1280×720 PNG per lesson in `docs/fintech-engineering-thumbnails/`, named `NN-<topic>.png` (the
end of the lesson's slug, which is how the studio workflow pairs a thumbnail with its lesson). All
40 are drawn by one page, `docs/fintech-engineering-thumbnail.html`, in the lessons' own figure
style: the dark ground with the dot grid, toned cards, and the three principle chips. A thumbnail
shows the lesson number, its part (the number and the glow take the part's tone), the Burmese
title, one small diagram drawn for the lesson, and under it one real line of the lesson (a line
its program prints, a line of its code, or a line one of its figures shows).

```bash
bun docs/fintech-engineering-thumbnails/render.ts          # render all 40
bun docs/fintech-engineering-thumbnails/render.ts 3 18     # just lessons 3 and 18
bun docs/fintech-engineering-thumbnails/render.ts --check  # check every card, write nothing
```

It needs Google Chrome and a network connection (the fonts are Inter, JetBrains Mono and Noto Sans
Myanmar from Google Fonts). To change a card, edit its entry in `LESSONS` (title lines, real line)
or its diagram in `GLYPHS` in the page, open the page in a browser to look (← / → or the route
under the frame changes the lesson), then render and commit the PNG.

The check fails when a card's title is not the lesson's title in its YAML, when the real line or
any word or number in a diagram is not in the lesson's YAML, when a label is wider than its box,
leaves the board or sits on another label, when the title or the real line does not fit, when a
part's name or a lesson's part differs from this guide, and when a lesson has no PNG or a PNG has
no lesson. After a lesson's title changes, change the card's title lines and render that lesson
again.

## Pronunciation candidates

English terms the Burmese voice may misread, as the authors listed them. These are the ones more than
one lesson uses (lesson count in brackets); each lesson's own list is in its `DESIGN.md` in the work
folder. Nothing was added to `BURMESE_RESPELLINGS`: add an entry only after a render says a term wrong.

PSP (6), ask (3), bid (3), idempotency (3), invariant (3), provider (3), settle (3), spread (3), webhook (3), AML (2), append-only (2), audit trail (2), balance column (2), by construction (2), cardholder (2), compliance (2), custodian (2), endpoint (2), Ethereum (2), expense (2), float (2), harness (2), HTTP (2), idempotent (2), JSON (2), key store (2), KYC (2), ledger (2), payout (2), posting (2), quote (2), reconciliation (2), replay (2), reserve (2), revenue (2), risk (2), signature (2), timeout (2), USDC (2), wei (2), Wire (2), withdrawal (2)

## How the course was built

Work folder (outside the repo): `~/Documents/fintech-course-work` — `curriculum.md`,
`COURSE-KIT.md`, `GLOSSARY.md`, `kit/FIGURES.md`, `facts/`, `tools/` (`fig.ts` the figure engine,
`build-lesson.ts`, `check-lesson.ts`, `sim-go.ts`, `lint-narration.ts`, `land-lesson.ts`). A lesson
is built from `template.yaml` + `ws/` + `figures/*.yaml`; the YAML in `src/studio/scripts/` is the
built result. To change a lesson, change its sources there, rebuild, run `check-lesson.ts <n>` and
land it again.
