# SRE from zero · Module 5 voice scripts

These are the Burmese voice scripts for the nine Module 5 lessons (Build it in; decks SRE 5A, 5B and
5C). They use the same layout as Modules 1–4 (see "How to read a script" in [README.md](./README.md)).
This pass read them together against the approved scripts for Lessons 1–8, the Module 3, 4 and 6
scripts as their passes left them, Lesson 16 (whose bridge Lesson 17 answers), Lesson 26 (final; Lesson
25's bridge leads into it), the fact sheet, the story spine, the first-use table, the lesson specs in
[../curriculum.md](../curriculum.md) and [../glossary.md](../glossary.md). Nothing here has been voiced
or rendered yet.

| File                                  | Lesson                              | Counted characters | ≈ min of speech |
| ------------------------------------- | ----------------------------------- | ------------------ | --------------- |
| `sre-17-toil-and-automation.md`       | 17 · Toil နဲ့ automation              | 8,803              | 10.5            |
| `sre-18-testing-and-config.md`        | 18 · Test နဲ့ config                  | 7,953              | 9.5             |
| `sre-19-testing-in-production.md`     | 19 · Production ထဲမှာ စမ်းသပ်ခြင်း       | 7,957              | 9.5             |
| `sre-20-capacity-planning.md`         | 20 · Capacity ဘယ်လောက် လိုမလဲ            | 8,786              | 10.5            |
| `sre-21-data-you-are-trusted-with.md` | 21 · ယုံကြည်ပြီး အပ်ထားတဲ့ data            | 7,978              | 9.5             |
| `sre-22-backups-and-restores.md`      | 22 · Backup ထက် restore က ပိုအရေးကြီးတယ် | 8,810              | 10.5            |
| `sre-23-containing-failure.md`        | 23 · Failure ကို ဘောင်ခတ်ထားတဲ့ design    | 8,818              | 10.5            |
| `sre-24-overload-change-emergency.md` | 24 · Overload နဲ့ emergency mode      | 8,773              | 10.4            |
| `sre-25-platform-engineering.md`      | 25 · မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင်         | 8,782              | 10.5            |

Lessons 17, 20 and 22–25 have a budget of 8,400 characters ±5% (7,980 to 8,820). Lessons 18, 19 and 21
have 7,600 ±5% (7,220 to 7,980). All nine sit near the top of their window, as the earlier modules do;
L21 and L23 have only 4 and 2 characters to spare, so any line you add there needs a cut nearby. The
module comes to 76,660 characters, about 91 minutes of speech. Pauses, page changes and gaps between
dialogs bring it to the curriculum's 96 rendered minutes. To recount:
`python3 -I ~/Documents/sre-course/work/count-narration.py docs/sre-course/voice-scripts/sre-1[7-9]*.md docs/sre-course/voice-scripts/sre-2[0-5]*.md`.
Every spoken number is in Burmese digits: `burmese-digits.py` changed no lines on any of the nine files.

## What the consistency pass changed

The pass ran in two goes. The first (2026-10-18) edited all nine files and was checking screen holds
when a network outage stopped it, before it wrote this note. The second go checked each of those edits
against the files, the fact sheet and the neighbouring lessons, kept them except where a fix is listed
below, and finished the work.

### First go (kept unless a fix is listed under the second go)

- **Openings.** Six lessons (L17, L18, L21, L22, L24, L25) opened "ပြီးခဲ့တဲ့ lesson မှာ …", L02's words,
  and L20 had L03's "… ပြီးကတည်းက Padauk က …". Each now opens on what the lesson before kept:
  - L17: "Bill Pay နဲ့ on-call ခွဲယူတဲ့ engagement ရေးပြီးနောက် မသီရိရဲ့ Site Reliability Engineering၊ SRE
    အဖွဲ့မှာ လေးယောက် ရှိလာပါပြီ". This is also the "SRE အဖွဲ့" that the Module 4 note asked for.
  - L18 names all three things L17 kept; it adds the failover bot's action card.
  - L20: "ခေါ်သုံးတဲ့ service တိုင်းက version အလိုက် ကိန်းဂဏန်းကို မြင်ရပြီး loyalty fault test ကိုလည်း
    ညတိုင်း run ပါတယ်".
  - L24 names all three things L23 kept; it adds the queued notifications.
  - L25: "သင်္ကြန် ညနဲ့ login ပိတ်တဲ့ မနက်က သင်ခန်းစာတွေကြောင့် priority label၊ … ပြောင်းလဲမှု စည်းကမ်းနဲ့
    အရေးပေါ် အိတ်တွေက Padauk ရဲ့ ပုံမှန် ဖြစ်လာပါတယ်".
  - The openers of L19, L20 and L23 no longer all end on "… နေပါပြီ". The first go also reworded the
    openers of L21, L22 and L23, and the second go changed them again.
  - L17's map line copied L06's "ဒီ မေးခွန်းနဲ့ Module N ကို စပါမယ်". The second go changed the new line
    again.
- **Same words everywhere.**
  - "SRE အဖွဲ့", never "reliability အဖွဲ့" (L17, twice). L20 never says the full phrase, so it now says
    "မသီရိရဲ့ အဖွဲ့".
  - "ပင်မ endpoint" for Operator A's own endpoint (L17 narration and B5 step 3), L10's word. It had "မူလ
    endpoint".
  - "payment အဖွဲ့" (L17 narration and l17_p02c), not the English plural "payments".
  - "freeze စည်းကမ်း" in L25 (narration, chapter label, B1 label and l25_p01), L24's word. It had
    "စည်းမျဉ်း" (a reviewer question).
  - L22's balance check now uses L21's two kinds of mismatch: the small differences were taken for
    "lesson ၂၁ က ပုံမှန် reconciliation", and the fixed check alerts on any mismatch "batch နဲ့
    မရှင်းနိုင်တဲ့".
  - L22 says "ဆန်းပြားတာထက် … ရိုးရှင်းတဲ့ နည်း", the words on l22_p03c.
- **Covers.** l18_p01 and l23_p01 had a statement in the question slot. They now ask the bridge's
  question: "test တွေက ဘာကို မကြည့်ခဲ့လဲ?" and "failure ကို ဘယ်လို ဘောင်ခတ်မလဲ?" (l23_p01's line 3 is now
  "server တိုင်းက ယုံ၊ data က မှားနေတာ").
- **Story.**
  - The timeline now runs straight. L20's bridge had the deletion request arrive "after Thingyan", but
    L21–L23 happen before Thingyan midnight (L24). L20's bridge and L21's hook now say "while preparing
    for Thingyan", and L23's bridge says "the Thingyan midnight we prepared six weeks for".
  - L25 happens at the next year's Thingyan ("နောက်တစ်နှစ်", in L24's bridge and L25's hook). The freeze
    rule only exists from L24 on, so the freeze that a Top-up deploy breaks must be a year later. L26
    follows straight on.
  - L24's hook says why L20's preparation didn't stop the overload: the machines rented in L20 were for
    real top-ups, and most of the 20,000 requests are retries.
  - L22's staging database is one "နာမည် မပြောင်းရသေးတဲ့" (not yet renamed), because L21 gives clear names
    only to new sandboxes (a reviewer question).
  - L21's undo window is 14 days, not 7, so it doesn't sound like L22's 7 days of backups (a reviewer
    question; narration and B2 label).
  - L22's drill now says it was Eats's backups that had never been tested.
  - L23's SMS fallback arrives "on the day Padauk revisits" the risk that Scene 3 wrote down.
  - L19 no longer mentions AI-written code. AI stays in Module 6.
  - L20 now says Padauk has run its settlement jobs on spot instances since lesson 4. It had "ပထမနည်းကို
    သုံးနေပါတယ်", and a reviewer asked whether "the first way" was clear by ear.
