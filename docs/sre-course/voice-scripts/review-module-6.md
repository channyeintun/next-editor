# SRE from zero · Module 6 voice scripts

These are the Burmese voice scripts for the seven Module 6 lessons (AI, and SRE where you work; decks
SRE 6A and SRE 6B). They use the same layout as Modules 1–4 (see "How to read a script" in
[README.md](./README.md)). This pass read them together against the approved scripts for Lessons 1–8,
the Module 3 and 4 scripts as their passes left them, Lesson 25 (whose bridge Lesson 26 answers), the
fact sheet, the story spine, the first-use table, the lesson specs in [../curriculum.md](../curriculum.md)
and [../glossary.md](../glossary.md). Nothing here has been voiced or rendered yet.

| File                                    | Lesson                                          | Counted characters | ≈ min of speech |
| --------------------------------------- | ----------------------------------------------- | ------------------ | --------------- |
| `sre-26-when-ai-writes-the-code.md`     | 26 · AI က code ရေးတဲ့ခေတ်                       | 8,764              | 10.4            |
| `sre-27-reliability-for-ai-features.md` | 27 · AI feature တွေရဲ့ reliability              | 8,811              | 10.5            |
| `sre-28-ai-in-production-safely.md`     | 28 · AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း | 8,798              | 10.5            |
| `sre-29-where-ai-helps-operations.md`   | 29 · AI က operations မှာ ဘယ်နေရာ ကူညီလဲ         | 7,959              | 9.5             |
| `sre-30-the-first-sre.md`               | 30 · ပထမဆုံး SRE                                | 7,967              | 9.5             |
| `sre-31-sre-in-legacy-and-regulated.md` | 31 · ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE              | 8,801              | 10.5            |
| `sre-32-the-road-ahead.md`              | 32 · SRE ရဲ့ ရှေ့ခရီး                           | 8,806              | 10.5            |

Lessons 26–28, 31 and 32 have a budget of 8,400 characters ±5% (7,980 to 8,820). Lessons 29 and 30 have
7,600 ±5% (7,220 to 7,980). All seven sit near the top, as the earlier modules do. The module comes to
59,906 characters, about 71 minutes of speech. Pauses, page changes and gaps between dialogs bring it to
the curriculum's 75 rendered minutes. To recount:
`python3 -I ~/Documents/sre-course/work/count-narration.py docs/sre-course/voice-scripts/sre-2[6-9]*.md docs/sre-course/voice-scripts/sre-3*.md`.
Every spoken number is in Burmese digits: `burmese-digits.py` changed no lines on any of the seven files.

## What the consistency pass changed

- **Openings.** Each lesson opens with one "Padauk so far" sentence that names what Padauk kept from
  the lesson before.
  - L26, L28 and L32 opened "ပြီးခဲ့တဲ့ lesson မှာ Padauk က …", L02's exact words; six Module 5
    lessons also open with "ပြီးခဲ့တဲ့ lesson မှာ". They now differ:
    - L26 names all four things L25 kept: "Padauk ရဲ့ platform အဖွဲ့က အခု golden path၊ shared
      gateway client နဲ့ exception စာရင်းကို ထိန်းနေပါပြီ". It had named only the group and the golden
      path.
    - L28 names what L27 kept: "Ask Padauk မှာ အခု AI SLI တွေ ရှိပြီး နေ့တိုင်း အဖြေ နမူနာ စစ်နေသလို fraud
      model ကလည်း data မကောင်းရင် training ကို ရပ်ပါတယ်". It had said only "SLI တွေနဲ့ check တွေ".
    - L32 opens "ညသန်းခေါင် incident နောက်မှာ …" and now also names the gateway in front of the vendor
      system, which it had left out.
  - L27 and L30 both had L03's shape ("Padauk မှာ … ရှိလာပါပြီ" / "ရှိနေပါပြီ"). L27 now opens on what
    the agents do: "Padauk ရဲ့ coding agent တွေက အခု instruction file နဲ့ fee spec ကို ဖတ်ပြီး
    ပြောင်းလဲမှုတိုင်းမှာ change record ချန်ပါတယ်".
  - The `m6_map` line copied "ဒီ မေးခွန်းနဲ့ Module N ကို စပါမယ်" from `m2_map` and `m5_map`. It now says
    what the map shows (the whole loop lit, the Ops Buddy icon at the stations AI touches): "Module ၆
    မှာ AI က reliability loop ရဲ့ အဆင့်တိုင်းကို ရောက်လာပါတယ်".
