# SRE from zero · Module 1 voice scripts

These are the Burmese voice scripts for the five Module 1 lessons of "SRE from zero". Please review
them before any YAML is built. Each script follows its lesson spec in
[../curriculum.md](../curriculum.md) and uses the terms in [../glossary.md](../glossary.md). Nothing
here has been voiced or rendered yet.

| File                             | Lesson                              | Counted characters | ≈ min of speech |
| -------------------------------- | ----------------------------------- | ------------------ | --------------- |
| `sre-01-why-reliability-now.md`  | 1 · SRE ဘာကြောင့် လိုလာတာလဲ         | 7,894              | 9.4             |
| `sre-02-what-sre-is.md`          | 2 · SRE ဆိုတာ ဘာလဲ                  | 7,923              | 9.4             |
| `sre-03-value-of-reliability.md` | 3 · Reliability ရဲ့ တန်ဖိုး         | 7,867              | 9.4             |
| `sre-04-production-then-now.md`  | 4 · Production ဘယ်လို ပြောင်းလဲလာလဲ | 7,926              | 9.4             |
| `sre-05-reliability-culture.md`  | 5 · Reliability ယဉ်ကျေးမှု          | 7,928              | 9.4             |

The budget is 7,600 characters ±5%, so each lesson must land between 7,220 and 7,980. Minutes are
estimated at VoxCPM2's pace of about 14 Burmese characters a second. Pauses, page changes and gaps
between dialogs bring each lesson to about 10 rendered minutes. The module comes to 39,538
characters, about 47 minutes of speech. To recount after an edit, run:
`python3 -I ~/Documents/sre-course/work/count-narration.py docs/sre-course/voice-scripts/sre-0*.md`.

## How to read a script

- **Header:** the lesson title, its slug, and the character budget.
- **`## Scene N · …`:** the scene names from the lesson spec, in English. Scenes are not spoken.
- **`chapter:`** is the chapter label the /learn player shows. `—` means the scene starts no new
  chapter.
- **Lines starting with `> `** are the narration, and only these are spoken. Each line is roughly one
  dialog. Everything else in the file is for the build.
- **Markers `⟪…⟫`** are actions, not speech. The counter skips them.
  - `⟪page l03_p02⟫` shows that page of deck SRE 1. `⟪close page⟫` hides it.
  - `⟪board B2 step 1⟫` draws step 1 of board B2 from the spec. `⟪close board⟫` hides the board.
  - `⟪notes⟫` opens `notes.md`.
  - `⟪select X⟫` highlights the text X in `notes.md` as the narration names it.
  - `⟪pause 3s⟫` is the silence before the answer to the recap question.
- **`On screen:`** lists what the learner sees during the scene. The Burmese wording there is
  proposed with the narration, so the page and the voice match.
  - **Page lines** show the page id and kit (K1 cover, K2 three points, K3 compare, K4 three cards),
    then the text items in order, separated by `|`.
    - A K1 cover reads: lesson number | title | headline | two lines | the question | loop badge.
    - In a K3 compare page each row is `left / right`: gray on the left, teal on the right. The first
      item is the column header, or the page title when it has no `/`.
  - **Board steps** show `(1)`, `(2)`, `(3)` in drawing order. Each step lists its labels, separated
    by `|`. Text in parentheses is a drawing note (colour, shape, layout), not a label. `cleared`
    means the board is wiped before that step.
  - **`notes.md`** shows the recap file line by line, with `(blank line)` for empty lines.

## What the consistency pass changed

All five scripts were read together against the fact sheet, the story spine, the first-use table and
the glossary. These are the changes from the separately reviewed drafts:

- **Openings.** Only Lesson 1 greets with "မင်္ဂလာပါ ခင်ဗျာ". The shipped CSS, React and Rust courses
  do the same: only their first lesson greets. Lessons 2–5 open with one "Padauk so far" sentence that names what Padauk kept from
  the lesson before:
  - L02: the list of shortcut loans from L01.
  - L03: the config check and the fee alert from L02.
  - L04: Ko Nay Lin's buy-in and Thiri's first-year list from L03.
  - L05: the config check, the alert and the template from L02–L04.
