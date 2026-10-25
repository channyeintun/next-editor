# SRE from zero · Module 4 voice scripts

These are the Burmese voice scripts for the three Module 4 lessons (People and teams, deck SRE 4). They
use the same layout as Modules 1–3 (see "How to read a script" in [README.md](./README.md)). This pass
read them together against the approved scripts for Lessons 1–8, the Module 3 scripts as their
consistency pass left them, the fact sheet, the story spine, the first-use table, the lesson specs in
[../curriculum.md](../curriculum.md) and [../glossary.md](../glossary.md). Nothing here has been voiced
or rendered yet.

| File                          | Lesson                        | Counted characters | ≈ min of speech |
| ----------------------------- | ----------------------------- | ------------------ | --------------- |
| `sre-14-becoming-an-sre.md`   | 14 · SRE တစ်ယောက် ဖြစ်လာဖို့        | 8,806              | 10.5            |
| `sre-15-where-sre-lives.md`   | 15 · SRE အဖွဲ့ကို ဘယ်မှာ ထားမလဲ       | 8,775              | 10.4            |
| `sre-16-engagement-models.md` | 16 · Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ | 8,807              | 10.5            |

All three lessons have a budget of 8,400 characters ±5% (7,980 to 8,820), and all three sit near the
top, as the earlier modules do. The module comes to 26,388 characters, about 31 minutes of speech.
Pauses, page changes and gaps between dialogs bring it to the curriculum's 33 rendered minutes. To
recount: `python3 -I ~/Documents/sre-course/work/count-narration.py docs/sre-course/voice-scripts/sre-1[4-6]*.md`.
Every spoken number is in Burmese digits: `burmese-digits.py` changed no lines on any of the three
files.

Deck SRE 4 now plans 40 pages including `m4_map` (L14 14, L15 14, L16 12), against the curriculum's 22.
That is the same pacing choice the earlier modules made. The longest estimated holds are l16_p01 at
35 s, l14_p02 and l16_p01b at 34 s, l14_p03 at 33 s, and l14_p01, l16_p03, l16_p06 and the L15 recap
question at 32 s. Every page line is inside the kit's limits.

## What the consistency pass changed

- **Openings.** Each lesson opens with one "Padauk so far" sentence that names what Padauk kept from
  the lesson before.
  - L15 and L16 both opened "ပြီးခဲ့တဲ့ lesson မှာ Padauk က …", L02's exact words. They now differ:
    - L15 opens on Ko Zaw's first Monday, with what L14 kept: "သူ့အတွက် action တွေနဲ့ ရေးထားတဲ့
      on-call checklist ရှိနေပြီး ကိုအောင်နဲ့ တွဲလုပ်ဖို့လည်း စီစဉ်ထားပါတယ်".
    - L16 names both things L15 kept, the charter and the review rule: "… charter တစ်ခုနဲ့
      အလုပ်စလိုက်ပြီး လစဉ် review မှာလည်း ဘယ်အဖွဲ့ကိုမှ အဆင့် မစီတော့ပါဘူး". It had named only the
      charter.
  - L14's module-map line copied "ဒီ မေးခွန်းတွေနဲ့ Module N ကို စပါမယ်" from L06. It now points back to
    the promise in L01: "lesson ၁ မှာ ပြောခဲ့သလို Module ၄ က … အလယ်က လူတွေ အကြောင်းပါ".
- **Same words everywhere.**
  - "SRE အဖွဲ့" for Padauk's team all through the module, as in L15's title and Module 1. L14 Scene 1
    and L16's bridge had said "reliability အဖွဲ့". L17's hook still says "reliability အဖွဲ့ … လေးယောက်".
    The Module 5 pass should match it.
  - L14's hook now says Thiri carried "the reliability side" of these incidents alone: "incident တွေမှာ
    reliability ဘက်ကို ထမ်းခဲ့ရတာ … မသီရိ တစ်ယောက်တည်းပါ". That is what L13's bridge says since the
    Module 3 pass. The cover's line 2 matches: "reliability ဘက်ကို မသီရိ တစ်ယောက်တည်း ထမ်းခဲ့".
  - L14 says "ပိတ်ခံရတဲ့ wallet ၂၈၀၀", L13's words. It had "ပိတ်မိသွားတဲ့".
  - "support lead မစု" in L15, the Module 3 form. L15 is on the tech lead path, and it had named her with
    no role.
  - Follow-up: the glossary has the same term twice, "non-functional requirement" (2.1, L02) and
    "nonfunctional requirement" (2.12, L16). L16 follows 2.12. One spelling should go, because the
    pronunciation list matches whole tokens. This pass touched only the voice scripts.