- **Same words everywhere.**
  - "success code" for an HTTP success, L08's word. L26's bridge said "request အောင်မြင်တယ်လို့
    ပြန်လာ" while L27's hook said "success code"; both now say "success code ပြန်လာရုံနဲ့ ဘယ်တော့
    မလုံလောက်တော့လဲ?".
  - "roll forward" in L30, as in L26. L30 said "fix forward" for the same move, and the glossary has
    them in one row. Narration, B2 step 2, the recap and notes.md all changed.
  - One off switch, one name. L27 called Ask Padauk's off switch a "kill switch" and L28 names the
    agent's "stop button" (glossary "kill switch (stop button)"). L27 now says "ချက်ချင်း ပိတ်တဲ့ ခလုတ်",
    so the only English name the module teaches is L28's.
  - "ဒီသင်တန်း" in L27, as in L01 and L32. It had "ဒီ course".
  - L28 says Lesson 22's script "merchant ၁၀၀၀၀ ကို ဖျက်မိခဲ့ပါတယ်", in L22's words. It had
    "ပျက်သွားခဲ့", which says the merchants broke, not that they were deleted.
  - L26 says "ပြောင်းလဲမှုတွေရဲ့ timeline" on payday night (a reviewer question). Timeline is L10's word,
    and the Burmese in front of it says what the timeline holds, for about 12 more characters. The
    l26_p02b column header is now "timeline ပြတာ", inside the 24-code-point chip.
- **First use.**
  - L27 said "SRE" once (Scene 6) and never the full phrase. It now says "မသီရိရဲ့ အဖွဲ့က
    တာဝန်ယူပြီး".
  - L32 never said "Site Reliability Engineering". Its hook now does: "နှစ်ကုန် review ကနေ Site
    Reliability Engineering၊ SRE ရဲ့ ရှေ့ခရီးကို ကြည့်ပါမယ်". L32 is on the tech lead path.
  - L28's borrowed term rollback had no clause. Scene 4 now says "အရင် အခြေအနေကို ပြန်ယူတဲ့ rollback".
  - "merge" stays without a gloss (a reviewer question). L25, the lesson just before, uses it bare, and
    it is developer vocabulary. "coding agent" is introduced with the glossary's own line.
- **Story.**
  - L32 Scene 8 called Ko Nay Lin's review Padauk's "ပထမဆုံး blameless review". Module 1 took "first" out
    of L05, because L02 already has a no-blame postmortem (README question 4). L32 now says "ကိုနေလင်း
    ဝင်ထိုင်ခဲ့တဲ့ blameless review".
  - L26's answer said incidents would double with "မျှော်လင့်ရပါတယ်", which also means "hope". It now
    says "incident တွေလည်း နှစ်ဆလောက် များလာမှာပါ". Scene 8's trend line says "ပိုရွေ့လာဖွယ် ရှိပါတယ်".
    Scene 5's neutral forecast keeps "မျှော်လင့်ရပါတယ်".
  - L26's hook now asks in L25's tense, "ဘာတွေ ပြောင်းသွားမလဲ?". It had "ပြောင်းသွားလဲ?".
  - L28's approvals line uses plain words, "လူက မဖတ်တော့ဘဲ approve ကိုပဲ နှိပ်ပေးတတ်ပါတယ်", in place of
    the rubber-stamp image "တံဆိပ်တုံး ထုသလို" (a reviewer question; narration avoids idioms).
  - **Kept:** Ops Buddy pages Ko Min as the Top-up on-call in L29 (a reviewer question). L10 introduced
    him as a Top-up developer, and L30 picks him up next.
- **Covers.** L28, L31 and L32 had a statement in the cover's question slot, and L27's question showed
  "200 OK" while the voice says "success code". Following L25, which joined two spec lines with "·" to
  free the slot, every cover now asks the bridge's question:
  - l26_p01: "ဘာတွေ ပြောင်းသွားမလဲ?" (21 code points).
  - l27_p01: "success code ဘယ်တော့ မလုံလောက်လဲ?" (33). The HTTP codes stay on B1 and in notes.md, where
    they are data ("error (500)", "200 ပဲ!").
  - l28_p01: "ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ?" (34). "production မှာ sandbox မရှိ" is still the title
    of l28_p01d.
  - l31_p01: line 3 "ခွင့်ပြုချက် တစ်နာရီကျော် · ပြင်တာ 5 မိနစ်ပဲ", question "မိနစ် 65
    ဘယ်ရောက်သွားလဲ?" (24). The l31_p01b ladder's title, which had the same question, is now
    "ညသန်းခေါင်ရဲ့ မိနစ် 70".
  - l32_p01: line 3 "ဘယ်ဟာမှ ရှေ့ကို မပြော · risk က အရင် ရှိနှင့်", question "ဘာက ကြိုပြောနိုင်မလဲ?"
    (21). The l32_p01b caption matches it.
