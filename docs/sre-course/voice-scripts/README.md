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

1. **Pacing is a curriculum question, not a wording one.** The guide wants something on screen to
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
   step. Fixing either problem means adding pages or board steps in the specs. Two examples: split
   "three meanings of SRE" off l02_p03, or give L04 a B1 step 4 with an orange "control plane: 1 နာရီ၊
   customer ထောင်ချီ". Should we amend the specs, or accept this for Module 1?

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