- **First use.**
  - L01–L13 say "page" and "on-call" but never "pager", and L16 used it from its first line without
    saying what it is. Its hook now defines it: "အဲဒီ page တွေ ဖြေရတဲ့ on-call တာဝန်၊ pager". The
    glossary's page / paging / pager row (2.3) covers it.
  - L16 keeps its one-clause re-definition of SLO ("သဘောတူထားတဲ့ reliability ပစ်မှတ်၊ SLO"). SLO is a
    borrowed term in L16's spec, and the tech lead path reaches L16 straight from L06 and L15.
- **Story.**
  - **Ko Min's whiteboard talk** (a reviewer question) now covers the Wallet ledger, "ငွေလွှဲ တစ်ခု
    ဘယ်လို မှတ်တမ်းဝင်လဲ". It had covered the Top-up system, which Ko Min already works on. The ledger
    teaches him more, it is where his L11 retry change landed, and it ties to the same scene's
    line that no outside course teaches Padauk's ledger.
  - L15 said "lesson ၆ ကတည်းက incident တိုင်းကို ထမ်းခဲ့တဲ့ မသီရိ". That repeated L14's hook and kept the
    claim Module 3 took out. It now says "အချိန်ပြည့် SRE ဖြစ်ကတည်းက မသီရိ တစ်ရက်မှ ခွင့်
    မယူနိုင်သေးပါဘူး". The third line of l15_p01b matches: "အချိန်ပြည့် ဖြစ်ကတည်းက မသီရိ ခွင့်
    တစ်ရက်မှ မယူရ".
  - L15's developers joined the rotation because they knew "what changed in today's release". That is
    L16's reason (Scene 5, from its spec) for keeping developers reachable at night, so the two lessons
    said it back to back. L15 now gives its own reason: they know "the code they wrote" best.
  - In L16 the supermarket chain now calls "ထပ်ပြီး". L07 already had its angry morning call, and L16's
    line had read as a copy of it.
  - L15 Scene 3 dropped "SRE ဆိုတာ ရာထူးနာမည် မဟုတ်ဘဲ ရေရှည် နေရာ ရှိတဲ့ အဖွဲ့ ဖြစ်ရပြီး". The spec doesn't
    ask for it, and Scene 2 already says why a separate team keeps its focus.
- **Bridges.** Each lesson's last question asks what the next cover asks:

  | From | Bridge asks                                                                                          | Next cover asks                             |
  | ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
  | L13  | Thiri alone on the reliability side: who to hire, how do newcomers learn safely?                     | Padauk ဘယ်သူ့ကို ခန့်မလဲ? · လူသစ် ဘေးကင်းကင်း ဘယ်လို သင်မလဲ? |
  | L14  | Ko Zaw starts on Monday, two SREs are not a rotation: ဘယ်မှာ ထားပြီး ဘာတွေကို တာဝန်ယူခိုင်းမလဲ?                  | ဘယ်မှာ ထားပြီး ဘာ တာဝန်ပေးမလဲ?                   |
  | L15  | soon after the charter, Bill Pay asks the three-person team to take its whole on-call: what instead? | SRE က ဘာကို ယူသင့်လဲ?                             |
  | L16  | Module 5: a four-person SRE team, and over half the week is toil: ဘယ်ကနေ စမလဲ?                         | (L17) ဘယ်ကနေ စမလဲ?                            |
  - Each hook repeats the bridge before it: L14 asks in L13's words ("ဘေးကင်းကင်း", which the Module 3
    pass chose), L15 in L14's, and L16 opens on L15's "မကြာခင်မှာပဲ".
  - L15's bridge opened on "နောက်တော့", L06's opener. It now opens "charter ရေးပြီး မကြာခင်မှာပဲ …".

- **Less templated.**
  - Recap openers. L16 opened "ပြန်နွှေးကြည့်ရအောင်", L05's words, which Module 3 took out of L12 and L13.
    L14's "ဒီ lesson ကို ပြန်ချုပ်ရအောင်" and L15's "ဒီ lesson ကို အတိုချုပ် ပြန်ကြည့်ရအောင်" were close to
    L01 and to each other. They now read:
    - L14: "SRE ဖြစ်လာဖို့ လိုတာတွေကို ကြည့်ရအောင်".
    - L15: "SRE အဖွဲ့ကို ဘယ်မှာ ထားမလဲ ဆုံးဖြတ်ရင် လိုမယ့် အချက်တွေပါ".
    - L16: "Bill Pay နဲ့ တွဲလုပ်ခဲ့ပုံကို ပြန်ကြည့်ရအောင်".
  - This week openers. L14 and L16 both had L01's shape ("SRE အဖွဲ့ မရှိ … ဒီအပတ် လုပ်(ကြည့်)လို့ရတာ
    သုံးခု"), and L15's "ဒီအပတ်ထဲမှာပဲ လုပ်ကြည့်လို့ရတာ သုံးခုပါ" was close to it. Each now ties to its own
    lesson:
    - L14: "လူ ဝင်ထွက်လည်း အဖွဲ့ ဆက်ရပ်တည်နိုင်အောင် ဒီအပတ် စလုပ်ကြည့်ပါ".
    - L15: "ကိုယ့်အဖွဲ့ကို ပြန်မဖွဲ့ခင် ဒီအပတ် အရင် လုပ်ကြည့်သင့်တာ သုံးခုပါ".
    - L16: "တခြား အဖွဲ့ တစ်ခုနဲ့ တွဲလုပ်နေရင် ဒီအပတ် ဒီ သုံးခုကို စမ်းကြည့်ပါ".
  - Repeats inside L15:
    - "တိတ်တိတ်လေး" came three times. Scene 8's is now "မသိမသာ".
    - "အဆင်ပြေပုံ ရ" came twice. The recap answer now says "မျဉ်းအောက်မှာ ရှိပေမဲ့".
    - "နှစ်နဲ့ချီ" came twice. Scene 7's is now "နှစ်အတော်ကြာ".