- **Bridges.** "နောက် lesson မှာတော့" (L17, L18, L22, L23) and "နောက်တော့" (L19, L21, L24) were L01's and
  L06's bridge openers. They now open on story time: "လစာထုတ်ရက် ညနေ တစ်ခုမှာ" (L17), "ညတိုင်း diff စတဲ့
  အပတ်မှာပဲ" (L18), "ဒီလိုနဲ့" (L19), "လကုန် စာရင်းပိတ်တော့" (L21), "ခြောက်ပတ် ပြင်ဆင်ခဲ့တဲ့ သင်္ကြန်
  ညသန်းခေါင် ရောက်တော့" (L23) and "နောက်တစ်နှစ်" (L24). L22's opener was cut with nothing in its place; the
  second go adds one. L25's "Module ၆ မှာတော့", close to L08's "Module ၃ မှာတော့", is now "Module ၆
  ရောက်တော့".
  - L17's bridge and L18's hook now set the console edit on a payday evening, which L18's "a month
    later, on payday night, Operator B slows again" already implied.
  - L21's bridge now asks in L22's words: "နောက်ပြန် ဘယ်အထိ သွားလို့ ရမလဲ?".
- **Less templated.**
  - Recap openers. Six lessons opened "ပြန်နွှေးကြည့်ရအောင်" (L05's words, retired in Modules 3, 4 and 6),
    and L19 and L21 "… ပြန်စုကြည့်ရအောင်" (L11's). Each now ties to its lesson:
    - L17: "toil audit က ချန်ခဲ့တဲ့ စကားလုံးတွေပါ" (changed again in the second go).
    - L18: "weight သုည ဖြစ်ခဲ့တဲ့ ညနေကနေ ဒီ လေးခုကို ယူသွားပါ".
    - L19: "notes ထဲက ခြောက်ခုကို pricing နဲ့ loyalty ပုံပြင်နဲ့ တွဲမှတ်ပါ".
    - L21: "ဆရာမရဲ့ စာ တစ်စောင်က data အကြောင်း အများကြီး သင်ပေးခဲ့ပါတယ်".
    - L22: "incident သုံးခုကို အတိုချုပ်ရရင် ဒီလိုပါ".
    - L23: "ဘောင်ခတ်နည်းတွေကို ပြန်ခေါ်ကြည့်ပါမယ်".
    - L24: "cascading failure ကနေ စပါမယ်".
    - L25: "Module ၅ ရဲ့ နောက်ဆုံး notes ပါ".
    - L20's "သင်္ကြန် ပြင်ဆင်ရင်း သိခဲ့တာတွေပါ" stays.
  - This week openers. L17 and L22 said "ဒီအပတ် လုပ်ကြည့်ဖို့ သုံးခုပါ", L19 and L21 "ဒီအပတ် tool အသစ်
    မလိုဘဲ …", and L18, L23, L24 and L25 "(SRE / platform) အဖွဲ့ မရှိ(သေး)လည်း …", L01's shape. They now
    open on the lesson's first task or its own reason, for example L22 "မသီရိရဲ့ drill လိုပဲ backup
    တစ်ခုကို ဒီအပတ် တကယ် restore လုပ်ကြည့်ပြီး …", L23 "failure တစ်ခု ဘယ်အထိ ပျံ့နိုင်လဲ သိအောင် …" and
    L25 "ကိုယ့်ကုမ္ပဏီရဲ့ မတော်တဆ platform ကို ဒီအပတ် ဒီလို စပြင်ကြည့်ပါ".
  - Question lead-ins. L17, L23 and L24 said "(ဒါဆို) ခေါင်းထဲမှာ တွက်ကြည့်ပါ", L07's words; L21 said "ဒါဆို
    စဉ်းစားကြည့်ပါ", and L25 "နောက်ဆုံး မေးခွန်း တစ်ခုပါ" (L26 and L32 say "နောက်ဆုံး မေးခွန်းပါ"). L17 now
    says "တွက်ခြေ ကိုက်လား ကိုယ်တိုင် တွက်ကြည့်ပါ" and L24 "သင်္ကြန် ညက retry တွေကို ပြန်တွေးကြည့်ပါ"; L21
    and L25 ask with no lead-in. L23's new one is fixed below.
  - "lesson N မှာ ကြည့်ပါမယ်" pointers, which Module 3 retired: L18 now says its canary and fault test are
    "production ထဲမှာ စမ်းတာမို့ lesson ၁၉ အတွက် ချန်ထားပါမယ်", and L22 says its incident "lesson ၂၈ မှာ …
    အကြောင်းရင်း ဖြစ်လာပါမယ်".
  - "တိတ်တိတ်လေး", which Modules 2 and 4 cut back, is now "ဘယ်သူမှ မသိဘဲ" (L19) and "သတိမထားမိခင်" (L21).
    L22's line names the reconciliation instead. L18 and L21 keep one each, in Scene 7, where the silence
    is the point.
  - L25 defines platform and golden path with "… က … ပါ" instead of two more "… လို့ ခေါ်ပါတယ်".
- **Trims.** L23's bad-input list lost "ဥပမာ" and "job ရပ်သွားလို့", "loyalty point" became "loyalty", and
  L22's doubled "ဆန်းဆန်းပြားပြား … ရိုးရိုးရှင်းရှင်း" became single words.

### Second go

- **Fixes to the first go's edits.**
  - Three dialogs had dropped under the 120-character floor: L21's opening (117) and the recap questions
    of L21 (113) and L25 (108). L21's opening now names all three things L20 kept ("… run နေပြီး
    အဖွဲ့တွေက server pool တစ်ခုကို မျှသုံးပါတယ်၊ …"). Each question joins the recap line before it, as
    L22's already does.
  - L24's cover held 510 characters, about 36 seconds, after the first go lengthened the hook. "fail
    လို့" (before "ထပ်ပို့နေတဲ့ retry"), "လောက်" (after ၂၀၀၀၀) and "ကိုယ်ပိုင်" (before cache) came out: 483
    characters, about 34 s.
  - L20 moved "spot instance" to its last line without saying what it is, and L20 is the lesson that
    teaches it (glossary: L04 → L20). It now says "provider က ပြန်ယူနိုင်တဲ့ spot instance", L04's words.
  - L17's new map line "Module ၅ နဲ့ … တည်ဆောက်တဲ့ အဆင့်ကို ရောက်လာပါပြီ" was written at the same time as
    L26's "Module ၆ မှာ AI က … အဆင့်တိုင်းကို ရောက်လာပါတယ်" and came out nearly the same. It now reads
    "Module ၅ က reliability loop ရဲ့ နောက်ဆုံး အဆင့်၊ တည်ဆောက်တဲ့ အဆင့်ပါ".
  - L17's new recap opener "toil audit က ချန်ခဲ့တဲ့ စကားလုံးတွေပါ" ended like L26's "agent တွေ ရောက်လာတဲ့
    လမှာ သုံးခဲ့တဲ့ စကားလုံးတွေပါ", another module opener written at the same time. It now ends "…
    သော့ချက်တွေပါ".
  - L23's new lead-in "Eats checkout လို မြှောက်ကြည့်ပါ" matched L29's "supermarket ရဲ့ job လိုပဲ
    တွက်ကြည့်ပါ", also written in parallel. L23 now asks with no lead-in. L20's "Wallet လို
    တွက်ကြည့်ရအောင်" had the same shape and L06's "ကဲ၊ တွက်ကြည့်ရအောင်"; it now says "ကိုဇော် တွက်ခဲ့တဲ့
    ပုစ္ဆာကို ဂဏန်း ပြောင်းပြီး မေးပါမယ်".
- **Openings.**
  - L19 opened "Operator A ရဲ့ traffic သုည ဖြစ်ပြီးကတည်းက Padauk က config … check …", L03's shape and
    nearly L03's content. It now opens "routing config ပြောင်းတိုင်း check သုံးဆင့် ဖြတ်ရပြီး live config
    ကိုလည်း Git နဲ့ ညတိုင်း တိုက်ကြည့်ပါတယ်".
  - L22's "ဆရာမရဲ့ စာ နောက်မှာ Padauk က …" had the shape of L32's "ညသန်းခေါင် incident နောက်မှာ Padauk က
    …". It is now "ဆရာမရဲ့ စာကြောင့် Padauk က …".
  - L23 named one of the three things L22 kept, as "Padauk ရဲ့ backup တွေကို အခု …", the "Padauk ရဲ့ …
    အခု …" shape that L26 and L27 open with. It now names the weekly restore tests and the two-person
    deletes: "Padauk က backup တွေကို အပတ်တိုင်း restore လုပ်ပြီး စစ်သလို data အများကြီး ဖျက်တာကိုလည်း လူ
    နှစ်ယောက် အတည်ပြုမှ လုပ်ပါတယ်".
- **Same words everywhere.**
  - "Padauk API" for the front door in L24 (Scenes 2 and 5 and the l24_p02e title), as L06–L08 and L29
    say. L24 had "API gateway", the name Module 2 took out of L07.
  - "ဖျက်တဲ့ pipeline" in L22's opening, L21's words. It had "deletion pipeline".
  - "ညသန်းခေါင်" for Thingyan midnight in L19's bridge and in L20 (hook, B3 step 1 and l20_p03c), as L23
    and L24 say. They had "သန်းခေါင်ယံ".
- **First use.**
  - L17's map line used the borrowed term toil ("toil ကနေ စပါမယ်") before any clause said what it is. The
    hook now says "လက်နဲ့ ထပ်ခါထပ်ခါ လုပ်ရတဲ့ toil", in L16's bridge words.
  - L21 said "integrity" in Scene 2 and defined it only in Scene 7. Scene 2 now says "data မှန်ကန်မှု၊
    integrity", the glossary's wording.
  - L19 said change supervision was "mentioned in lesson 8", but L08 never names it; it has the automatic
    rollback after a bad deploy. L19 now says the method "lesson ၈ က အလိုအလျောက် rollback ကို
    ချဲ့ထားတာပါ".
- **Covers.** l21_p01's question slot held "ဘယ်သူ့ဆီ မိတ္တူ ရှိနေသေးလဲ?", while L20's bridge asks where her
  data lives. The two lines swap: line 3 is now the copy question, and the question slot asks "သူ့ data
  တွေ ဘယ်မှာ ရှိလဲ?". Every Module 5 cover now asks its bridge's question in the question slot.
- **Bridges.** L22's bridge ran straight on from the answer after the first go cut "နောက် lesson
  မှာတော့". It now opens "တစ်ညမှာတော့" and drops "ညတိုင်း", which L23's hook says.
- **Less templated.**
  - Hook questions. L17 to L23 all put "ဒါဆို" before the hook's question. L20, L21 and L23 drop it (each
    still asks in its bridge's words), and L18 now says "ဒီတော့ test အစိမ်းရောင်က ဘာကို တကယ်
    သက်သေပြတာလဲ?".
  - This week openers. L20's "ကိုယ့် peak မရောက်ခင် ဒီအပတ် လုပ်ကြည့်စရာ သုံးခုပါ" kept the "before X,
    three things this week" shape of L10 and L15, and L21, right after it, opens "ကိုယ့် user တွေ … ဒီအပတ်
    … သုံးခုပါ". L20 now opens on its first task: "လစာထုတ်ရက်၊ ပွဲတော်၊ promotion လို ကိုယ့် peak ရက်တွေကို
    ဒီအပတ် ပြက္ခဒိန် တစ်ခုထဲ ချရေးပါ". The first go's openers for L17, L18 and L19 all turned on "start"
    ("ဒီအပတ်ကစပြီး", "console တွေကနေ စပြီး", "စာရွက်ပေါ်ကနေ စပါ"); L18 now says "review မပါဘဲ
    ပြောင်းလို့ရနေတဲ့ config တစ်ခုကို ဒီအပတ် console တွေထဲမှာ ရှာပါ".
  - L23 said "ဒါကြောင့်" seven times. Three are now "ဆိုတော့" and "ဒီတော့".
- **Register.** L20 Scene 9 ended a sentence on a plain "ရေးထားတယ်". It now says "ရေးထားပါတယ်".

### Bridges

Each lesson's last question asks what the next cover asks:

| From | Bridge asks                                                                                                        | Next cover asks                 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| L16  | Module 5: a four-person SRE team, and over half the week is toil: ဘယ်ကနေ စမလဲ?                                       | ဘယ်ကနေ စမလဲ?                      |
| L17  | a payday evening, tests green, a console edit, no traffic to Operator A: test တွေက ဘာကို တစ်ခါမှ မကြည့်ခဲ့လဲ?                | test တွေက ဘာကို မကြည့်ခဲ့လဲ?            |
| L18  | the week the nightly diff starts, pricing's canary passes, Bill Pay times out: ဘယ်သူ့ဘက်ကို ကြည့်နေခဲ့တာလဲ?                   | ဘယ်သူ့ဘက်ကို ကြည့်နေခဲ့လဲ?                 |
| L19  | Thingyan in six weeks, last year 20,000 a second at midnight: ဒီနှစ်အတွက် ဘယ်လောက်အထိ ပြင်ဆင်ထားရမလဲ?                         | ဘယ်လောက်အထိ ပြင်ဆင်ထားရမလဲ?           |
| L20  | during the preparation, a user asks Ma Su's team to delete her account: သူ့ data တွေက တကယ်တော့ ဘယ်မှာ ရှိနေလဲ?               | သူ့ data တွေ ဘယ်မှာ ရှိလဲ?              |
| L21  | the month-end close finds a cashback bug older than the oldest backup: နောက်ပြန် ဘယ်အထိ သွားလို့ ရမလဲ?                      | (l22_p01b) နောက်ပြန် ဘယ်အထိ သွားနိုင်လဲ? |
| L22  | one night, half a price list, top-ups stop everywhere at 1 a.m.: ကြိုမစီစဉ်ထားတဲ့ failure ကို ဘယ်လို ဘောင်ခတ်မလဲ?                | failure ကို ဘယ်လို ဘောင်ခတ်မလဲ?         |
| L23  | Thingyan midnight, 20,000 a second into a service built for 3,000, servers restarting: ပြိုမကျဘဲ ဘယ်လို တည်ငြိမ်အောင် ထိန်းမလဲ? | ပြိုမကျဘဲ ဘယ်လို ထိန်းမလဲ?               |
| L24  | the next year's freeze: a Top-up deploy goes out, the rule lived on a wiki: မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင် ဘယ်လို လုပ်မလဲ?       | မှန်တဲ့နည်းကို ဘယ်လို လွယ်စေမလဲ?             |
| L25  | Module 6: coding agents, merges 15 → 120 a day: SRE အလုပ်မှာ ဘာတွေ ပြောင်းသွားမလဲ?                                        | (L26) ဘာတွေ ပြောင်းသွားမလဲ?         |

- Each hook takes up the bridge before it. L17, L19, L20, L22, L23, L24 and L25 ask the bridge's
  question in its words, and so does L26. L18 tells the same evening and answers at once ("config ကိုတော့
  ဘယ်တော့မှ မကြည့်ခဲ့ပါဘူး") before it asks what a passing test proves. L21 asks the bridge's question and
  adds "who else has a copy?".
- L17's hook also repeats L16's "SRE အဖွဲ့ … လေးယောက်", and L26's opening names the four things L25 kept
  (the platform group, the golden path, the shared gateway client and the exception list).

### Decided (no input needed)

These were open in the reviewers' notes. This pass settled them:

- **Deck size and pacing (for information).** Deck SRE 5A plans 33 pages including `m5_map` (L17 14,
  L18 10, L19 9) against the curriculum's 15; SRE 5B plans 42 (L20 15, L21 13, L22 14) against 19; SRE
  5C plans 31 (L23 6, L24 13, L25 12) against 14. This is the pacing choice every earlier module made. At
  deck SRE 1's 92 KB a page, 5B's 42 pages come to about 3.9 MB, just under the 4 MB split line, so the
  deck builder should measure KB per page after the first 5B pages. The longest estimated holds are
  l25_p01 at 35 s; l24_p01, l20_p04, l18_p01b and l25_p05 at 34 s; l19_p01 at 33 s; and L24's recap
  question, l21_p04, l20_p01 and l18_p04 at 32 s. Every dialog is 120–450 characters, and every marker
  follows ။, ၊ or ?.
- **Two cover titles stay as the curriculum sets them,** as Module 3 decided for L12 and L13: L22's
  "Backup ထက် restore က ပိုအရေးကြီးတယ်" (35 code points, 13 of them Latin letters) and L25's "မှန်တဲ့နည်းကို
  လွယ်တဲ့နည်း ဖြစ်အောင်" (36, all Burmese; about 583 of the title's 586 pt at the kit's 0.54 em). The K1
  safe maximum of 34 assumes pure Burmese, and both are catalog titles. The deck builder checks both
  thumbnails, and a title comes back to you only if it overflows. `m5_map`'s second line (44 code points,
  mostly Latin) may wrap to three lines, inside the 56 hard maximum.
- **Copyright cautions (resolved, kept in our own words).**
  - L17 keeps the spec's rule that a restore never starts from one alert, because one monitoring glitch
    can fire every alert. It is one general sentence with no story.
  - L20's capacity left idle on purpose is the spare zone and a standby database replica, not the spec's
    "attack shield", which is a book example.
  - L24's "a fallback should feel the same" uses an offline runbook with the wiki's steps, not the spec's
    deploy page that links to one rollback command, which retells a book case. Its three questions for a
    day when the tools are down (l24_p04c) are simplified and in our own words, so the page stays.
- **"configuration drift" stays in L18.** It is glossary 2.1's term, and L12's notes already use
  "drift" for the safety idea. The scene's chapter label is "Git နဲ့ live မတူတော့ရင်", so the phrase is
  never a heading.
- **L23 keeps the spec's order** for the shared SMS gateway: accepted and written down with a revisit
  date in Scene 3, the fallback added on that date in Scene 6.
- **L25's "reviewed by whoever pays"** names Thiri, who is woken at night if the new runtime breaks, and
  Ko Nay Lin, who pays for it. The fraud team asks for the exception, so it doesn't review its own
  request.
- **Padauk's own named rules say "စည်းကမ်း"** (L24's change rule and freeze rule, L25's freeze rule).
  Laws and rules in general say "စည်းမျဉ်း" (L21's hypothetical rules, L25's rule on a wiki and its
  restore-test rule).
- **L19's board B2** draws all three v8 bars the same amount taller, because v8 adds the same ~600 ms to
  every fee lookup; only Bill Pay's 1-second timeout line is crossed. The curriculum's "Bill Pay far
  taller" should change to match (see the follow-ups).
- **L18 stays at 7,953 characters.** A reviewer asked about trimming it toward 7,600; it is inside its
  window.

## Open questions for Chan (Module 5)

The numbers continue from Module 4. Module 6's questions are numbered 6.1–6.4.

39. **The derived-data example in L21 (copyright) — decided, switched.** L21 used the Eats restaurant
    search index, which takes 6 hours to rebuild, so Padauk protects it like original data. The L21 and
    L22 reviewers both noted that a search index is the book's own example for this idea, and the
    private reading notes list it among the examples not to retell, so the course's copyright rule
    settles it. L21 now uses the wallet balance table: rebuilt from the database's transfer records it
    takes 6 hours, during which no wallet can show a balance, so Padauk protects it like original data.
    Changed: Scene 3 (B1 steps 1 and 3, l21_p02c), the recap question, notes.md and the curriculum's L21
    spec; the script is now 7,978 characters. Only the new wording needs your ear: "wallet
    လက်ကျန်ငွေတွေ သိမ်းတဲ့ balance table", "လက်ကျန်ငွေ ပြလို့ မရတော့တဲ့အတွက်" and the page line
    "ပြန်ဆောက်နေတုန်း လက်ကျန် မပြ".
40. **"3-2-1" in Burmese words.** L22 says "သုံး နှစ် တစ် rule" (Scene 5 and the recap), following your
    rule that numbers are said in Burmese. Glossary 4.2 still proposes the English "three-two-one rule"
    from before that rule. Keep the Burmese (recommended; the glossary row then changes), or switch to
    English? English would mean writing the words "three-two-one" in the narration, because the digit
    rule turns "3-2-1" into Burmese digits.
41. **Burmese words to confirm by ear.** None has a fixed glossary wording yet, so whichever you choose
    goes into the glossary:
    - "ဆရာမ" for the Mandalay teacher who asks to be deleted (L21, all through the lesson).
    - "ဥပဒေက အနည်းဆုံး အဆင့်ပဲ ဖြစ်ပြီး ကျင့်ဝတ်က အဲဒီထက် မြင့်" for "the law is the floor, and ethics sits
      above it" (L21 Scene 8; l21_p05b says "ဥပဒေက အနည်းဆုံး အဆင့်ပဲ").
    - "database ရဲ့ အရန် replica" for a standby replica, and "utilization လှအောင်" for making utilization
      look good (L20 Scene 6).
    - Two phrasings new in this pass: "ကိုဇော် တွက်ခဲ့တဲ့ ပုစ္ဆာ" for "the problem Ko Zaw worked out" (L20's
      recap question) and "toil audit က ချန်ခဲ့တဲ့ သော့ချက်တွေပါ" for "the key points the toil audit left
      us" (L17's recap opener).
42. **Pronunciation probe additions** (glossary 4.2–4.3):
    - The name Lisanne Bainbridge (L17).
    - Postgres, Redis and Python (L25); SSH and PDF, said as letters (L25, L21).
    - Run-together words: watchdog, blocklist, workaround, redeploy, hackathon and gigabyte, and the
      hyphenated append-only, read-only, point-in-time, sign-on (in "single sign-on") and break-glass.
    - Other words not yet in 4.2: jitter, sheddable, utilization, asynchronous, synchronous, validator and
      metadata. GitOps (4.2 A) and chaos, goodput, throughput and backoff (4.2 B) are already listed and
      come back here.

### Follow-ups for the lead (not questions for Chan)

- Glossary rows to add, since this pass touched only the scripts: watchdog, memory leak and incident
  doc (L17); test pyramid and emergency push (L18); model checker (L19); forecast range (L20); undo window
  and data catalog (L21); write log, validator and trash (L22); dependency card and blocklist (L23);
  priority label and single sign-on (L24); linter and hackathon (L25). The "safe default" row's first use
  should say L17, which teaches it. The "3-2-1 rule" row's "said as" follows question 40.
- Curriculum lines to change to match the scripts:
  - L17 Scene 9: "switch back to Operator B" becomes switching back to Operator A's main endpoint (L10's
    "ပင်မ endpoint").
  - L18 recap: "drift" becomes "configuration drift".
  - L19 Scene 3, board B2 step 2: all three v8 bars the same amount taller, and only Bill Pay's crosses
    its timeout line.
  - L20 Scene 6: "the attack shield" becomes a standby database replica.
  - L24 Scene 8: the deploy page that links to one command becomes an offline runbook with the wiki's
    steps.
  - The cover specs of l18_p01, l19_p01, l21_p01, l22_p01 (now l22_p01 and l22_p01b), l23_p01, l24_p01
    and l25_p01, whose question slots now ask the bridge's question, as Module 6 did for its covers.
- If README question 29 goes to "မှတ်ပုံတင်", L21's four "NRC" lines (Scenes 2, 5, 6 and 8) change with
  L08's.