- **Same words everywhere.**
  - "SRE အဖွဲ့", never "SRE team" (L01 had "team"). Also "Top-up အဖွဲ့".
  - "ဝန်ဆောင်ခ" for the fee in L01–L04.
  - "ငွေ နှစ်ခါ ဖြတ်" for the double charge (L03 had "2 ခါ").
  - "SMS code" in L03–L05. L03 had said "OTP", a word the glossary doesn't have, for the same codes.
  - "merchant တွေဆီ ငွေလွှဲတဲ့ settlement job" in both L04 and L05. L04 had "settlement batch" with no
    explanation.
  - "lesson 3" in lowercase.
  - "ဒီအပတ် လုပ်စရာ" as the title of every This week page.
- **Numbers.** Small counts are written in Burmese words (သုံးခု, သုံးမျိုး, နှစ်ခု). Measurements
  and story numbers stay in digits (3 နာရီ, 30 မိနစ်, 10 ဆ, user 1800). This follows the shipped
  Burmese lessons.
- **First use.**
  - "you build it, you run it" is now named once, in L04, where the glossary first uses it. L01
    describes the idea without the English name.
  - L03 adds one line saying that SLO and error budget are the proper names for L01's agreed risk
    limit, which L01 promised the learner.
  - L05's awards line says "SMS provider အရန်" instead of "failover", which L05 never explains.
- **Story.**
  - In L02, Ma Hnin (not Ko Nay Lin) now asks whether everything must be 100%. Ko Nay Lin's push for
    100% then happens once, in L03, as the story spine has it.
  - In L03, Bill Pay is now launching soon, since it only ships in L04.
  - L04's recap question and notes now say "dashboard" instead of "status page". The lesson never
    introduces a status page, and the glossary uses that term for a public page for customers.
  - L05 no longer calls the review Padauk's "first" blameless review (see question 4).
  - L05's bridge says "အချိန်ပြည့် SRE အဖြစ် ခန့်လိုက်ပါတယ်", the same words L01 used when it promised
    this.
- **Bridges.** Each lesson's last question now asks the same thing as the next lesson's cover:

  | From | Bridge asks                                           | Next cover asks                      |
  | ---- | ----------------------------------------------------- | ------------------------------------ |
  | L01  | typo, 20 minutes of 10× fees: ဘာကို အရင်ဆုံး ပြင်မလဲ? | ဘာကို အရင် ပြင်မလဲ?                  |
  | L02  | shop QR down 30 minutes: 30 minutes, or much bigger?  | ဘယ်ဂဏန်းက တကယ့် ကုန်ကျစရိတ်လဲ?       |
  | L03  | all green, Bank Y 20 seconds: dashboard or user?      | ဘယ်သူ မှန်လဲ?                        |
  | L04  | 9 p.m., developer ကိုမင်း, laughed at: ပြောရဲပါ့မလား? | ကိုမင်း ပြောရဲပါ့မလား?               |
  | L05  | Thiri full-time; finance wants 100%: how reliable?    | (L06) How reliable should Top-up be? |