- **Pages.** l15_p03c line 3 now fits on one line: "အောင်မြင်မှု: သီတင်းကျွတ်မှာ မသီရိ ခွင့်ယူနိုင်" (47
  of 49). The narration still says "page တစ်ခုမှ မရောက်ရဘူး".
- **Trims for the budget.** Besides the L15 Scene 3 cut above, L16 dropped "ကိန်းဂဏန်းကို ကြည့်ပြီး" before
  "rollback ကို အရင် လုပ်ပါတယ်", and L14's recap opener lost "တစ်ခုချင်း".

### Decided (no input needed)

These were open in the reviewers' notes. This pass settled them:

- **Copyright caution (resolved).** l14_p03's vague goal is "operator gateway ကို နားလည်", not the spec's
  "Understand monitoring", which echoes the book's own example. The l14_p03 spec line in
  curriculum.md should change to match, as Module 1 did for L05's confidence check.
- **Ko Min's whiteboard talk is about the Wallet ledger** (see Story above).
- **L15's cover question stays shorter on screen.** The page asks "ဘယ်မှာ ထားပြီး ဘာ တာဝန်ပေးမလဲ?"
  (30 code points). The spoken "… ဘာ တာဝန်ယူခိုင်းမလဲ?" would take 35, one over the K1 limit of 34. It is
  the same question, shortened the way L02's cover was in Module 1.
- **l15_p03c line 3 is shortened to one line** (see Pages above).
- **L15 doesn't point ahead to L16** for its one way to ask SRE for help. L16 opens with the engagement,
  which is that way, and Module 3 just retired "lesson N မှာ ဆက်ကြည့်ပါမယ်" as a stock line.
- **L16 keeps its firefighting image** ("Bill Pay ရဲ့ မီးတွေကို ငြိမ်းပေးနေ", and "SRE က မီးငြိမ်း" on
  l16_p06). Glossary 2.12's "repeat fire" row for L30 uses the same image ("ငြိမ်းရမယ့် မီး"), so the
  course says it one way.

## Open questions for Chan (Module 4)

The numbers continue from Module 3.

35. **"kitchen sink"** (L16 Scene 3 and card A of l16_p03). This English idiom will be new to most
    Burmese listeners. The narration glosses it once ("ဘာမဆို on-call ယူပေးတဲ့ kitchen sink အဖွဲ့").
    The two choices:
    - Keep it. It is the usual name for this team shape, and learners will meet it in further reading.
      It then needs a row in glossary 2.12.
    - Drop the English name and keep only the Burmese description. That saves about 13 characters, and
      the card's label becomes something like "ဘာမဆို ယူ".
36. **Burmese words to confirm by ear (L15).**
    - "ticket ဖြေပေးရုံ ကောင်တာ" for the risk that a central team turns into a ticket desk (Scene 4). The
      page shortens it to "ticket ကောင်တာ". The English "ticket desk" is the alternative.
    - "context ပျောက်" for people losing context after a reorg (Scene 6). An alternative says what gets lost:
      "ဘယ်သူ့ကို ဘာ မေးရမလဲ ခဏ မသိ ဖြစ်".
37. **The third SRE.** L14 hires only Ko Zaw, because Thiri already covers the developer side. The
    developer-leaning candidate who also cleared the bar stays unnamed. L15 then adds "one more" SRE,
    also unnamed, which follows the fact sheet. Should that third SRE be L14's developer candidate? That
    takes one clause in L15 Scene 4, about 25 characters. If you don't mind either way, both stay as
    they are.
38. **Pronunciation probe additions** (glossary 4.2–4.3):
    - Law names: Conway's (not yet in 4.2), Goodhart's and Hyrum's (already in 4.2).
    - T-shaped, which should sound like "T shaped".
    - Kubernetes (4.2 A), in L14's recap question.
    - Words not yet in 4.2: handback, onboarding, shadowing, nonfunctional, scorecard, Linux, and
      kitchen sink if it stays.
