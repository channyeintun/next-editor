# SRE from zero — course guide

An original 32-lesson course on Site Reliability Engineering, narrated in Burmese, for developers who
have shipped software but have never run production on purpose. It teaches what a newcomer needs, from
why reliability matters, through SLOs, incidents and learning from them, to safe infrastructure,
platforms, AI and SRE in any kind of company, in our own words, with our own examples and diagrams.
Nothing runs: every lesson teaches with pages from a branded Next Editor Google Slides deck
(definitions, short lists, comparisons) and the Excalidraw whiteboard (mechanisms, flows, timelines,
loops). Each lesson is a studio LessonScript in `src/studio/scripts/` (locale `my-MM`, lesson type
`javascript` with an HTML/CSS placeholder workspace) and ends on a `notes.md` recap. All lessons share
one fictional company, **Padauk** (ပိတောက်), a Yangon fintech super-app that grows from 25 engineers
with no SRE team to a platform group working with AI agents. Learners meet the same people, products and
numbers from lesson to lesson, and every lesson closes with three things a small team can do this week.

For further reading the course points to _Site Reliability Engineering, 2nd edition_ (O'Reilly, 2026)
and the public sources listed under "Sources". The course is not affiliated with or endorsed by Google
or O'Reilly. Which ideas each lesson carries is tracked in a private coverage map kept with the reading
notes outside this public repo; this guide holds only the course's own material.

Nothing in this guide has been rendered or voiced yet. The narration is written later as Burmese
voice scripts (natural, connected, polite spoken Burmese; English kept for the terms developers say
in English), which Chan reviews before any YAML is built. Slide lines below are English content
specs; their Burmese wording is fixed together with the approved voice script, so the words on the
page match the words spoken. Spoken terms follow [glossary.md](./glossary.md).

## Lessons

"≈ min" is the rendered length. "Chars" is the narration budget at VoxCPM2 pace (about 14 characters a
second; `bun scripts/studio-compile-check.ts` estimates 400 ms per dialog plus 70 ms per character and
is the gate before voice synthesis). Every lesson stays between 7,000 and 8,400 characters. **Idea
budget:** a lesson explains at most 8 ideas (about one per concept scene) and mentions at most 12 more in
a sentence each; anything beyond that is left out on purpose and recorded in the private coverage map.
Catalog titles are "SRE from zero N: <Burmese title>".

| #   | Script                               | Burmese title                              | Topic                                                    | ≈ min | Chars |
| --- | ------------------------------------ | ------------------------------------------ | -------------------------------------------------------- | ----- | ----- |
| 1   | `sre-01-why-reliability-now`         | SRE ဘာကြောင့် လိုလာတာလဲ                    | running software is the long, hard part                  | 10    | 7,600 |
| 2   | `sre-02-what-sre-is`                 | SRE ဆိုတာ ဘာလဲ                             | what users feel, shrinking incidents, the Padauk loop    | 10    | 7,600 |
| 3   | `sre-03-value-of-reliability`        | Reliability ရဲ့ တန်ဖိုး                    | the real outage bill, and why 100% is wrong              | 10    | 7,600 |
| 4   | `sre-04-production-then-now`         | Production ဘယ်လို ပြောင်းလဲလာလဲ            | cloud, golden paths, gray failure                        | 10    | 7,600 |
| 5   | `sre-05-reliability-culture`         | Reliability ယဉ်ကျေးမှု                     | bad news, blameless reviews, no heroes                   | 10    | 7,600 |
| 6   | `sre-06-slo-error-budget`            | SLO နဲ့ error budget                       | agreeing on "reliable enough"                            | 11    | 8,400 |
| 7   | `sre-07-slo-from-the-users-side`     | User ဘက်က ကြည့်တဲ့ SLO                     | three ways a green SLO can lie                           | 11    | 8,400 |
| 8   | `sre-08-observability`               | Monitoring ကနေ observability ဆီ            | seeing production clearly                                | 11    | 8,400 |
| 9   | `sre-09-sustainable-on-call`         | ရေရှည် လုပ်နိုင်တဲ့ on-call                | rotations people can sustain, incident roles             | 10    | 7,600 |
| 10  | `sre-10-working-an-incident`         | Incident တစ်ခုကို အစကနေ အဆုံးထိ            | the payday incident, minute by minute                    | 10    | 7,600 |
| 11  | `sre-11-postmortems`                 | သင်ခန်းစာ ရတဲ့ postmortem                  | a postmortem meeting that teaches                        | 10    | 7,600 |
| 12  | `sre-12-how-complex-systems-fail`    | ရှုပ်ထွေးတဲ့ system တွေ ဘယ်လို ပျက်လဲ      | near misses, drift, good days, cliffs                    | 11    | 8,400 |
| 13  | `sre-13-stpa-and-cast`               | Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST   | control loops: STPA before, CAST after                   | 11    | 8,400 |
| 14  | `sre-14-becoming-an-sre`             | SRE တစ်ယောက် ဖြစ်လာဖို့                    | hiring, onboarding, a team that survives people leaving  | 11    | 8,400 |
| 15  | `sre-15-where-sre-lives`             | SRE အဖွဲ့ကို ဘယ်မှာ ထားမလဲ                 | team placement, limits on ops work, honest scorecards    | 11    | 8,400 |
| 16  | `sre-16-engagement-models`           | Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ         | outcomes instead of carrying the pager                   | 11    | 8,400 |
| 17  | `sre-17-toil-and-automation`         | Toil နဲ့ automation                        | measuring toil, automating safely                        | 11    | 8,400 |
| 18  | `sre-18-testing-and-config`          | Test နဲ့ config                            | what tests prove, config as dangerous as code            | 10    | 7,600 |
| 19  | `sre-19-testing-in-production`       | Production ထဲမှာ စမ်းသပ်ခြင်း              | canaries, fault experiments, game days                   | 10    | 7,600 |
| 20  | `sre-20-capacity-planning`           | Capacity ဘယ်လောက် လိုမလဲ                   | forecasting Thingyan, zones, shared pools                | 11    | 8,400 |
| 21  | `sre-21-data-you-are-trusted-with`   | ယုံကြည်ပြီး အပ်ထားတဲ့ data                 | deletion, classes, integrity, access                     | 10    | 7,600 |
| 22  | `sre-22-backups-and-restores`        | Backup ထက် restore က ပိုအရေးကြီးတယ်        | three data incidents and the restore drill               | 11    | 8,400 |
| 23  | `sre-23-containing-failure`          | Failure ကို ဘောင်ခတ်ထားတဲ့ design          | risk, failure domains, dependencies, bad input           | 11    | 8,400 |
| 24  | `sre-24-overload-change-emergency`   | Overload နဲ့ emergency mode                | cascades, safe change, when your own tools are down      | 11    | 8,400 |
| 25  | `sre-25-platform-engineering`        | မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင်       | golden paths, shift down, exceptions                     | 11    | 8,400 |
| 26  | `sre-26-when-ai-writes-the-code`     | AI က code ရေးတဲ့ခေတ်                       | what changes when agents write code                      | 11    | 8,400 |
| 27  | `sre-27-reliability-for-ai-features` | AI feature တွေရဲ့ reliability              | when 200 OK isn't enough                                 | 11    | 8,400 |
| 28  | `sre-28-ai-in-production-safely`     | AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း | Ops Buddy earns its access                               | 11    | 8,400 |
| 29  | `sre-29-where-ai-helps-operations`   | AI က operations မှာ ဘယ်နေရာ ကူညီလဲ         | complaints, incidents, toil and reviews                  | 10    | 7,600 |
| 30  | `sre-30-the-first-sre`               | ပထမဆုံး SRE                                | Ko Min's first 30 days at a small company                | 10    | 7,600 |
| 31  | `sre-31-sre-in-legacy-and-regulated` | ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE              | banks, vendors, crises, one problem through three lenses | 11    | 8,400 |
| 32  | `sre-32-the-road-ahead`              | SRE ရဲ့ ရှေ့ခရီး                           | risk as an early signal, agents, what lasts              | 11    | 8,400 |

**Total: 32 lessons, about 339 minutes (5 h 39 min), about 258,000 narration characters.**

The course follows the order a newcomer needs, not the order of any book: first why, then agreeing on
"reliable enough" and noticing when users hurt, then responding and learning, then the people and
teams (once learners have seen real incidents), then building lessons into systems, and finally AI and
SRE wherever the learner works. Each module sits on the Padauk reliability loop (see "Visuals").

| Module                       | Lessons | ≈ min | Decks          | On the loop                                   |
| ---------------------------- | ------- | ----- | -------------- | --------------------------------------------- |
| 1 Why SRE                    | 1–5     | 50    | SRE 1          | why the loop matters; people in the hub (L05) |
| 2 Agree and notice           | 6–8     | 33    | SRE 2          | Agree, Notice                                 |
| 3 Respond and learn          | 9–13    | 52    | SRE 3          | Respond, Learn                                |
| 4 People and teams           | 14–16   | 33    | SRE 4          | the hub: the people who turn the loop         |
| 5 Build it in                | 17–25   | 96    | SRE 5A, 5B, 5C | Build in                                      |
| 6 AI, and SRE where you work | 26–32   | 75    | SRE 6A, 6B     | AI on every station; the whole loop           |

Rendering follows the earlier courses: one deck (about one week of work) at a time, in the order above.
Deck SRE 3 (five lessons) takes two production weeks. Add the lessons to one playlist in order.

### Learner paths

Every lesson opens with one sentence of "Padauk so far", and every lesson spec lists 2–3 **borrowed
terms** from earlier lessons that its narration re-defines in one clause at first use, so a learner who
skips lessons is never lost.

- **Full course**, lessons 1–32 in order. For developers who want to become SREs.
- **Developer quick path** (9 lessons, about 92 min): 1, 2, 3, 6, 8, 9, 10, 11, 30. Motivation, what
  SRE is, its value, SLOs, observability, on-call, incidents, postmortems, and where to start on Monday.
- **Tech lead and manager path** (10 lessons, about 106 min): 1, 3, 4, 5, 6, 15, 16, 25, 31, 32.
- Lessons 12 and 13 are marked "deeper" in the playlist description; both quick paths skip them.

## Course title

1. **SRE from zero** (recommended). It matches "Rust from zero", so the catalog groups the series,
   and "from zero" tells a newcomer the course starts from no SRE knowledge (not from no programming).
2. ပစ်တိုင်းထောင် — SRE ကို အခြေခံကစ ("Pyit Taing Htaung": the Myanmar roly-poly doll that stands back
   up every time it is knocked over).
3. Production ကို ယုံကြည်ရအောင် — Site Reliability Engineering
4. SRE လက်တွေ့
5. Reliability Engineering ကို မြန်မာလို

Never use "Google" in a course or lesson title, and never the bare book title, which would read as a
translation. The ပစ်တိုင်းထောင် doll makes a good original mascot for the thumbnails (falls, recovers),
drawn fresh like the React course mascot, and it sits in the hub of the Padauk loop. Lesson titles avoid
`၊`, which can look like "ı" after a bold Latin word on a small card.

**Lesson description (catalog):** one Burmese sentence about the lesson, then: "Original course. For
further reading: Site Reliability Engineering, 2nd ed. (O'Reilly, 2026) and the public sources in the
lesson. Not affiliated with or endorsed by Google or O'Reilly." The course is never described as a
translation, summary or adaptation of the book.

## Running example

### The company

**Padauk** (ပိတောက်) is a fictional Yangon fintech super-app founded "a few years ago" (no real dates),
named after the flower that blooms at Thingyan, which is also the company's biggest night. It serves
Yangon and Mandalay first and more cities later. Every number is invented. No real Myanmar company,
wallet, bank, telecom, regulator or law is ever named: partners are **Bank X / Bank Y** and
**Operator A / B / C**, and every legal rule is stated as hypothetical ("suppose the rule says…").
Amounts are in kyat. A web search on 2026-10-17 found no wallet or app called "Padauk" or "Padauk Pay";
re-check before the first publish. ("Padauk" is also an SIL Myanmar font in the placeholder CSS
stack; never put the font and the company in the same sentence.)

**Products** (same names in every lesson):

| Product                   | What it does                                                                                                                                | What it lets the course teach                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Padauk Pay · Wallet**   | send money, pay shops by QR, balance; sits on an append-only **ledger**                                                                     | data integrity, idempotency, 24-hour on-call             |
| **Padauk Pay · Top-up**   | airtime and data through **Operator A, B, C** gateways; SMS one-time passwords                                                              | SLIs, outside dependencies, retries, failover, peaks     |
| **Padauk Pay · Bill Pay** | electricity and water bills through a closed **vendor billing system** Padauk bought (unnamed, so no brand collision); launches in Module 1 | wrapping systems you can't change                        |
| **Padauk Eats**           | food delivery with restaurants and **riders**; launches in Yangon at the start of Module 2                                                  | user journeys, mobile clients, lunch and dinner overload |
| **Padauk for Business**   | merchant QR acceptance, daily settlement files and a settlement API; its biggest customer is a supermarket chain (never named)              | business customers, per-customer SLOs, hidden promises   |

Added later: **Ask Padauk**, a Burmese AI support assistant (lesson 27); a **fraud model** (27);
**Ops Buddy**, an internal AI operations agent (28–29); **Padauk Parcel**, a small Mandalay delivery
startup Padauk buys (30).

**Services that recur on boards:** mobile app (mostly Android, many old versions), API gateway,
top-up router and the shared operator gateway client, payment service and wallet ledger, refund job,
settlement batch and morning reconciliation, notification/SMS (two SMS providers behind one operator
gateway), rider dispatch, config service, CI/CD pipeline, monitoring stack.

### Fact sheet (fixed numbers, so lessons never contradict each other)

| Item               | Value                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users              | about 1.2 million active a month; about 3 million registered accounts                                                                                                                                                                                                                                                                                                                    |
| Engineers          | 25 (Module 1) → about 40 (Modules 2–4) → about 55 (L17–L22) → about 60 (L23 on; the same headcount while agents multiply output)                                                                                                                                                                                                                                                         |
| Reliability people | none; Thiri "looks after reliability" on the side (L01–L05) → Thiri full-time and alone, with developer rotations and a volunteer swarm (L06–L13) → Ko Zaw hired, Ko Min onboarded (L14) → Thiri, Ko Zaw and one more, with a charter for Wallet + Top-up (L15–L16) → a 4-person reliability team (L17–L22) → a 4–5-person platform and reliability group (L23–L32)                      |
| Services           | about 30 (L08) → 35 (L25) → 90 (L32, many built with agents)                                                                                                                                                                                                                                                                                                                             |
| Cloud              | one rented region with **three zones**. Wallet runs in two of them until lesson 20 spreads it across all three. Private links to the banks and operators.                                                                                                                                                                                                                                |
| Send money         | 3,000,000 transfers a month (about 100,000 a day, about 4,200 an hour); SLO 99.9% over 30 days → an error budget of 3,000 failed transfers (about 43 minutes of full outage)                                                                                                                                                                                                             |
| Top-up             | about 2,000,000 top-ups a month (about 67,000 a day; payday evenings about 10,000 an hour); SLO 99.5% "airtime arrives within 10 seconds" → an error budget of 10,000 failed top-ups a month. The top-up service is built for about 3,000 requests a second (every app call counts, status checks and retries included); Thingyan midnight brings about 20,000 a second, mostly retries. |
| Eats               | Yangon (from Module 2), Mandalay later; lunch 12:00–13:00 and dinner 18:00–20:00 peaks                                                                                                                                                                                                                                                                                                   |
| Supermarket chain  | its Mandalay stores carry about 2% of all payments, so their failures barely move the overall number                                                                                                                                                                                                                                                                                     |
| Toil               | 55% at the audit (L17), target 35%; creeps back to 45% as services grow from 35 to 90, then falls to 15% (L32)                                                                                                                                                                                                                                                                           |
| Calendar           | payday (around the 25th to the 1st), **Thingyan** in April (the biggest peak), Thadingyut in October, the daily lunch and dinner rush, monsoon floods, power cuts (on-callers keep backup power and a second SIM)                                                                                                                                                                        |

### Recurring people

Burmese names are written and spoken in Burmese script. Nobody is a real person.

| Person                     | Role                                     | Arc                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ma Thiri** (မသီရိ)       | backend developer on Top-up              | asked to "look after reliability" on the side (L01) → first full-time SRE (from L06) → leads the reliability team (L15–L22) → platform and reliability lead (L25) → the generalist who directs agents with principles (L32). The learner's guide. |
| **Ko Nay Lin** (ကိုနေလင်း) | co-founder and CTO                       | wants speed and "100%" (L03, L06) → sits in the first blameless review (L05) → learns to fund reliability (L15, L25) → executive sponsor (L31)                                                                                                    |
| **Ma Hnin** (မနှင်း)       | product manager (Wallet, later Eats)     | the business voice; owns SLO targets with engineering (L06); sets an SLO at design time (L16)                                                                                                                                                     |
| **Ko Zaw** (ကိုဇော်)       | former bank systems administrator        | the second SRE, systems-leaning (L14); starts Ops Buddy in dry-run mode (L28); leads the bank and vendor work (L31)                                                                                                                               |
| **Ko Min** (ကိုမင်း)       | junior developer                         | the quiet warning (L05) → handed a task in the payday incident (L10) → writes the Wallet retry change (L11) → onboarded properly (L14) → first SRE at Padauk Parcel (L30). The learner's peer.                                                    |
| **Ma Su** (မစု)            | customer support lead                    | sees problems first on Facebook and Viber (L06, L12, L29); reads the support timeline in postmortems (L11)                                                                                                                                        |
| **Ko Aung** (ကိုအောင်)     | the only person who can rerun settlement | the hero antipattern (L05) → paired with Ko Zaw (L14)                                                                                                                                                                                             |

### Story spine

Later lessons point back to these lasting changes, so the story accumulates. Moving or cutting a
lesson means updating this table and the neighbours' bridges.

| L   | Padauk moment                                                                                                                      | What Padauk keeps afterwards                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Thingyan eve: a rewards screen built in an afternoon while top-ups double-charge (idempotency keys skipped for a promo months ago) | a written list of the "loans" it pays interest on, and a repay rule                                                       |
| 2   | a fee-config typo charges 10× for 20 minutes                                                                                       | config in Git with a check, a fee-anomaly alert, Yangon-first rollout; the loop drawn around it                           |
| 3   | a 30-minute lunchtime outage of shop QR payments, tallied from the users' and shops' side                                          | CTO buy-in; Padauk's first-year starter list                                                                              |
| 4   | "all servers green, users can't pay"; Bill Pay ships through a template                                                            | a first golden-path template; a cap on autoscaling                                                                        |
| 5   | Ko Min's quiet warning; Ko Aung away at Thingyan; the first blameless review                                                       | a 30-minute blameless review after every incident; Thiri made full-time SRE                                               |
| 6   | Top-up pilot: finance wants 100%                                                                                                   | first SLOs and an error budget policy                                                                                     |
| 7   | every SLO green, Eats orders stuck                                                                                                 | a journey SLO with a synthetic test order; per-merchant SLOs for the top 10                                               |
| 8   | "Top-up never confirms"                                                                                                            | user-level checks, monitoring in another zone, evidence-based alerts, dashboards generated from the shared gateway client |
| 9   | a muted 60-person Viber alert group                                                                                                | per-service rotations, a volunteer swarm, incident roles                                                                  |
| 10  | the payday top-up incident                                                                                                         | a generic mitigation list, a drill card, monthly incident role-plays                                                      |
| 11  | double charges from Ko Min's Wallet retry change (the Wallet half of the L01 loan, never repaid)                                   | a postmortem template with "went right / got lucky"; idempotency keys on Wallet                                           |
| 12  | a payday near miss saved by luck                                                                                                   | a quarterly "normalized shortcuts" review; a manual bank throttle made into a tool                                        |
| 13  | 2,800 wallets freeze on payday                                                                                                     | STPA on the refund design; CAST on the frozen wallets                                                                     |
| 14  | hiring Ko Zaw; onboarding Ko Min properly after the payday incident                                                                | an on-call checklist of actions, shadowing, Ko Aung paired up                                                             |
| 15  | "two SREs are not a rotation"                                                                                                      | a 3-person team with a charter; a review rule with no rankings                                                            |
| 16  | Bill Pay asks SRE to carry its pager; a settlement file change breaks the supermarket chain                                        | a written engagement with Bill Pay's own outcomes and shared on-call                                                      |
| 17  | toil audit: 55%                                                                                                                    | a 35% toil target, a promo tool that refuses empty input, the failover bot's action card                                  |
| 18  | a console edit zeroes Operator A's traffic                                                                                         | config checks, a nightly drift diff                                                                                       |
| 19  | pricing v8 makes Bill Pay time out                                                                                                 | per-caller numbers by version, a nightly fault test, a Thingyan game day                                                  |
| 20  | Thingyan in six weeks                                                                                                              | Wallet in three zones, a pooled quota, a degradation profile                                                              |
| 21  | a "delete my account" request and a production copy on a test server                                                               | a data catalog, a deletion pipeline, synthetic test data                                                                  |
| 22  | a cashback bug older than the backups; a cleanup script deletes 10,000 merchants                                                   | weekly automated restore tests, point-in-time recovery for the ledger, two-person deletes                                 |
| 23  | a half-written price list stops top-ups everywhere                                                                                 | per-zone caches, "did it shrink?" checks, queued notifications                                                            |
| 24  | Thingyan midnight cascade; single sign-on down                                                                                     | priority labels and shedding, a budget-and-calendar change rule, an emergency kit                                         |
| 25  | a Top-up deploy goes out during the Thingyan freeze                                                                                | a platform group, a golden path, the shared gateway client, an exception list                                             |
| 26  | coding agents: 15 → 120 merges a day                                                                                               | an agent instruction file, a fee spec, change records with reasons                                                        |
| 27  | Ask Padauk opens wrong refund tickets                                                                                              | AI SLIs, sampled grading, a data check that halts training                                                                |
| 28  | Ops Buddy asks for production access                                                                                               | the action card, two budgets, a stop button                                                                               |
| 29  | green dashboard, angry comments                                                                                                    | complaint charts by version and operator, an incident co-pilot, a fleet scan                                              |
| 30  | Padauk buys Padauk Parcel                                                                                                          | Ko Min is its first SRE                                                                                                   |
| 31  | wallets locked for 70 minutes at midnight                                                                                          | an IC mandate, guarded break-glass, a gateway in front of the vendor system                                               |
| 32  | uptime said nothing about what was coming                                                                                          | Thiri's risk sheet, "catalog entry before deploy", Thiri as generalist                                                    |

### First use before full use

The course seeds a few ideas in one or two sentences before it relies on them:

| Concept                                        | Seeded                                                                         | Taught in full     | Called back                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------- |
| Agreed risk limit → SLO → error budget         | L01 (Padauk's repay rule), L03 (100% is wrong; "this target is called an SLO") | L06                | L16, L17, L20, L24, L28                                                |
| Toil and its ceiling                           | L02 (hand-work has a name), L03                                                | L17                | L14, L15, L29, L30, L31                                                |
| Incident, on-call, postmortem                  | L02 (three ways to shrink an incident), L05 (the first blameless review)       | L09–L11            | L16                                                                    |
| Blameless                                      | L05                                                                            | L11                | L12, L13, L23                                                          |
| Canary, progressive rollout                    | L02 ("Yangon first")                                                           | L19                | L24, L26, L32                                                          |
| Golden path, guardrails                        | L04                                                                            | L25                | L30, L32                                                               |
| Critical user journey                          | L06 (key user actions)                                                         | L07                | L08, L19, L30                                                          |
| Failure domain, blast radius                   | L02                                                                            | L20, L23           | L24                                                                    |
| Hyrum's law                                    | —                                                                              | L07 (implicit SLO) | L16, L27                                                               |
| Technical debt as a loan                       | L01                                                                            | —                  | L11 (the Wallet half never repaid), L26, L32 (the first risk register) |
| The Padauk reliability loop                    | L01 (outline)                                                                  | L02                | each module's first lesson, L28, L32                                   |
| Ironies of automation                          | L17                                                                            | L17                | L26, L31                                                               |
| The action card (what automation may do alone) | L17                                                                            | L17                | L28                                                                    |

Each repeated theme has one home: overload mechanics in L24 (L20 only decides in advance what to shed),
journeys and client-side SLOs in L07 (L08 refers back), dependency arithmetic in L23, data resilience in
L22, AI in observability, incidents and postmortems in L29, Westrum only in L05, shift down drawn once
in L25.

## Visuals and deck plan

### Which surface does which job

| Surface                                | Used for                                                                                                                     | Never used for                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Deck page** (module deck)            | definitions, rules, short lists, two-column comparisons, 2×2 grids, one number or formula, ladders of 3–5 steps              | mechanisms that unfold over time; more than about 25 words |
| **Whiteboard** (drawn in step by step) | flows, request paths, timelines, loops, arithmetic, failure spreading, before/after redesigns, bar charts                    | paragraphs; tables; more than about 9 labelled elements    |
| **Editor `notes.md`** (recap)          | the lesson's 4–6 key terms, highlighted with `editor.select` as the narration names them, then one pause-and-answer question | new content                                                |

Every lesson uses both deck pages and boards (about 4–7 pages and 2–5 boards). **Pacing:** something
on screen changes at least every 30 seconds (a page advance, a board step or an editor selection).
**Riders:** while one page stays still, the narration adds at most two ideas beyond the page's own
lines; anything more gets its own page advance or board step, or is left out.

### Slide page kit

Pages are 720 × 405 pt on the brand background `#F0EFE9` with white cards and 2 pt black borders.
Every text box with Burmese uses **Noto Sans Myanmar** with line spacing of at least 1.3; Google Sans
is only for English-only headers and the `{ Next Editor }` badge. One idea per page, Burmese page titles
of at most about 20 code points, no Google-hosted images. Burmese runs about 1.5–2× the code points of
the English specs below, so the English limits are strict.

| Kit | Type             | Content limit (English spec)                                                                                | Typical use                                                       |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| K1  | **Cover-hook**   | lesson number, Burmese title, up to 3 lines of ≤ 8 words, and the small loop badge with today's station lit | first page of every lesson                                        |
| K2  | **Three points** | title + ≤ 3 lines of ≤ 7 words                                                                              | rules, checklists, "This week"                                    |
| K3  | **Compare**      | two columns, ≤ 3 rows, ≤ 5 words per cell; left gray ("old / risky"), right teal ("better")                 | then/now, A vs B                                                  |
| K4  | **Grid-3**       | three cards, term + ≤ 6 words                                                                               | three kinds, three questions                                      |
| K5  | **Grid-4**       | 2 × 2 cards, term + ≤ 5 words                                                                               | four cards                                                        |
| K6  | **Ladder**       | 3–5 chevron chips, ≤ 3 words each                                                                           | sequences, levels                                                 |
| K7  | **Number**       | one big number or formula + one line of ≤ 7 words                                                           | budgets, arithmetic                                               |
| K8  | **Module map**   | the Padauk loop with this module's station lit, plus 2 lines                                                | 10–15 s in a module's first lesson only (L06, L09, L14, L17, L26) |

A private lint script (`slide-lint.py`, kept with the reading notes) checks every quoted page line in
this guide against these limits; run it after every edit to the page specs.

Slide colours follow the board's colour jobs in brand colours: purple = the named concept, teal =
healthy or better, yellow = caveat or highlight, gray = old or risky (the brand has no red, so "bad"
is gray with a strike or ✗).

### Whiteboard kit

Hard limits from the studio code (`src/studio/plan.ts`): kinds are only `rectangle`, `ellipse`,
`text` and `freedraw`; freedraw strokes are only `underline`, `strike`, `circle`, `check`,
`arrow-right` and `arrow-down`; lines are always solid; fills are solid at full opacity (there is no
opacity or stroke-width field); the visible area is x 250–1100, y 150–650; labels are at least 28 px
and titles at least 36 px; a Burmese label's box is at least code points × font size × 0.55 wide with
empty space to its right; `drawMs` is at most 6,000 per step; never set `maximized`; never use yellow
ink (it fails compile-check's pale-ink rule). So there are no left or up arrows, no curves, no dashed
lines, no diagonal connectors and no translucent bands (a band is an outline-only rectangle), and every
board below is built from eight patterns:

| Pattern                  | How it is drawn                                                                                                                                                                            | Replaces                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **P1 Flow**              | ≤ 5 boxes left→right with `arrow-right` (or ≤ 5 top→bottom with `arrow-down`); never wraps, because a second row would need a left arrow                                                   | request paths, pipelines                                                       |
| **P2 Comb**              | source → `arrow-right` → a thin vertical rectangle (the "bus") → `arrow-right` into each target; fan-in is the mirror image                                                                | fan-out and fan-in trees                                                       |
| **P3 Ring**              | one large ellipse as the track with 3–6 node boxes on it; one `arrow-right` on the top arc and one `arrow-down` on the right arc show clockwise travel                                     | feedback loops: the Padauk loop, budget loop, cascade, control loop, toil loop |
| **P4 Unrolled loop**     | a left→right strip whose last node repeats the first, circled "again"                                                                                                                      | loops where order matters more than the cycle                                  |
| **P5 Bars**              | an `underline` axis, filled rectangles as bars, a thin orange rectangle as a threshold line; a two-axis placement chart uses a second, vertical thin rectangle and small labelled ellipses | every chart (growth, cost, forecasts, uptime, risk placement)                  |
| **P6 Lanes**             | 2–3 horizontal lanes, each a P1 flow                                                                                                                                                       | before/after, old vs new, races                                                |
| **P7 Stack / staircase** | rectangles stacked bottom-up or rising left→right; ≤ 2 lines of ≤ 9 Burmese code points per step                                                                                           | maturity steps, onboarding                                                     |
| **P8 Timeline**          | an `underline` time axis with short vertical tick rectangles; labels alternate above and below the axis; no arrows                                                                         | incident timelines, diaries, data timelines                                    |

**Label budget per layout** (28 px, the 0.55 rule): three boxes in a row hold about 15 Burmese code
points each; four boxes about 10; five boxes only short English words (about 7 characters); a vertical
column holds at most 5 boxes. **Label language:** a label that is a term the glossary keeps in English
(SLO, canary, rollback, config, …) is drawn in English; every other label is drawn in Burmese, so its
width follows the budget above. In week 0, measure each pattern's standard coordinates once with
`wb-overflow.ts` and copy them.

**Build-up:** every board spec below lists its steps as (1), (2), (3), with at most three new
elements per step, each landing as the narration names it. Furniture (titles, a redrawn map or loop)
comes first with no `drawMs`; teaching groups use 800–2,600 ms.

Grid for reusable coordinates: title at (280, 160) in 36 px; rows at y ≈ 240 / 360 / 480 / 580;
two columns at x 280 / 690 (width ≤ 380), three at x 280 / 560 / 840 (width ≤ 240).

**Colour jobs for the whole course** (light-mode hex, inverted on the dark canvas): ink `#1e1e1e`;
**blue `#1971c2`** = the thing being named, and data series; **green `#2f9e44`** = healthy or done;
**red `#e03131`** = failure, toil or budget spent; **orange `#f08c00`** = caveat, limit or threshold
(never a data series); **violet `#6741d9`** = result or flow, and a second data series.

**The Padauk service map** (P1 + P2, drawn in L01 and reused as furniture): `Padauk app` (x 280) →
`gateway` (x 480) → bus (x 680) → `Wallet`, `Top-up`, `Bill Pay` stacked at x 720 (y 200 / 290 /
380, 170 × 70), with `Banks` and `Operators` at x 940 beside Wallet and Top-up. `Eats` joins at
y 470 from L06 on. Measure it once with `wb-overflow.ts` and copy the coordinates.

**The Padauk reliability loop** (P3, the course map; outline drawn in L01, filled in L02): five
stations clockwise on one ring, in our own words — **Agree** (what "reliable enough" means), **Notice**
(seeing that users hurt), **Respond** (on-call and incidents), **Learn** (postmortems and safety
thinking), **Build in** (turning lessons into tests, tools, capacity, data care, design and platforms) —
and back to Agree. In the hub sits the ပစ်တိုင်းထောင် doll, drawn as two stacked ellipses labelled
"people": culture is what keeps the loop turning. It is a feedback loop that every Padauk incident goes
round, not a hierarchy with a base, and it has no "AI" part of its own: from Module 6 an Ops Buddy icon
appears at whichever station a lesson discusses. Station labels are Burmese words of at most 8 code
points (fixed with the L01 voice script). Six labels plus the title stay inside the 9-label limit.
Every K8 module map page shows this loop with the module's station lit; every K1 cover carries a
small badge of it.

### Decks

One deck per module (per the platform report: about 15–35 pages each), with Module 5 split in three
and Module 6 in two so no deck passes about 4 MB per fetch. That is **9 decks and 9 publish clicks**
for Chan.

| Deck                                                   | Lessons | Pages (incl. map) |
| ------------------------------------------------------ | ------- | ----------------- |
| Next Editor · SRE 1 · Why SRE                          | L01–L05 | 27                |
| Next Editor · SRE 2 · Agree and notice                 | L06–L08 | 19                |
| Next Editor · SRE 3 · Respond and learn                | L09–L13 | 27                |
| Next Editor · SRE 4 · People and teams                 | L14–L16 | 22                |
| Next Editor · SRE 5A · Toil and tests                  | L17–L19 | 15                |
| Next Editor · SRE 5B · Capacity and data               | L20–L22 | 19                |
| Next Editor · SRE 5C · Design and platforms            | L23–L25 | 14                |
| Next Editor · SRE 6A · AI                              | L26–L29 | 22                |
| Next Editor · SRE 6B · Where you work, and what's next | L30–L32 | 16                |
| **Total**                                              | 32      | **181**           |

- Copy "Next Editor · Lesson Template" (Drive id `1J6QneZBDjB3c2dZ7fp3XBk0-yZt4F42uGgU8UUcrD9A`)
  with the Drive `copy_file` tool, **delete its 12 sample pages** (they add about 1 MB to every
  fetch), and build pages with `update_presentation`, checking each with
  `read_slide_page_thumbnail`. Read the `anthropic-skills:google-workspace` skill before the first
  write. The connected tools can't publish, so Chan does File → Share → Publish to web once per deck.
- Create every page with an explicit objectId: **`lNN_pMM`** (lesson NN, page MM, e.g. `l06_p03`) and
  **`mN_map`** for the module map, which lives only in the deck that holds the module's first lesson
  (`m5_map` in deck 5A, `m6_map` in deck 6A). YAML then reads `pageId: l06_p03`.
- **Freeze** a page once its lesson has rendered a draft. Fix a typo by editing in place and
  re-rendering only that lesson. Never delete and re-create a page id (that breaks later renders with
  `SlideResolutionError`); inserting or reordering pages is safe.
- **Build order:** one Myanmar probe page first (Burmese title and three mixed Burmese/English lines,
  Noto Sans Myanmar, 1.3 spacing). Chan publishes it, the Director fetches it, and the shaping is
  checked in the pinned SVG. Measure KB per page then; if a deck would pass about 4 MB, split it
  before building. Only then build deck 1.

### Workspace and lesson shape

Every lesson uses the validated skeleton from the platform report:

- **Workspace:** `notes.md` is the entry file (the lesson's recap terms in Burmese, then one
  pause-and-answer question) with `sidebarStartsCollapsed: true`; `index.html` and `style.css` are a
  Burmese title-card placeholder (Noto Sans Myanmar stack); a `package.json` with no dependencies and a
  harmless `dev` script, so the /learn player's ambient `pnpm install` / `pnpm dev` does nothing visible.
- **Runtime:** `kind: webcontainer`, `initCommand: ""`, `runCommand: pnpm dev`. No `runtime.start`,
  `runtime.run`, `preview.*`, `expect.*` or `console.point` actions. `runtime.collapseDock` at
  `{ scene: start, offsetMs: -1900 }`, the cover page at `-1600`. Checks: `timing.p95Ms: 500`.
- **Shape (7–11 scenes):**
  1. **Hook:** one sentence of "Padauk so far", the Padauk moment as a question on the cover page (K1,
     with the loop badge); in a module's first lesson only, the module map page (K8) for 10–15 seconds.
  2. **Concepts:** boards for mechanisms, pages for definitions, alternating; each concept tied to the
     Padauk moment as soon as it appears. The Padauk story decides the order of scenes.
  3. **This week:** a K2 page with three actions a developer at a small company can take without an
     SRE team or new tools.
  4. **Recap:** close the board, open `notes.md`, `editor.select` each term as the narration names it,
     then read the pause-and-answer question and leave a 3-second pause before the answer.
  5. **Bridge:** the last sentence poses the next lesson's Padauk problem as a question, the same one
     the next cover page asks.
- **Rules:** close the previous surface 400 ms before the next opens; consecutive pages advance in
  place; every new board opens with `open: true, clear: true`; marks sit after `။` or `၊`; dialogs stay
  between 120 and 450 characters (never over 2,000); every scene has `sources:`, crediting the book and
  the scene's public sources there and never in the audio.

## Module 1 — Why SRE

Deck SRE 1 · lessons 1–5 · about 50 minutes. Padauk: 25 engineers, Top-up and Wallet live, Bill Pay
launching, no SRE team; Thiri looks after reliability on the side. No module map page: L01 draws the
loop's outline and L02 fills it; L03–L05 carry the loop badge on their covers.

How to read a lesson spec: page lines are English content specs (their Burmese wording is fixed with
the approved voice script); board steps are numbered in drawing order; "Narration" notes are what the
voice script must explain in that scene, in our own words. The lists of book ideas each scene carries
live only in the private coverage map.

### Lesson 1 · `sre-01-why-reliability-now` · ≈ 10 min · deck SRE 1

**SRE ဘာကြောင့် လိုလာတာလဲ** — _Why running software is the long, hard part, and how this course works_

- **Prerequisites:** none (the learner has shipped software) · **Borrowed terms:** none · **Pages:** 5 ·
  **Boards:** 4 · **Chars:** 7,600
- **Goals.** The learner can:
  1. explain why running a service lasts far longer and costs more than building it;
  2. describe a shortcut as a loan: the interest is hand-work and fear of change, and an outage is the
     day it comes due;
  3. explain why a team agrees a limit for its loans instead of trying to have none;
  4. recognize that reliability practices work at any company size, with or without an SRE team;
  5. name the course's modules on the Padauk loop.
- **Padauk:** first meeting. On Thingyan eve the new rewards screen was built in one afternoon with an
  AI assistant, while top-ups fail, take 40 seconds, or charge twice. The cause is a loan taken months
  earlier: idempotency keys were skipped to launch a promo on time. The interest was three hours of
  hand-reconciliation every Monday, growing to six, and fear of touching the retry code; the due date
  came when Operator B slowed at peak. Afterwards Padauk writes its loans down and agrees a repay rule.
  Ko Nay Lin asks Ma Thiri to "look after reliability" alongside her Top-up work.
- **Scenes:**
  1. **Hook: Thingyan eve.** Page `l01_p01` (K1) "Thingyan eve at Padauk" · "A rewards screen, built in
     one afternoon" · "Top-ups: double charges, 40-second waits" · "Which one will users remember?"
  2. **Hoping vs engineering.** Page `l01_p02` (K3) "Hope it holds | Engineer it" · "Fix it when it breaks
     | Measure what users feel" · "Ship, then pray | Agree how reliable is enough" · "Heroes at night |
     Change the system". Narration defines SRE in our own words: engineers who use software to keep big
     services, running on many machines, reliable for the people who depend on them; the same work goes
     by many titles (SRE, DevOps, platform engineer), and people and teams matter as much as tools.
  3. **Build short, run long.** Board B1 (P5): (1) an `underline` time axis and a small blue block "build:
     one afternoon"; (2) a long violet bar "run: years" with three labels under it, "monitoring · on-call",
     "upgrades · data", "capacity · retiring"; (3) orange "AI made building cheaper", red "running is
     still hard". Narration: infrastructure is rented now, so the work moves up to choosing, configuring
     and understanding how the bought parts fail.
  4. **Padauk's loan.** Board B2 (P8 timeline), cleared: (1) the axis with ticks "promo week" and "every
     Monday", labels "keys skipped (borrow)" above and "3 h of hand-fixing (interest)" below; (2) ticks
     "months later" and "Thingyan eve", labels "nobody dares touch retries" above and red "double charges
     (due)" below; (3) an orange note under the Monday tick "3 h → 6 h: interest grows quietly".
     Narration: every Padauk number on the board; a second way the loan comes due is that nobody dares
     deploy at all.
  5. **What Padauk agreed afterwards.** Page `l01_p03` (K2) "What Padauk agreed afterwards" · "Write
     every loan on one list" · "Over 5 hours weekly? Repay next sprint" · "Repay before the next peak".
     Narration: no team can have zero shortcuts, and it would cost too much to try, so Padauk agrees a
     limit before trouble starts; this limit gets a proper name later in the course; reliability is never
     finished. SREs are both engineers and advisors on this kind of risk.
  6. **Any company can start.** Page `l01_p04` (K2) "You can start without an SRE team" · "Developers can
     run what they build" · "Safe rollouts need no special team" · "Small, old or regulated: start anyway".
     Narration: practices don't depend on an org chart; any team can start, but keeping it going is harder
     without someone whose job it is, and reliability done on the side keeps slipping, which is why, at the
     end of Lesson 5, Padauk makes it Thiri's full-time job.
  7. **Meet Padauk.** Board B3, the Padauk service map (P1 + P2), drawn in three steps: (1) app →
     gateway; (2) Wallet, Top-up and Bill Pay; (3) the partners and the title "Padauk: 25 engineers, no SRE
     team". Narration introduces Ma Thiri, Ko Nay Lin and Ma Hnin.
  8. **The course on one loop.** Board B4 (P3, the Padauk loop outline), cleared: (1) the ring with the
     five station names and the clockwise arrows (furniture); (2) the doll in the hub, "people". Narration:
     every Padauk incident goes round this loop: agree what "reliable enough" means, notice when users
     hurt, respond, learn, and build the lesson into the system; Module 2 learns to agree and notice,
     Module 3 to respond and learn, Module 4 is about the people in the middle, Module 5 builds lessons in,
     and Module 6 brings AI onto the loop and takes it to any workplace.
  9. **This week.** Page `l01_p05` (K2) "This week" · "List three shortcuts you still pay for" · "Ask what
     users feel when slow" · "Pick the one service to protect first".
- **Recap (`notes.md`):** SRE · build vs run · technical debt · agreed risk limit · sociotechnical ·
  **Question:** "Your team re-runs a failed job by hand every Friday. Is that the loan, the interest, or
  the due date?" (the interest)
- **Bridge:** "Next: a typo in the fee config charges users ten times the fee for 20 minutes. What do we
  fix first?"

### Lesson 2 · `sre-02-what-sre-is` · ≈ 10 min · deck SRE 1

**SRE ဆိုတာ ဘာလဲ** — _What SRE is: what users feel, three ways to shrink an incident, and the Padauk loop_

- **Prerequisites:** L01 · **Borrowed terms:** the Padauk loop · **Pages:** 5 · **Boards:** 3 ·
  **Chars:** 7,600
- **Goals.** The learner can:
  1. describe reliability as what users feel: down, slow or wrong;
  2. explain "as reliable as this use needs", and why SRE builds safe roads instead of saying no;
  3. contrast fixing by hand with changing the system, and say why automation pays twice;
  4. use three levers on an incident: shorter, rarer, smaller;
  5. walk one incident around the Padauk loop.
- **Padauk:** a fee-config typo charges users ten times the fee for 20 minutes. Ma Su sorts the
  complaints into down, slow and wrong. The fixes Padauk keeps: a fee-anomaly alert (shorter), config in
  Git with a check (rarer) and rolling out Yangon first, then Mandalay (smaller). The engineer who made
  the typo helps write the review, without fear.
- **Scenes:**
  1. **Hook: 20 minutes of 10× fees.** Page `l02_p01` (K1) "20 minutes of 10× fees" · "One typo in the
     fee config" · "Users charged ten times the fee" · "What do we fix first?"
  2. **What Ma Su's inbox said.** Page `l02_p02` (K4) "What Ma Su's inbox said" · "Down: my top-up failed"
     · "Slow: it took 40 seconds" · "Wrong: I paid 10× the fee". Narration: reliability is what users feel,
     not what the servers say; in moments like these a new feature earns nothing, so reliability is often
     the most important feature.
  3. **Reliable enough.** Page `l02_p03` (K3) "How reliable is enough?" · "Promo banner image | Wallet
     balance" · "Broken a minute: fine | Wrong a minute: not fine" · "Cheap to protect | Worth real
     effort". Narration: "SRE" can mean the practice, the person or the team; a dedicated voice for
     reliability sits at the planning table, and SRE teaches a reliability culture rather than chasing
     100%.
  4. **Three ways to shrink an incident.** Board B1 (three panels, each its own cleared step): (1) "how
     long": a long red bar "20 min" and a short green bar "3 min: fee-anomaly alert"; (2) "how often": many
     small red ellipses, then few, label "config in Git + a check"; (3) "how wide": a red "Yangon" box and a
     green "Mandalay" box, label "Yangon first". Narration: an incident's harm is how long × how often × how
     wide; on panel 3 name **blast radius** and **failure domain**, and add "switch off extras, keep
     payments"; the real work starts after the fire is out; on-call is a means, not the goal.
  5. **Hand fix vs engineering fix.** Page `l02_p04` (K3) "Hand fix | Engineering fix" · "Fix by hand,
     every time | Change the system once" · "More work, more people | More work, more automation" ·
     "Depends who's awake | Same result every time". Narration: automation pays twice, in time and in
     consistency; repeated hand-work like Padauk's Monday reconciliation has a name, toil, which Lesson 3
     measures.
  6. **Roads, not walls.** Board B2 (P6 lanes), cleared: (1) top lane "developer" → red block "SRE says
     no"; (2) bottom lane "developer" → green "safe road: Yangon first" → "users". Narration: SRE works
     with developers rather than against them, and these practices work even without an SRE team.
  7. **The fee typo around the loop.** Board B3 (P3, the Padauk loop), cleared: (1) the loop from L01 as
     furniture; (2) a `check` at Agree ("fees must look normal") and Notice ("the fee-anomaly alert") as
     the narration reaches them, plus an orange label beside Notice "SLOs · alerts · dashboards · logs ·
     traces"; (3) `check` marks at Respond ("rolled back in 3 minutes"), Learn ("review with the engineer,
     no blame") and Build in ("config check, Yangon first"). Narration: production health used to mean
     firefighting; today most of it comes from design and being prepared; every station is people and
     technology together, which is why people sit in the hub; the loop never stops, because reliability
     decays without effort; later AI shows up at several stations, both as something to run and as a
     helper. Reliability that lasts is built into the tools and the organization rather than left to each
     person's memory (Lesson 25 shows how).
  8. **This week.** Page `l02_p05` (K2) "This week" · "Sort last month's complaints: down, slow, wrong" ·
     "Time your last fix, alert to done" · "Find your weakest loop station".
- **Recap (`notes.md`):** down / slow / wrong · reliable enough · incident impact · blast radius · the
  Padauk loop · **Question:** "A bug hit 5% of users for two hours. Name one way to make the next one
  shorter, one rarer and one smaller."
- **Bridge:** "Next: a 30-minute lunchtime outage. Is that 30 minutes of cost, or something much bigger?"

### Lesson 3 · `sre-03-value-of-reliability` · ≈ 10 min · deck SRE 1

**Reliability ရဲ့ တန်ဖိုး** — _The value of reliability: the real outage bill, and why 100% is the wrong goal_

- **Prerequisites:** L01, L02 · **Borrowed terms:** toil, blast radius · **Pages:** 5 · **Boards:** 4 ·
  **Chars:** 7,600
- **Goals.** The learner can:
  1. tally an outage's real cost from the users' and shops' side;
  2. explain how a neglected system decays into one nobody dares touch;
  3. explain why 100% is the wrong target, and name the gap an error budget;
  4. contrast an ops-team model with an SRE model, including a ceiling on operations work;
  5. pick starter practices for a young team, and treat reliability as an investment.
- **Padauk:** a 30-minute lunchtime outage of QR payments at shops, tallied at about 500 hours of
  people's time plus lost shop sales. The old SMS one-time-password integration nobody has touched in two
  years. A 3-minute glitch at 2 a.m. compared with a 40-minute outage on Thingyan eve. Bill Pay rolls out
  from 1 city to 3 to 5: ops staff would grow from 2 to 10 by hand, but only to 3 with templates and CI/CD.
  Manual merchant approvals grow from about 2.5 hours a week at 200 merchants to most of the week at 2,000.
- **Scenes:**
  1. **Hook: 30 minutes?** Page `l03_p01` (K1) "Lunchtime: shop QR payments down" · "30 minutes on the
     clock" · "About 500 hours of people's time" · "Which number is the real cost?"
  2. **The real bill.** Board B1 (P2 comb): (1) red "30 minutes down" → bus; (2) tines "1,800 users × 10
     min retrying = 300 h", "1,500 support messages × 6 min = 150 h", "finance refunds: 2 days × 3 people =
     48 h"; (3) tines "120 shops lost lunch sales: 3.6 million kyat" and orange "next feature ships 2 weeks
     late", then a violet total "≈ 500 hours + lost sales". Narration: all numbers are Padauk's; the failures
     we prevent stay invisible, so nobody thanks you for them.
  3. **How a system decays.** Board B2 (P3 ring), cleared: (1) the ring with "no upkeep" and "partner API
     and libraries change"; (2) "a small fix becomes a project", "surprise failures"; (3) red "don't touch
     it", leading back to "no upkeep". Narration: the old SMS integration; the signs are more hand
     workarounds and more slowness than anyone expects; the way out is to measure the decay against an
     agreed target and to cut the hand-work.
  4. **Cost grows with time and timing.** Board B3 (P5), cleared: (1) bars "cost per 10 minutes down" for
     minutes 10 / 20 / 30 / 40: the first bar green "users retry", the later bars red and much taller
     "users switch apps"; (2) a second, taller violet set "Thingyan eve". Narration: a 3-minute glitch at
     2 a.m. is not a 40-minute outage on Thingyan eve; ask marketing for the campaign calendar.
  5. **Why not 100%?** Page `l03_p02` (K2) "Why not 100%?" · "Each extra nine costs far more" · "Users on
     weak networks can't tell" · "Pick a target; the gap is budget". Narration: the first question is how
     much reliability this service needs, and the answer comes from what failure costs us, changes as we
     grow, and is never copied from another company; this agreed target is called an SLO; budget left →
     ship, budget spent → fix (Lesson 6).
  6. **Two ways to run production.** Page `l03_p03` (K3) "Ops team | SRE" · "Keeps servers up | Shares the
     product's success" · "Rewarded for no change | Spends an agreed budget" · "Fixes by hand | Engineers
     who automate". Narration: all operations work, toil included, stays under half of anyone's time, a
     ceiling and not a goal; if a service keeps missing its target or pages so much that people suffer, SRE
     can hand the pager back to its developers until it is fixed, which keeps both sides honest (a different
     handback from the planned one in Lesson 16).
  7. **Growth without hiring.** Board B4 (P5), cleared: (1) grouped bars at 1 / 3 / 5 cities, red "staff by
     hand" 2 / 6 / 10; (2) green "templates + CI/CD" 2 / 2.5 / 3; (3) the gap labelled violet "what SRE
     buys". Narration: Bill Pay's city rollout; the merchant-approval hand-work is toil, and it grows with
     the business unless someone engineers it away.
  8. **Padauk's first-year list.** Page `l03_p04` (K2) "Padauk's first-year list" · "One-button rollback" ·
     "An alert on failed top-ups" · "A written on-call list". Narration: a 15-minute check for risky changes
     came next; adding reliability later costs far more than building it in; so plan reliability like any
     investment: it costs people and time now and pays back in fewer outages, operations cost that grows
     slower than the business, and engineers free to build.
  9. **This week.** Page `l03_p05` (K2) "This week" · "Tally your last outage's real hours" · "Get
     marketing's campaign calendar" · "Add one item from Padauk's list".
- **Recap (`notes.md`):** real outage cost · system decay · 100% is wrong · error budget · limits on ops
  work · **Question:** "Your service is 99% reliable. What is the gap called, and who should agree it?"
  (the error budget; the business with engineering)
- **Bridge:** "Next: every server shows green, yet Bank Y transfers take 20 seconds. Who is right, the
  dashboard or the user?"

### Lesson 4 · `sre-04-production-then-now` · ≈ 10 min · deck SRE 1

**Production ဘယ်လို ပြောင်းလဲလာလဲ** — _Production then and now: cloud, golden paths and gray failure_

- **Prerequisites:** L02, L03 · **Borrowed terms:** SLO (one clause), blast radius · **Pages:** 6 ·
  **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. contrast hand-kept servers with workloads on rented platforms;
  2. explain what changes when capacity becomes a spending decision, and how cloud failures change shape;
  3. describe a golden path with guardrails instead of tickets and approvals;
  4. explain gray failure and why "all servers up" is not reliability;
  5. say why reliability is measured from the user's side, ahead of trouble rather than after it.
- **Padauk:** "everything green, but people can't pay": for two hours, transfers to Bank Y are slow for
  users of the older Android app. A new electricity Bill Pay service: the two-week ticket path vs a
  template. On a peak night an uncapped autoscaling rule plus a retry loop doubled the cloud bill.
- **Scenes:**
  1. **Hook.** Page `l04_p01` (K1) "All servers green. Users can't pay." · "Status checks: all up" · "Bank
     Y transfers: slow for two hours" · "Who is right?"
  2. **Then and now.** Page `l04_p02` (K3) "Then | Now" · "Hand-kept servers | Containers and functions" ·
     "Tickets, weeks | Self-service, minutes" · "Server uptime | What users feel".
  3. **Capacity is now spending.** Board B1 (P5): (1) monthly demand bars Jan→Dec with a tall April bar
     "Thingyan"; (2) a thin orange threshold "bought for peak" and the empty space under it labelled "idle
     money"; (3) green "scale up and down" and red "no cap + retries = double bill". Narration: managed
     services move responsibility up but don't remove it; cost engineering never stops (the settlement
     batch can run on cheap capacity that may be taken away, the payment API on reserved capacity);
     failures change shape too: a provider's shared control service can have a bad hour and hit thousands
     of customers at once, and we own how our app behaves when it does.
  4. **Ticket path vs golden path.** Board B2 (P6 lanes), cleared: (1) top lane "developer" → "ticket: 2
     weeks" → "ops" → red "server, no monitoring"; (2) bottom lane "developer" → "template" → green "service
     with metrics, alerts, backups"; (3) an orange "check" box on the bottom lane that stops a red "typo".
     Narration: Lesson 1 said developers can run what they build; that only works when a platform carries
     servers, networks, storage and security for them, because nobody can be an expert in all of it.
  5. **Guardrails, not gates.** Page `l04_p03` (K2) "Guardrails, not gates" · "Checks in the path, not
     approvals" · "Monitoring and backups on by default" · "Fast developers, no extra risk". Narration: one
     example of a rule written as code: suppose national ID data must stay in-country; the pipeline then
     blocks any deploy that would put it elsewhere.
  6. **Gray failure.** Board B3 (P6 lanes), cleared: (1) top lane, one green box "status checks: all UP";
     (2) bottom lane "% of Bank Y transfers slower than 5 s (old Android app)", six 30-minute bars "0.4% ·
     0.6% · 19% · 23% · 24% · 21%" with a thin orange threshold "target: at most 1% slow"; (3) the last
     four bars turn red (the hook's two hours) and the label "Bank Y: slow for old Android users".
     Narration: an average transfer time would look fine; the pain sits in one group of users.
  7. **Server says, user feels.** Page `l04_p04` (K3) "Server says | User feels" · "All up | Can't pay Bank Y"
     · "Average: 2 seconds | One in five: 20 s" · "Green dashboard | Angry posts". Narration: a server
     dashboard tells you after users hurt; measuring from the user's side warns you sooner, while there is
     still time to act.
  8. **Seeing production now.** Page `l04_p05` (K2) "Seeing production now" · "Follow one request across
     services" · "SLOs first, details to explain" · "Few metric labels, shared data". Narration points
     ahead to Lesson 8 for the depth.
  9. **This week.** Page `l04_p06` (K2) "This week" · "Find one failure dashboards can't see" · "Check your
     autoscaling has a cap" · "Time a new service to production".
- **Recap (`notes.md`):** workload-centric · golden path · guardrail · gray failure · user-side measurement
  · **Question:** "Your status page is green while 20% of one group's requests are slow. What kind of
  failure is that?" (a gray failure)
- **Bridge:** "Next: 9 p.m., Ko Min sees the SMS codes slowing before a big promo. He's new, and last
  month someone laughed at his question. Does he speak up?"

### Lesson 5 · `sre-05-reliability-culture` · ≈ 10 min · deck SRE 1

**Reliability ယဉ်ကျေးမှု** — _Reliability culture: bad news, blameless reviews, no heroes_

- **Prerequisites:** L01–L03 · **Borrowed terms:** incident, a shared target (no SLI or SLO yet) ·
  **Pages:** 6 · **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. place an organization on Westrum's three types by how it treats a messenger with bad news;
  2. run a blameless review that still ends with named owners;
  3. replace the hero antipattern with shared, written knowledge;
  4. explain psychological safety and who creates it;
  5. change culture through one small, repeated behavior, with leaders taking part.
- **Padauk:** **the quiet warning**: working late on a top-up promo and watching the SMS dashboard, junior
  developer Ko Min sees the one-time-password provider slowing. Last month someone laughed at his question
  in the team chat, so he says nothing; codes arrive four minutes late during the promo. **The midnight
  hero**: Ko Aung is the only person who can rerun the stuck bank settlement job; he is away at Thingyan,
  and payouts slip a day. Thiri runs Padauk's first blameless review, and Ko Nay Lin sits in. At the next
  quarterly awards, the Top-up failover fix is named next to the rewards screen. Afterwards Ko Nay Lin
  makes reliability Thiri's full-time job.
- **Scenes:**
  1. **Hook.** Page `l05_p01` (K1) "9 p.m.: Ko Min sees a warning" · "SMS codes slowing before a promo" ·
     "Last month, someone laughed at him" · "Does he speak up?"
  2. **How bad news travels.** Page `l05_p02` (K4) "What happens to the messenger?" · "Pathological: the
     messenger is silenced" · "Bureaucratic: the warning waits in a queue" · "Generative: the messenger is
     thanked". Narration: these are the sociologist Ron Westrum's three types, taught from his own public
     table; research by DORA finds that this kind of culture predicts how well teams deliver, which is the
     evidence Thiri shows Ko Nay Lin.
  3. **Padauk's night, placed.** Board B1 (P6, two lanes): (1) lane "that night": "Ko Min sees it" → red
     `strike` "stays quiet" → red "codes 4 min late"; (2) lane "after the review": "Ko Min posts it" → green
     "Thiri thanks him" → green "second provider on". Narration: Padauk's real night sat near the left of
     Westrum's row; one thank-you, repeated, moves it.
  4. **What the culture does.** Page `l05_p03` (K4) "What a reliability culture does" · "Decides with data
     and users' view" · "Shares what it knows across teams" · "Treats failure as information". Narration:
     under these habits sit two foundations: users decide how reliable is enough, and reliability work earns
     the same praise and promotion as a shiny feature (the quarterly awards); tools shape habits too: one
     shared dashboard beats five tools nobody reads.
  5. **Hero loop vs learning loop.** Board B2 (P4, two unrolled rows), cleared: (1) red row "incident" →
     "Ko Aung fixes it at night" → "nothing written" → "incident", circled "again"; (2) green row "incident"
     → "blameless review" → "runbook + shared on-call" → "fewer incidents"; (3) an orange label under the red
     row "praise for night rescues → burnout". Narration: praising night rescues teaches everyone that
     overwork is the job.
  6. **Two questions from Padauk's first review.** Page `l05_p04` (K3) "We asked | We ask now" · "Why skip
     the check? | What did the screen show?" · "Who allowed this? | Why only one path?" Narration: if a
     choice made sense to Ko Aung at 2 a.m., it will make sense to the next person (local rationality);
     blameless does not mean nobody is responsible: the review ends with named owners and dates (Ko Aung and
     Thiri write the runbook), in the spirit of just culture (Sidney Dekker); when someone else breaks
     something we call them careless, and when we do it we blame the tool. Ko Nay Lin asks "what allowed
     it?", not "who?", and his presence is why the habit sticks; at first things may look worse, because
     problems that were hidden now get written down.
  7. **Safe to speak.** Page `l05_p05` (K2) "Safe to speak" · "Leaders say what they don't know" ·
     "Questions get thanks, not laughs" · "Anyone may raise a risk". Narration: psychological safety means
     nobody is punished or humiliated for a question, a concern or a mistake; it isn't about being nice, it
     makes hard conversations possible, and managers create it; Thiri can agree with Ma Hnin to pause
     features when toil is too high.
  8. **Behavior first.** Board B3 (P7 staircase), cleared: (1) "try it once" → "it helps"; (2) "habit" →
     violet "culture". Narration: Padauk's one habit is a 30-minute blameless review after every incident,
     with no memo and no mandate; renaming the ops team without changing what people are rewarded for
     turns people against it; to see whether it works, ask people before and after how confident they are
     at a real task (never done it → with a pair → alone → every week → taught it), and again a month and
     six months later.
  9. **This week.** Page `l05_p06` (K2) "This week" · "Thank the next person with bad news" · "Rewrite one
     'who' as 'what'" · "Find what only one person knows".
- **Recap (`notes.md`):** blameless · local rationality · psychological safety · hero antipattern · Westrum
  · **Question:** "Rewrite this review question: 'Who pushed the bad config?'" (for example: "What made
  pushing it look safe?")
- **Bridge:** "After the review, Ko Nay Lin makes reliability Thiri's full-time job. Her first task:
  finance wants Top-up at 100%. How reliable should it really be?"

## Module 2 — Agree and notice

Deck SRE 2 · lessons 6–8 · about 33 minutes. Padauk: about 40 engineers; Eats has just launched in
Yangon; Thiri is the first full-time SRE and works alone with each product team. Module map page
`m2_map` (in L06): "Module 2 · Agree and notice" · "Agree what reliable enough means" · "Notice when
users hurt". The loop's Agree and Notice stations are lit.

### Lesson 6 · `sre-06-slo-error-budget` · ≈ 11 min · deck SRE 2

**SLO နဲ့ error budget** — _SLOs and error budgets: agreeing on "reliable enough"_

- **Prerequisites:** L03 (why not 100%), L05 (blameless review) · **Borrowed terms:** error budget
  (from L03), blameless review · **Pages:** 7 + map · **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. define metric, SLI (good ÷ valid), SLO (target + window) and SLA;
  2. calculate an error budget and a burn rate, and know when a burn pages and when it files a ticket;
  3. choose a first SLI for a key user action with two thresholds: how often, and what counts as good;
  4. run a small SLO pilot on one existing service and agree the target with the business;
  5. write an error budget policy that tightens step by step, with written exceptions.
- **Padauk:** **the Top-up pilot.** Thiri picks Top-up because it hurts on salary days, its team is
  willing and the code is Padauk's own; Ko Nay Lin asks whether refund hand-work is the bigger problem,
  and they check before starting. A month of measurement shows "airtime within 10 seconds" at about 99.6%
  over the month, with salary days far lower. Ko Nay Lin wants 100%; Ma Su's support data shows that what
  hurts most is money taken with no airtime delivered. Agreed: 99.5%, plus a refund within an hour. In the
  first month a payday evening and a slow leak spend the whole budget by day 6, so a feature slips while
  the failover fix continues, and releases now follow the budget instead of a fixed weekday. The first
  breach gets a blameless review; Padauk announces the win at all-hands, and Eats asks to be next.
- **Scenes:**
  1. **Hook + map.** Page `l06_p01` (K1) "How reliable should Top-up be?" · "Engineers: it's fine" ·
     "Finance: 100%" · "Users: don't take my money twice", then `m2_map`.
  2. **From number to promise.** Page `l06_p02` (K5) "From number to promise" · "Metric: a raw count" ·
     "SLI: good ÷ valid" · "SLO: target + window" · "SLA: promise with penalties". Narration: an SLA's
     penalty is money; an SLO between two teams inside Padauk, such as the ledger team's promise to the
     payment service, costs engineering time when missed, and most first SLOs are internal ones like that.
  3. **First SLI and two thresholds.** Board B1 (P1): (1) "tap Top-up" → "Padauk API" → "operator gateway"
     → "airtime arrives"; (2) a blue box at the end "good = arrived within 10 s"; (3) orange labels "how
     often: 99.5%" and "what's good: ≤ 10 s". Narration: measure the key action at the front door, crude but
     far better than nothing; a latency SLO is a percentage, not a number of seconds; where no metric exists
     yet, start from generic rate, error and duration numbers and replace them later; other systems need
     other SLIs: the settlement file must be ready by 6 a.m. and every row must reconcile, and the ledger
     needs a separate durability SLO ("a written transfer is never lost") with far more nines.
  4. **The agreement.** Page `l06_p03` (K2) "First SLOs: few and agreed" · "The business owns the target" ·
     "Start from what users complain about" · "Agree first, even before metrics". Narration: the pilot
     meeting with Ko Nay Lin, Ma Hnin, Ma Su and Thiri; engineers, the business and users each see
     reliability differently until the number is agreed; most services land near 99.9%, and the real choice
     is which side of it; don't freeze today's numbers into a promise; review the target at least once a
     year.
  5. **Burn rate.** Page `l06_p04` (K7) "burn rate = error rate ÷ allowed rate" · "1 → a month · 10 → 3
     days".
  6. **The budget.** Board B2 (P5), cleared: (1) a long bar "this month's budget: 10,000 failed top-ups"
     (100% − 99.5% of 2 million); (2) three bars below it: green "burn 0.5: budget left at month end",
     orange "burn 1.5: 15% gone in 3 days → ticket", red "burn 50: 7% gone in 1 hour → page"; (3) a stacked
     bar "this month": red "payday evening: 7,500" and orange "leak: 500 a day × 5", ending at "gone on day
     6". Narration: alerts are generated from the SLO itself: page when about 2% of the month's budget burns
     in one hour, file a ticket at about 10% in three days, and check more than one window so the alert
     clears when users recover; for comparison, Send money's 99.9% over 30 days allows about 43 minutes of
     full outage.
  7. **The budget loop.** Board B3 (P3 ring), cleared: (1) nodes "measure" and "budget left?" on the track;
     (2) green "ship, experiment" and red "stabilize, fix"; (3) centre label "check every sprint" and violet
     "release by budget, not calendar". Narration: the budget ends the speed-versus-stability argument with
     a rule both sides agreed; effort shifts gradually, not on and off.
  8. **The policy.** Page `l06_p05` (K4) "Padauk's error budget policy" · "Healthy: ship as planned" · "Low:
     slower rollouts, more fixes" · "Spent: only fixes and security patches". Narration: the day-6 story;
     exceptions are written down; after a huge overrun the budget still resets monthly while the real fix
     continues, instead of a year-long freeze; the first breach gets a blameless review (Lesson 5).
  9. **The next team.** Page `l06_p06` (K3) "Rolling out SLOs" · "No metrics yet? | Start generic, replace
     later" · "Everything at once? | Users' tap, then shared parts" · "A CTO memo? | Thiri sits with each
     team". Narration: the first month is slower for everyone; Padauk announces the Top-up win at all-hands,
     credits the Top-up team and says why it matters (salary-day trust, not last month's outage); Eats asks
     to be next.
  10. **This week.** Page `l06_p07` (K2) "This week" · "Write the SLI for one key action" · "Agree a first
      target with product" · "Write a three-line budget policy".
- **Recap (`notes.md`):** SLI · SLO · SLA · error budget · burn rate · budget policy · **Question:**
  "Budget: 10,000 failed top-ups a month. Yesterday 1,000 failed. What was yesterday's burn rate?" (about
  3: the daily allowance is about 333)
- **Bridge:** "Next: every SLO is green, but Eats orders are stuck. What did we forget to measure?"

### Lesson 7 · `sre-07-slo-from-the-users-side` · ≈ 11 min · deck SRE 2

**User ဘက်က ကြည့်တဲ့ SLO** — _SLOs from the user's side: three ways a green SLO can lie_

- **Prerequisites:** L06 · **Borrowed terms:** SLI, SLO, error budget · **Pages:** 7 · **Boards:** 3 ·
  **Chars:** 8,400
- **Goals.** The learner can:
  1. define a critical user journey and measure the whole journey, not only the backends;
  2. count bad minutes for a journey and explain the phone's noise floor;
  3. find a big customer's pain hidden in an overall number with per-customer SLOs;
  4. explain the implicit SLO, Hyrum's law, and why changing delivered reliability hurts in both
     directions;
  5. name where SLOs fit poorly.
- **Padauk:** three ways a green SLO lied. **Where we measured:** on the Eats "order lunch" journey every
  backend SLO is green, but a silent payment-to-order callback failure strands orders; a journey SLO and a
  full synthetic test order catch it. **Whom we averaged:** the supermarket chain fails 1 payment in 25 at
  its Mandalay stores (about 2% of all payments) while the overall number reads 99.91%; per-merchant SLOs
  for the top 10 merchants find one old point-of-sale model. **What we never promised:** a profile service
  promises 99.5% but delivers 99.99%, so other teams quietly build on it.
- **Scenes:**
  1. **Hook.** Page `l07_p01` (K1) "Every SLO green. Orders stuck." · "Payment: green · Orders: green" ·
     "Users see an endless spinner" · "What did we forget to measure?"
  2. **Lie 1: where we measured.** Board B1 (P1): (1) "app" → "payment" → "order" → "restaurant"; (2) a red
     `strike` on the arrow between payment and order, "callback lost"; (3) below, a short red bar
     "home-page check: OK" and a long green bar "test order, end to end".
  3. **Measure the journey.** Page `l07_p02` (K2) "Measure the journey" · "Name it as users do: order
     lunch" · "Measure in the app and front door" · "Walk the path with a test order". Narration: name the
     key steps inside each journey (tap Pay, see the receipt) and tag telemetry with the journey's name;
     the journey is described the way users see it, not the way the architecture is drawn.
  4. **Bad minutes.** Page `l07_p03` (K7) "43 bad minutes a month" · "99.9% of 43,200 minutes are good".
     Narration: at 12:07 a user taps Pay (fine) but never sees the receipt (failed), so that minute counts
     as bad for the whole journey; the journey SLO is good minutes ÷ all minutes.
  5. **What only the phone sees.** Page `l07_p04` (K2) "What only the phone sees" · "Crashes, lost
     connections, dead buttons" · "Cheap phones add noise" · "Count bad minutes above it". Narration: on
     the rider app about 3% of requests fail on a normal day, so a minute counts as bad only above 5%; a
     request SLO swamped by that noise needs so few nines that a fast-burn page can never fire, and an app
     fix waits for the store and for users to update; client data also arrives late, through a public door
     anyone can call, from devices we don't control, so agree one trusted definition per SLI in one shared
     SLO tool.
  6. **Lie 2: whom we averaged.** Board B2 (P5), cleared: (1) a tall green bar "all payments: 99.91%";
     (2) beside it a narrow red bar "chain, Mandalay stores: 96%" with the note "about 2% of payments";
     (3) green "per-merchant SLOs, top 10" → "found: one old point-of-sale model". Narration: a per-customer
     SLO is the existing metric plus a customer label; now the alert names the merchant, so Padauk's
     account manager calls the chain before its stores complain; one number can hide a small group that
     suffers every day.
  7. **Lie 3: what we never promised.** Board B3 (P5), cleared: (1) monthly bars for the profile service at
     99.99% (blue) with a thin orange threshold "written: 99.5%"; (2) small boxes stacking above the bars,
     "teams built on it"; (3) a red bar "99.7%: Friday lunch outage". Narration: users build on the
     reliability you actually deliver, not the one you wrote (the implicit SLO); Hyrum's law says every
     behavior you can observe gets relied on, reliability included; it hurts both ways: when the shared
     operator gateway client suddenly got far more reliable, Top-up's nightly re-check job and Bill Pay's
     retry wrapper became wasted cost.
  8. **Make it explicit.** Page `l07_p05` (K2) "Make the promise explicit" · "Publish the SLO you mean" ·
     "Warn when you run far above" · "Announce changes before they land".
  9. **Where SLOs strain.** Page `l07_p06` (K2) "Where SLOs strain" · "They need countable pass or fail" ·
     "Wrong AI answers still return 200" · "Responses are all or nothing". Narration: SLOs are a means, not
     the goal; a strict SLO is not a badge of importance; build medium-sized responses on purpose, not only
     "page someone or do nothing".
  10. **This week.** Page `l07_p07` (K2) "This week" · "Write your top journey in users' words" · "Split one
      SLI by top customers" · "Find one place you over-deliver".
- **Recap (`notes.md`):** critical user journey · synthetic test order · bad minute · client-side SLO ·
  per-customer SLO · implicit SLO · **Question:** "30 days at 99.5% good minutes: how many bad minutes may
  the journey spend?" (216)
- **Bridge:** "Next: Top-up never confirms, users ask for refunds of top-ups that worked, and every
  dashboard is perfect. How do we see inside?"

### Lesson 8 · `sre-08-observability` · ≈ 11 min · deck SRE 2

**Monitoring ကနေ observability ဆီ** — _From monitoring to observability: seeing production clearly_

- **Prerequisites:** L06, L07 · **Borrowed terms:** critical user journey, SLO burn alert · **Pages:** 4 ·
  **Boards:** 5 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain how connected signals (metrics, logs, traces, profiles) answer new questions, and aim them at
     shortening the time to mitigate;
  2. catch success codes that hide failures with checks at the user's level, and pause changes on them;
  3. keep monitoring from sharing the fate of the app it watches;
  4. scale monitoring to dozens of services with generated dashboards and first checks that run
     themselves;
  5. control telemetry cost, cardinality and personal data, and alert on evidence rather than raw counts.
- **Padauk:** **Top-up never confirms**: Operator A renames a status field; Padauk's API still returns
  success, the app spins, users give up and buy scratch cards instead, then ask for refunds of top-ups that
  actually worked; every server signal looks perfect. It is the same kind of gap as the L01 loan: the
  system didn't check what the user actually got. **Monitoring dies with the app** on a festival night
  because it ran on the same cluster. **About 30 services**: hand-built dashboards no longer keep up.
  **The log bill**: national ID card (NRC) numbers in logs, and a `user_id` metric label.
  **Per-operator alerts**: 1 failure in 40 requests at 3 a.m. should not page; 240 failures in 20,000
  should.
- **Scenes:**
  1. **Hook.** Page `l08_p01` (K1) "Top-up never confirms" · "API: 200 OK · App: spinning" · "Refunds for
     top-ups that worked" · "Every dashboard looks perfect".
  2. **Monitoring vs observability.** Page `l08_p02` (K3) "Monitoring | Observability" · "Is it broken? |
     How, where, why?" · "Fixed dashboards | New questions anytime" · "Seniors' memory | Connected shared
     data". Narration: the goal is a shorter time until users are OK (time to mitigate), then a shorter time
     to notice (time to detect).
  3. **Connected signals.** Board B1 (P2, fan-in): (1) four blue boxes "metrics", "logs", "traces",
     "profiles" each `arrow-right` into a bus; (2) violet "one request's story"; (3) small text "latency ·
     traffic · errors · saturation". Narration: every signal carries the same labels (service, version,
     zone), the same trace ID and the code location, so we can ask where, which request and which code; the
     four golden signals are a start; OpenTelemetry is the open standard, and a tool choice lasts years.
  4. **Success that hides failure.** Board B2 (P1, vertical), cleared: (1) "tap Top-up" ↓ green "API: 200
     OK" ↓ "status field read"; (2) red "confirmation never shown"; (3) a green `check` beside it, "rule:
     paid → airtime shown". Narration: a check at the user's level catches what status codes miss;
     Padauk's own changes (a server release, a config push, an app release, a feature at 5%, a data push)
     pause by themselves when that check drops, which is prevention (Lesson 19 shows how); an alert on the
     journey SLO is detection; having both is defence in depth.
  5. **Don't share fate.** Board B3 (P6 lanes), cleared: (1) top lane, one box "cluster" holding "app" and
     "monitoring", both red; (2) bottom lane "app" in zone A (red), "monitoring" in zone B (green) and an
     "outside prober" (green) still alerting. Narration: fast, fresh signals feed alerts, and slower,
     complete data answers questions later; during an incident the freshest data comes first, and a
     partial picture beats none.
  6. **Thirty services.** Board B4 (P1), cleared: (1) blue "dashboards from the shared client"; (2) orange
     "alerts that fit each service's traffic"; (3) green "first checks run themselves; rollback offered".
     Narration: Thiri puts standard metrics into the shared operator gateway client and the HTTP and
     database libraries, so every service gets the same generated graphs, and the library's owner writes
     one alert for every service that uses it; when a Top-up alert fires, a script checks the usual
     suspects (last deploy, operator latency, database pool) and posts what it found in the incident
     channel, and if errors jump right after a deploy, the deploy rolls back by itself; alerts on causes
     such as "quota nearly full" stay alongside the alerts on user pain.
  7. **Telemetry has a bill and a duty.** Page `l08_p03` (K2) "Telemetry: a bill and a duty" · "Mask NRC
     numbers where logged" · "Suppose logs must stay in-country" · "Detail expires after 30 days".
     Narration: user IDs belong in logs and traces, which can hold them but cost more to search, never in
     metric labels, where every new value multiplies the bill; mark each field's class (an operator's
     error rate isn't personal; a log line with a phone number is) and carry that mark everywhere; a
     "Mandalay stores" number is really one merchant, so it isn't anonymous.
  8. **Alert on evidence.** Board B5 (P5), cleared: (1) a thin orange threshold "0.5% allowed"; (2) bar
     "Operator C, 3 a.m.: 1 of 40 failed" with an outline-only orange rectangle for its uncertainty, wide
     and crossing the line, green "no page"; (3) bar "Operator A: 240 of 20,000" with a narrow outline above
     the line, red "page". Narration: a fixed count fails in both directions; a per-minute average hides a
     5-second spike; better detection first looks like more failures.
  9. **This week.** Page `l08_p04` (K2) "This week" · "Find a success code hiding failure" · "Check where
     monitoring runs" · "Remove one high-cardinality label".
- **Recap (`notes.md`):** observability · golden signals · trace · shared fate · generated dashboard ·
  cardinality · evidence-based alert · **Question:** "Your monitoring runs on the same cluster as your
  app. What happens when the cluster dies?" (the alerts die with it)
- **Bridge:** "Module 3: the alert fires at 2 a.m. into a Viber group of 60 people who have all muted it.
  Who answers?"

## Module 3 — Respond and learn

Deck SRE 3 · lessons 9–13 · about 52 minutes · two production weeks. Padauk: about 40 engineers; Thiri
is still the only SRE, so each product team carries its own rotation, backed by a volunteer swarm. This
is the course's difficulty peak. Module map page `m3_map` (in L09): "Module 3 · Respond and learn" ·
"When it breaks: on-call and incidents" · "Afterwards: learn, then change the system". The loop's
Respond and Learn stations are lit.

### Lesson 9 · `sre-09-sustainable-on-call` · ≈ 10 min · deck SRE 3

**ရေရှည် လုပ်နိုင်တဲ့ on-call** — _On-call people can sustain, and who leads when it breaks_

- **Prerequisites:** L06 (burn-rate pages), L08 · **Borrowed terms:** burn-rate page, SLO · **Pages:**
  5 + map · **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. tell bug, incident and outage apart, and let anyone declare an incident;
  2. design a rotation per service by asking what is lost if a page waits until morning;
  3. explain what a fast response time costs the people on call, and keep the load sustainable;
  4. assign incident roles: incident commander, communications, operations, scribe;
  5. explain why the incident commander leads whatever their rank, and when to call a coordinator.
- **Padauk:** alerts go to a 60-person Viber group that everyone has muted, and the CTO gets called for
  everything. The fix is a rotation per service: Wallet 24 hours with a 5-minute response; Eats
  7:00–23:00; settlement business hours; the promo banner service never pages. Noisy alerts get fixed
  first; on-callers keep backup power and a second SIM. Five senior volunteers form a swarm for major
  incidents. Ma Su is thanked for a false alarm.
- **Scenes:**
  1. **Hook + map.** Page `l09_p01` (K1) "Who answers at 2 a.m.?" · "Alerts go to 60 people on Viber" ·
     "Everyone has muted it" · "The CTO gets every call", then `m3_map`.
  2. **Bug, incident, outage.** Board B1: (1) an orange ellipse "incident → organized response" with a red
     ellipse nested inside it, "outage → named responders, right now"; (2) a separate blue ellipse "bug →
     ticket" overlapping the incident ellipse; (3) a small label inside the incident ellipse but outside
     the bug ellipse, "Operator B slow". Narration: not every bug is an incident, and incidents also come
     from things that aren't bugs; the criteria are agreed in advance, anyone may declare, a downgrade
     costs nothing, and opening one takes a single Viber command with a default severity that can be
     corrected later; Ma Su is thanked for her false alarm.
  3. **Who answers?** Page `l09_p02` (K4) "Who answers the page?" · "The whole group: everyone waits" ·
     "One leader: a single point" · "A rotation: one named person".
  4. **The coverage clock.** Board B2 (P5, horizontal bars across a 24-hour `underline` axis), cleared:
     (1) green "Wallet: 24 h, 5 min"; (2) "Eats: 7–23" and "settlement: 9–17"; (3) orange "promo banners:
     never pages". Narration asks one question per service: "What does Wallet lose if this page waits
     until 7 a.m.?" A 5-minute response means a laptop everywhere and a handoff before the commute, with
     pages going to a primary and then a secondary; anything faster than about 3 minutes needs two people
     awake; a 30-minute response leaves room for normal life.
  5. **A rotation people can sustain.** Page `l09_p03` (K2) "A rotation people can sustain" · "About two
     incidents a shift, at most" · "Backup power and a second SIM" · "No schedule fits? Relax the target".
     Narration: too few pages also hurts, because skills fade; one cheap health check is to count last
     month's incidents that users found before our alerts did; never burn people to meet a target.
  6. **Incident roles.** Board B3 (P2, downward comb), cleared: (1) blue "incident commander" ↓ a thin
     horizontal bus; (2) ↓ "communications", "operations", "scribe"; (3) text "the IC leads, whatever their
     rank". Narration: when several teams are involved, the owner is unclear, or a decision is bigger than
     one team, Padauk calls a coordinator from a small company-wide rotation, who gets decisions made but
     doesn't fix things, and the owning team keeps the follow-up; very big incidents can put one
     coordinator above several team commanders.
  7. **When it's big.** Page `l09_p04` (K2) "When it's big" · "Senior volunteers, paged for majors" · "The
     IC leads, agreed beforehand" · "Share business context early". Narration: decisions by group consensus,
     or by the CTO, are slower; page the swarm early, but don't let it take every hard incident, or the
     product teams lose their own skills; swarm work counts at review time.
  8. **This week.** Page `l09_p05` (K2) "This week" · "Write down what counts as incident" · "Replace one
     group alert with a rotation" · "Agree who may be incident commander".
- **Recap (`notes.md`):** incident · outage · rotation · response time · incident commander ·
  **Question:** "A service pages its on-caller six times a night. What should change first?" (fix or
  silence the noisy alerts; then re-check the response target)
- **Bridge:** "Next: payday, 6:40 p.m., the Top-up burn-rate page fires and support says airtime isn't
  arriving. Where do you start?"

### Lesson 10 · `sre-10-working-an-incident` · ≈ 10 min · deck SRE 3

**Incident တစ်ခုကို အစကနေ အဆုံးထိ** — _Working an incident: the payday incident, minute by minute_

- **Prerequisites:** L09 · **Borrowed terms:** incident commander (one clause), burn-rate page ·
  **Pages:** 5 · **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. follow an incident from page to all-clear on its own timeline;
  2. triage from what users suffer, and let the size of the harm decide how bold to be;
  3. test several hypotheses in parallel, each owned by someone trying to prove it wrong;
  4. mitigate first with a generic toolbox, judge decisions by what was known at the time, and know when
     an incident is over;
  5. keep the response small and calm.
- **Padauk:** **the payday top-up incident**: an SLO page fires together with support tickets; the
  incident commander asks for Ma Su's first three facts; three hypotheses run at once (yesterday's
  release, the database pool, Operator A slow); a rollback rules the release out; switching to Operator
  A's backup endpoint mitigates; they wait and watch, then announce closure everywhere. Ko Min, a
  developer on Top-up, is asked to check Operator A's latency and report in 10 minutes, and spends most of
  those minutes looking for the right dashboard. **The Eats lunch outage with 25 people in the call**: a
  mid-level incident commander appoints a communications lead, moves redesign talk to the postmortem
  list, releases the extra people and turns off the promo banner over marketing's objection.
- **Scenes:**
  1. **Hook.** Page `l10_p01` (K1) "Payday, 6:40 p.m." · "Top-up burn-rate page fires" · "Support: airtime
     isn't arriving" · "Where do you start?"
  2. **The timeline.** Board B1 (P8 timeline): (1) the axis with ticks "18:40
     page + tickets" and "18:45 IC named"; (2) ticks "18:55 rollback: no change" and "19:05 switch to backup
     endpoint"; (3) tick "19:25 watched, then closed". Narration: this timeline is the spine of the lesson;
     the alert and the support tickets arrived together, and both count.
  3. **Ma Su's first three facts.** Page `l10_p02` (K4) "Ma Su's first three facts" · "Money taken, no
     airtime?" · "Which operator?" · "Growing or flat?" Narration: money is being taken on payday and the
     harm is growing, so the incident commander accepts a bolder fix; public severity scales such as
     PagerDuty's open incident-response guide are another way to size harm.
  4. **Several hypotheses at once.** Board B2, cleared: (1) "IC" at the top `arrow-down` into three cards
     "yesterday's release", "database pool", "Operator A slow"; (2) a `strike` on the first two; (3) a
     `check` on the third with an `arrow-right` to green "switch to the backup endpoint". Narration: each
     idea gets an owner who tries to prove it wrong, which guards against seeing only what we expect; only
     one change goes into production at a time, through the operations lead; testing one idea at a time
     (observe, orient, decide, act, and go round again) is slower, and with three people we test three;
     investigation serves the fix, not a hunt for one root cause.
  5. **Make users OK first.** Page `l10_p03` (K2) "Make users OK first" · "Roll back · add capacity ·
     restart" · "Move traffic · feature off · switch provider" · "Judge by what was known then". Narration:
     every fix is an experiment; a rollback only works if the old version can read the new data; doing
     nothing is also a choice; the incident is over when one of three is true: we know why and it won't come
     back, the bad change is rolled back and blocked from returning, or what's left can wait for normal
     work; then announce it on every channel.
  6. **The Eats lunch call.** Board B3 (P6 lanes), cleared: (1) red "25 people in the call" → green "IC +
     comms + operations + 3 experts"; (2) side labels "redesign ideas → postmortem list" and "basic
     questions → docs"; (3) "extra people → released". Narration: ask, page, then leave; in a big incident
     the commander takes no hands-on task and says aloud when new evidence changes an assumption; the promo
     banner goes off over marketing's objection.
  7. **Padauk's drill card.** Page `l10_p04` (K2) "Padauk's drill card" · "Say a name and a deadline" ·
     "Park redesign talk for later" · "Release people out loud". Narration: Padauk practises with a monthly
     30-minute role-play of a past incident; judgment grows by hearing experienced people think aloud;
     culture and structure come before tooling.
  8. **This week.** Page `l10_p05` (K2) "This week" · "Write your generic fix list" · "Role-play a past
     incident" · "Practise: 'Ko Min, check X by 7'".
- **Recap (`notes.md`):** triage · hypothesis · mitigation · wait and watch · outcome bias ·
  **Question:** "Two engineers want to push different fixes at the same time. What is the rule?" (one
  change at a time, through the operations lead)
- **Bridge:** "Next: a week later, Wallet charges some users twice during a promotion. How do we learn
  from it without blaming the person who wrote the change?"

### Lesson 11 · `sre-11-postmortems` · ≈ 10 min · deck SRE 3

**သင်ခန်းစာ ရတဲ့ postmortem** — _A postmortem meeting that teaches_

- **Prerequisites:** L05, L10 · **Borrowed terms:** blameless review, mitigation · **Pages:** 5 ·
  **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. build a postmortem around a shared timeline that includes the support side;
  2. ask about the situation, not the person, and spot hindsight and outcome bias;
  3. record what went wrong, what went right, and where the team got lucky;
  4. write action items with owners, reasons and real time, and get them closed;
  5. keep people accountable without blame, and review the customer's side.
- **Padauk:** Ko Min adds retries to a Wallet payment call during a promotion. Bank X slows, the retries
  charge some users twice, and refunds pile up. Padauk had put idempotency keys on its L01 loan list but
  built them only on the Top-up path, so the Wallet half was never repaid. A lead from the Eats team, who
  was not involved, runs the postmortem; Wallet and the Bank X integration owner write it together. A
  public post blamed Bank X before anyone knew, and nobody told users that refunds were automatic.
- **Scenes:**
  1. **Hook.** Page `l11_p01` (K1) "Charged twice during a promotion" · "New retries, and Bank X slowed" ·
     "Refunds, angry users, a long night" · "What do we learn?"
  2. **The meeting opens.** Board B1 (P8 timeline): (1) Ma Su reads the support side onto the axis: ticks
     "retry change deployed", "Bank X slows", "double charges start"; (2) ticks "support sees refunds",
     "alert", "mitigated"; (3) an orange `circle` on the gap between "double charges start" and "alert",
     "first chance to notice". Narration: the lead from Eats builds the timeline first and interviews
     support too; the timeline is shared before anyone asks why.
  3. **What made sense that night.** Page `l11_p02` (K3) "Not this | But this" · "Why add retries? | What
     was Bank X doing?" · "Why no idempotency key? | What did old code do?" Narration: Ko Min
     explains that retries looked safe because the Top-up path already had keys; if it made sense to him,
     it will make sense to the next person (local rationality).
  4. **"Obviously".** Board B2, cleared: (1) someone says "obviously", and two orange boxes appear on the
     left, "hindsight: it was obvious" and "outcome: bad result = bad decision"; (2) each `arrow-right` into
     red "blame comes back"; (3) a green box below, with an `arrow-down` from the red one, "what did he
     know then?" Narration: the lead names both biases in the room.
  5. **Wrong, right, lucky.** Page `l11_p03` (K4) "Wrong, right, lucky" · "Went wrong → fix it" · "Went
     right → make it default" · "Got lucky → stop relying on it". Narration: the refund job happened to
     run early that night (luck); a support macro written in minutes worked so well it became the default
     (right); a public example postmortem in the free first edition shows the same sections.
  6. **Padauk's action items.** Page `l11_p04` (K2) "Padauk's action items" · "Wallet idempotency keys: Ko
     Min + lead" · "Double-charge alert: Thiri, 2 weeks" · "Refund in an hour: support + Wallet".
     Narration: a quick patch left in place becomes new fragility; every item has an owner, a reason and
     real time, and gets closed; Ko Min co-owns the fix, which is accountability that repairs rather than
     punishes (restorative just culture, Dekker); a reviewer from another team checks that the actions
     would really shorten the next incident, and once a month Ko Nay Lin reviews the trends and one launch
     that went well.
  7. **The customer's side.** Board B3 (P6 lanes), cleared: (1) lane "we posted: 'Bank X problem'" → red
     "it was our retry"; (2) lane "refunds were automatic" → red "nobody told users" → orange "1,500
     calls". Narration: Ma Su's point: what we tell customers is part of the engineering, and it gets
     reviewed like code.
  8. **This week.** Page `l11_p05` (K2) "This week" · "Add 'went right' and 'got lucky'" · "Give every
     action an owner" · "Write up one near miss".
- **Recap (`notes.md`):** postmortem · timeline · local rationality · hindsight bias · outcome bias ·
  restorative accountability · **Question:** "Rewrite: 'Why didn't you check the logs?'" (for example:
  "What did the logs and dashboards show at that time?")
- **Bridge:** "Next: a payday near miss that nobody caused and luck saved. Why do complex systems fail
  like that?"

### Lesson 12 · `sre-12-how-complex-systems-fail` · ≈ 11 min · deck SRE 3 · deeper

**ရှုပ်ထွေးတဲ့ system တွေ ဘယ်လို ပျက်လဲ** — _How complex systems fail: near misses, drift, good days and cliffs_

- **Prerequisites:** L11 · **Borrowed terms:** near miss, blameless · **Pages:** 5 · **Boards:** 3 ·
  **Chars:** 8,400
- **Goals.** The learner can:
  1. contrast simple systems with complex ones, where people are part of the system;
  2. use the Swiss cheese model, with active failures and long-standing gaps, to explain a near miss, and
     say why "the root cause" is only where we stopped asking;
  3. recognize drift toward the edge of safety and push back early;
  4. learn from normal days that succeed, and turn a good trick into a tested tool;
  5. watch spare capacity, because a system can absorb losses quietly and then collapse.
- **Padauk:** **a payday near miss**: a config change points Top-up at Operator B's old test address;
  code review, a config check that never existed and the 5% canary all miss it; Ma Su catches it from
  angry Facebook posts, which was luck. **Six months of drift on the Wallet team**: skipping the soak
  period, disabling a slow test, raising connection limits, leaving one person on-call too often; the
  Thingyan-eve outage that follows has no single bad decision behind it. **A smooth payday studied**: one
  engineer's manual bank throttle becomes a tested tool. **The rider-location service**: it absorbs
  instance losses quietly, then falls off a cliff.
- **Scenes:**
  1. **Hook.** Page `l12_p01` (K1) "A near miss on payday" · "Config pointed Top-up at a test address" ·
     "Review, checks and canary missed it" · "Angry posts caught it: luck".
  2. **Two kinds of systems.** Page `l12_p02` (K3) "Simple | Complex" · "Parts explain the whole | Parts
     keep adapting" · "One chain of causes | Each part fine, whole fails" · "Fix the broken part | Change
     how parts interact". Narration: people are part of the system; models like the ones in this lesson are
     tools for thinking, not truths.
  3. **Swiss cheese.** Board B1: (1) four tall rectangles left→right, "code review", "config check", "5%
     canary", "support + alerts", each with small ellipses as holes; (2) a red line of `arrow-right` strokes
     passes three holes and stops at slice 4, labelled green "luck"; (3) labels on two holes, "active: the
     push" and "long-standing: no config check for months". Narration: James Reason's model from his public
     paper; which hole is "the root cause"? Any one of them is just the place we decided to stop asking,
     and the hole we pick depends on the model in our head; blaming the person who pushed is the weakest
     answer.
  4. **Drift toward the edge.** Board B2, cleared: (1) a row of short `arrow-right` strokes from "safe
     zone" toward a thin red vertical rectangle "unsafe"; (2) orange pressure labels "ship faster" and
     "easier ways"; (3) a green box left of the red line "safety work pushes back" and text by the line
     "postmortems react only here". Narration: Jens Rasmussen's drift model; the Wallet team's six months;
     Sidney Dekker's writing on drift describes the same slide from another angle; Padauk now holds a
     quarterly review of the shortcuts it calls normal.
  5. **Learn from good days.** Page `l12_p03` (K4) "Learn from days that went well" · "Safety-I: study
     failures" · "Safety-II: study normal success" · "Turn a good trick into a tool". Narration: Erik
     Hollnagel's public white paper; the smooth payday and the bank throttle.
  6. **Always partly broken.** Board B3 (P5), cleared: (1) for "servers down: 0 / 2 / 4", blue spare-
     capacity bars 40 / 20 / 0; (2) success shown as a `check` at 0 and 2 and a red `strike` at 4, "retry
     storm"; (3) label "watch the reserve, not only success". Narration in two parts: Richard Cook's point
     that some part is always degraded, so a disaster needs several failures at once; then David Woods's
     point that a system can absorb losses quietly and then fall off a cliff, which he calls
     decompensation.
  7. **Ready-made moves.** Page `l12_p04` (K2) "Ready-made moves" · "Drain, roll back, fail over, switch
     off" · "Fast and safe to press" · "Practised before you need them". Narration: to check that learning
     worked, compare later incidents of the same kind; one chain of causes misses failures that come from
     parts interacting, which is where Lesson 13 goes.
  8. **This week.** Page `l12_p05` (K2) "This week" · "List shortcuts your team calls normal" · "Study one
     good day" · "Track spare capacity, not only success".
- **Recap (`notes.md`):** complex system · Swiss cheese · near miss · drift · Safety-II · decompensation ·
  **Question:** "Name one hole in your own system that has been open for months." (open answer)
- **Bridge:** "Next: on payday, payroll and the fraud engine both worked as designed, and 2,800 wallets
  froze. Where is the root cause now?"

### Lesson 13 · `sre-13-stpa-and-cast` · ≈ 11 min · deck SRE 3 · deeper

**Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST** — _Beyond root cause: control loops, STPA before, CAST after_

- **Prerequisites:** L11, L12 · **Borrowed terms:** blameless, root cause (as a stopping point) ·
  **Pages:** 6 · **Boards:** 4 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain why a loss can happen with nothing broken, and why "before" is not "because";
  2. draw a control loop: controller, belief, action, feedback;
  3. run the four STPA steps on a design document;
  4. run CAST on an incident, drawing the control structure as it really was;
  5. start small: a first target and a team of two or three.
- **Padauk:** **hook**: on payday, payroll and the fraud engine both work as designed, yet 2,800 wallets
  freeze; the fraud rule had shipped the day before payroll. **STPA on the refund design**, which
  auto-refunds after 10 unconfirmed minutes: it finds refunds even though the operator's success message
  arrived late, and support plus the automatic job both refunding the same payment; the fixes are
  design-document edits (check the status first, only one refunder, idempotency keys, an alert on the
  hazard "balance mismatch"). **CAST on the frozen wallets**: support had no bulk unfreeze and no line to
  on-call, on-call had no alert for "many wallets frozen", the fraud dashboard counted "2,800 blocked" as
  a success, and nobody owned how payroll and fraud rules interact.
- **Scenes:**
  1. **Hook.** Page `l13_p01` (K1) "Nothing broke. 2,800 wallets froze." · "Payroll worked as designed" ·
     "Fraud engine worked as designed" · "Together: salaries frozen on payday".
  2. **Worked as designed.** Board B1: (1) two blue boxes "payroll batch" and "fraud engine", each with a
     green `check` "as designed"; (2) both `arrow-down` into red "2,800 frozen wallets"; (3) a short P8
     strip "fraud rule: Thursday" → "payroll: Friday" with the label "before ≠ because". Narration: safety
     emerges from how parts interact; Nancy Leveson's STAMP model says losses come from inadequate control,
     and errors by people or software are symptoms of it; a chain of events can't show this.
  3. **A control loop.** Board B2 (P3 ring), cleared: (1) nodes "controller" → "action" on the track; (2)
     "process" → "feedback" back to the controller; (3) an orange ellipse on the controller "belief (can be
     wrong)".
  4. **Every controller has…** Page `l13_p02` (K4) "Every controller has…" · "A job and decision rules" ·
     "A belief that can be wrong" · "Feedback that updates the belief". Narration: the example of on-call
     moving traffic while the dashboard runs two minutes late; people at the edge of automation inherit its
     hardest cases.
  5. **STPA in four steps.** Page `l13_p03` (K6) "STPA in four steps" · "Losses" · "Controls" · "Unsafe
     actions" · "Causes". Narration: an action can be unsafe in four ways (missing, wrong, too early or too
     late, going on too long); STPA works on a paper design or a running system, before any incident.
  6. **The refund design.** Board B3, cleared: (1) the structure: "support agent" and "auto-refund job" each
     `arrow-down` to "wallet ledger", and "operator callback" with `arrow-down` labelled "late feedback";
     (2) red tags "refund after late success" and "both refund"; (3) cleared and redrawn as furniture, then
     green "check status first", "one refunder", "idempotency key" and orange "alert: balance mismatch".
     Narration: the hazard alert fires before the loss reaches users; a design-document fix is one
     paragraph, while the same fix in production takes a team and data repairs.
  7. **CAST on the frozen wallets.** Board B4, cleared: (1) the structure as it really was: "payroll batch"
     → "fraud engine" → red "frozen wallets"; (2) "support: no bulk unfreeze, no line to on-call" and
     "on-call: no alert on frozen wallets"; (3) orange "payroll × fraud rules: owner? nobody". Narration:
     draw the structure as it actually worked, not as the org chart says; gaps and overlaps in ownership are
     where causes hide; the fraud dashboard counted 2,800 blocks as success, so its feedback measured the
     wrong thing.
  8. **CAST, step by step.** Page `l13_p04` (K6) "CAST, step by step" · "Loss and questions" · "Real
     structure" · "Local reasons" · "Shared factors" · "Traced plan". Narration: no blame and no
     conclusions yet; the timeline only raises questions; each local fix leads to a system question (who
     owns how rules interact? why could support not reach on-call?); every recommendation traces back to a
     factor; ask of each one: would it stop similar incidents, or only this one? Controls weaken as a
     company grows.
  9. **The shift.** Page `l13_p05` (K3) "Before | After" · "Respond fast | List losses, fix worst" · "Find
     the root cause | Fix factors and structure" · "Blameless | Blameless and analytical". Narration: our
     drills and fault tests start by breaking something, while STPA finds losses where nothing breaks and
     tells us which fault test to run next (Lesson 19); after an incident CAST is cheaper, while STPA looks
     wider; start small: two or three people, one design doc, and a first target that has surprised
     people before.
  10. **This week.** Page `l13_p06` (K2) "This week" · "Read a postmortem: where did it stop?" · "Draw one
      control loop" · "Try STPA on a design doc".
- **Recap (`notes.md`):** control loop · hazard · unsafe control action · STPA · CAST · **Question:** "The
  fraud dashboard showed 'blocked: 2,800' as good news. Which part of the control loop failed?" (the
  feedback)
- **Bridge:** "Module 4: Thiri has carried every one of these incidents alone. Who should Padauk hire, and
  how do newcomers learn without drowning?"

## Module 4 — People and teams

Deck SRE 4 · lessons 14–16 · about 33 minutes. Padauk: about 40 engineers; after the payday incident and
the frozen wallets, Ko Nay Lin funds a reliability team, and Thiri hires and onboards its first members.
Learners now know SLOs, on-call and incidents, so the people questions have something to stand on. Module
map page `m4_map` (in L14): "Module 4 · People and teams" · "The people in the middle of the loop" ·
"Who we hire, where they sit, how we work with others". The loop's hub is lit.

Every lesson here is told through a Padauk person facing a decision, and every "This week" works for an
individual developer too.

### Lesson 14 · `sre-14-becoming-an-sre` · ≈ 11 min · deck SRE 4

**SRE တစ်ယောက် ဖြစ်လာဖို့** — _Becoming an SRE: skills, onboarding, and a team that survives people leaving_

- **Prerequisites:** L05, L09, L10 · **Borrowed terms:** on-call rotation, toil · **Pages:** 7 + map ·
  **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. describe the technical and mindset traits of a good SRE, and T-shaped skills;
  2. plan onboarding as a staircase toward on-call, sized to the company's growth;
  3. write learning goals as actions a newcomer can show, not topics;
  4. balance planned work and interruptions, and keep people from being single points of failure;
  5. choose their own next step as an SRE.
- **Padauk:** one SRE is not a team: Thiri has carried every incident alone since Lesson 6. A
  developer-leaning candidate and Ko Zaw, a former bank systems administrator, clear one hiring bar in
  different ways; a nine-week process lost another good candidate. In the payday incident Ko Min spent his
  10 minutes looking for the operator dashboard; Thiri won't let the next person learn that way, so Ko Min
  goes through a real onboarding path, and his starter project is that missing per-operator dashboard. Ko
  Aung is paired with Ko Zaw, and split day/night shifts are offered.
- **Scenes:**
  1. **Hook + map.** Page `l14_p01` (K1) "Padauk's first SRE job post" · "Thiri has carried every incident"
     · "Who should Padauk hire?" · "How do newcomers learn safely?", then `m4_map`.
  2. **A good SRE.** Page `l14_p02` (K4) "A good SRE…" · "Codes and designs from fundamentals" · "Debugs
     with hypotheses, sees patterns" · "Dislikes toil enough to automate". Narration: SREs think in risks;
     they write code, but not all day: Thiri spent a week convincing Operator B's team, and the change
     itself was three lines.
  3. **Two ways to clear the bar.** Board B1 (P5): (1) two stacked bars reaching a thin orange "hiring
     bar": bar 1 a tall blue "software" segment and a short violet "systems" segment, bar 2 (Ko Zaw) the
     reverse; (2) a red struck-out bar "trivia questions"; (3) a T built from two rectangles, "breadth"
     across and "depth" down. Narration: the same bar as developers, met in different ways; a slow hiring
     process loses good people (nine weeks lost one).
  4. **The onboarding staircase.** Board B2 (P7), cleared: (1) steps "docs + checklist" → "starter
     project" → "whiteboard talk"; (2) steps "shadow" → "reverse shadow" and a green top "on-call"; (3) a
     violet "mentor" bar under the stairs and an orange label "small + growing fast → a real program".
     Narration: sink or swim fails, as the payday incident showed; a small, stable team can lean on a
     buddy, but Padauk is small and growing fast, so it builds a real program; no outside course teaches
     Padauk's ledger, so the team teaches its own systems, and nobody memorizes everything: they know where
     to look; the newcomer fixes the stale docs they find; mentor hours cost something, but people reach
     on-call sooner and fewer leave in their first year.
  5. **Goals you can check.** Page `l14_p03` (K3) "Vague goal | Goal you can check" · "Understand
     monitoring | Find failures per operator" · "Know the deploy tool | Roll back a release". Narration:
     every line of Ko Min's on-call checklist is an action he can show; anything that serves no line is
     cut.
  6. **Ko Min's starter project.** Page `l14_p04` (K2) "Ko Min's starter project" · "A per-operator failure
     dashboard" · "Mentor: Thiri · demo in 4 weeks" · "Used in the next incident". Narration: why this one
     and not the settlement redesign (it needs the bank's sign-off) or the refund clean-up (it only repeats
     hand-work and teaches nothing new); let learners say what makes it a good first project.
  7. **Planned work and interruptions.** Page `l14_p05` (K3) "Planned work | Interruptions" · "Things that
     last | Pages, tickets, reviews" · "Protect focus time | Keep under half". Narration: feeling like an
     impostor is normal for new SREs, and concrete goals help.
  8. **People redundancy.** Board B3 (P6 lanes), cleared: (1) top lane "settlement job" tied to one name
     "Ko Aung", red "single point of failure"; (2) bottom lane the same job tied to "Ko Aung + Ko Zaw" in
     green, with a 24-hour bar split "day | night". Narration: it can take up to a year to get someone ready
     for on-call, so losing people is expensive, and on-call is one of the main reasons people leave;
     flexible on-call (split shifts, swaps) keeps them.
  9. **Growing, the Padauk way.** Page `l14_p06` (K2) "Growing, the Padauk way" · "Learn a neighbouring
     system quarterly" · "Own one fix end to end" · "Teach it back in 10 minutes". Narration: practise one
     system design with real numbers (estimate Thingyan's top-up peak), read one public postmortem a week,
     and practise writing and explaining; becoming a manager is not the only way up.
  10. **This week.** Page `l14_p07` (K2) "This week" · "Write an on-call checklist of actions" · "Draw your
      system for a teammate" · "Pair someone with your only expert".
- **Recap (`notes.md`):** T-shaped skills · starter project · shadow / reverse shadow · planned work vs
  interruptions · N+1 for people · **Question:** "Rewrite 'learn Kubernetes' as a goal you can check."
  (for example: "deploy and roll back one service on our cluster")
- **Bridge:** "Next: Ko Zaw starts on Monday. Two SREs are still not a rotation. Where should they sit,
  and what should they own?"

### Lesson 15 · `sre-15-where-sre-lives` · ≈ 11 min · deck SRE 4

**SRE အဖွဲ့ကို ဘယ်မှာ ထားမလဲ** — _Where SRE lives: team placement, limits on ops work, and honest scorecards_

- **Prerequisites:** L09, L14 · **Borrowed terms:** rotation, toil, Goodhart's law (one clause) ·
  **Pages:** 7 · **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. measure when a service has outgrown "you build it, you run it", and what a charter gives a new team;
  2. weigh central vs embedded SRE, say when each fits, and spot the drift into shadow SRE;
  3. apply limits on ops work as ceilings and estimate the smallest workable on-call team;
  4. decide how much SRE help a service gets from how bad and how frequent its failures are;
  5. explain why scorecards help, how they mislead, and how to review them without rankings.
- **Padauk:** Ko Zaw starts, but two people are still not a rotation and Thiri still can't take leave.
  Padauk measures the production work each team carries per sprint, then forms a 3-person team (Thiri, Ko
  Zaw and one more) with a charter scoped to Wallet and Top-up; Eats developers keep their own pager with
  SRE-built tools. Eats had waited two weeks for help, quietly hired its own ops person and bought a second
  monitoring tool. An "incidents per month" ranking backfires: one team stops declaring small incidents.
- **Scenes:**
  1. **Hook.** Page `l15_p01` (K1) "Two SREs are not a rotation" · "Ko Zaw starts Monday" · "Thiri still
     can't take leave" · "Where should they sit?"
  2. **Where the pain is.** Board B1 (P5): (1) red bars "sprint hours lost to production work": Wallet 30,
     Top-up 26, Eats 8; (2) a thin orange threshold "a quarter of the sprint"; (3) a blue label over
     Wallet and Top-up "outgrew 'you build it, you run it'". Narration: habit hides the moment a service
     outgrows its team's own on-call, so Padauk measures it; a separate reliability group keeps its focus
     when feature priorities change every quarter.
  3. **The central–embedded slider.** Board B2, cleared: (1) a long thin rectangle as the slider, left end
     "central: shared standards", right end "embedded: product context"; (2) a violet ellipse knob in the
     middle "hybrid"; (3) an `arrow-down` from the knob into a red box "drift too far: shadow SRE".
     Narration: Eats's unofficial ops person and second tool are shadow SRE, usually born when official help
     is too slow; systems copy how teams talk (Conway's law): Eats and Wallet never talked, so Eats wrote its
     own payment retry code, and where Padauk puts its reliability people will show up in its systems for
     years.
  4. **Central vs embedded.** Page `l15_p02` (K4) "Central vs embedded" · "Central: consistent; risk: ticket
     desk" · "Embedded: context; risk: duplicate tools" · "Hybrid: central help + dedicated SREs".
     Narration: central suits low trust or few experienced SREs; embedded needs trust both ways and enough
     seniors; to hold the middle, Padauk runs a monthly reliability guild whose work counts in reviews, one
     standard way to ask SRE for help (next lesson), and someone who keeps cross-team plans moving.
  5. **Keep ops work in check.** Page `l15_p03` (K4) "Keep ops work in check" · "At least half on
     engineering" · "At most a quarter on-call" · "Nights at one site: about 8". Narration: these are
     ceilings, not targets, and healthy teams sit well below them; ideally the person on call absorbs the
     ops work, about one person's share in eight; the charter states the mission, a scope of services still
     being actively built, and measurable success with dates.
  6. **Change the org like a canary.** Page `l15_p04` (K2) "Change the org like a canary" · "Wallet and
     Top-up go first" · "Watch incidents and a monthly survey" · "Expand only if it works". Narration: expect
     a dip first, because people lose context and habits resist; reorganizing costs real time.
  7. **How much help does a service get?** Board B3 (P5, two-axis placement), cleared: (1) axes "how bad is
     a failure?" and "how often does it break?"; (2) "Wallet" (bad, often), "Eats" (medium, often) with an
     `arrow-right` "after its incidents", and "staff grocery pilot" (low, rare: low help by choice); (3)
     "old scratch-card vouchers" with an `arrow-down` "steps down". Narration: help can go down as well as
     up; moving a service up takes years of work and it can slide back; this sets how much SRE a service
     gets, never a grade.
  8. **Scorecards: useful, but…** Page `l15_p05` (K2) "Scorecards: useful, but…" · "One shared number ends
     arguments" · "Proxies get gamed" · "Rankings hide problems". Narration: scorecards turn a feeling into
     a number everyone reads the same way, and what nobody measures quietly gets worse; but the "incidents
     per month" ranking made one team stop declaring small incidents (Goodhart's law).
  9. **Padauk's review rule.** Page `l15_p06` (K2) "Padauk's review rule" · "Numbers open a conversation"
     · "The team explains its numbers" · "Nobody is ranked". Narration: DORA's public guidance also warns
     against using delivery numbers to compare teams; structure and culture feed each other, and a safe
     review matters more than any single number.
  10. **This week.** Page `l15_p07` (K2) "This week" · "Write a three-line reliability charter" · "Measure
      your production-work hours" · "Check one metric for gaming".
- **Recap (`notes.md`):** Conway's law · charter · limits on ops work · shadow SRE · scorecard · Goodhart's
  law · **Question:** "Five people cover nights at one site. What does this lesson suggest?" (too few:
  aim for about 8, or narrow the hours)
- **Bridge:** "Next: Bill Pay asks Thiri's three-person team to carry its pager. What should SRE take on
  instead?"

### Lesson 16 · `sre-16-engagement-models` · ≈ 11 min · deck SRE 4

**Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ** — _Working with product teams: outcomes instead of carrying the pager_

- **Prerequisites:** L06, L07, L15 · **Borrowed terms:** SLO, Hyrum's law, handback (from L03) ·
  **Pages:** 7 · **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. write a short engagement agreement: owners, outcomes, on-call, how it ends;
  2. compare SRE team shapes and the trap each falls into;
  3. replace pager-centred support with ranked outcomes, time-boxed joint efforts and shared on-call, and
     plan a cooperative handback;
  4. set a new product's SLO at design time and let it shape the design;
  5. adjust for business customers: one customer's trust, hidden promises, telling them first.
- **Padauk:** Bill Pay asks SRE to carry its pager. Instead the leads rank outcomes from Bill Pay's own
  pain: no payment stuck "pending" after a biller timeout, the due-date reminder spike doesn't slow
  Wallet, a receipt within one minute, vendor file errors caught before 6 a.m. They staff the top two as
  8–10-week joint efforts and re-rank each quarter. Bill Pay developers stay first on call for the app;
  SRE takes the pages for the shared database and the biller gateway. A reordered column in the daily
  settlement file breaks the supermarket chain's import script while every SLO is green. Ma Hnin sets the
  rider-matching SLO before any code is written. An orphaned Thingyan lucky-draw service is handed back to
  its team.
- **Scenes:**
  1. **Hook.** Page `l16_p01` (K1) "'Please carry our pager'" · "Bill Pay wants full SRE support" ·
     "Thiri's team has three people" · "What should SRE take on?"
  2. **The agreement.** Page `l16_p02` (K2) "An engagement says…" · "Who owns what; which outcomes" · "How
     we share on-call" · "When and how it ends". Narration: what older ways of working taught: a big review
     before SRE takes a service means SRE arrives late, when changing the design is expensive; once SRE
     holds a team's pager, the arrangement is hard to end and developers stop learning production; support
     levels defined by who carries the pager make every team want the pager level, which is exactly Bill
     Pay's request; reviewing every launch costs more with every launch, faster than SRE can grow.
  3. **Team shapes and their traps.** Page `l16_p03` (K4) "Team shapes and their traps" · "Kitchen sink:
     on-call for everything" · "Embedded: alone, drifts apart" · "Consulting: little context". Narration:
     three more shapes (product, infrastructure, tools) and the mix most companies end up with; Padauk's
     likely future mix: product SRE on Wallet, embedded SRE in rider tracking, infrastructure SRE on the
     shared cluster, office hours for the rest; renaming the ops team "SRE" changes nothing if nobody writes
     code.
  4. **Bill Pay's outcomes.** Board B1, cleared: (1) a column of four ranked cards: "no payment stuck
     'pending'", "reminder spike doesn't slow Wallet", "receipt within 1 minute", "file errors caught by 6
     a.m."; (2) a thin red bar under card 2, "SRE capacity", and `arrow-right` from cards 1–2 to "8–10-week
     joint efforts"; (3) a violet base bar under the column "always on: postmortem review, office hours,
     big-incident help" and the label "re-rank every quarter". Narration: one SRE is the accountable tech
     lead for the engagement, and reactive work is shared across both teams; the always-on basics stay even
     for teams with no effort staffed.
  5. **Who carries which pager.** Board B2 (P6 lanes), cleared: (1) top lane "design" → "launch" →
     "developers move on" → red "SRE stuck with the pager"; (2) bottom lane green "planned handback: date +
     runbook + training + office hours stay". Narration: Padauk's decision for Bill Pay (developers first
     for the app, SRE for the shared database and biller gateway); developers stay reachable at night
     because only they know what changed in today's release; this planned handback differs from Lesson 3's,
     where the pager goes back because a service keeps missing its SLO; the orphaned lucky-draw service
     goes back this planned way.
  6. **An SLO before any code.** Board B3 (P1), cleared: (1) "SLO first: 95% matched in 45 s"; (2) "design
     to it: queue, order key, photos off at peak"; (3) "v1 ships with dashboard, runbook, rollback".
     Narration: Ma Hnin sets the rider-matching SLO at design time, when changing the architecture is
     cheapest; it starts lower than Wallet's because riders want the feature soon, and Ma Hnin and Thiri
     write down why and when they will raise it; Thiri prices the last dinner-peak slowdown in lost orders
     and refunds, and writes its postmortem for Ma Hnin as the main reader; these "how well" requirements
     are called nonfunctional requirements, and SRE speaks up for them.
  7. **Questions we stopped answering.** Page `l16_p04` (K2) "Questions we stopped answering" · "Count
     SRE's Viber questions weekly" · "Turn the top three into checks" · "Next month, they stop coming".
     Narration: Thiri adds the top three to the golden-path template; this is how SRE moves from gatekeeper
     to helper.
  8. **When one customer matters a lot.** Page `l16_p05` (K2) "When one customer matters a lot" · "One
     complaint can be an outage" · "They rely on unpromised behavior" · "Tell their account manager first".
     Narration: the settlement file's reordered column broke the chain's import script while every SLO was
     green (Hyrum's law again, from Lesson 7), so Padauk adds a per-merchant "old file format" setting; with
     millions of consumers you roll back first, but with one big customer you also talk first.
  9. **Bill Pay now and next year.** Page `l16_p06` (K3) "Bill Pay: now | Next year" · "SRE fights its
     fires | Its team runs it" · "Deep help, one product | Shared checks for everyone" · "Success: no outage
     | Success: on-time, fewer refunds". Narration: firefighting is a fair place to start but not the place
     to stay; deep help on one product and wide help across all of them work together.
  10. **This week.** Page `l16_p07` (K2) "This week" · "Write your engagement in five lines" · "Rank three
      outcomes, not tasks" · "Agree who gets which pages".
- **Recap (`notes.md`):** engagement · outcome · shared on-call · planned handback · nonfunctional
  requirement · Hyrum's law · and four questions to ask of any engagement: does it keep us on reliability,
  buy the business the most, stop us drowning, and make working together easy? · **Question:** "Bill Pay
  asks again for SRE to carry its whole pager. What do you offer instead?" (ranked outcomes, a joint
  effort, shared on-call with a planned end)
- **Bridge:** "Module 5: the reliability team has four people now, and a toil audit says half their week
  is hand-work. Where do they start?"

## Module 5 — Build it in

Decks SRE 5A (lessons 17–19), SRE 5B (20–22) and SRE 5C (23–25) · about 96 minutes · three production
weeks. Padauk: about 55 engineers and a 4-person reliability team (L17–L22), then about 60 engineers and a
4–5-person platform and reliability group (L23–L25), with growth in Mandalay. Module map page `m5_map`
(in L17, deck 5A only): "Module 5 · Build it in" · "Turn every lesson into a system" · "Toil, tests,
capacity, data, design, platform". The loop's Build in station is lit.

### Lesson 17 · `sre-17-toil-and-automation` · ≈ 11 min · deck SRE 5A

**Toil နဲ့ automation** — _Toil and automation: what to automate, and how to do it safely_

- **Prerequisites:** L03 (toil, the ceiling), L08 (alert quality), L10 (mitigation) · **Borrowed terms:**
  toil, the ceiling on ops work · **Pages:** 5 + map · **Boards:** 5 · **Chars:** 8,400
- **Goals.** The learner can:
  1. separate toil from hard but valuable engineering, and explain how toil feeds on itself;
  2. measure toil and alert quality, and set a toil target the way they would set an SLO;
  3. decide whether to automate from cost against savings, plus what the arithmetic misses;
  4. avoid the automation traps (lost skills, surprise actions, hiding a broken design) with safe defaults
     and guards;
  5. let automation earn trust with a track record, decided action by action on an action card.
- **Padauk:** **toil audit**: 55% of the team's time is toil and only 11 of 70 pages needed action; target
  35%. **Morning top-up reconciliation**: a 25-minute daily spreadsheet check; the naive estimate is about
  456 hours saved against about 188 to build, but operators change their file format twice a year, which
  pushes the real cost to about 368; what decides it is the money at risk, the early-morning pain, and in
  the end a settlement API with the operators that removes the task. **Promo SMS**: an empty segment and
  city mean "every registered user", so about 3 million SMS go out at 2 a.m. **The rider-dispatch
  watchdog** restarts a leaking service. **The Top-up failover bot** earns the right to act alone, for one
  operator only.
- **Scenes:**
  1. **Hook + map.** Page `l17_p01` (K1) "Half the week is gone" · "Toil audit: 55% hand-work" · "Only 11
     of 70 pages needed action" · "Where do we start?", then `m5_map`.
  2. **Sorting board.** Board B1, two columns: (1) red "toil": "rerun settlement", "approve merchants by
     hand", "restart stuck worker"; (2) blue "engineering": "post-outage fix + tests", "security policy",
     "one-time migration". Narration: toil is fine when it is temporary and planned; re-queuing stuck orders
     by hand during an incident is fine for hours or days, not weeks; warning signs are toil that fills a
     gap in the product, and toil that grows faster than the team.
  3. **Toil feeds on itself.** Board B2 (P3 ring), cleared: (1) "toil" → "no time for fixes"; (2)
     "burnout" → "people leave"; (3) back to "toil", labelled "more toil each". Narration: this is why 55%
     is a business problem, not a mood problem.
  4. **Treat toil like an SLO.** Page `l17_p02` (K2) "Treat toil like an SLO" · "Measure: one week of
     logging" · "Target: 35%, trending down" · "Fix pages nobody acts on". Narration: a page must be
     something its receiver can act on, so if the action is "tell the payments team", page the payments
     team; declaring a toil emergency adds pressure, not people, one "toil person" burns out and hides the
     pain, and handing it to the newest hire isn't onboarding, so big toil gets a funded project and fixing a
     whole class of tickets counts like shipping a feature.
  5. **Why automate?** Page `l17_p03` (K4) "Why automate? More than minutes" · "Routine hours on normal
     days" · "Minutes that matter in outages" · "Same steps every time". Narration: 99.99% a month allows
     about 4 minutes of outage, less than it takes a person to wake up and log in; the cheapest start is a
     small incident bot that opens the channel and the incident doc, names the roles and records the
     timeline, so the postmortem is half written.
  6. **Break-even.** Board B3 (P5), cleared: (1) three yearly groups: green "hours saved" rising, blue
     "build + upkeep" beside them; (2) an orange extra segment "format changes" pushing break-even later;
     (3) a thin red vertical rectangle "system retired". Narration: the reconciliation numbers; the
     spreadsheet forgets two costs: the guards a powerful tool needs (caps, checks, a stop switch), and the
     wrong actions a tool takes when it acts on a fuzzy signal; Padauk did it by hand first to learn the
     edge cases, then scripted it with a person checking the result, then automated it for the team, and
     the best answer was the settlement API that removed the task; stopping at "script plus a person"
     forever gives neither consistency nor scale, so finish the last, messiest part.
  7. **Automation can hurt.** Page `l17_p04` (K4) "Automation can hurt" · "People lose the rare, hard
     skill" · "It surprises; nobody sees why" · "It hides a broken design". Narration: Lisanne Bainbridge
     noticed in 1983 that taking over from failing automation is harder than doing the job by hand, and that
     people are poor at watching for rare events; Eats dispatch leaks memory, and a watchdog restarts it at
     85%: once a day is a fair trade while the real fix takes weeks, but at the Thingyan promotion it
     restarts every 40 minutes, drops rider assignments, and the dashboard stays green; when restarts happen
     more often than deploys, fixing the leak goes to the top of the list.
  8. **Missing input means do nothing.** Board B4 (P6 lanes), cleared: (1) a `send-promo` box with "segment
     = (empty)", then red lane "empty = every registered user" → "3 million SMS at 2 a.m."; (2) green lane
     "empty = refuse" → "clear error"; (3) orange guards "cap · rate limit · dry run · explicit --all ·
     stop and ask a human". Narration: before acting, a tool asks "would this make things worse?"; a
     confusing tool is an outage waiting to happen.
  9. **The failover bot's action card.** Board B5, cleared: (1) two bars "40 nights of suggestions": green
     "38 right", red "2 wrong"; (2) card row "switch Operator A to backup" → green mode "acts, then tells";
     (3) card row "switch back to Operator B" → orange mode "asks first, always". Narration: Padauk's action
     card lists each action with its mode (suggests, asks first, acts then tells, or never), how to undo it,
     and when it must stop; the bot earned "acts, then tells" for one operator with a record, not a date;
     some steps stay human on purpose (switching back, and a restore never starts from an alert alone,
     because one monitoring glitch could fire every alert at once); the bot has its own logs and dashboard.
  10. **This week.** Page `l17_p05` (K2) "This week" · "Log one week of toil" · "Make one script refuse
      empty input" · "Start with the quickest win".
- **Recap (`notes.md`):** toil · toil target · safe default · ironies of automation · action card ·
  **Question:** "A task takes 20 minutes every day; automating it costs 80 hours. Roughly when does it pay
  back?" (about 8 months, before upkeep)
- **Bridge:** "Next: all the tests are green, yet Operator A gets zero traffic after someone edits a
  config in a console. What did the tests never look at?"

### Lesson 18 · `sre-18-testing-and-config` · ≈ 10 min · deck SRE 5A

**Test နဲ့ config** — _What tests prove, and config as dangerous as code_

- **Prerequisites:** L07 (journeys), L08 (alerts), L17 · **Borrowed terms:** critical user journey,
  canary (one clause) · **Pages:** 5 · **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. explain testing as finding where our picture of the world is wrong, and why a pass proves little;
  2. map the test types, and choose repeatable tests or real-world checks;
  3. turn every bug and every alert into a test;
  4. ask three questions of any config change and run three levels of config checks;
  5. detect and fix configuration drift without making it worse.
- **Padauk:** an engineer edits the top-up routing config in a console and Operator A's traffic weight
  becomes 0. Padauk moves routing config into Git with a safe default and adds syntax, meaning and dry-run
  checks. A later deploy undoes an uncommitted incident fix (drift); the first answer is a nightly diff.
- **Scenes:**
  1. **Hook.** Page `l18_p01` (K1) "Tests green. Operator A got zero traffic." · "Someone edited routing in
     a console" · "The weight became 0" · "No test looked at config".
  2. **What a test proves.** Page `l18_p02` (K2) "What a test proves" · "A pass: imagined cases still work"
     · "A failure: a real problem" · "Many outages: one wrong assumption".
  3. **Test map.** Board B1 (P1, English labels): (1) "unit" → "integration" → "smoke"; (2) → "canary" →
     "fault"; (3) a blue label over the left end "repeatable" and an orange label over the right end "real
     world: final check". Narration: smoke tests walk the key journeys; on an existing system start with
     payments, then the APIs others call and the APIs you call; the familiar test pyramid shows how many
     tests sit on each layer, not which ones protect users; performance decays slowly unless something
     tests it.
  4. **Two habits.** Page `l18_p03` (K2) "Two habits" · "Every bug: failing test first" · "Every alert: a
     test of its cause" · "Red builds get fixed".
  5. **Padauk's config questions.** Page `l18_p04` (K4) "Three questions for any config" · "Could anyone
     see it change?" · "Could we undo it in one step?" · "Did any check run?" Narration: config is as
     dangerous as code; the public OpenGitOps principles (declared, versioned, pulled automatically, kept in
     sync) are the reference; Padauk's routing config moves into Git with a safe default.
  6. **Config checks.** Board B2 (P6 lanes), cleared: (1) top lane "syntax" → "meaning" → "dry run" →
     green "rollout"; (2) Padauk's meaning checks under "meaning": "weights add to 100", "no operator at 0,
     06:00–24:00", "fee +20% → second approver"; (3) bottom lane red "emergency push" with orange "skips
     review; keeps syntax check + log". Narration: an emergency code push works the same way: the tests it
     skipped still run right after it, and a failure marks that push as broken so the next fix starts from
     the truth; if break-glass is used every week, it runs a quick subset of tests by itself.
  7. **Drift.** Board B3, cleared: (1) two boxes "Git: weight 50" and "live: weight 70 (hand fix)", red
     "next deploy undoes the fix"; (2) cleared, a P1 strip "keep with code (small team)" → "detect in CI" →
     "alert, kept trusted" → "auto-sync from Git"; (3) an orange note on the last box "only with strong
     checks before merge". Narration: which one is right, 50 or 70? After drift, nobody knows for sure;
     drift alerts tend to get noisy and ignored, so keep them trusted; automatic syncing also pushes a bad
     commit everywhere.
  8. **This week.** Page `l18_p05` (K2) "This week" · "Find config changed without review" · "Turn your last
     bug into a test" · "Compare live config with Git".
- **Recap (`notes.md`):** repeatable test · smoke test · config check · drift · **Question:** "Name one
  config value in your system that could be set to 0 and take you down." (open answer)
- **Bridge:** "Next: pricing's canary passes, yet Bill Pay starts timing out. Whose side were we
  watching?"

### Lesson 19 · `sre-19-testing-in-production` · ≈ 10 min · deck SRE 5A

**Production ထဲမှာ စမ်းသပ်ခြင်း** — _Testing in production: canaries, fault experiments and game days_

- **Prerequisites:** L18 · **Borrowed terms:** SLO, soft dependency (one clause) · **Pages:** 4 ·
  **Boards:** 4 · **Chars:** 7,600
- **Goals.** The learner can:
  1. run a canary as a comparison against a baseline, with small steps and bake time;
  2. catch rollouts that hurt their callers by splitting callers' numbers by serving version;
  3. design a fault experiment from a steady state and a hypothesis;
  4. keep soft dependencies soft with scheduled fault tests;
  5. plan a game day and scale experiments up step by step.
- **Padauk:** pricing v8 adds about 600 ms to each fee lookup. Pricing's own canary passes, and v8 serves
  only 2% of calls, so overall latency barely moves; but Bill Pay calls pricing with a 1-second timeout,
  and 30% of its calls through v8 time out. Version tags plus per-caller numbers stop the rollout.
  **Loyalty points fault test**: checkout must survive loyalty errors or a 3-second delay; run at 2 a.m.
  on 1% of traffic with a rule that removes itself, it reveals a 30-second default timeout; the fix is a
  300 ms timeout and crediting points later, and the test now runs every night. **A Thingyan game day.**
- **Scenes:**
  1. **Hook.** Page `l19_p01` (K1) "Pricing's canary passed. Bill Pay broke." · "Pricing v8: all green" ·
     "Bill Pay timeouts via v8: 30%" · "We watched the wrong side".
  2. **The canary.** Board B1 (P2): (1) "users" → bus → "baseline (old)" and "canary (new) 1%"; (2) both
     `arrow-right` into violet "compare"; (3) cleared, a green strip "1% → 10% → 50% → all" with a red "roll
     back" branch. Narration: canary analysis compares two groups at the same time, it is not just
     watching graphs; bake time; move fast early and slowly late.
  3. **Callers feel it.** Board B2 (P5), cleared: (1) blue bars "latency via v7" for checkout, Eats and Bill
     Pay; (2) violet bars "via v8": checkout and Eats a little taller, Bill Pay far taller, crossing a thin
     orange threshold "Bill Pay timeout: 1 s"; (3) red "stop rollout". Narration: a header carries the
     serving version and the shared client library records it, so every caller gets the split for free;
     the cost is more metric labels to store.
  4. **Why test in production?** Page `l19_p02` (K2) "Why test in production?" · "Staging can't copy real
     users" · "Small exposure, fast undo" · "Test failures, not just features".
  5. **A fault experiment.** Page `l19_p03` (K6) "A fault experiment" · "Steady state" · "Hypothesis" ·
     "Inject" · "Compare" · "Limit blast". Narration: the public Principles of Chaos Engineering; Padauk's
     steady state is 99.5% checkout success with p95 under 1.5 s; the hypothesis is that checkout survives
     loyalty errors or a 3-second delay; 1% of traffic at 2 a.m., with a rule that removes itself.
  6. **The loyalty test.** Board B3 (P1), cleared: (1) "checkout" → orange "loyalty points (soft)"; (2) red
     "inject: 3 s delay" → red "30 s default timeout!"; (3) green "300 ms timeout + credit later" and the
     label "now every night". Narration: a written plan with a backout anyone can run, review by the
     loyalty team, and results shared even when they look bad; test a dependency's failure from your own
     side.
  7. **Scale up, then a game day.** Board B4 (P7 staircase), cleared: (1) "delay a call" → "fail a
     dependency"; (2) "cut a link" → "drain a zone"; (3) "lose a region (on paper)". Narration: Padauk's
     Thingyan game day: leadership picks one theme ("our region is gone") and each team adds a test of its
     own (Wallet restores yesterday's backup; support talks through "the settlement expert is on leave");
     Wallet and Eats check each other's tests, and every finding goes into next quarter's plan; it is a way
     to get better, not an audit; check that the right alerts fire. For small, critical rules like "a
     balance never goes below 0", a model checker can try every order of steps and find the gap between
     checking a balance and taking the money.
  8. **This week.** Page `l19_p04` (K2) "This week" · "Write one fault experiment" · "Split one caller
     metric by version" · "Book a one-hour game day".
- **Recap (`notes.md`):** canary · baseline · change supervision · fault experiment · soft dependency ·
  game day · **Question:** "Your canary looks fine. What two groups should it be comparing?" (the canary
  and a baseline running the old version at the same time)
- **Bridge:** "Next: Thingyan is six weeks away. Last year brought 20,000 requests a second at midnight.
  How much should we prepare?"

### Lesson 20 · `sre-20-capacity-planning` · ≈ 11 min · deck SRE 5B

**Capacity ဘယ်လောက် လိုမလဲ** — _Capacity planning: how much is enough, and how much risk we accept_

- **Prerequisites:** L04 (capacity as spending), L06 (choosing risk) · **Borrowed terms:** error budget,
  failure domain · **Pages:** 7 · **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. decide whether detailed planning is worth it, and what the trade-off between speed, cost and staying
     up is;
  2. forecast as a range across steady growth, planned events and surprises;
  3. plan in business units and ask the right questions about supply;
  4. size for losing a zone, and pool capacity using the peak of the sums;
  5. decide in advance what to drop under load, and count the full cost of capacity.
- **Padauk:** **Thingyan forecast** with a widening range; last year the forecast said 2× and reality was
  2.6×. **Zone arithmetic**: Wallet runs 12 instances across 2 zones at 65%, which becomes 130% if one zone
  fails; spread as 3 zones of 5 instances (3 added) at 52%, a lost zone leaves 78%, so Wallet moves to all
  three zones. **Shared pool**: team reservations of 20 + 30 + 15 = 65, while the combined peak is 40 (plus
  a buffer, about 46). **Dinner-rush degradation profile**: never drop a payment write.
- **Scenes:**
  1. **Hook.** Page `l20_p01` (K1) "Thingyan is six weeks away" · "Last year: 20,000 requests a second" ·
     "Built for 3,000" · "How much should we prepare?"
  2. **Is planning worth it?** Page `l20_p02` (K2) "First: is planning worth it?" · "Small or tolerant:
     autoscale, buy extra" · "Big or critical: plan ahead" · "Choose the risk you accept". Narration: every
     capacity choice trades speed, cost and staying up, and the business sets the balance, not engineering
     taste.
  3. **The forecast fan.** Board B1 (P5): (1) bars for the last two quarters; (2) four forecast bars, each a
     blue "likely" part with a violet "could be" extension that widens; a taller one marked "Thingyan"; (3)
     a red bar "surprise" with the note "buffer + demand shaping". Narration: three kinds of demand (steady
     growth, planned events, surprises); give a range, not one number; for the payment path plan to the
     cautious end, because checking old forecasts against what happened shows how wrong we usually are
     (2× forecast, 2.6× real); a shorter lead time beats a better prediction.
  4. **Plan in top-ups, not CPUs.** Page `l20_p03` (K2) "Plan in top-ups, not CPUs" · "Kyat of cloud per
     1,000 top-ups" · "A jump is a regression" · "Wish list vs plan: price the gap". Narration: the plan
     depends on supply: can this capacity run anywhere, or does location or a residency rule pin it down?
     How long from "we need it" to serving traffic? How far can it grow, and shrink again? Know what you can
     get within a day, and the most you can get at all.
  5. **Zone arithmetic.** Board B2, cleared: (1) "2 zones × 6 at 65%" → a red `strike` on one zone → red
     "survivor: 130%"; (2) "3 zones × 5 at 52% (3 added)" → a `strike` → green "78%"; (3) orange "database
     connections ×2 after failover" and the label "size the survivors". Narration: the console and scaling
     API you would use to fail over may live in the zone that just died, so write the drain into the
     playbook and rehearse it before Thingyan; the cloud is not infinite, so reserve before critical events;
     no service runs in one zone except tests.
  6. **Peak of sums.** Board B3 (P6 lanes), cleared: (1) three lanes "Wallet", "Eats", "Top-up", each with
     one peak block at its own hour (12:00, 19:00, 00:00); (2) two total bars, blue "separate: 65" and
     violet "shared: 40 + buffer ≈ 46"; (3) a red note "if everyone claims at once: no capacity left".
     Narration: utilization is what you use divided by what you pay for; raise it by paying for less or
     doing more useful work on the same machines; some machines are meant to look idle (the spare zone, the
     attack shield), and pushing utilization too high leaves nothing for a lost zone.
  7. **Keep batch away from payments.** Page `l20_p04` (K3) "Keep batch away from payments" · "Separate
     machines | One pool, priority labels" · "Simple, strong guarantee | Cheaper, needs good labels" · "Costs
     more | Reports can slow payments". Narration: settlement reports on cheap machines that can be taken
     away, or one shared pool where payments are always served first.
  8. **Our degradation profile.** Page `l20_p05` (K6) "Our degradation profile" · "100%: slower" · "120%:
     drop extras" · "150%: queue orders" · "Never: lose payments". Narration: tag traffic by what it needs;
     shaping demand beats adding supply; count every dropped request so the business can price it; plan
     capacity incidents in advance.
  9. **What capacity really costs.** Page `l20_p06` (K5) "What capacity really costs" · "Cloud bill" · "Idle
     reserved servers" · "Engineer hours" · "Lost orders". Narration: capacity planning is choosing how much
     risk to carry: spread across zones, test failure often, share where peaks don't line up, and plan with
     product and finance, not alone.
  10. **This week.** Page `l20_p07` (K2) "This week" · "Write your peak calendar" · "Can we lose a zone at
      peak?" · "Track kyat per 1,000 requests".
- **Recap (`notes.md`):** forecast range · plan of record · size the survivors · peak of sums ·
  utilization · degradation profile · **Question:** "12 instances at 60% across 2 zones. One zone dies.
  What load do the survivors carry?" (120%)
- **Bridge:** "Next: a user asks Padauk to delete her account. Where does her data actually live?"

### Lesson 21 · `sre-21-data-you-are-trusted-with` · ≈ 10 min · deck SRE 5B

**ယုံကြည်ပြီး အပ်ထားတဲ့ data** — _Data you're trusted with: deletion, classes, integrity and access_

- **Prerequisites:** L08 (telemetry is personal data) · **Borrowed terms:** failure domain, least privilege
  (one clause) · **Pages:** 6 · **Boards:** 3 · **Chars:** 7,600
- **Goals.** The learner can:
  1. explain why data failures can't be undone like outages, so business, legal and ethical questions come
     first;
  2. design deletion as a pipeline (soft and hard delete, safe automatic expiry);
  3. classify data (original or derived, value, sensitivity) to decide how much care it gets;
  4. keep production data out of tests and give every person and service the least access it needs;
  5. check integrity with designed reconciliation, and treat speed as part of data availability.
- **Padauk:** a "delete my account" request reaches Ma Su's team: where does this person's data live? A
  developer copied real wallet data to a shared test server to debug a bug. Wallet balances are checked
  against the cashback ledger every night. The Eats restaurant search index takes 6 hours to rebuild.
  Every legal rule is stated as hypothetical.
- **Scenes:**
  1. **Hook.** Page `l21_p01` (K1) "'Please delete my account'" · "A request reaches Ma Su's team" · "Where
     does her data live?" · "Who else has a copy?"
  2. **Some things can't be retried.** Page `l21_p02` (K3) "Outage | Data failure" · "Can be retried | Can
     never be undone" · "Ends when fixed | Stays wrong until repaired" · "Users wait | Users stop trusting".
     Narration: that is why the business, legal and ethical questions about data come before any tool;
     integrity is never traded for speed or cost.
  3. **Where does she live?** Board B1 (P2 comb): (1) "delete request" → bus → "database", "caches",
     "search index"; (2) → "analytics", "logs", "backups"; (3) small tags "original" on the database,
     "derived" on the search index, "personal" on the logs. Narration: deletion is a pipeline, and each store
     has its own deadline; derived data can be rebuilt, unless rebuilding takes so long that the product is
     down meanwhile: the Eats search index takes 6 hours, so Padauk protects it like original data.
  4. **Soft, then hard.** Board B2 (P1), cleared: (1) blue "soft delete: undo window" → red "hard delete:
     deadline"; (2) an orange note "automatic expiry: fixable first, with a global pause". Narration: a
     safe expiry can be stopped everywhere at once if a bug starts deleting the wrong things.
  5. **Know your data.** Page `l21_p03` (K4) "Know your data" · "Original or derived?" · "How valuable? How
     sensitive?" · "Hashed IDs still link records". Narration: NRC numbers, addresses and birth dates need
     a reason and a review; the class decides retention, access, backups and the restore path.
  6. **The copy on the test server.** Page `l21_p04` (K2) "Who can see it" · "Least access, people and
     services" · "Break-glass: narrow, short, logged" · "No production data in tests". Narration: the
     developer's copy of real wallet data; Padauk uses synthetic test data, wiped instances and clearly
     named sandboxes instead; users care deeply about who sees their data.
  7. **The nightly check.** Board B3 (P6 lanes), cleared: (1) blue "nightly: balances = cashback ledger?";
     (2) top lane green "designed reconciliation: a normal daily job"; bottom lane orange "bug repair: keep
     details, log it, alert at the first"; (3) red "silent fix-ups hide bugs". Narration: integrity means
     the data stays exactly right, and database constraints reject bad writes cheaply; for data,
     "available" also means fast: the ledger needs consistency, the Eats menu needs speed, and a timeout
     looks to the user like missing data.
  8. **Suppose the rule says…** Page `l21_p05` (K2) "Suppose the rule says…" · "This data stays
     in-country" · "Use it only for its reason" · "Would users be comfortable?" Narration: find the real
     rules with lawyers, never assume; in-country data stays in-country even during a disaster; the law is
     the floor, and ethics sits above it.
  9. **This week.** Page `l21_p06` (K2) "This week" · "Find production data outside production" · "Write
     where one user's data lives" · "Remove one standing admin access".
- **Recap (`notes.md`):** entrusted data · soft vs hard delete · original vs derived · least privilege ·
  reconciliation · **Question:** "A derived search index takes 6 hours to rebuild. Back it up, or not?"
  (yes: the product is down while it rebuilds)
- **Bridge:** "Next: a cashback bug turns out to be older than our backups. How far back can we go?"

### Lesson 22 · `sre-22-backups-and-restores` · ≈ 11 min · deck SRE 5B

**Backup ထက် restore က ပိုအရေးကြီးတယ်** — _When data breaks: three incidents, replicas, backups and restores_

- **Prerequisites:** L21 · **Borrowed terms:** soft delete, SLO · **Pages:** 6 · **Boards:** 4 ·
  **Chars:** 8,400
- **Goals.** The learner can:
  1. decide how far back backups must reach, and what caps that window;
  2. set RPO and RTO for money data from business need, and say why they are for disasters, not daily
     health;
  3. explain why replication is not a backup, and keep backups and their keys out of production's reach;
  4. stop one mistake from reaching everything with staged deletes and guards;
  5. prove backups with automated restore drills, and agree a recovery policy in advance.
- **Padauk:** three data incidents, in the order they happened. **The cashback rounding bug** reaches
  every replica instantly and is found 11 days later, but backups are kept for only 7; the append-only
  ledger allows correcting entries, and the balance check now alerts on any repair at all. **A cleanup
  script deletes 10,000 merchants**: a developer wrote it with a coding assistant and ran it with admin
  credentials, and the staging and production names differ by one letter; recovery is the hourly snapshot
  plus replaying the write log; afterwards, two-person approval and a trash period. **The first restore
  drill**: 900 GB takes 7 hours against a 1-hour target, and a validator finds payments with no matching
  order.
- **Scenes:**
  1. **Hook.** Page `l22_p01` (K1) "A bug older than our backups" · "Cashback rounding: found on day 11" ·
     "Backups kept: 7 days" · "How far back can we go?"
  2. **How far back.** Board B1 (P8 timeline): (1) the axis with blue backup ticks and red "rounding bug";
     (2) orange "noticed: day 11" and an orange bracket bar "backups kept: 7 days" that ends after the bug;
     (3) red "can't go back far enough". Narration: keep backups longer than it takes us to notice a bug,
     but not forever: last lesson's deletion deadlines and the storage bill set the far end; even inside
     the window we can lose up to one backup's worth of new writes.
  3. **Two numbers.** Page `l22_p02` (K4) "Two numbers for money data" · "RPO: how much recent data lost?" ·
     "RTO: how long until it's back?" · "Set from business need, not tools". Narration: RPO decides how often
     we back up, which decides tools and even how data is laid out, so decide early; these numbers are for
     disasters and only start counting after things break, while day to day the SLO and its budget warn us
     while there is still time.
  4. **Replication spreads the mistake.** Board B2 (P2), cleared: (1) red "cleanup script: delete 10,000"
     → "primary" → bus; (2) three replicas, all red; (3) two nested green rectangles "independent backup:
     separate account, read-only". Narration: replicas copied the deletes instantly; recovery came from the
     hourly snapshot plus the write log; an asynchronous failover loses whatever had not copied yet, while
     synchronous writes are slower but simpler to recover.
  5. **Snapshot and backup.** Page `l22_p03` (K3) "Snapshot | Backup" · "Fast and cheap | Separate, slower" ·
     "Shares the storage's fate | Survives the storage" · "Keep only one | Keep both: 3-2-1". Narration: 3-2-1 means three
     copies, on two kinds of storage, one somewhere else; point-in-time recovery (a backup plus the write
     log) gives money data a tiny RPO; nothing that writes to production may delete backups; a backup also
     needs its keys and its map, so Padauk keeps the ledger's encryption keys and metadata backups in a
     separate cloud account with separate logins; boring, simple backups beat clever ones.
  6. **One mistake can't reach everything.** Board B3 (P1), cleared: (1) "cleanup script" → red
     "production (one letter different)"; (2) green guards along the path "trash period" and "second
     approver"; (3) "scope cap" and "backups out of reach". Narration: deletes are staged and reversible,
     and risky data operations run zone by zone, never everywhere at once; Lesson 28 calls this incident
     back as the reason agents start read-only.
  7. **The drill.** Board B4 (P8 + P5), cleared: (1) a red bar "900 GB restore: 7 h" against a thin orange
     threshold "target: 1 h"; (2) the drill's measured parts on its timeline: "finding machines: 2 h",
     "copying: 4 h", "checking: 1 h"; (3) orange "validator: payments without orders" and green "split the
     data · weekly restore test". Narration: the drill needs the same machines a real restore needs; if we
     can't find them on a calm Tuesday, we won't find them during an outage.
  8. **Proof is a restore.** Page `l22_p04` (K2) "Proof is a restore" · "Test restores on a schedule" ·
     "Alert on failed or slow restores" · "Check restored data makes sense". Narration: test every kind of
     restore (one user's data, a batch of bad writes, a whole site), and fund the testing.
  9. **Padauk's data list.** Page `l22_p05` (K4) "Padauk's data list" · "Money: point-in-time, tested
     weekly" · "Can rebuild: protect if slow" · "No backup needed: say so". Narration: a restore is the
     tested path, recovery is salvage; decide now, not at 3 a.m.: if the ledger is lost, the wallet comes
     back read-only showing "balances being restored" rather than fully dark; never hand-edit balances
     during a recovery: every change goes through reviewed code, and a manual fix needs the CTO's written
     OK; leadership signs off the plan.
  10. **This week.** Page `l22_p06` (K2) "This week" · "Restore one backup, and time it" · "Write RPO and
      RTO for money" · "Make one delete need two people".
- **Recap (`notes.md`):** RPO · RTO · replication ≠ backup · snapshot · 3-2-1 · restore drill ·
  **Question:** "Backups run every 6 hours. What is your worst-case RPO?" (6 hours of writes)
- **Bridge:** "Module 5 continues: a nightly job sends half a price list, and top-ups stop everywhere at
  1 a.m. How do we contain a failure we never planned for?"

### Lesson 23 · `sre-23-containing-failure` · ≈ 11 min · deck SRE 5C

**Failure ကို ဘောင်ခတ်ထားတဲ့ design** — _Designing for resilience: risk, failure domains, dependencies and bad input_

- **Prerequisites:** L06, L20 (zones), L22 · **Borrowed terms:** failure domain, SLO arithmetic · **Pages:**
  3 · **Boards:** 5 · **Chars:** 8,400
- **Goals.** The learner can:
  1. distinguish reliable (inside the designed range) from resilient (contains failures beyond it);
  2. place risks by how often and how bad, and give rare but severe ones a plan;
  3. make failure domains truly independent, and recover when a bad change reaches all of them;
  4. calculate how serial dependencies cap availability, and prove optional dependencies are optional;
  5. harden against bad input, choosing fail open or fail closed in advance.
- **Padauk:** **the half-written price list**: a nightly job publishes the operator price list cut off at
  40% of its rows, every server loads it, and top-ups for the missing plans fail everywhere at 1 a.m.; the
  fixes are a rollout one zone at a time, "smaller than yesterday?" and "older than an hour?" checks, and
  keeping the last good version. **A hidden shared session cache**: Wallet now runs in three zones, so
  losing one should cost a third, but all three share one cache in zone A; the fix is a cache per zone.
  **Eats checkout dependencies**: Wallet at 99.9% × notification at 99% caps any "99.9%" promise unless the
  notification is queued; two SMS providers look like a hedge, but both use the same operator gateway.
- **Scenes:**
  1. **Hook.** Page `l23_p01` (K1) "Top-ups stopped everywhere at 1 a.m." · "A nightly job sent half a price
     list" · "Every server believed it" · "Nothing was down; it was wrong".
  2. **Reliable vs resilient.** Board B1 (P5): (1) an outline-only blue rectangle "designed range" with load
     bars inside it; (2) one tall bar beyond it, then red "collapse" vs green "dip and recover"; (3) a wider
     outline "each lesson widens it". Narration: resilience is a cost-benefit choice, never total
     protection, and users decide what "resilient enough" means.
  3. **Padauk's risk picture.** Board B2 (P5, two-axis placement), cleared: (1) axes "how often" and "how
     bad"; (2) "price list cut short" (often, bad), "lose a zone" (rare, very bad), "shared SMS gateway"
     (sometimes, medium); (3) Padauk's decisions beside them: "cheap checks, always on", "plan now, fix step
     by step", "accepted for now, written down". Narration: for catastrophes, "how likely × how bad" stops
     working, so a rare but severe risk still gets a plan; fixes can be by hand, automated or built into the
     architecture.
  4. **Is it really independent?** Board B3 (P2), cleared: (1) three zone boxes "zone A / B / C: 33%
     each"; (2) an orange "shared session cache (zone A)" combing into all three, red "lose zone A = lose
     100%"; (3) green "a cache per zone". Narration: align deployments with failure domains and do the
     arithmetic; add zones rather than making zones bigger, because when a big zone fails its traffic floods
     the others and the returning zone is flooded again, so shift traffic in steps; if a bad push breaks all
     three zones, fence one off, fix it from a protected known-good copy of config, data and binaries that
     gets changes last, rejoin it, and repeat zone by zone.
  5. **Dependency arithmetic.** Board B4 (P1 + P2), cleared: (1) "Eats checkout" → "Wallet 99.9%" →
     "notification 99%" → violet "≈ 98.9% if independent; never above 99%"; (2) an orange "promise 99.9%?"
     with a `strike`, and green "queue the notification"; (3) "SMS provider 1" and "SMS provider 2" combing
     into one red "operator gateway: no better than it". Narration: two providers that fail independently
     would give 1 − 0.01 × 0.01 = 99.99%, but through one shared gateway they are no better than the
     gateway; don't add error budgets together, draw how the request really calls its dependencies.
  6. **Eats checkout's dependency card.** Page `l23_p02` (K4) "Eats checkout's dependency card" · "Needs:
     Wallet; notifications queued" · "Optional: loyalty, photos (tested)" · "Owes riders and shops: 99.5%".
     Narration: the SMS gateway outage sat between two teams, each thinking the other owned it, so every
     shared dependency on the card gets one named owner and leaders look for the gaps; Padauk's SMS fallback
     is a second provider on its own route, which costs more but doesn't share the gateway's fate.
  7. **Bad input.** Board B5 (P1), cleared: (1) "price list job" → orange "smaller than yesterday? older
     than an hour?"; (2) → red "reject, alert" and green "keep last good version"; (3) → "servers".
     Narration: data that every server shares is the most dangerous change we make, because it lands
     everywhere at once, so it rolls out zone by zone like code; each reader decides in advance what "bad or
     empty" means for it: an empty fraud blocklist would let everything through (fail open), while an empty
     merchant list would block everything (fail closed); when in doubt, keep doing what you were doing.
  8. **This week.** Page `l23_p03` (K2) "This week" · "List what your zones really share" · "Multiply your
     journey's dependencies" · "Add a 'too small?' check".
- **Recap (`notes.md`):** resilience · failure domain · blast radius · serial dependency · shared fate ·
  fail open / fail closed · **Question:** "A journey calls two independent services in series, at 99.9%
  and 99.5%. What can it reach at best?" (about 99.4%)
- **Bridge:** "Next: Thingyan midnight brings 20,000 requests a second to a system built for 3,000, and
  then the servers start restarting. How do we hold steady?"

### Lesson 24 · `sre-24-overload-change-emergency` · ≈ 11 min · deck SRE 5C

**Overload နဲ့ emergency mode** — _Overload, safe change, and responding when your own tools are down_

- **Prerequisites:** L10 (mitigations), L19 (canary), L20 (degradation profile), L23 · **Borrowed
  terms:** error budget, canary, generic mitigations · **Pages:** 5 · **Boards:** 4 · **Chars:** 8,400
- **Goals.** The learner can:
  1. trace a cascading failure and break the loop: shed, degrade, back off with jitter, budget retries,
     pause restarts;
  2. make overloaded systems hold steady and recover by themselves, measured by useful work;
  3. change safely: everything rolls out gradually, one change at a time, stoppable;
  4. tie how careful changes must be to the error budget, the calendar and live incidents;
  5. prepare an emergency kit for when the responders' own tools are down.
- **Padauk:** **Thingyan midnight**: the top-up service, built for 3,000 requests a second, gets 20,000;
  stacked retries cascade; the fixes are priority labels, shedding, retries in one layer only with backoff,
  per-partner quotas and paused automatic restarts. **Padauk's change rule**, tied to its budget and
  calendar. **Single sign-on fails**: it locks everyone out of the console, chat and the runbook wiki; the
  kit is break-glass keys, a phone bridge and offline runbooks, and a game day then shows that the only key
  holder was unreachable.
- **Scenes:**
  1. **Hook.** Page `l24_p01` (K1) "Thingyan midnight: 20,000 a second" · "Built for 3,000" · "Retries
     piled on retries" · "Then servers kept restarting".
  2. **The cascade.** Board B1 (P3 ring): (1) on the track "too much load" → "queues grow" → "timeouts"; (2)
     → "clients retry" → "restarts, cold caches" → back to "too much load"; (3) red `strike` marks across the
     ring labelled "shed + degrade", "backoff + jitter", "pause restarts".
  3. **Hold steady, don't collapse.** Board B2 (P5), cleared: (1) bars of useful work at offered load 1× /
     2× / 4× / 6×; (2) red bars that rise and then collapse; (3) green bars that rise and then hold level,
     "serve near capacity". Narration: success means payments keep flowing the whole time, and the system
     comes back by itself when midnight passes, with nobody pressing anything.
  4. **Breaking the loop.** Page `l24_p02` (K4) "Breaking the loop" · "Server: reject early, by priority" ·
     "Client: retry less, back off" · "Per-partner quotas". Narration: when most of the app's recent calls
     have failed, it holds back new ones by itself and keeps only the important ones; shedding only works if
     clients behave (the AWS Builders' Library articles on load shedding and on retries with jitter are
     good public reading).
  5. **Change safely.** Page `l24_p03` (K4) "Change safely" · "Code, config, data: all gradual" · "One
     change at a time" · "Every change can stop". Narration: change is the steady source of risk; feature
     flags undo cleanly.
  6. **Padauk's change rule.** Board B3 (P8 timeline), cleared: (1) a month strip with Padauk dates:
     "payday week (25th–1st)" and "3 days before Thingyan"; (2) an orange label "budget under 25%, payday
     week or 3 days out: named rollback + second reviewer"; (3) red "Thingyan eve: rollouts paused; urgent
     and security fixes only". Narration: the same switch flips during any big incident: still-healthy
     services and the recovery tools get the strict rule until it is over.
  7. **Your undo toolbox.** Page `l24_p04` (K2) "Your undo toolbox" · "Drain · roll back · add capacity" ·
     "Degrade · block a bad caller" · "Data changed? Roll forward". Narration: fixes are changes too, so test
     them; "restart" from Lesson 10 needs care under overload, because restarts throw away capacity and warm
     caches, so pause them, and restart only servers doing no useful work at all.
  8. **When our usual tools are down too.** Board B4 (P2), cleared: (1) red "single sign-on down" → bus →
     red "console", "chat", "runbook wiki"; (2) under each a green fallback "break-glass keys", "phone
     bridge", "offline runbooks"; (3) orange "game day: one key holder, unreachable" → green "second key
     holder in Mandalay". Narration: the break-glass key still needs a second person, because if the
     emergency path were easier than the normal one, someone would break the normal one on purpose; people
     are a failure domain too; when tools fail, ask in order: does the normal way work? is there a fallback?
     if not, call the two most experienced people; a fallback should feel the same, so if the deploy page is
     down its error links to the one command that does the same rollback; leaders keep the fallbacks alive,
     and small, frequent drills build skills that last.
  9. **This week.** Page `l24_p05` (K2) "This week" · "Find clients retrying in two layers" · "Mark your
     next peak's rule" · "Ask: how do we talk without chat?"
- **Recap (`notes.md`):** cascading failure · goodput · load shedding · backoff with jitter · change rule ·
  emergency kit · **Question:** "Three layers each try a call up to 3 times. One user tap can become how
  many calls at the bottom?" (27)
- **Bridge:** "Next: a Top-up deploy goes out in the middle of the Thingyan freeze, because the freeze rule
  lived on a wiki page. How do we make the safe way the easy way?"

### Lesson 25 · `sre-25-platform-engineering` · ≈ 11 min · deck SRE 5C

**မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင်** — _Platform engineering: make the right way the easy way, and shift reliability down_

- **Prerequisites:** L04 (golden path seed), L17, L19, L24 · **Borrowed terms:** golden path, canary,
  break-glass · **Pages:** 6 · **Boards:** 4 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain why reliability rules on a wiki fail as a company grows, and when one shared system must be
     required;
  2. define a production platform as technology plus habits, designed or accidental;
  3. design a golden path with a few supported choices, checks that steer, and escape hatches;
  4. use shift left and shift down together, and match oversight to consequence;
  5. roll out a new rule for old systems with exceptions, expiry dates and visible risk.
- **Padauk:** **the freeze that reached one script**: Wallet, Top-up and Eats each have their own deploy
  script; the Thingyan freeze rule reached only Wallet's, so a Top-up deploy went out during the freeze and
  repeated an outage Wallet had already learned from; the new rider service's pipeline, written in a
  weekend, knew none of the rules. **A desire path becomes a golden path**: a bash script shared on Viber
  inspires a template with an auto-rollback canary that asks four questions; from new repository to first
  deploy drops from 3 weeks to 1 day. **The shared gateway client**: timeouts, backoff with jitter, a retry
  budget and a circuit breaker, written once. **The fraud team's Python model server** needs an exception.
  **A new restore-test rule** for 35 old services.
- **Scenes:**
  1. **Hook.** Page `l25_p01` (K1) "A deploy went out during the freeze" · "The freeze rule lived on a
     wiki" · "Wallet's script knew it" · "Top-up's script didn't".
  2. **One rule, many scripts.** Board B1 (P2 comb): (1) "freeze rule" → bus →
     "Wallet script" (`check`), "Top-up script" (red ✗), "Eats script" (red ✗); (2) a fourth box "rider
     service: weekend pipeline", red "?"; (3) cleared: "shared deploy platform" → bus → all four services,
     each with a `check`. Narration: rules on paper fail as a company grows: there are many tools, rules
     reach them late, and new tools forget old lessons, while most outages repeat patterns someone already
     learned; so for each risky kind of change (deploys, config pushes) Padauk picks one shared system that
     every team must use, so a rule lives in one place and a new team inherits it on day one; moving teams
     onto it is extra work now and nobody likes it, so leaders back it and explain why.
  3. **Your platform already exists.** Page `l25_p02` (K4) "Your platform already exists" · "Deploy, run,
     watch, store + habits" · "Designed, or an accident" · "A product for your engineers".
  4. **From desire path to golden path.** Board B2 (P1), cleared: (1) orange "script shared on Viber"; (2) →
     blue "template: 4 questions" → green "service with canary, auto-rollback, SLO dashboard"; (3) a small
     orange side box "escape hatch" and the label "3 weeks → 1 day". Narration: give requirements plus a few
     supported solutions; bound a choice in one of three ways: a strong default (Postgres unless you can
     justify otherwise), a small menu (Postgres, or Postgres with a Redis cache), or removing it (no more
     deploying by SSH); with the small stuff settled, teams argue about which SLO fits, not which dashboard
     tool; people adopt it because it is the easiest path and its reasons are visible, not because they are
     punished.
  5. **When the template said no.** Page `l25_p03` (K2) "When Top-up broke a rule" · "Editor warning: no
     rollback plan" · "Merge blocked: no canary step" · "Break glass: logged, reviewed". Narration: like a
     code style guide with a linter, each check names the rule and suggests the fix, and the best rule is a
     default that is already compliant; tricky code like the shared gateway client is written once by
     experts and reaches every service when it redeploys; the flip side is that a bug there also reaches
     every service, so the platform team canaries its own changes, one service and one zone first.
  6. **Shift down.** Board B3 (P6 lanes), cleared: (1) top lane: three team boxes each carrying a red label
     "retries, rollouts, SLOs" → one queue box "SRE"; (2) bottom lane: the same teams standing on a wide
     green slab "platform" that holds those words; (3) the label "use both: early and shared". Narration:
     keep thinking about reliability early (shift left), and let the platform make that early work shared
     and done once by experts (shift down).
  7. **Right-sized control.** Page `l25_p04` (K6) "Right-sized control" · "Playground" · "Light" ·
     "Standard" · "Strict". Narration: hackathon apps, most services, and the ledger and anything that moves
     money; oversight matches the consequence of a mistake, it is not a maturity ladder, and one company
     runs every level at once.
  8. **Exceptions are normal.** Page `l25_p05` (K2) "Exceptions are normal" · "Memory limit: self-service,
     logged" · "New runtime: reviewed by payer" · "Three asks: build it next". Narration: every platform
     misses some real needs (a case nobody planned, a special business need, an old service too costly to
     move, a new technology like the fraud team's Python model server); force the platform anyway and
     people build hidden workarounds; too much variety is one kind of debt and too much strictness another;
     the new runtime is reviewed by whoever pays if it goes wrong, and every exception goes in one list.
  9. **A new rule for old systems.** Board B4 (P6, two lanes merging), cleared: (1) "new services" → red
     "blocked without a restore test"; (2) "35 old services" → orange "exempt until a date"; (3) both
     `arrow-down` into green "scorecard + exception list". Narration: Padauk writes the rule down with an
     owner, a reason and a review date ("every money database has a passing restore test in the last 90
     days"; owner Thiri; reason: the failed drill; reviewed yearly); a nightly check feeds team scorecards
     and a roll-up ("6 money databases never restored"), which gets Ko Nay Lin to fund a restore sprint;
     fixes arrive as tickets, as ready-made pull requests, or applied automatically when safe; the deadline
     depends on the risk: the ledger by a date, merchant services at their next big change, and the old SMS
     gateway accepted until it is retired, re-signed every quarter.
  10. **This week.** Page `l25_p06` (K2) "This week" · "Find the script everyone copies" · "Turn one wiki
      rule into a check" · "List your exceptions in one place".
- **Recap (`notes.md`):** golden path · escape hatch · break-glass · shift down · right-sized control ·
  exemption with expiry · **Question:** "A rule lives only on a wiki page. Name one way to build it into
  the path instead." (a default, a check in the template, or a blocked merge)
- **Bridge:** "Module 6: coding agents arrive, and merges jump from 15 to 120 a day. What changes for
  SRE?"

## Module 6 — AI, and SRE where you work

Decks SRE 6A (lessons 26–29) and SRE 6B (lessons 30–32) · about 75 minutes · two production weeks.
Padauk: still about 60 engineers; coding agents arrive, Padauk buys Padauk Parcel and links with a
partner bank. Module map page `m6_map` (in L26, deck 6A only): "Module 6 · AI, and SRE where you work" ·
"AI writes code, runs as a feature, helps operate" · "Any company, and what comes next". The whole loop is
lit, with Ops Buddy's icon at the stations AI touches.

Present the AI lessons as trends ("we expect", "likely"); name no vendors and cite no AI code-quality
figures.

### Lesson 26 · `sre-26-when-ai-writes-the-code` · ≈ 11 min · deck SRE 6A

**AI က code ရေးတဲ့ခေတ်** — _When AI writes the code: what changes for SRE_

- **Prerequisites:** L01 (build vs run, debt as a loan), L19 (canary), L24 (one change at a time), L25 ·
  **Borrowed terms:** canary, feature flag, rollback · **Pages:** 6 + map · **Boards:** 3 · **Chars:**
  8,400
- **Goals.** The learner can:
  1. explain why cheap code moves the cost to understanding, coherence and safe shipping;
  2. show that reliability is decided and built in every phase, and that the step into production doesn't
     get easier;
  3. predict what many more changes bring, and why, at very high change rates, rolling forward may often
     replace rollback;
  4. counter coherence drift with written specs, shared modules and change records;
  5. explain why people who keep the whole system in view stay necessary.
- **Padauk:** **the month the coding agents arrived**: merges per day went from 15 to 120, and incidents
  from 3 a month to 11 in the first month, still climbing; a duplicate-SMS bug in Top-up can't be rolled
  back because a schema changed, so the fix rolls forward behind a flag, 5% first, watched by a canary.
  **Four ways to round a delivery fee**: agents wrote four kyat-rounding helpers (to 50, up, to 10, none);
  refunds stop matching charges; later an agent "fixing rounding" edits the wrong helper; the fix is an
  agent instruction file, a written fee spec, a lint rule and one owned SLI per journey. **The confident
  assistant on payday night**: it blames the database pool and suggests restarting every server; the
  change timeline instead shows three things landing together (agent-added retries, a new fraud rule, the
  bank's payday batch); an engineer turns off the retry flag; from then on, agent changes record the task,
  the reasoning and the tests run.
- **Scenes:**
  1. **Hook + map.** Page `l26_p01` (K1) "Merges: 15 → 120 a day" · "Same team, agents everywhere" ·
     "Incidents: 3 → 11, still climbing" · "What changed?", then `m6_map`.
  2. **Code is cheap now.** Page `l26_p02` (K4) "Code is cheap. What isn't?" · "Writing it: cheaper every
     month" · "Running it safely: as hard" · "Understanding it: harder than ever". Narration: calls back
     Lesson 1: building is short, running is long.
  3. **The production wall.** Board B1 (P6 lanes, English labels): (1) top lane "design" → "build + test" →
     "deploy" → "run"; (2) bottom lane "with AI", the same boxes narrower, and a thick red vertical
     rectangle before "deploy", "production"; (3) an orange label under the top lane, "one changed line can
     break reliability in any phase". Narration: how reliable it must be is decided at plan and design time,
     and building it takes design, test and deploy, so SRE belongs from design onward; short phases leave
     less time to correct course; fast feedback helps features more than reliability; "it works" is not "it
     is reliable".
  4. **What the 11 incidents were.** Board B2 (P5), cleared: (1) blue "before agents" bars by cause:
     "config" 1, "retries" 1, "schema" 1; (2) violet "after" bars: config 3, retries 3, schema 2, and a new
     "duplicate helpers" 3; (3) the label "trouble grows with changes, rarely slower". Narration: automation
     catches the easy cases, and people get the rare, hard ones; the confident assistant on payday night:
     it had never seen this combination, it sounded sure and was wrong, and someone had to explain the
     incident to Bank X and to management, which is why people stay in incidents.
  5. **Roll back or roll forward?** Page `l26_p03` (K2) "Roll back or roll forward?" · "Clean rollback?
     Roll back first" · "Schema changed? Forward, behind a flag" · "5% first, watched by a canary".
     Narration: the duplicate-SMS bug; we expect that at very high change rates rolling forward will often
     replace rollback, but where a clean rollback exists it still comes first (Lesson 10); when fixing gets
     cheap, leaders may stop paying for prevention, so don't let fast recovery replace fixing causes; with
     deploys all day, "which version is live?" has no single answer and staging stops looking like
     production, so every request records its build, flags and app version.
  6. **Coherence drift.** Board B3 (P2 fan-in), cleared: (1) four helper boxes "round to 50", "round up",
     "round to 10", "no rounding"; (2) combing into red "refund ≠ charge"; (3) green "one fee spec + one money
     module + agent instruction file". Narration: an agent's reasons are hard to see afterwards, so every
     agent change records the task, the reasoning and the tests; the same drift hit the metrics, when three
     different "top-up success" numbers disagreed during an incident, so each SLI is defined once.
  7. **What changes, what doesn't.** Page `l26_p04` (K3) "Changes | Doesn't change" · "Time per phase |
     Bugs per change" · "Who writes code | Cost of a bad deploy" · "Team edges blur | Someone sees the
     whole". Narration: skills fade when you never use them, so Padauk practises incidents with the
     assistant switched off; and a tool that is usually right is weakest on rare events, so check its
     suggestion before pressing the button.
  8. **Where SRE work moves.** Page `l26_p05` (K4) "Where SRE work moves" · "More before deploy: specs,
     guardrails" · "Small changes, flags, canaries" · "Keeping the whole system in view". Narration: running
     production won't get easier; SREs will need many more tools, and most of them can't be trusted to act
     alone yet.
  9. **This week.** Page `l26_p06` (K2) "This week" · "Write design rules agents read" · "Put risky changes
     behind flags" · "Practise one incident, AI off".
- **Recap (`notes.md`):** production wall · roll back first, roll forward safely · coherence drift · fee
  spec · change record · **Question:** "Agents doubled your merges. If nothing else changes, what do you
  expect to happen to incidents?" (roughly double, rarely fewer)
- **Bridge:** "Next: Ask Padauk answers 99.9% of chats successfully, yet opens refund tickets for the
  wrong transactions. When is 200 OK not enough?"

### Lesson 27 · `sre-27-reliability-for-ai-features` · ≈ 11 min · deck SRE 6A

**AI feature တွေရဲ့ reliability** — _When 200 OK isn't enough: reliability for AI features_

- **Prerequisites:** L06 and L07 (the 200 OK seed), L19 (canary), L20 · **Borrowed terms:** SLI, canary,
  blast radius · **Pages:** 7 · **Boards:** 3 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain what stays the same when the service is AI, and why answer quality becomes a reliability
     signal;
  2. derive AI SLIs from the harm users feel, and treat an eval score as an SLI;
  3. plan AI capacity as cost per request, and turn "degraded" into a number;
  4. treat prompts, models and data as changes: gate them, canary them, stop the pipeline on bad data;
  5. limit an agent's blast radius, and log what it does.
- **Padauk:** **Ask Padauk, the Burmese support assistant**: HTTP success is 99.9%, yet it opens refund
  tickets for the wrong transactions because transaction IDs get mixed up; the fixes are ID validation,
  agent SLIs, a scenario suite built from 50 real complaints, and permission to open tickets only (no money
  moves). **The payday fallback**: the AI provider's rate limits push free-tier chat to a cheaper model;
  dashboards stay green but users start rephrasing their questions; a `degraded=true` flag plus grading 2%
  of answers shows the truth: "available, but 30% degraded". **The Thingyan fraud model**: a logging change
  empties a column; a null check halts the nightly training, and the old model keeps serving.
- **Scenes:**
  1. **Hook.** Page `l27_p01` (K1) "99.9% success. Wrong refunds." · "Ask Padauk answered every chat" ·
     "Tickets for the wrong transactions" · "HTTP said everything was fine".
  2. **AI is still a service.** Page `l27_p02` (K4) "AI is still a service" · "SLOs, capacity, safe
     change: still apply" · "New: answers can be wrong" · "New: every request costs tokens". Narration:
     training builds a model and inference uses it; tokens and the context window; an agent is a model that
     calls tools in a loop; and for teams on hosted models four habits carry over: keep the part that sets
     prompts, routes and limits apart from the part that answers users; treat provider quota as scarce;
     observe the AI parts, not just the servers; version every prompt and model choice so it can be rolled
     back (a model router that sends traffic to a cheaper model is one reliability lever).
  3. **The answer spectrum.** Board B1 (P5, one long segmented bar): (1) red "error (500)" at the left;
     (2) orange "weak or fallback answer (still 200!)" in the middle and green "good answer" at the right;
     (3) above the red end "HTTP sees only this", below the whole bar "users feel all of it". Narration: the
     payday fallback, the users rephrasing, the degraded flag and the 2% sample.
  4. **Ask Padauk's SLIs.** Page `l27_p03` (K5) "Ask Padauk's SLIs" · "Right transaction picked" · "No
     repeat question in 5 min" · "First words within 2 s" · "Fallbacks count as degraded". Narration: an
     eval score is an SLI, and its pass line is the SLO; exact-match tests break when answers vary; the
     agent has its own SLIs too: tool calls that succeed, transaction IDs that pass validation, tickets whose
     JSON is valid; Ma Hnin and Thiri agree the product goal first, set the first SLO at a number they can
     meet and raise it later, and the degraded share counts against it.
  5. **Capacity is cost.** Page `l27_p04` (K7) "Cost per request × requests" · "Plan AI capacity in kyat".
     Narration: AI features get fewer requests, but each one is expensive and the cost varies, so alerts
     that ignore low volume or assume equal cost hide problems; log tokens, latency and cost per request;
     spare quota costs real money; load tests must check answer quality, not just errors; measure a new
     feature at 5% and scale the bill up before launch, and keep one switch to change providers; teams that
     train their own models also manage scarce accelerators and long jobs, which this course leaves aside.
  6. **Bad data stops the line.** Board B2 (P1 + branch), cleared: (1) "transactions table" → orange
     "check: fresh? enough rows? empty columns?" → "training"; (2) → "eval gate" → "serving"; (3) a red
     `arrow-down` from the check, "halt, keep the old model, alert". Narration: checks come in layers, cheap
     to expensive: always-on freshness and volume checks; watching whether the spread of fraud scores drifts
     away from real fraud; and a sampled review by a second model or a person, done only occasionally
     because it costs more; halting was right, but a stale model is also an outage, so the fraud model gets
     a freshness SLO ("a fresh model passes by Thingyan morning"); once training runs every night by itself
     it is production, and while it is an experiment SRE only advises.
  7. **What counts as a change?** Page `l27_p05` (K2) "What counts as a change?" · "A new model, or a
     silent update" · "A prompt, template or setting" · "All go through evals and canary". Narration:
     slower answers and worse answers both block a rollout; guardrails let Padauk ship faster, not slower;
     test agent workflows as whole systems.
  8. **The agent's blast radius.** Board B3 (P6 lanes), cleared: (1) top lane "read chat" → "find
     transaction" → "open refund ticket", with a red wrong ID carried along; (2) bottom lane, the same steps
     with green shields "validate the ID" and "tickets only, no money moves"; (3) "log every tool call".
     Narration: give the agent a step budget and a rule to hand over to a person after N steps; never let one
     agent read untrusted chats, see wallet data and send messages freely: Ask Padauk's SMS tool may only
     text the customer's own verified number, enforced in plain code; prompt injection works because the
     model's rules and the user's text arrive in the same channel, so check what goes in and what comes out;
     downloaded models and datasets are dependencies too; log prompts and answers with personal data removed.
  9. **Launching an AI feature.** Page `l27_p06` (K6) "Launching an AI feature" · "50 real complaints" ·
     "Rollback tested" · "5% of chats" · "Grade 2% daily". Narration: load-test with quality checks first;
     keep a tested way back to the old model or prompt, or an off switch; feed complaints and grades into
     the next round; a prototype takes days, production much longer.
  10. **This week.** Page `l27_p07` (K2) "This week" · "Mark fallback answers degraded" · "Build a 50-case
      golden set" · "Give your agent least permissions".
- **Recap (`notes.md`):** inference · token · eval · golden set · degraded answer · prompt injection ·
  **Question:** "Your AI feature returns 200 for every request. Name one SLI that would catch a wrong
  answer." (for example: right transaction picked, or no repeat question within five minutes)
- **Bridge:** "Next: the other direction. Ops Buddy asks for access to production. How do we let an AI
  agent in safely?"

### Lesson 28 · `sre-28-ai-in-production-safely` · ≈ 11 min · deck SRE 6A

**AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း** — _Letting AI help run production: Ops Buddy earns its access_

- **Prerequisites:** L06 (budgets), L17 (the action card), L22 (the cleanup script), L27 ·
  **Borrowed terms:** error budget, action card, rollback · **Pages:** 4 · **Boards:** 5 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain why a small AI error rate is dangerous at production scale, and start AI where mistakes are
     cheap;
  2. let an agent earn access from read-only with a reviewed track record;
  3. decide autonomy per action on an action card, never per agent;
  4. use two separate budgets (the service's and the agent's own), a stop button, and small undoable
     actions only;
  5. treat the agent as a service with its own SLOs and continuous evaluation.
- **Padauk:** **Ops Buddy earns its access.** Ko Zaw runs it in dry-run mode for a month: it makes 40
  suggestions, and the review finds 31 right, 6 harmless and 3 wrong. A Friday session teaches seniors and
  new engineers what it does well and badly. Its first solo action is pausing a promo SMS batch when
  one-time-password latency rises; restarting a stuck dispatch worker still needs approval, and it never
  touches the ledger. It pauses itself during the Thingyan freeze, has its own safety budget, and there is
  a stop button. Lesson 22's cleanup script is why it starts read-only.
- **Scenes:**
  1. **Hook.** Page `l28_p01` (K1) "Ops Buddy asks for production access" · "A person errs once; someone
     notices" · "An agent wrong 1 in 200 repeats it" · "Production has no sandbox". Narration: systems
     outgrow scripts and human attention; AI reads messy input and handles cases nobody wrote rules for, so
     skip it where simple rules already work.
  2. **Where Ops Buddy may help.** Board B1 (P3, the Padauk loop): (1) the loop as furniture; (2) green notes
     "Notice: group complaints" and "Learn: draft timelines"; (3) orange "Respond: suggests only, at first".
     Narration: Padauk starts where mistakes are cheap and people check the output; psychological safety
     comes first, so the tool is never used to score people, and pushing everyone to use it before it is
     safe damages trust.
  3. **Ko Zaw's dry-run month.** Board B2 (P8 timeline), cleared: (1) ticks "week 1–4: dry run, 40
     suggestions" and "review: 31 right, 6 harmless, 3 wrong"; (2) ticks "Friday teaching session" and
     "first solo action". Narration: tools age but principles last; a model swap is a production change;
     when something isn't ready, Padauk tries again in a few months.
  4. **The action card.** Board B3, cleared: (1) card rows "pause a promo SMS batch" → green "acts, then
     tells" and "add one Top-up instance" → green "acts, then tells"; (2) "shift operator weight 10%" →
     orange "asks first" and "restart stuck dispatch worker" → orange "asks first"; (3) "touch the ledger" →
     red "never". Narration: the same card as the failover bot's in Lesson 17: each row also says how to undo
     the action and when it must stop; autonomy is decided per action, by how critical it is and how costly
     a mistake would be; a row moves up only with tests, rollback, budgets and a track record, and lower is
     often better; approving every single step turns into rubber-stamping, so a review is feedback that
     earns the next step.
  5. **Before Ops Buddy touches production.** Page `l28_p02` (K2) "Before Ops Buddy touches production" ·
     "Read-only first, least privilege" · "Dry run before every action" · "A stop button that works".
     Narration: never an admin token "just to try it"; Lesson 22's cleanup script is the reason.
  6. **Two budgets and a brake.** Board B4 (P5), cleared: (1) two bars "service's error budget" and "Ops
     Buddy's safety budget"; (2) red `arrow-down` strokes "service budget spent → suggests only" and "safety
     budget spent → pauses"; (3) a red ellipse "STOP". Narration: Ops Buddy also pauses itself during a
     change freeze and checks whether an incident is open before it acts.
  7. **One undoable unit.** Board B5 (P1 + branch), cleared: (1) "act" → "warm-up" → "watch" →
     "healthy?"; (2) green "keep" and a red `arrow-down` "auto-undo"; (3) an outer rectangle "one audited
     unit", example "pause SMS batch; resume when OTP recovers". Narration: no known undo, no action; even
     when a whole release can't be rolled back (Lesson 26), each agent action must be small and undoable,
     and actions that destroy or reshape data stay with people; Ops Buddy is a service with its own SLOs for
     speed, usefulness and safety, checked continuously against what people did in past incidents, and
     every incident feeds those checks.
  8. **What people do now.** Page `l28_p03` (K2) "What people do now" · "Set goals and limits" · "Check
     evidence, approve, stop" · "Take the new, hard problems". Narration: AI won't replace SREs; people move
     from inside the loop to above it; cheaper reliability work means more of it gets built, so the work
     grows rather than shrinks; senior engineers' caution is reasonable, so earn their trust with evidence.
     The lasting principles: AI helps people rather than replacing them, autonomy comes in steps, checking
     never stops, and the AI that runs production must itself be reliable.
  9. **This week.** Page `l28_p04` (K2) "This week" · "Give your AI helper read-only" · "List actions it may
     never take" · "Build the stop button first".
- **Recap (`notes.md`):** action card · two budgets · stop button · undoable action · dry run ·
  **Question:** "An agent action has no known undo. What does Ops Buddy's card say?" (no action: it stays
  with people)
- **Bridge:** "With the brakes in place, where does AI actually help? Next: a green dashboard and a wall
  of angry comments on a Friday promo."

### Lesson 29 · `sre-29-where-ai-helps-operations` · ≈ 10 min · deck SRE 6A

**AI က operations မှာ ဘယ်နေရာ ကူညီလဲ** — _Where AI helps operations: complaints, incidents, toil and reviews_

- **Prerequisites:** L28 · **Borrowed terms:** mitigation, toil, playbook · **Pages:** 4 · **Boards:** 4 ·
  **Chars:** 7,600
- **Goals.** The learner can:
  1. explain why averages and anomaly detection miss pain concentrated in a small group, and how grouping
     written complaints finds it;
  2. use AI during an incident (summaries, a fix picked from a menu) and after it (cause, drafted
     postmortem, fleet scan);
  3. turn past human fixes into playbooks and then guarded agents, measured by how often tickets reopen;
  4. explain with arithmetic why removing toil has a limit, and aim AI at building systems;
  5. let teams experiment locally and graduate what works.
- **Padauk:** **the Friday promo**: the success rate reads 99.7%, yet users on Operator B with app version
  5.3 can't top up. An AI groups 420 complaints, a spike stands out, the Top-up on-call is paged, and about
  2,100 affected users get a message instead of all 1.2 million. Ops Buddy writes running summaries and
  handoffs, suggests a rollback with its confidence, and a person approves it. The next day it helps find
  the cause: app 5.3 retries a top-up without an idempotency key, and Operator B rejects the duplicate. It
  drafts the postmortem, and a scan across every codebase finds 7 more payment calls without idempotency
  keys. **Settlement-file toil** becomes a playbook.
- **Scenes:**
  1. **Hook.** Page `l29_p01` (K1) "Green dashboard, angry comments" · "Success rate: 99.7%" · "Operator B
     users on app 5.3 fail" · "Why did no alert fire?"
  2. **Before: the complaints chart.** Board B1 (P5): (1) bars of Ma Su's tagged complaints that evening by
     app version and operator: "5.1 / A", "5.2 / A", "5.3 / A"; (2) "5.3 / B" spiking red (38) and "5.3 /
     C"; (3) a small label "an AI grouped 420 messages". Narration: averages hide pain in a small group, and
     small error rates compound: the supermarket's nightly settlement check makes 500 calls, and at 0.2%
     errors per call about 63% of its nightly runs fail while our dashboard shows 99.8%; anomaly detection
     tends to mistake launches and traffic shifts for failures.
  3. **Complaints as a signal.** Page `l29_p02` (K2) "Complaints as a signal" · "People say what, where,
     when" · "Group size shows how bad" · "Backs up metrics, never replaces". Narration: users often notice
     partial failures first; the filters and guardrails around the model made it work, which is mostly
     plumbing, not magic.
  4. **During.** Board B2 (P6, lane "during"), cleared: (1) "summary for latecomers" → "handoff draft";
     (2) → "rollback suggested (confidence: high)"; (3) a green box below, "a person approves". Narration:
     below a confidence line Padauk set, Ops Buddy shows nothing at all, so a weak guess can't pull the
     on-call engineer the wrong way; fewer "what's happening?" messages in the channel.
  5. **After.** Board B3 (P6, lane "next day"), cleared: (1) "cause found: retry without idempotency key";
     (2) → "postmortem drafted" → "people write the lessons"; (3) an orange box "fleet scan: 7 more payment
     calls". Narration: during the incident Ops Buddy picks from a known menu of fixes and a person approves;
     the next day it builds hypotheses from traces and logs, and people confirm; it also searches the
     postmortem archive, refreshes playbooks against what responders actually did, and can build a
     dashboard from similar past incidents; the fleet scan ties back to Lesson 1's loan and Lesson 11.
  6. **The toil loop.** Board B4 (P3 ring), cleared: (1) on the track "find toil in tickets and chats" →
     "merge duplicates"; (2) → "playbook from past human fixes" → "guarded agent or person"; (3) red
     "reopened?" back to the start, and a side box "ask for missing details first". Narration: the meaning of
     toil hasn't changed since Lesson 17; what's new is how fast the automation itself gets built; the
     reopen rate measures the agent; settlement-file toil became a playbook this way.
  7. **Beyond toil.** Page `l29_p03` (K7) "At most 97%" · "Toil 30% of the week, 10× faster". Narration:
     removing toil can only give back time, so the real gain is the new work AI makes affordable: first-pass
     design and launch reviews, checking that a resilience test's fault really hit and that we survived it,
     comparing running config with our rules under Lesson 28's safety rules; teams experiment locally and
     the platform adopts what works; on-call moves up to new kinds of problems. SRE's oldest idea still
     holds: do the operations work, then engineer it away; AI widens what can be engineered away.
  8. **This week.** Page `l29_p04` (K2) "This week" · "Group complaints by version, region" · "Let AI draft
     a timeline" · "Turn one repeated fix into a playbook".
- **Recap (`notes.md`):** complaint grouping · confidence line · playbook · reopen rate · limit of removing
  toil · fleet scan · **Question:** "A nightly job makes 500 calls at 0.1% errors each. Roughly how often does a
  run hit at least one error?" (about 39%)
- **Bridge:** "All of this assumed Padauk's own platform and team. Next: Padauk buys a small delivery
  startup, and Ko Min goes there as its first SRE. Where does he start?"

### Lesson 30 · `sre-30-the-first-sre` · ≈ 10 min · deck SRE 6B

**ပထမဆုံး SRE** — _The first SRE at a small company: Ko Min's first 30 days_

- **Prerequisites:** helpful but not required; this lesson is on the developer quick path and stands on
  its own · **Borrowed terms:** SLO, critical user journey, rollback · **Pages:** 6 · **Boards:** 2 ·
  **Chars:** 7,600
- **Goals.** The learner can:
  1. explain how a lone SRE's job differs from a big team's, and why spreading the work is the real job;
  2. order the first weeks from the company's own facts, keeping one visible priority list;
  3. explain why one-button rollback matters most in a first deploy fix;
  4. set up a few user checks and plain, shared visibility;
  5. keep playbooks reachable offline, and grow reliability through shared on-call and review.
- **Padauk:** Padauk buys **Padauk Parcel**, a small Mandalay delivery startup: 8 engineers, no SRE,
  outages every week, a dispatch worker that keeps hanging, and deploys only one person can run, a person
  who leaves in two weeks. **Ko Min goes there as its first SRE**, with Thiri as his mentor and her team as
  his peers. His order comes from Parcel's facts: deploys first, the hanging worker second, three user
  checks third; then developers share on-call and every change gets a reviewer.
- **Scenes:**
  1. **Hook.** Page `l30_p01` (K1) "Ko Min becomes a first SRE" · "Padauk bought Parcel: 8 engineers" ·
     "Weekly outages; one person deploys" · "And he leaves in two weeks".
  2. **Day 1.** Page `l30_p02` (K2) "Ko Min's day-1 questions" · "What hurts customers most?" · "Who can
     deploy, and until when?" · "What does an hour down cost?" Narration: adapt, don't copy a big company;
     Lesson 15 said one SRE isn't a team, so Ko Min's real job is to spread the work; his first weeks will be
     mostly hand-work, and that is expected, while the ceiling on ops work still applies later.
  3. **A team of one.** Board B1 (P6 lanes): (1) top lane blue "big SRE team" → "SLOs, budgets, automation
     first"; (2) bottom lane green "team of one" → "survive, see, ship safely"; (3) under it one person box
     with "responder · builder · teacher". Narration: you don't need a big team; persuading and teaching are
     half the job.
  4. **Ko Min's diary.** Board B2 (P8 timeline), cleared: (1) ticks "day 3: deploy steps written with the
     leaver" and "day 10: one-button deploy + rollback"; (2) ticks "day 14: the leaver goes; deploys still
     work" and "day 21: dispatch worker fixed"; (3) tick "day 30: three user checks live". Narration: why
     deploys came first at Parcel; of one-step, rollback-able and no-downtime deploys, rollback matters most,
     because it stops panicked fixing-forward that turns one outage into several; one ordered list shared
     with the founders, where something enters only when something else leaves and finished items are
     shown.
  5. **Parcel's user checks.** Page `l30_p03` (K4) "Parcel's three user checks" · "A rider can accept a
     job" · "A label prints" · "A customer sees tracking". Narration: the journey idea from Lesson 7; alert on
     user symptoms only, quietly and actionably; logs go to one place in one shape (JSON lines both people
     and machines can read); one toolset for metrics, logs and traces, because gluing several together is
     toil Ko Min can't afford; switch a new alert on in the morning, not as you leave.
  6. **Playbooks.** Page `l30_p04` (K2) "Playbooks Ko Min keeps" · "Written during the fire" · "An offline
     copy, too" · "Anyone can run rollback". Narration: the wiki may be down when you need it; a rollback
     only Ko Min can run is useless at 2 a.m.
  7. **Grow beyond yourself.** Page `l30_p05` (K4) "Grow beyond yourself" · "Developers share on-call" ·
     "Every change: one human reviewer" · "First SLOs on two journeys". Narration: reduce human review only
     after SLOs are wired into alerts and reliably met; be the person who makes the safe way easy, not the
     one who says no.
  8. **This week.** Page `l30_p06` (K2) "This week" · "Name your repeat fire" · "Write rollback steps anyone
     runs" · "Share your ordered priority list".
- **Recap (`notes.md`):** priority list · repeat fire · rollback · playbook · shared on-call ·
  **Question:** "The only person who can deploy leaves next month. What goes first on your list?" (make
  deploys and rollback something anyone can run)
- **Bridge:** "Next: SRE inside old, regulated companies and around systems you can't change. Wallets are
  locked at midnight and the fix takes five minutes. Why did it take seventy?"

### Lesson 31 · `sre-31-sre-in-legacy-and-regulated` · ≈ 11 min · deck SRE 6B

**ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE** — _SRE in old, regulated companies, around systems you can't change_

- **Prerequisites:** L09 and L10 (incident commander), L17 (toil), L30 · **Borrowed terms:** incident
  commander, toil audit, break-glass · **Pages:** 5 · **Boards:** 4 · **Chars:** 8,400
- **Goals.** The learner can:
  1. connect authority to access: an incident commander's mandate plus pre-approved, time-limited,
     guarded emergency access;
  2. turn "too much toil" into a business case with a toil audit;
  3. stabilize closed vendor systems by wrapping them, and alert on user symptoms;
  4. spread SRE in a siloed organization with one shared, practical tool;
  5. run a crisis with the incident skills you already have, see one problem through reliability, security
     and privacy, and write what SRE means where you work.
- **Padauk:** Padauk links with a partner bank and runs the closed vendor billing system behind Bill Pay;
  Ko Zaw (ex-bank) leads. **Midnight wallet lock**: the outsourced support desk had read-only access, so
  approval to act took 70 minutes; the new setup is an incident-commander mandate sponsored by Ko Nay Lin
  and two-hour break-glass access with a second approver and an audit log; the same fix now takes 5
  minutes; the postmortem also serves as the report to the (hypothetical) regulator. **The vendor billing
  system**: a toil audit finds 45 hours a month; Padauk puts the system's surroundings into code, writes a
  restart script and puts its own gateway in front (timeouts, a queue, metrics, a config check); fee tables
  stay human-only. **One SLO report**: Ko Zaw builds one report that reads the vendor's monitoring, Padauk's
  metrics and the bank link checks. **A monsoon flood** hits riders and restaurants. **NRC numbers turn up
  in the vendor system's logs.**
- **Scenes:**
  1. **Hook.** Page `l31_p01` (K1) "Midnight: wallets locked 70 minutes" · "The outsourced desk could only
     look" · "Approval took over an hour" · "The fix took five minutes".
  2. **Authority and access.** Board B1 (P1): (1) blue "incident commander: mandate" → an orange
     "break-glass" box; (2) three small lock labels "expires in 2 h", "second approver", "audit log"; (3) a
     gray "read-only desk" and green "70 min → 5 min". Narration: responders need both to see and to act;
     access is least privilege by default, with the same controls for all production access, not only in
     incidents; the desk's voice in the postmortem turned "we could only watch" into an action item with an
     owner, and leadership gave time for it.
  3. **Complaint → business case.** Page `l31_p02` (K3) "Complaint | Business case" · "Too much toil | 45
     hours monthly, 2 incidents" · "Ignored | Approved" · "Automation forever | An owner maintains it".
     Narration: prevention needs time and commitment; automation is never set-and-forget, and when it
     fails it gets a blameless review too.
  4. **Wrap the vendor system.** Board B2, cleared: (1) a locked box "vendor billing (can't change)"
     inside a larger orange rectangle "our setup as code"; (2) "users" → blue "our gateway: timeouts, queue,
     metrics, config check" → the box; (3) green "alert on user success rate". Narration: a protective layer
     in front of a system you can't change (an anticorruption layer); standardize the layer you manage;
     alerts on user symptoms work across every stack, old or new.
  5. **When you can't change it.** Page `l31_p03` (K4) "When you can't change it" · "Start with one
     system" · "Generic moves: roll back, drain, fail over" · "Drill its recovery anyway". Narration:
     automate only where acting beats waiting for a person; the fee tables stay human-only.
  6. **One shared report.** Board B3 (P2, fan-in), cleared: (1) "vendor monitoring", "Padauk metrics",
     "bank link checks" each → a bus; (2) violet "one SLO report". Narration: Ko Zaw's move to bring SRE to
     the bank side: one tool that plugs into what already exists, rather than a mandate; in low-trust or
     expert-poor companies, a small central group often works better than embedding SREs everywhere
     (Lesson 15); "blameless" must never become a shield against owning action items; the free Workbook's
     chapter on organizational change is good reading.
  7. **Monsoon night.** Page `l31_p04` (K2) "Monsoon night" · "Rider safety call list" · "Shops switch to
     cash on delivery" · "One status page for everyone". Narration: incident skills carry over to crises;
     Padauk borrows the public Incident Command System's idea that one person runs the response while each
     function acts in its own area; it fits Padauk now: too big for "everyone jump on one call", too small
     for a full-time emergency team.
  8. **One problem, three lenses.** Board B4 (P2 comb), cleared: (1) "NRC numbers in vendor logs" → bus;
     (2) → "reliability: log bill, full disks" and "security: exposure"; (3) → "privacy: used beyond its
     purpose". Narration: the same habits serve all three; when a library vulnerability hits, Padauk runs it
     as one incident, gives every team the same finish line (upgraded, or a written exception, with status
     recorded) and asks each team for proof, not just "done".
  9. **What SRE means here.** Page `l31_p05` (K2) "This week" · "Write who approves emergency access" · "Run
     a one-hour toil audit" · "Write: what SRE means here". Narration before the list: for Padauk, SRE was
     never a tool it bought; it picked the practices that fit its size, budget and (hypothetical) regulator;
     your SRE might be a platform team, an on-call rotation or a stronger DevOps team, and it needs time and
     a manager's backing.
- **Recap (`notes.md`):** break-glass · toil audit · anticorruption layer · executive sponsor · one SLO
  report · **Question:** "Your outsourced desk can only watch during incidents. Name two guards that make
  emergency access safe." (time limit, second approver, audit log)
- **Bridge:** "Last lesson: three months of uptime numbers said nothing about what was coming. What
  does?"

### Lesson 32 · `sre-32-the-road-ahead` · ≈ 11 min · deck SRE 6B

**SRE ရဲ့ ရှေ့ခရီး** — _The road ahead: Padauk's year-end review_

- **Prerequisites:** the whole course, especially L11, L13, L25, L26, L28 · **Borrowed terms:** postmortem,
  shift down, canary · **Pages:** 5 · **Boards:** 4 · **Chars:** 8,400
- **Goals.** The learner can:
  1. explain availability as a backward-looking signal and risk as a forward-looking one;
  2. keep a risk sheet from postmortems and near misses, find the biggest pattern and fix it once in shared
     infrastructure;
  3. prepare for agents doing more production work: many small changes each with its own canary, and a
     catalog of every service with an owner;
  4. describe how the SRE role moves toward a generalist who directs agents with principles;
  5. choose their own next step, on the loop.
- **Padauk:** **the year-end review.** Uptime of 99.94%, 99.95% and 99.71% over three months predicted
  nothing. Thiri rereads 31 postmortems and 12 near misses and builds her own risk sheet: 11 incidents came
  from config pushed everywhere at once without checks, so the shared config service gets checks and staged
  rollout. Postmortems now end with "risks we found". **The weekly release train** grows from about 90
  changes to about 600 and is replaced by one pipeline and one canary per change. **The ownerless
  service**: services grew from 35 to 90, and one of them, an agent-built "operator balance checker" with
  no owner, sat in the top-up path; now nothing deploys without a catalog entry. **Thiri as generalist**:
  she checks the unfamiliar rider-dispatch system by giving agents principle checks (timeouts, shedding,
  canary, fallbacks) and picks two fixes before Thingyan. Toil crept back to 45% as services grew, then
  fell to 15%, and pages fell from 20 to 6 a week, with the same team.
- **Scenes:**
  1. **Hook.** Page `l32_p01` (K1) "Uptime looks backward" · "Three months: 99.94, 99.95, 99.71%" · "None
     said what was coming" · "The risk was there first".
  2. **Leading vs trailing.** Board B1 (P5): (1) three months of blue "risks found" bars rising 12 → 19 →
     27; (2) green availability bars level, then a red third month; (3) labels "leading" over the risk bars
     and "trailing" over availability. Narration: remember the list of loans Padauk wrote on Thingyan eve
     in Lesson 1? That was its first risk sheet: debt and risk show up before the outages do.
  3. **Thiri's risk sheet.** Board B2 (P5), cleared: (1) bars from 31 postmortems and 12 near misses:
     "config pushed everywhere: 11", "retries: 7", "capacity: 5", "other: 8"; (2) cleared: a green slab
     "shared config service: checks + staged rollout" under "Wallet · Top-up · Eats". Narration: one fix in
     shared infrastructure removes a whole pattern, which is shift down from Lesson 25, the platform
     carrying it for every team; postmortems now list "risks we found"; reviews of designs by people and by
     agents add more; keep looking.
  4. **What Padauk kept, what it changed.** Page `l32_p02` (K3) "What we kept | What we changed" ·
     "Blameless reviews | Who writes the code" · "SLOs on user journeys | How many services run" · "Rollback
     before anything | The release train". Narration: people depend on services like Padauk more every year, so
     this work only grows; guess the future carefully; the habits that got Padauk here won't carry it
     through the next stage on their own.
  5. **The release train.** Board B3 (P6), cleared: (1) a big red box "weekly release train: ~600 changes"
     with "which one broke it?"; (2) one lane "change" → "tests" → "1%" → "all", with one bad change caught
     alone in green; (3) the label "× 600, each alone". Narration: many small changes, each in its own
     pipeline with its own canary.
  6. **Before any deploy.** Page `l32_p03` (K2) "Before any deploy" · "A catalog entry" · "A named owner" ·
     "A rollback". Narration: the ownerless balance checker in the top-up path; supervising agents is active
     work: setting goals, checking evidence, approving, stopping, and taking over the new, hard problems.
  7. **What Padauk learned to value.** Page `l32_p04` (K4) "What Padauk learned to value" · "Say what you
     don't know" · "Write it down so others act" · "Make the safe way easy". Narration: Thiri the
     generalist and the principle checks; toil and pages fell with the same team; automation frees people
     for harder problems, so the work changes rather than disappears, said honestly, with no promises about
     jobs.
  8. **The course on one loop.** Board B4 (P3, the Padauk loop), cleared: (1) the loop as furniture; (2)
     `check` marks at Agree and Notice as the narration recalls the Top-up SLO and the Eats journey; (3)
     `check` marks at Respond, Learn and Build in (the payday incident, the first postmortem, the platform).
     Narration: the whole journey from Thingyan eve in Lesson 1 to now; the people in the hub kept it
     turning; reliability is never finished.
  9. **Your next step.** Page `l32_p05` (K2) "Your next step" · "Add 'risks we found' to postmortems" ·
     "Start a risk sheet" · "Try one lesson this month".
- **Recap (`notes.md`):** leading signal · risk sheet · service catalog · generalist · the Padauk loop ·
  **Question:** "Which station of the loop is your team weakest at today, and what is one step this week?"
  (open answer). The course closes: Padauk's story, like reliability, keeps going.

## What the course leaves out

Anything that would only be "one more list on a slide" becomes a sentence or is left out, within each
lesson's idea budget. Left out everywhere: the book's case studies and anything that looks like them;
every figure and table, and every list kept in the book's own selection and order; book-coined framework
names; internal product and program names; the book's exact numbers and percentages; epigraphs, quotes,
slogans and catchphrases; SRE history; reading lists; the appendices. The private coverage map records,
lesson by lesson, which ideas are explained, which get one sentence, and which are left out and why.

## Sources

Every scene's `sources:` credits the book once, as `{ title: "Site Reliability Engineering, 2nd edition
(O'Reilly, 2026)", url: "https://sre.google/books/" }`, plus at least one public source for the lesson
below. Sources without a mark were verified on 2026-10-17; sources marked † were added in the curriculum
revision and must have their URL opened and checked before a YAML uses them. The 2nd edition is not free
online, so never cite O'Reilly chapter URLs. Sources support the ideas only; the course still teaches in
our own words. The book is credited in `sources` and the lesson description, never in the narration.
Prefer a non-Google source where one fits, so the course reads as drawing on the field, not on one
company's book.

### Lesson 1 · Why running software is the hard part

- [SRE book second edition (Google Cloud Blog)](https://cloud.google.com/blog/products/devops-sre/sre-book-second-edition) — the 2026 rewrite and the decade of change (AI, microservices, multi-cloud, serverless, platform engineering).
- [20 Years of SRE at Google](https://sre.google/20/) — lessons from twenty years of practice.
- [SRE book, 1st ed: Foreword](https://sre.google/sre-book/foreword/) and [Preface](https://sre.google/sre-book/preface/) — software engineering applied to operations.
- † [Ward Cunningham, "The WyCash Portfolio Management System" (OOPSLA 1992 experience report)](http://c2.com/doc/oopsla92.html) — the origin of the technical-debt metaphor.
- † [Martin Fowler: Technical Debt](https://martinfowler.com/bliki/TechnicalDebt.html) — debt, interest and when to repay.

### Lesson 2 · What SRE is

- [SRE book, 1st ed: Introduction](https://sre.google/sre-book/introduction/) — SRE as software engineers running operations; a cap on ops work.
- [Workbook: How SRE Relates to DevOps](https://sre.google/workbook/how-sre-relates/) — SRE as one concrete way to practise DevOps.
- [Prodverbs](https://sre.google/prodverbs/) — short rules of thumb about production.

### Lesson 3 · The value of reliability

- [SRE book, 1st ed: Embracing Risk](https://sre.google/sre-book/embracing-risk/) — 100% is the wrong target; risk tolerance is a business choice.
- [SRE book, 1st ed: Availability Table](https://sre.google/sre-book/availability-table/) — what each "nine" allows.
- [The Calculus of Service Availability (research.google)](https://research.google/pubs/the-calculus-of-service-availability/) — availability is capped by dependencies.
- † [DORA: The four keys / software delivery performance](https://dora.dev/guides/dora-metrics-four-keys/) — stability and speed measured together.

### Lesson 4 · Production then and now

- [SRE book, 1st ed: The Production Environment at Google](https://sre.google/sre-book/production-environment/) — a 2016 baseline, useful for "then vs now".
- [Google Cloud Well-Architected Framework: Reliability pillar](https://docs.cloud.google.com/architecture/framework/reliability) — current cloud reliability principles.
- [Hybrid and multicloud architecture patterns](https://docs.cloud.google.com/architecture/hybrid-multicloud-patterns) — production across on-prem, several clouds and edge.
- † [CNCF Platforms White Paper](https://tag-app-delivery.cncf.io/whitepapers/platforms/) — golden paths and self-service platforms.
- † [FinOps Foundation: FinOps principles](https://www.finops.org/framework/principles/) — capacity as a spending decision.

### Lesson 5 · Reliability culture

- [Westrum, "A typology of organisational cultures" (BMJ Qual Saf, PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC1765804/) — the primary source for the three culture types and how each treats information.
- [DORA capability: Generative organizational culture](https://dora.dev/capabilities/generative-organizational-culture/) — culture predicts delivery performance.
- [re:Work: Understand team effectiveness](https://rework.withgoogle.com/intl/en/guides/understand-team-effectiveness) — psychological safety as the top factor in team effectiveness.
- [DORA capability: Learning culture](https://dora.dev/capabilities/learning-culture/) — learning as a capability you can measure.
- † [Etsy, "Debriefing Facilitation Guide"](https://extfiles.etsy.com/DebriefingFacilitationGuide.pdf) — running blameless reviews and asking questions without blame.
- † Sidney Dekker's public writing on restorative just culture — accountability that repairs rather than punishes (find and verify a public URL).

### Lesson 6 · SLOs and error budgets

- [SRE book, 1st ed: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/) — SLI, SLO, SLA.
- [Workbook: Implementing SLOs](https://sre.google/workbook/implementing-slos/) — from SLI to SLO, with error budgets.
- [Workbook: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) — burn rate and multi-window alerts.
- [Workbook: Example Error Budget Policy](https://sre.google/workbook/error-budget-policy/) — what a team agrees to do when the budget runs out.
- [SRE fundamentals: SLAs vs SLOs vs SLIs (Google Cloud Blog)](https://cloud.google.com/blog/products/devops-sre/sre-fundamentals-slis-slas-and-slos) — the three terms in plain language.
- † [Brendan Gregg: The USE Method](https://www.brendangregg.com/usemethod.html) and † [Tom Wilkie: The RED Method (Grafana blog)](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/) — generic first metrics.

### Lesson 7 · SLOs from the user's side

- [Product-Focused Reliability for SRE (sre.google)](https://sre.google/resources/practices-and-processes/product-focused-reliability-for-sre/) — critical user journeys as the unit of reliability.
- [OpenTelemetry: Browser getting started](https://opentelemetry.io/docs/languages/js/getting-started/browser/) — client-side telemetry.
- [web.dev: Web Vitals](https://web.dev/articles/vitals) — user-felt client metrics.
- † [Hyrum's Law](https://www.hyrumslaw.com/) — every observable behavior gets relied on.

### Lesson 8 · Observability

- [OpenTelemetry: Observability primer](https://opentelemetry.io/docs/concepts/observability-primer/) — observability vs monitoring.
- [OpenTelemetry: Signals](https://opentelemetry.io/docs/concepts/signals/) — traces, metrics, logs and profiles.
- [SRE book, 1st ed: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) — the four golden signals; symptoms vs causes.
- [What is eBPF?](https://ebpf.io/what-is-ebpf/) — collecting telemetry without changing app code.
- † The OECD Privacy Guidelines — collection limits and purpose, for telemetry that is personal data (find and verify the URL).

### Lesson 9 · Sustainable on-call

- [Workbook: On-Call](https://sre.google/workbook/on-call/) — sustainable rotations and paging load.
- [Google SRE Incident Management Guide (sre.google)](https://sre.google/resources/practices-and-processes/incident-management-guide/) — incident roles, the incident commander.
- [PagerDuty Incident Response docs: Different Roles](https://response.pagerduty.com/before/different_roles/) — IC, scribe and subject-matter-expert roles.
- † [Atlassian Incident Management Handbook](https://www.atlassian.com/incident-management/handbook) — declaring incidents and assigning roles.

### Lesson 10 · Working an incident

- [SRE book, 1st ed: Managing Incidents](https://sre.google/sre-book/managing-incidents/) — separate roles, a live incident document, clear handoffs.
- [Workbook: Incident Response](https://sre.google/workbook/incident-response/) — incident command applied to software.
- † [PagerDuty Incident Response docs: Severity Levels](https://response.pagerduty.com/before/severity_levels/) — a public way to size harm.
- [OODA loop (Wikipedia)](https://en.wikipedia.org/wiki/OODA_loop) — Boyd's observe-orient-decide-act loop.

### Lesson 11 · Postmortems

- [Workbook: Postmortem Culture: Learning from Failure](https://sre.google/workbook/postmortem-culture/) — writing and sharing postmortems that teach.
- [SRE book, 1st ed: Postmortem Culture](https://sre.google/sre-book/postmortem-culture/) — blameless postmortems.
- † [SRE book, 1st ed: Example Postmortem](https://sre.google/sre-book/example-postmortem/) — a public example with "what went well" and "where we got lucky".
- † [Etsy, "Debriefing Facilitation Guide"](https://extfiles.etsy.com/DebriefingFacilitationGuide.pdf) — local rationality and questions without blame.

### Lesson 12 · How complex systems fail

- [Reason, "Human error: models and management" (BMJ, PMC)](https://pmc.ncbi.nlm.nih.gov/articles/PMC1117770/) — the Swiss cheese model.
- [How Complex Systems Fail (Richard Cook)](https://how.complexsystems.fail/) — failure needs several flaws at once.
- [Hollnagel, Wears & Braithwaite, "From Safety-I to Safety-II: A White Paper" (NHS England PDF)](https://www.england.nhs.uk/signuptosafety/wp-content/uploads/sites/16/2015/10/safety-1-safety-2-whte-papr.pdf) — learning from what goes right.
- [Defence at the Boundary of Acceptable Performance (SREcon24 Americas)](https://www.usenix.org/conference/srecon24americas/presentation/hatch) — Rasmussen's drift model applied to SRE.
- [Paper notes: Going Solid (Cook & Rasmussen)](https://ferd.ca/notes/paper-going-solid.html) — how loaded systems lose their buffers.
- † [Woods, "Four concepts for resilience and the implications for the future of resilience engineering" (Reliability Engineering & System Safety, 2015)](https://doi.org/10.1016/j.ress.2015.03.018) — decompensation and graceful extensibility.
- † Sidney Dekker, _Drift into Failure_ (Ashgate, 2011) — drift from another angle (cite the publisher page).

### Lesson 13 · STPA and CAST

- [STPA Handbook (Leveson & Thomas, MIT PSASS, PDF)](https://psas.scripts.mit.edu/home/get_file.php?name=STPA_Handbook.pdf) — control structures, unsafe control actions, loss scenarios.
- [CAST Handbook (Leveson, MIT PSASS, PDF)](https://psas.scripts.mit.edu/home/get_file4.php?name=CAST_Handbook.pdf) — analyzing a loss through the control structure, and the critique of event chains.
- [STAMP at Google (sre.google)](https://sre.google/resources/practices-and-processes/stpa/) — STPA and CAST on software systems.
- [Teaching a new way to prevent outages at Google (sre.google)](https://sre.google/stpa/teaching/) — how STPA is taught.
- [STPA for Software Systems (SREcon25 EMEA)](https://www.usenix.org/conference/srecon25emea/presentation/klein) — STPA applied to software services.

### Lesson 14 · Becoming an SRE

- [SRE book, 1st ed: Accelerating SREs to On-Call and Beyond](https://sre.google/sre-book/accelerating-sre-on-call/) — onboarding paths and shadowing.
- [Workbook: SRE Team Lifecycles](https://sre.google/workbook/team-lifecycles/) — how a team grows from its first SRE.
- [Why heroism is bad (sre.google)](https://sre.google/resources/practices-and-processes/no-heroes/) — why one person filling every gap hurts the team.
- [SRE Fundamentals course (sre.google)](https://sre.google/resources/practices-and-processes/sre-fundamentals-course/) — a public training path.
- [DORA capability: Well-being](https://dora.dev/capabilities/well-being/) — burnout and working conditions.

### Lesson 15 · Where SRE lives

- [SRE at Google: How to structure your SRE team (Google Cloud Blog)](https://cloud.google.com/blog/products/devops-sre/how-sre-teams-are-organized-and-how-to-get-started) — team shapes and their trade-offs.
- [Workbook: Organizational Change Management in SRE](https://sre.google/workbook/organizational-change/) — rolling out a new structure.
- † [Team Topologies: key concepts](https://teamtopologies.com/key-concepts) — Conway's law and team design.
- † [DORA: The four keys, with its caution against comparing teams](https://dora.dev/guides/dora-metrics-four-keys/) — why delivery numbers should not rank teams.

### Lesson 16 · Working with product teams

- [SRE book, 1st ed: The Evolving SRE Engagement Model](https://sre.google/sre-book/evolving-sre-engagement-model/) — readiness reviews and early engagement.
- [Workbook: SRE Engagement Model](https://sre.google/workbook/engagement-model/) — setting up and ending support.
- [SRE book, 1st ed: Launch Coordination Checklist](https://sre.google/sre-book/launch-checklist/) — what a readiness check covers.
- [SRE at Google: How to structure your SRE team (Google Cloud Blog)](https://cloud.google.com/blog/products/devops-sre/how-sre-teams-are-organized-and-how-to-get-started) — the public list of team shapes.

### Lesson 17 · Toil and automation

- [SRE book, 1st ed: Eliminating Toil](https://sre.google/sre-book/eliminating-toil/) — what counts as toil.
- [Workbook: Eliminating Toil](https://sre.google/workbook/eliminating-toil/) — measuring toil and choosing what to automate.
- [SRE book, 1st ed: The Evolution of Automation at Google](https://sre.google/sre-book/automation-at-google/) — automation's own risks.
- † [Bainbridge, "Ironies of Automation" (Automatica 19(6), 1983)](<https://doi.org/10.1016/0005-1098(83)90046-8>) — taking over from automation, and watching for rare events.
- † Sheridan & Verplank, _Human and Computer Control of Undersea Teleoperators_ (MIT, 1978) — the public origin of graded levels of automation behind the action card.

### Lesson 18 · Testing and config

- [SRE book, 1st ed: Testing for Reliability](https://sre.google/sre-book/testing-reliability/) — test types from unit to production probes.
- † [OpenGitOps principles](https://opengitops.dev/) — declared, versioned, pulled and reconciled configuration, and drift.
- † [Martin Fowler: The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) — test layers.

### Lesson 19 · Testing in production

- [Workbook: Canarying Releases](https://sre.google/workbook/canarying-releases/) — comparing a canary against a control.
- [Principles of Chaos Engineering](https://principlesofchaos.org/) — steady state, hypothesis, injection, comparison, limited blast radius.
- [SRE principles in practice for business continuity (Google Cloud Blog)](https://cloud.google.com/blog/products/management-tools/sre-principles-in-practice-for-business-continuity) — planned disaster testing.

### Lesson 20 · Capacity planning

- [Capacity Planning (USENIX ;login:, Feb 2015)](https://www.usenix.org/publications/login/feb15/capacity-planning) — forecasting demand, N+2 redundancy.
- [Workbook: Managing Load](https://sre.google/workbook/managing-load/) — load balancing and autoscaling.
- [Kubernetes: Autoscaling Workloads](https://kubernetes.io/docs/concepts/workloads/autoscaling/) — dynamic capacity.
- [Using load shedding to avoid overload (AWS Builders' Library)](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/) — what to drop under load. (Redirects to builder.aws.com.)

### Lesson 21 · Data you're trusted with

- [SRE book, 1st ed: Data Integrity: What You Read Is What You Wrote](https://sre.google/sre-book/data-integrity/) — integrity, defence in depth.
- [Building Secure and Reliable Systems, Ch 9: Design for Recovery](https://google.github.io/building-secure-and-reliable-systems/raw/ch09.html) — restoring to a known-good state.
- † The OECD Privacy Guidelines — purpose limits and collection limits (find and verify the URL).

### Lesson 22 · Backups and restores

- [Google Cloud: Disaster recovery planning guide](https://docs.cloud.google.com/architecture/dr-scenarios-planning-guide) — RTO and RPO.
- [SRE book, 1st ed: Managing Critical State](https://sre.google/sre-book/managing-critical-state/) — replication for state that must not be lost.
- † A public-body explanation of the 3-2-1 backup rule, such as CISA's data backup guidance (find and verify the URL).

### Lesson 23 · Containing failure

- [The Calculus of Service Availability (research.google)](https://research.google/pubs/the-calculus-of-service-availability/) — how dependencies limit availability.
- [Building Secure and Reliable Systems, Ch 8: Design for Resilience](https://google.github.io/building-secure-and-reliable-systems/raw/ch08.html) — defence in depth, blast-radius control.
- † [AWS Builders' Library: Static stability using Availability Zones](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/) — zones that stay independent.

### Lesson 24 · Overload, change and emergencies

- [SRE book, 1st ed: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/) — how overload spreads and how to stop it.
- [Workbook: Managing Overload](https://sre.google/workbook/overload/) — overload control in practice.
- [Timeouts, retries, and backoff with jitter (AWS Builders' Library)](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) — safe retries. (Redirects to builder.aws.com.)
- [Using load shedding to avoid overload (AWS Builders' Library)](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/) — shedding by priority.

### Lesson 25 · Platform engineering

- [CNCF Platforms White Paper](https://tag-app-delivery.cncf.io/whitepapers/platforms/) — platform as a product, golden paths.
- [CNCF Platform Engineering Maturity Model](https://tag-app-delivery.cncf.io/whitepapers/platform-eng-maturity-model/) — platform team maturity.
- [DORA capability: Platform engineering](https://dora.dev/capabilities/platform-engineering/) — research on internal platforms.
- † Google Cloud's public blog writing on "shifting down" into the platform (find and verify the article URL).
- † Hargreaves (Rivers) and Brookbank, PlatformCon 2025 talk on matching oversight to consequence — credit for the right-sized control idea (add the talk URL).

### Lesson 26 · When AI writes the code

- [DORA: State of AI-assisted Software Development 2025](https://dora.dev/research/2025/dora-report/) — how AI tools change throughput and stability.
- [DORA AI Capabilities Model](https://dora.dev/ai/capabilities-model/) — practices that decide whether AI adoption helps.
- [AI in SRE (sre.google)](https://sre.google/resources/practices-and-processes/ai-engineering-reliable-operations/) — code generation speeds up; review and operations must keep up.

### Lesson 27 · Reliability for AI features

- [MLOps: Continuous delivery and automation pipelines in ML (Google Cloud)](https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning) — continuous training and serving.
- [Hidden Technical Debt in Machine Learning Systems (NeurIPS 2015)](https://papers.nips.cc/paper_files/paper/2015/hash/86df7dcfd896fcaf2674f757a2463eba-Abstract.html) — data dependencies and feedback loops.
- [The ML Test Score (research.google)](https://research.google/pubs/the-ml-test-score-a-rubric-for-ml-production-readiness-and-technical-debt-reduction/) — production readiness for ML.
- [Rules of Machine Learning (Google for Developers)](https://developers.google.com/machine-learning/guides/rules-of-ml) — monitoring and launching ML systems.
- † [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) — prompt injection and other AI risks.
- † [Simon Willison: The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) — untrusted input, private data and outside communication.

### Lesson 28 · AI in production, safely

- [AI in SRE (sre.google)](https://sre.google/resources/practices-and-processes/ai-engineering-reliable-operations/) — AI agents with humans kept in control.
- [DORA: State of AI-assisted Software Development 2025](https://dora.dev/research/2025/dora-report/) — trust in AI output.
- † [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) — vendor-neutral guidance on governing AI systems.
- † Sheridan & Verplank (1978), as in Lesson 17 — graded levels of automation.

### Lesson 29 · Where AI helps operations

- [SRE book second edition (Google Cloud Blog)](https://cloud.google.com/blog/products/devops-sre/sre-book-second-edition) — AI for triage, telemetry questions and postmortem drafting.
- [DORA: State of AI-assisted Software Development 2025](https://dora.dev/research/2025/dora-report/) — where AI helps.
- [Workbook: Eliminating Toil](https://sre.google/workbook/eliminating-toil/) — toil's definition, unchanged.

### Lesson 30 · The first SRE

- [Succeeding as the Lone SRE in a Small Team (SREcon23 EMEA)](https://www.usenix.org/conference/srecon23emea/presentation/kirchmeier) — the solo-SRE situation.
- [From Nothing to SRE: Implementing SRE in Smaller Organisations (SREcon19 EMEA)](https://www.usenix.org/conference/srecon19emea/presentation/huxtable) — SRE with fewer than about 50 engineers.
- [SRE book, 1st ed: Embracing Risk](https://sre.google/sre-book/embracing-risk/) — choosing how much reliability to buy.

### Lesson 31 · SRE in old and regulated companies

- [Workbook: SRE: Reaching Beyond Your Walls](https://sre.google/workbook/reaching-beyond/) — SRE outside one big-tech setting.
- [Workbook: Organizational Change Management in SRE](https://sre.google/workbook/organizational-change/) — spreading a practice through an organization.
- [Strangler Fig Application (Martin Fowler)](https://martinfowler.com/bliki/StranglerFigApplication.html) — replacing a legacy system step by step.
- † [FEMA IS-100.c: Introduction to the Incident Command System](https://training.fema.gov/is/courseoverview.aspx?code=IS-100.c) — public-domain crisis coordination.

### Lesson 32 · The road ahead

- [20 Years of SRE at Google](https://sre.google/20/) — looking back to see where the practice is heading.
- [The Evolution of SRE at Google (USENIX ;login:)](https://usenix.org/publications/loginonline/evolution-sre-google) — from error budgets to systems-theory safety.
- [Workbook: Conclusion](https://sre.google/workbook/conclusion/) — what stays constant as SRE spreads.

## Copyright approach

The book is licensed CC BY-NC-ND 4.0. NoDerivatives means we may not publish a translation, adaptation,
abridgment or close paraphrase. Ideas, methods and widely used industry terms are not owned, so the
course teaches the ideas and builds everything else itself:

- **Our own words.** Narration, slides and boards are written fresh. No sentence, list or heading of the
  book is translated or closely paraphrased.
- **Lists come from Padauk or from a public source.** A page or board never maps one-to-one onto a book
  list, table, figure or section sequence: if each line has a partner in the book in the same order,
  rewrite it, even when every item is renamed. The items on a list are what happened at Padauk, or they
  come from a named public primary source cited in `sources`.
- **The story decides the order.** No lesson follows a chapter's heading order for more than two
  consecutive scenes; the Padauk story sets the scene order.
- **No book-coined frameworks on screen.** Names and taxonomies the book coined are not used as on-screen
  frameworks; teach the idea in our own explanation, or cite its original public source when one exists.
- **Our own examples.** Every story is a Padauk story with invented numbers. None of the book's case
  studies, companies, incidents or anecdotes appears, nor anything built to resemble one.
- **Our own diagrams.** No figure or table is redrawn. The course map is the Padauk reliability loop: a
  feedback loop with people in its hub, our own picture with our own station names. Boards follow the
  course's own eight patterns.
- **Named public models stay public.** Ideas with their own public literature are taught from that
  literature and cited to it in `sources`: Westrum's culture types, the Swiss cheese model (Reason),
  drift (Rasmussen, Dekker), Safety-II (Hollnagel), how complex systems fail (Cook), decompensation
  (Woods), STAMP, STPA and CAST (Leveson), the ironies of automation (Bainbridge), levels of automation
  (Sheridan), Hyrum's law, Goodhart's law, Conway's law, OODA, the golden signals, RED and USE, the
  Principles of Chaos Engineering, OpenGitOps, the Incident Command System, just culture (Dekker), the
  technical-debt metaphor (Cunningham), DORA research, and the burn-rate alerts, error budget policy, toil
  definition and on-call numbers in the free first edition and Workbook.
- **No slogans.** The private chapter notes list each chapter's distinctive phrases, quotes and metaphors
  to avoid, and the private coverage map adds label phrasings that must never reach narration;
  voice-script writers check both before writing and reviewers check again.
- **Credit without reproduction.** The book is credited in every scene's `sources` and in each lesson's
  description, with the non-affiliation line, and never read aloud. No "Google" in course or lesson
  titles, and the course is never presented as a translation.
- **Where notes live.** This repo is public. Notes made while reading the book (chapter notes, briefs,
  the coverage map, critiques) stay outside it, in `~/Documents/sre-course/`. Only our own course
  material (this guide, the glossary, the voice scripts and the lesson YAML) lives in
  `docs/sre-course/` and `src/studio/scripts/`; this guide holds no chapter-by-chapter lists of the
  book's ideas.

## Producing the course

**Week 0, three probes before any deck or voice work:**

1. **Myanmar probe page** in a copied template deck (Noto Sans Myanmar, line spacing 1.3, mixed English
   terms). Chan publishes it, the Director fetches it, and the shaping is checked in the pinned SVG.
   This gates every deck, and its KB-per-page decides whether any deck must split further.
2. **VoxCPM2 pronunciation probe** for SRE, SLO, SLI, SLA, RPO, RTO, MTTR, STPA, CAST, on-call,
   postmortem, toil, rollout, canary and numbers like 99.9% and 3,000. Chan picks the spoken forms, and
   they go into `BURMESE_RESPELLINGS` (public repo change). Many lesson titles start with an acronym.
3. **One real-Chrome `/studio` render** of an English copy of the platform probe (Pocket voice), plus
   one look at the published lesson on /learn to see what the dock shows.

**Weekly rhythm** (deck N renders while deck N+1's voice scripts are written):

| When            | Work                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the week | Voice scripts for the deck's lessons are drafted, then reviewed and approved by Chan. Slide lines and board labels are finalized from the approved script.                                      |
| Day 1           | Build the deck from the page specs, check thumbnails, Chan publishes (one click). Measure the boards with `wb-overflow.ts` from the standard coordinates.                                       |
| Day 2           | Write the YAMLs. Run `studio-director.ts` and `studio-compile-check.ts` (0 warnings, no dialog over 2,000 characters, marks after `။` or `၊`, every lesson between 7,000 and 8,400 characters). |
| Days 3–4        | Render in Chrome `/studio` with VoxCPM2, tab in front. Watch each replay.                                                                                                                       |
| Day 5           | Fix, re-render, draft, publish, add to the playlist in order. One commit per lesson (YAML + critique.json).                                                                                     |

Nine decks take ten production weeks: deck SRE 3 (five lessons, 52 minutes) takes two, and the lighter
decks (SRE 5A, 5C, 6B) absorb slippage.

**Review checklist per lesson:**

- Burmese on every page is shaped correctly; every page passes the slide lint (K2 lines ≤ 7 words, K6
  chips ≤ 3 words, K7 one formula and one line), and Burmese titles stay within about 20 code points.
- Every board label fits its box with space on the right; nothing outside x 250–1100 / y 150–650; no
  board maximized; no yellow ink, no translucent fills; colours keep their jobs; loops read clockwise;
  bars, not curves; no left or up arrows; each step adds at most three elements.
- Each board step lands as its words are spoken; something changes at least every 30 seconds; no static
  page carries more than two extra ideas.
- Padauk names and numbers match the fact sheet; every number on a board adds up on screen.
- **Copyright check:** open the matching chapter's heading list (from the private notes) beside the scene
  list, and each list-like page or board beside its book passage; if more than two scenes in a row follow
  the headings, or a page's lines each have a partner in the same order, rewrite. No book sentences,
  figures, tables, case studies, coined frameworks or slogans.
- The narration is connected, spoken Burmese with English kept for developer terms, per
  [glossary.md](./glossary.md); the recap ends with its question; the bridge asks the next lesson's
  question.

**Open decisions for Chan:**

1. The course title ("SRE from zero" recommended) and the ပစ်တိုင်းထောင် mascot, which also sits in the
   hub of the Padauk loop.
2. Approval of the running example: the fictional Padauk company, its people and products, and a final
   name check for "Padauk" before the first publish.
3. The spoken forms of the acronyms (from the week-0 probe).
4. The catalog description wording, including the non-affiliation line.