- **Bridges.** Each lesson's last question asks what the next cover asks:

  | From | Bridge asks                                                                                       | Next cover asks                    |
  | ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
  | L25  | Module 6: coding agents, merges 15 → 120 a day: SRE အလုပ်မှာ ဘာတွေ ပြောင်းသွားမလဲ?                | ဘာတွေ ပြောင်းသွားမလဲ?              |
  | L26  | Ask Padauk: success code on 99.9% of chats, refund tickets for the wrong transactions             | success code ဘယ်တော့ မလုံလောက်လဲ?  |
  | L27  | the other direction: Ops Buddy asks for production access: ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ?     | ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ? |
  | L28  | brakes in place; Friday promo, dashboard 99.7%, angry comments: alert ဘာလို့ မတက်ခဲ့တာလဲ?         | alert ဘာလို့ မတက်ခဲ့တာလဲ?          |
  | L29  | Padauk buys a Mandalay delivery startup, Ko Min its first SRE: ကိုမင်း ဘယ်ကနေ စမလဲ?               | ကိုမင်း ဘယ်ကနေ စမလဲ?               |
  | L30  | wallets locked at midnight, a 5-minute fix, 70 minutes locked: ကျန်တဲ့ မိနစ် ၆၅ က ဘယ်ရောက်သွားလဲ? | မိနစ် 65 ဘယ်ရောက်သွားလဲ?           |
  | L31  | the year-end review: three months of uptime said nothing: ဒါဆို ဘာက ကြိုပြောနိုင်မလဲ?             | ဘာက ကြိုပြောနိုင်မလဲ?              |
  | L32  | the course closes: Padauk's story, like reliability, keeps going                                  | —                                  |
  - Each hook repeats the bridge before it. L26 asks in L25's words, L27 in L26's ("success code
    ပြန်လာရုံနဲ့ …"), L28 in L27's ("ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ?", word order aligned), and L31 in
    L30's. L30's bridge used to ask "ဘာလို့ မိနစ် ၇၀ ကြာခဲ့တာလဲ?" while L31 asked where the 65 minutes
    went. The bridge now asks L31's question.

- **Less templated.**
  - Recap openers. L27, L29, L30 and L31 opened "ပြန်နွှေးကြည့်ရအောင်", L05's words, which Modules 3 and
    4 retired. L28 and L32 had it inside a longer line, and L26 had L02's "အဓိက အချက်တွေကို
    ပြန်ကြည့်ရအောင်". Each now ties to its lesson:
    - L26: "agent တွေ ရောက်လာတဲ့ လမှာ သုံးခဲ့တဲ့ စကားလုံးတွေပါ".
    - L27: "Ask Padauk ကနေ ရလာတဲ့ ဝေါဟာရတွေပါ".
    - L28: "Ops Buddy ကို ဘေးကင်းအောင် ထားတဲ့ နည်းတွေပါ".
    - L29: "AI ကူခဲ့တဲ့ နေရာတွေပါ".
    - L30: "ကိုမင်း Parcel မှာ သင်ခဲ့တာတွေပါ".
    - L31: "ဘဏ်ဘက်ကို ကိုဇော် ယူသွားခဲ့တဲ့ အလေ့အထတွေပါ".
    - L32: "နှစ်ကုန် review ကနေ မှတ်စရာတွေပါ".
  - Lead-ins to the recap question. L26 and L32 both said "နောက်ဆုံး မေးခွန်းပါ"; L28 ("ဒါဆို ခဏ
    စဉ်းစားကြည့်ပါ"), L29 ("ဒါဆို တွက်ကြည့်ပါ") and L30 ("ဒါဆို စဉ်းစားကြည့်ပါ", L21's words) were near
    copies. L26 now asks with no lead-in. The others read:
    - L28: "card ကို ကိုယ်တိုင် ဖြည့်ကြည့်ပါ".
    - L29: "supermarket ရဲ့ job လိုပဲ တွက်ကြည့်ပါ".
    - L30: "ကိုယ်က ကိုမင်းနေရာမှာ ဆိုပါစို့".
    - L32: "သင်တန်းရဲ့ နောက်ဆုံး မေးခွန်းပါ".
  - L32's answer opened "အဖြေက အဖွဲ့တိုင်း မတူပါဘူး", close to L12's "အဖြေက လူတိုင်း မတူပါဘူး". It now
    says "အဖြေ မှန် တစ်ခုတည်း မရှိပါဘူး".
  - Bridge openers. L26 opened "နောက်တော့" (L06, L19, L21, L24), and L27 and L30 opened "နောက် lesson
    မှာတော့" (L01, L17, L18, L22, L23). They now read:
    - L26: "AI က code ရေးရုံ မကဘဲ feature တစ်ခုလည်း ဖြစ်လာပါတယ်".
    - L27: "အခု ဘက်ပြောင်းကြည့်ရအောင်".
    - L30: "startup လေးကနေ … ကုမ္ပဏီကြီး အဟောင်းတွေဆီ ကူးကြည့်ရအောင်".
    - L29's "နောက်တစ်ခါမှာတော့" is now "အခု".
  - This week openers. L27 and L31 said "ဒီအပတ် လုပ်ကြည့်ဖို့ သုံးခုပါ" (L17, L22). L29's "ဒီအပတ် စလို့ရတာ
    သုံးခု ရှိပါတယ်" was close to L25. L30 had the "SRE မရှိသေးရင်တောင်" shape of L01, L18, L23 and L24,
    and L32's "tool အသစ် မလိုဘဲ" was L19's and L21's. They now read:
    - L27: "AI feature ရှိရင် ဒီအပတ် စမ်းကြည့်ဖို့ သုံးခုပါ".
    - L29: "agent မရှိသေးလည်း ဒီအပတ် စလို့ရတာ သုံးခုပါ".
    - L30: "ကုမ္ပဏီရဲ့ ပထမဆုံး SRE ဖြစ်ဖြစ်၊ developer ဖြစ်ဖြစ် ဒီအပတ် ဒီ သုံးခုနဲ့ စလို့ရပါတယ်".
    - L31: "ကုမ္ပဏီ အဟောင်းမှာလည်း ဒီအပတ် စလို့ရတာ သုံးခုပါ".
    - L32: "သင်တန်း ပြီးသွားပေမဲ့ ကိုယ့်အဖွဲ့မှာ ဒီလ စလုပ်လို့ရတာ သုံးခု ရှိပါတယ်".
  - Repeats inside lessons:
    - L26 said "ဒါကြောင့်" seven times. Three are now "ဒီတော့", "အဲဒီအတွက်" and "အခုတော့".
    - L26 said "နှစ်နဲ့ချီ" twice. Scene 3's is now "အကြာကြီး".
    - L26's "တိတ်တိတ် ပျောက်သွား", the stock word Modules 2 and 4 cut back, is now "အဲဒီ စစ်ဆေးမှုကို
      ကျော်သွားနိုင်ပါတယ်".
    - L27 Scene 2 had three "… လို့ ခေါ်ပါတယ်" in a row. Agent and tool call now use "… က … ပါ", and so
      does L32's risk sheet.
    - L30 said "ထပ်ခါထပ်ခါ" four times. Scene 1 and l30_p01b now say "ခဏခဏ".
- **Trims for the budget.** The changes above added characters to lessons already at the ceiling, so
  some lines went:
  - L26: the sentence on many causes mixing in one incident (the reviewer's suggested cut, about 80
    characters; not in the spec).
  - L27: Scene 7's opener is now "log ပြောင်းတာလေးတောင် model ကို ထိခဲ့ပါတယ်". It still links the fraud
    story to "what counts as a change".
  - L28: Scene 6 lost "ယုံလာတဲ့ နောက်ပိုင်းမှာတောင် ဒီ ခလုတ်ကို မဖြုတ်ပါဘူး". The next clause still says
    the button is why on-call trusts Ops Buddy.
  - L31: Scene 4 lost "ရှုပ်ထွေးတဲ့ self-healing မဆောက်ဘဲ" (not in the spec). The plain restart script
    stays.

### Decided (no input needed)

These were open in the reviewers' notes. This pass settled them:

- **Deck size and pacing (for information).** Deck SRE 6A now plans 44 pages including `m6_map` (L26
  13, L27 15, L28 8, L29 8) against the curriculum's 22. Deck SRE 6B plans 36 (L30 13, L31 11, L32 12)
  against 16. This is the same pacing choice the earlier modules made. It settles the L31 reviewer
  question: its six pacing pages and its 5-step boards B1 and B4 stay, including B4 step 4 (the
  gateway strips the NRC number), which ties the three lenses back to L31's own gateway. At deck SRE 1's
  92 KB a page, 44 pages come to about 4 MB, the split line. The deck builder should measure KB per page
  after the first 6A pages and split 6A (L26–L27 and L28–L29) if it goes over. The longest estimated
  holds are l27_p01 and l31_p01 at 35 s; l26's and l29's recap questions, l29_p01b and l30_p04 at 34
  s; and nine more at 33 s. Every page line is inside the kit's limits except l28_p01's title
  (question 6.1).
- **The Workbook pointer (L31)** goes only into Scene 6's `sources:`. Narration never names a book or
  chapter.
- **L32's lasting traits stay** (asks why, knows a little about many layers, decides well when the
  answer is unclear). The coverage map lists the idea as essential for that scene, and l32_p04's three
  values are about Padauk, not about the person.
- **"Unicode နဲ့ ဇော်ဂျီ ညှိတာ" stays** in L29's plumbing line. It is real Myanmar text work, and Zawgyi
  is an encoding, not a company.
- **"နားချ" stays** for L30's teacher role. It means to persuade by explaining, which is the job;
  "ဖျောင်းဖျ" means to coax or console.
- **"၁၂ သိန်း"** for 1.2 million users was settled in Module 2.

## Open questions for Chan (Module 6)

These are numbered 6.1–6.4, because the Module 5 review is being written in parallel and its numbers
aren't fixed yet.

6.1. **Lesson 28's title is too long for its cover.** "AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း" is 42
code points, and the K1 cover title's safe maximum is 34. It also ends on a heavy "-ခြင်း" noun. The
title comes from the curriculum, so this pass left it. The options:

- "AI ကို production ထဲ ဘေးကင်းကင်း" (32 code points). Recommended: it is the same title without the
  verb.
- "Production ထဲက AI ကို ဘေးကင်းအောင်" (34).
- Keep it and test a two-line cover title on the kit first.

Whichever you choose changes the curriculum's lesson table, the script header, the cover and the
notes.md heading together.

6.2. **Diary days in L30.** After "ပထမ ရက် ၃၀", the diary says "ရက် ၃ မှာ", "ရက် ၁၀ မှာ", "ရက် ၁၄", "ရက်
၂၁" and "ရက် ၃၀" so that they match the board labels. Do these sound clearly like day 3 and day 10, and
not like the 3rd of the month or three days? The alternative, "၃ ရက်မြောက်နေ့" and so on, costs about 40
characters, and L30 is at 7,967 of 7,980, so a line elsewhere would have to go.

6.3. **"ပြန်ပြန်လောင်တဲ့ မီး" for repeat fire** (L30 Scene 4, This week, the recap and notes.md). Glossary
2.12 has the idea in Burmese only, as a full sentence. Does this two-word name sound natural? Whatever
you choose goes into that glossary row.

6.4. **Pronunciation probe additions** (glossary 4.2–4.3):

- AI terms: inference, token, context window, prompt injection, golden set, and time to first token as
  a full phrase. eval is already in 4.2 B ("ee val").
- Other new words: anticorruption, generalist, fleet scan, reopen rate, Unicode, and Incident Command
  System. Jevons and JSON are already in 4.2 B.
- Product names: Ops Buddy, Ask Padauk, and Padauk Parcel. Padauk keeps its written form, as the probe
  decided, so listen for "Parcel" and "Buddy".

### Follow-ups for the lead (not questions for Chan)

- Glossary rows to add, since this pass touched only the scripts: agent instruction file and fee spec
  (L26); model router, step budget, eval gate and freshness SLO (L27); and vulnerability (L31).
  "anomaly detection" (first said in L29) can join the existing "baseline / anomaly" row (L08).
- The glossary row "roll forward / fix forward" can drop "fix forward". The course now says only "roll
  forward", and the pronunciation list matches whole tokens.
- The curriculum's cover specs for l26_p01, l27_p01, l28_p01, l31_p01 and l32_p01 should change to match
  the covers above, as Module 4 did for l14_p03.