- **Less templated.** Five lessons had opened the recap, the pause question ("ကဲ၊ မေးခွန်း တစ်ခု
  မေးပါရစေ … ဆိုပါစို့"), the answer, the bridge and the This week page with the same words. Each lesson
  now words them differently. L02's description of the loop now points back to lesson 1 instead of
  repeating L01's sentence.
- **Layout of the On screen lists.** Covers are written `N | title`. `notes.md` always uses
  `term — explanation` (L03 had bare terms). Blank lines and K3 rows use one notation. L01's separate
  This week chapter is gone, since no other lesson has one.

## Open questions for Chan

**Whole module**

1. **Pacing (decided, listed for information).** The guide wants something on screen to
   change at least every 30 seconds, but many scenes get only one page or board step. These hold
   longer, estimated from one page advance or board step to the next:
   - L01: l01_p02 73 s, l01_p03 64 s, l01_p04 55 s, l01_p01 52 s, B2 step 1 33 s.
   - L02: l02_p03 59 s, l02_p04 54 s, l02_p01 43 s, l02_p02 39 s; B1 steps 40 / 40 / 43 s,
     B3 step 3 44 s.
   - L03: l03_p02 80 s, l03_p03 76 s, l03_p04 61 s, l03_p01 40 s; B1 and B2 step 3 34 s each.
   - L04: B1 step 3 71 s (autoscaling, spot vs reserved, managed services and the provider's control
     plane all sit on one step); l04_p02 57 s, l04_p03 45 s, l04_p04 43 s, l04_p05 42 s.
   - L05: l05_p04 84 s, l05_p03 55 s, l05_p05 54 s, l05_p02 53 s; B2 step 1 43 s, B3 step 2 42 s.

   Also, L05's B2 step 1 draws four boxes plus a circle, over the limit of three new elements per
   step. **Decided (no input needed):** when the YAML is built, long stretches get extra page advances
   or board steps (a second page, or a board split into more steps) placed at existing sentence ends.
   The spoken narration you approve stays word for word; only the on-screen plan and markers change.

2. **Pronunciation probe before the first render.** Please check these by ear (glossary 4.2–4.3):
   - Padauk → ပိတောက်
   - idempotency
   - top-up / Top-up
   - DORA ("Dora")
   - Westrum
   - CTO
   - pathological, bureaucratic, generative
   - toil, postmortem, rollout, rollback, DevOps
   - four-digit numbers such as 1800, 1500 and 2000. The narration writes them without commas; the
     screen shows them with commas.
3. **SMS code or OTP.** All three lessons now say "SMS code" for the login codes. If you prefer "OTP",
   switch L03–L05 together and add an OTP row to glossary 2.14.
4. **The "first" blameless review.** L02 already has the typo engineer co-writing a no-blame
   postmortem, so L05 calling its review Padauk's "first" blameless review contradicted it. L05 now
   says blameless is "like lesson 2's postmortem". What is new in L05 is the CTO sitting in and the
   habit of a review after every incident. Is that acceptable? If you'd rather keep "first", L02's
   Learn station should lose its no-blame line instead.

**Lesson 1**

5. Keep the tea-shop image for build vs run (our own image)? Dropping it saves about 80 characters.
6. Should the loan rule "outage က ဆပ်ရမယ့် နေ့" keep the English word "outage"? It is said
   generally, as in the spec, but Padauk's Thingyan night was double charges and slow top-ups, not a
   full outage. The alternative is "ကြီးကြီးမားမား ပျက်တဲ့ နေ့". The same wording is in the recap and
   in notes.md.

**Lesson 2**

7. Are "ပိုတို / ပိုနည်း / ပိုသေး" the right words for shorter, rarer and smaller? "ပိုရှား" sounded odd
   for incidents. An alternative would be "ခဏခဏ မဖြစ်အောင်".
8. The hook explains config: "code မပြင်ဘဲ ဝန်ဆောင်ခ နှုန်းတွေကို ပြောင်းလို့ရတဲ့ config". It is
   there because the glossary asks for an explanation before L18, and it costs about 45 characters.
   Keep it, or cut it if every developer already knows config?
9. Which cover headline? "မိနစ် 20၊ ဝန်ဆောင်ခ 10 ဆ" (23 characters, with a ၊), or "မိနစ် 20 ကြာ
   ဝန်ဆောင်ခ 10 ဆ", which the chapter label already uses?

**Lesson 3**

10. "ရင်းနှီးမြှုပ်နှံမှု တစ်ခုလို" is fairly formal. Keep it, or say the English "investment
    တစ်ခုလို"?
11. The recap question makes 99% an agreed level ("99 ရာခိုင်နှုန်း reliable ဖြစ်ရင် လုံလောက်ပြီ
    ဆိုရင်…") rather than the spec's literal "Your service is 99% reliable". Is that OK?
12. Scene 6 no longer says that the planned handback is covered in lesson 16. It was cut for length,
    and that page already holds about 76 seconds. Add it back (about 50 characters)?
13. The L03 cover badge now lights သဘောတူ (Agree), because the lesson seeds the agreed target, just as
    L04 lights သတိထားမိ. Is that OK?

**Lesson 4**

14. "ဂိတ်" for gate (page title "ဂိတ် မဟုတ်ဘဲ guardrail", recap and notes.md) can sound like a bus
    terminal in Yangon. Keep it, use "ကင်းဂိတ်", or say the English "gate"?
15. "အလဟဿ ဖြစ်နေတဲ့ ငွေ" (narration and B1 label) replaced "အလကား ထိုင်နေတဲ့ ငွေ", which copied
    "idle money". Does it sound natural?

**Lesson 5**

16. Is the hook "team chat ထဲမှာ စာရိုက်ပြီးပေမဲ့ ပို့ဖို့ ချီတုံချတုံ ဖြစ်နေပါတယ်" how you would say it?
17. **Copyright caution (resolved).** The confidence check followed the book's survey schedule and a
    five-step answer scale close to the book's. It now uses our own three answers (မလုပ်ရဲသေးဘူး /
    တစ်ယောက်ယောက် ဘေးမှာ ရှိရင် လုပ်နိုင်တယ် / ကိုယ့်ဘာသာ လုပ်နိုင်တယ်), asked once before the habit starts
    and again a few months later. The curriculum spec was changed to match. Please check the new sentence
    reads naturally.
18. Should the three Westrum types stay in English (pathological, bureaucratic, generative) with a
    Burmese gloss, or get Burmese labels in the narration?
19. Ko Aung skipped the 2 a.m. check on an earlier night, since he was away during the Thingyan
    stall. Does that fit the story spine and L14's callback to his settlement nights?

## Module 2

These are the Burmese voice scripts for the three Module 2 lessons (Agree and notice, deck SRE 2).
They use the same layout as Module 1 (see "How to read a script") and were read together against
the approved Module 1 scripts, the fact sheet, the story spine and the glossary. Nothing here has been
voiced or rendered yet.

| File                                | Lesson                              | Counted characters | ≈ min of speech |
| ----------------------------------- | ----------------------------------- | ------------------ | --------------- |
| `sre-06-slo-error-budget.md`        | 6 · SLO နဲ့ error budget            | 8,807              | 10.5            |
| `sre-07-slo-from-the-users-side.md` | 7 · User ဘက်က ကြည့်တဲ့ SLO          | 8,799              | 10.5            |
| `sre-08-observability.md`           | 8 · Monitoring ကနေ observability ဆီ | 8,784              | 10.5            |

The budget is 8,400 characters ±5%, so each lesson must land between 7,980 and 8,820. All three sit
near the top. Pauses, page changes and gaps between dialogs bring each lesson to about 11 rendered
minutes. The module comes to 26,390 characters, about 31 minutes of speech. The recount command above
covers these files too.

**New on screen in Module 2:**

- Pages also use K5 (four cards), K6 (a ladder: the chips in order, then a `(caption)` line), K7 (one
  big number or formula, then one line) and K8 (the module map `m2_map`, in L06 only).
- A page id with a letter suffix (`l06_p02b`, `l07_p04c`) is an extra page that keeps one page from
  holding too long. Pages sit in the deck in script order.

### What the consistency pass changed

- **Openings.** Each lesson opens with one "Padauk so far" sentence that names what Padauk kept from
  the lesson before:
  - L06: the 30-minute blameless review after every incident, and Thiri as full-time SRE (L05).
  - L07: Top-up's agreed SLOs and its error budget policy (L06).
  - L08: the journey SLO and the SLOs for the top 10 merchants (L07). It now also says what a journey
    SLO measures ("order တစ်ခုကို အစအဆုံး တိုင်းတဲ့"), because critical user journey is one of L08's
    borrowed terms. It no longer reuses L03's opening pattern ("… ကတည်းက Padauk မှာ … ရှိလာပါပြီ").
- **Same words everywhere.**
  - "Padauk API" for the front door in L06–L08. L07 had "API gateway" (narration and l07_p02), which
    sat too close to the "operator gateway".
  - "operator gateway client" in L07 and L08. L08 had "shared gateway client"; its B4 step 1 label now
    reads "gateway client က / dashboard".
  - "လစာထုတ်ရက်" for payday all through L06. It had mixed it with "လစာရက်" (narration, l06_p02d and
    l06_p06b).
  - "အကြီးဆုံး merchant 10 ခု" in L07 and L08 (L08 had "ဆယ်ခု"). A story number stays in digits, as in
    Module 1.
  - "အစိမ်းရောင်" in the narration (L08 had one bare "အစိမ်း").
  - "အလိုအလျောက် rollback", the glossary's own example (L08 had "အလိုလို rollback").
  - "Eats သုံးတဲ့ payment service" in L07. The payment service belongs to Padauk, not to Eats, and L06
    has the ledger team promising it an SLO.
  - "ငွေဝင်ငွေထွက် စာရင်း၊ ledger" in L06, with the comma every other gloss uses.
- **First use.**
  - L08's This week no longer says "SRE အဖွဲ့". L08 never says "Site Reliability Engineering", and the
    glossary wants the full phrase before the acronym in each lesson.
  - L06 is on both quick paths, so learners may arrive without L03–L05. Its first mention of Ko Nay Lin
    now says "CTO". For the same reason L08 now says "support က မစု".
- **Story.**
  - L06 answers L05's bridge question in Scene 4: not 100%, but airtime within 10 seconds for 99.5% of
    top-ups and a refund within an hour (page l06_p03b "Top-up ရဲ့ အဖြေ"). Its hook now asks the
    question in L05's exact words ("ဒါဆို" dropped).
  - L06 Scene 8 drops "အကြွေးဆပ်သလို" (a reviewer question). In L01, paying back the loan is the good
    habit, so calling a year-long freeze "paying off a debt" pulled against L01's image. This also saves
    16 characters.
  - L07's bridge now says "app က ဖုန်းဘေလ် ဝင်ကြောင်း ဘယ်တော့မှ မပြ", in the words of L08's hook.
  - L08's in-country log rule now points back to L04's rule ("lesson 4 က စည်းမျဉ်းလိုပဲ … ဆိုပါစို့")
    instead of repeating L04's sentence. It stays hypothetical.
  - **Kept:** "top-up 20 သိန်း" in L06 (a reviewer question). The approved L01 and L08 count users as
    "12 သိန်း", so a count in သိန်း is already the course's style.
- **Less templated.**
  - This week openers. L06 echoed L05 ("သေးသေးလေး … စလို့ရပါတယ်"), L07 echoed L02 ("စမ်းလုပ် … သုံးခု
    ရှိပါတယ်") and L08 echoed L01 ("SRE အဖွဲ့ … မလိုဘဲ လုပ်ကြည့်လို့ရတာ သုံးခု"). Each now ties to its
    own lesson.
  - Recap openers. L07 and L08 both counted "အချက် N ခု", as L04 does. Both are reworded.
  - L08's "ကဲ၊ စဉ်းစားကြည့်ပါ" before the question was L02's, word for word.
  - L07's bridge opened "နောက် lesson မှာတော့", exactly like L01's. L07's answer and L06's both ran
    on "… ဆိုတော့".
  - L07 said "တိတ်တိတ်လေး" twice; the second is now "တဖြည်းဖြည်း".
  - L08 had five definitions in "… လို့ ခေါ်ပါတယ်". Cardinality and defense in depth now use "… က …
    ပါ".
  - L07 Scene 1 now says "ဘယ်သူတွေကို ပျမ်းမျှခဲ့လဲ", the same words as its chapter label and l07_p01b.
- **Bridges.** Each lesson's last question asks the same thing as the next lesson's cover:

  | From | Bridge asks                                                     | Next cover asks                    |
  | ---- | --------------------------------------------------------------- | ---------------------------------- |
  | L05  | Thiri full-time; finance wants 100%: how reliable?              | Top-up ဘယ်လောက် စိတ်ချရဖို့ လိုလဲ? |
  | L06  | Eats: every SLO green, orders stuck: what did we forget?        | ဘာကို တိုင်းဖို့ မေ့ခဲ့လဲ?         |
  | L07  | Top-up never confirms, refunds for top-ups that worked: inside? | system ရဲ့ အထဲကို ဘယ်လို မြင်မလဲ?  |
  | L08  | 2 a.m. alert into a muted 60-person Viber group: ဘယ်သူ ဖြေမလဲ?  | (L09) Who answers at 2 a.m.?       |

  L09 is not written yet. Its cover question should end on the same "ဘယ်သူ ဖြေမလဲ?".

### Open questions for Chan (Module 2)

The numbers continue from Module 1, so each question has one number.

**Whole module**

20. **Deck size and pacing (decided, listed for information).** The scripts already carry the extra
    pages that Module 1 decided to add at build time. Deck SRE 2 now plans 37 pages including `m2_map`
    (L06 15, L07 14, L08 8), against the guide's 19. Deck SRE 1 was built with 61 pages for the same
    reason and passed QA, so the size is fine and the extra pages stay. This answers the reviewer's question about
    L06's seven added pages. The longest estimated holds are l07_p01 and l08_p01 at 35 s, l06_p04 at
    33 s, l06_p01 and l07_p06 at 32 s, and l08_p03 at 31 s.
21. **Pronunciation probe additions** (glossary 4.2–4.3): OpenTelemetry; Hyrum's; failover, cache;
    SLI, SLA and NRC (SLA ends in a vowel); and these words not yet in 4.2: callback, cardinality,
    observability, telemetry, saturation, synthetic, durability, Viber, and Padauk Eats (→ ပိတောက်
    Eats).
22. **"valid"** stays English in L06 (Scenes 2 and 10, the recap, notes.md and l06_p02: "valid ဖြစ်တဲ့
    top-up"), but the glossary has no row for it. Keep it and add a row to glossary 2.2, or use a
    Burmese word?
23. **Name for an evidence-based alert** (L08). The script says "အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert" in
    Scene 8, the recap and notes.md, and its chapter label reads "အထောက်အထား ခိုင်လုံမှ page ပို့". Glossary
    2.3 has a row for it but no fixed wording. Keep the long name, or use something shorter such as
    "သေချာမှ တက်တဲ့ alert"? Whichever you choose goes into the glossary.
24. **Noise floor** (L07) is said only in Burmese, as "နောက်ခံ fail" (narration, l07_p04 and l07_p04b).
    Keep it, or say "noise floor" in English and add it to the glossary?

**Lesson 6**

25. B1 step 3 shows 99.5% before Scene 4 agrees on it. The narration calls it "99.5 ရာခိုင်နှုန်းလို
    ပစ်မှတ်", an example, and the curriculum's board spec has the number there. Is that OK, or should
    the board leave the number out until the agreement?

**Lesson 7**

26. **Copyright caution (resolved, kept).** The bad-minute page uses 99.9% of 30 days = 43 bad minutes.
    That is the standard "three nines" conversion found in nearly every SLO guide, and arithmetic is not
    the book's expression; our noise numbers (3% and 5%) and the Eats story are our own. Hearing 43 in
    L06 and again in L07 works as a callback, so the spec stays as it is.
27. "SLO ကို တင်းတင်း ထားတာက service အရေးကြီးကြောင်း ပြတဲ့ တံဆိပ် မဟုတ်ပါဘူး" (Scene 9 and l07_p06b): does
    "တံဆိပ်" sound natural for "a badge of importance", or would you say "ဂုဏ်ပြု တံဆိပ်" or the English
    "badge"?
28. The journey steps "ဟင်း ရွေး → Pay နှိပ် → ပြေစာ မြင်" appear in the narration and on l07_p02b and
    l07_p02c. Is "ဟင်း ရွေး" what a Yangon food-app user would say, or would "အစားအသောက် ရွေး" (the
    glossary's critical user journey line) or "menu ရွေး" be better?

**Lesson 8**

29. "NRC နံပါတ်" (the glossary's wording) or "မှတ်ပုံတင် နံပါတ်"? L04 said "မှတ်ပုံတင် အချက်အလက်", and
    L08 now points back to L04's in-country rule, which favours "မှတ်ပုံတင်". It appears twice in Scene
    7 and on l08_p03.
30. For defense in depth, the narration and the B2 labels use "ကြိုကာ" for prevention and "ဖမ်း" for
    detection. Do they sound natural, or would you prefer "ကြိုတား" and "ဖမ်းမိ"?
31. To fit the budget, Scene 2 lost a line saying that even a newcomer like Ko Min could trace the
    problem with connected data (about 40 characters). Do you want it back? L08 would then come to
    about 8,825, just over the 8,820 ceiling, so a few characters would have to go elsewhere.
