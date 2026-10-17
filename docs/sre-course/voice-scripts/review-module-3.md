# SRE from zero · Module 3 voice scripts

These are the Burmese voice scripts for the five Module 3 lessons (Respond and learn, deck SRE 3). They
use the same layout as Modules 1 and 2 (see "How to read a script" in [README.md](./README.md)). This pass
read them together against the approved scripts for Lessons 1–8, the fact sheet, the story spine, the
first-use table, the lesson specs in [../curriculum.md](../curriculum.md) and
[../glossary.md](../glossary.md). Nothing here has been voiced or rendered yet.

| File                                 | Lesson                                        | Counted characters | ≈ min of speech |
| ------------------------------------ | --------------------------------------------- | ------------------ | --------------- |
| `sre-09-sustainable-on-call.md`      | 9 · ရေရှည် လုပ်နိုင်တဲ့ on-call               | 7,976              | 9.5             |
| `sre-10-working-an-incident.md`      | 10 · Incident တစ်ခုကို အစကနေ အဆုံးထိ          | 7,960              | 9.5             |
| `sre-11-postmortems.md`              | 11 · သင်ခန်းစာ ရတဲ့ postmortem                | 7,920              | 9.4             |
| `sre-12-how-complex-systems-fail.md` | 12 · ရှုပ်ထွေးတဲ့ system တွေ ဘယ်လို ပျက်လဲ    | 8,784              | 10.5            |
| `sre-13-stpa-and-cast.md`            | 13 · Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST | 8,808              | 10.5            |

Lessons 9–11 have a budget of 7,600 characters ±5% (7,220 to 7,980). Lessons 12 and 13 are the two
"deeper" lessons, with 8,400 ±5% (7,980 to 8,820). All five sit near the top of their window, as the
Module 1 and 2 scripts do. The module comes to 41,448 characters, about 49 minutes of speech. Pauses,
page changes and gaps between dialogs bring it to the curriculum's 52 rendered minutes. To recount:
`python3 -I ~/Documents/sre-course/work/count-narration.py docs/sre-course/voice-scripts/sre-09*.md docs/sre-course/voice-scripts/sre-1[0-3]*.md`.
Every spoken number is in Burmese digits: `burmese-digits.py` changed no lines on any of the five files.

Deck SRE 3 now plans 65 pages including `m3_map` (L09 10, L10 11, L11 15, L12 14, L13 15), against the
curriculum's 27. That is the same pacing choice Modules 1 and 2 made: deck SRE 1 was built with 61
pages and passed QA. The deck builder measures the fetch size as usual.

## What the consistency pass changed

- **Openings.** Each lesson still opens with one "Padauk so far" sentence that names what Padauk kept
  from the lesson before. Three of them had the same shape, "Padauk မှာ … ရှိလာ / ရလာပါပြီ". That is
  L03's pattern, which the Module 2 pass took out of L08. They now differ:
  - L10: "… Padauk က … rotation တွေ၊ … swarm နဲ့ incident role တွေကို သုံးနေပါပြီ".
  - L11: "လစာထုတ်ရက် incident ကနေ Padauk ထုတ်ခဲ့တာ သုံးခုပါ …".
  - L12: "… Wallet ကိုလည်း idempotency key တွေ တပ်ပြီးပြီ၊ postmortem template ကလည်း … မေးလာပါပြီ".
  - L09's module-map line no longer copies L06's "ဒီ မေးခွန်းနဲ့ Module ၂ ကို စပါမယ်". It now says
    "Module ၃ မှာ … တုံ့ပြန်တဲ့ အဆင့်နဲ့ သင်ယူတဲ့ အဆင့်ကို ဖြတ်သွားပါမယ်".
- **Same words everywhere.**
  - "support lead မစု" in L09 too. It had "support ခေါင်းဆောင်", while L10–L13 say "support lead",
    like the other lead roles in this module (communications lead, operations lead, Eats lead, Wallet
    lead).
  - L13 says "safety ဆိုတာ …" instead of "ဘေးကင်းမှုဆိုတာ …". L12 and L13 otherwise say "safety" in
    English, and glossary 3.1 asks for one form per idea.
  - L10 says "doc တွေ" instead of the English plural "docs", in the narration and on the B3 label
    (glossary 3.1).
  - L11 says "မစုကိုလည်း မေးကြည့်တော့" instead of "interview လုပ်". In Burmese, "interview" sounds like
    a job interview.
  - "lesson N မှာ ဆက်ကြည့်ပါမယ်" had become a stock line (L08, L12, L13). L12 now says "ဒါက lesson ၁၃
    ရဲ့ ခေါင်းစဉ်ပါ", and L13 says "lesson ၁၉ မှာ ပြန်တွေ့ရပါမယ်".
- **First use.**
  - L09 teaches on-call but never said what it is. Scene 3 now says "ချက်ချင်း ဖြေရမယ့် on-call
    တာဝန်ကို အလှည့်ကျ ယူတဲ့ rotation", right after it defines a page.
  - L13 uses fault injection six lessons before L19 teaches it, so the line now explains it: "fault
    injection test တွေက တစ်ခုခုကို တမင် ပျက်အောင် လုပ်ပြီးမှ စပေမဲ့ …".
  - Ko Min now gets his role at first mention on the developer quick path: "Top-up developer ကိုမင်း"
    in L10, as the spec has it, and "developer ကိုမင်း" in L11's hook.
- **Story.**
  - L08's bridge ("who answers at 2 a.m.?") is now answered in words in L09 Scene 3: "မနက် ၂ နာရီ
    မေးခွန်းအတွက် Padauk ရဲ့ အဖြေက … rotation ပါ".
  - L09's company-wide coordinator is now "အဖွဲ့တွေကြား ညှိပေးသူ". The same scene defines the incident
    commander as the one who "ညှိပြီး ဆုံးဖြတ်", so a bare "ညှိပေးသူ" blurred the two.
  - L10's Ko Min no longer "had never opened the gateway dashboard". He now "didn't know where to see
    latency per operator" and spent most of his 10 minutes looking for the right dashboard. That matches
    L08, where generated gateway dashboards already exist, and L14, where his starter project is the
    missing per-operator dashboard.
  - L10 Scene 7 ended "learning is part of the response", which blurred the loop's separate Respond and
    Learn stations. It now ends "incident ပိတ်လိုက်ပေမဲ့ loop ရဲ့ နောက်တစ်ဆင့်၊ သင်ယူတာ ကျန်ပါသေးတယ်",
    which also leads into L11. Page `l10_p04c` changes to match: "ပိတ်ပြီးရင် နောက်တစ်ဆင့်: သင်ယူ".
  - **Near miss.** L11's This week defined a near miss as "user ကို မထိခိုက်ခဲ့ပေမဲ့ …", and L12's recap
    called it a lesson that costs nothing. But L12's own near miss (the curriculum's story) let a few
    hundred top-ups fail before Ma Su caught it.
    - L11 now says "ကံကောင်းလို့ ထိခိုက်မှု မရှိသလောက်နဲ့ လွတ်ခဲ့တဲ့ near miss".
    - L12's recap and notes.md say "ကံကြောင့်သာ အကြီးအကျယ် မဖြစ်လိုက်တဲ့ အဖြစ်".
    - L12's hook keeps "top-up ရာဂဏန်းလောက်ပဲ fail ခဲ့ပေမဲ့ … တစ်ညလုံး ပျက်နိုင်တဲ့".
    - Follow-up: the near-miss row in glossary 2.5 still says "user ကို မထိခိုက်ခဲ့ပေမဲ့". It should
      allow minimal harm, for example "user ကို မထိခိုက်ခဲ့ ဒါမှမဟုတ် နည်းနည်းပဲ ထိခိုက်ခဲ့ပေမဲ့". This
      pass touched only the voice scripts.
  - L12 no longer names Sidney Dekker. His point stays, unnamed, as the reason push-back is needed:
    shortcuts that work make people trust them more. Dekker stays in the scene's `sources`. See question
    32 for the other names.
  - L13's bridge said Thiri "carried every one of these incidents alone". That clashed with L09 and L10,
    where a junior developer and an Eats engineer lead incidents as incident commander. It now says
    "ဒီ incident တွေမှာ reliability ဘက်ကို ထမ်းခဲ့ရတာ မသီရိ တစ်ယောက်တည်းပါ". L14's hook still says
    "incident တိုင်းကို ထမ်းခဲ့ရတာ … မသီရိ တစ်ယောက်တည်း". The Module 4 pass should match it.
  - L13's STPA session on the refund design now takes "တစ်မနက်လောက်", not "၂ နာရီလောက်". That is
    still small and encouraging, and closer to a real first pass.
- **Bridges.** Each lesson's last question now asks what the next cover asks:

  | From | Bridge asks                                                                           | Next cover asks                                                    |
  | ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
  | L08  | 2 a.m. alert into a muted 60-person Viber group: ဘယ်သူ ဖြေမလဲ?                        | မနက် 2 နာရီ ဘယ်သူ ဖြေမလဲ?                                          |
  | L09  | payday 6:40 p.m., Top-up burn-rate page, support says no airtime: ဘယ်ကနေ စမလဲ?        | ဘယ်ကနေ စမလဲ?                                                       |
  | L10  | a week later, Wallet charges twice in a promotion; no blame: ဘာ သင်ခန်းစာ ယူမလဲ?      | ဘာ သင်ခန်းစာ ယူမလဲ?                                                |
  | L11  | next payday, a near miss with nobody's mistake, saved by luck: why do they fail so?   | ဘယ်သူမှ မမှားဘဲ ဘာကြောင့် ပျက်လဲ?                                  |
  | L12  | payroll and fraud engine both as designed, 2,800 wallets frozen: root cause ဘယ်မှာလဲ? | ဒီတစ်ခါ root cause က ဘယ်မှာလဲ?                                     |
  | L13  | Thiri alone on reliability: who to hire, how do newcomers learn safely?               | (L14) Padauk ဘယ်သူ့ကို ခန့်မလဲ? · လူသစ် ဘေးကင်းကင်း ဘယ်လို သင်မလဲ? |
  - L12's cover had no question. Its question slot held "ဒေါသထွက်တဲ့ post တွေက ဖမ်းမိ: ကံ". Line 3 now
    reads "review · check · canary လွတ်၊ post တွေက ဖမ်းမိ: ကံ" (50 of 56), and the question is "ဘယ်သူမှ
    မမှားဘဲ ဘာကြောင့် ပျက်လဲ?" (33 of 34). Both lean on the bridge's "ဘယ်သူမှ မမှားဘဲ".
  - L13's bridge said "နစ်မွန်းမသွားဘဲ". It now says "ဘေးကင်းကင်း", the word on L14's cover and in L14's
    hook.
  - L09's bridge now says "၆ နာရီ ၄၀", like L10's hook (it had "၆ နာရီ ၄၀ မိနစ်").

- **Less templated.**
  - Recap openers. L12 and L13 opened with "ပြန်နွှေးကြည့်ရအောင်", L05's exact words. L09 and L10 ended
    on "… မှတ်ထားစရာတွေပါ", which is L07's. They now read:
    - L09: "Viber group ကနေ rotation ဆီ ရောက်လာတဲ့ လမ်းကို ပြန်လျှောက်ကြည့်ရအောင်".
    - L10: "အဲဒီ ၄၅ မိနစ်ကို ချုံ့ကြည့်ရအောင်".
    - L12: "near miss ကနေ ချောက်ကမ်းပါးအထိ ဒီနေ့ ခရီး ရှည်ခဲ့ပါတယ်".
    - L13: "ဒီ စကားလုံးတွေက control loop ကနေ လာတာပါ".
    - L11's opener was already its own and stays.
  - This week openers.
    - L10 and L11 both began "နောက် incident …". L11 now says "ဒီအပတ် ကိုယ့်အဖွဲ့ရဲ့ postmortem
      အလေ့အထကို နည်းနည်းချင်း ပြင်ကြည့်ပါ".
    - L12 had L07's shape ("… ဒီအပတ် … ကြည့်ရအောင်"). It now ties to its own model: "ကိုယ့်အဖွဲ့ရဲ့ ဒိန်ခဲ
      အချပ်တွေမှာလည်း အပေါက်တွေ ရှိမှာပါ".
    - L13 echoed L05 ("… ကနေ စလို့ရပါတယ်"). It now says "ဒီအပတ် postmortem နဲ့ design doc တွေကို
      မျက်လုံးအသစ်နဲ့ ကြည့်ပါ".
  - L11's question and answer followed L05's almost word for word ("review မှာ တစ်ယောက်က … မေးရင်၊ …
    ဘယ်လို ပြန်ရေးမလဲ?" and "ဥပမာ … ပြန်ရေးနိုင်ပါတယ်"). The question now points back to the Eats lead
    in Scene 3: "… Eats lead လိုပဲ လူကို မဟုတ်ဘဲ အခြေအနေကို မေးအောင် ဘယ်လို ပြန်ရေးမလဲ?".
  - Bridges. L10, L11 and L12 all opened on "… မှာတော့". They now open differently, and L09 keeps it.
  - L12 had four sentences starting "ဒါကြောင့် Padauk က …". Three now start differently. Scene 3's
    "ငြိမ်ငြိမ်လေး" (Woods's word again in Scene 6) is now "သတိမထားမိဘဲ".
- **Trims for the budget.** A few small cuts paid for the additions above:
  - L09 dropped "ခဏကြာတော့" (Scene 6) and "ကိုနေလင်းလို" (Scene 7).
  - L10 dropped "bug ကို ရှာပြီးမှ ပြင်မယ့်အစား", which repeated the mitigation definition.
  - L11 shortened the Eats team re-checking its own payment calls to "ကိုယ့်ဘက်ကို ပြန်စစ်ပါတယ်".
  - L13 dropped "ရန်ကုန်က" before the garment factory.

### Decided (no input needed)

These were open in the reviewers' notes. This pass settled them:

- **L09 response-time tiers stay.** The 5- and 30-minute targets and "about two incidents a shift" are
  the on-call numbers from the free first edition. The curriculum's copyright section lists those as
  public, and glossary 2.4's response-time row already carries them. The examples (the commute, a phone
  left charging, a school pickup) and every sentence are our own.
- **L09 leaves out customer requirements** as a rotation factor. The spec doesn't ask for them, and the
  idea budget is full.
- **L10 keeps Thiri as Top-up's on-caller and incident commander.** She came from Top-up, so being on
  its rotation fits L09's "each product team carries its own rotation". L13's bridge now says she carried
  the reliability side alone.
- **L11 keeps "Eats lead" and "Wallet lead",** in line with support lead, communications lead and
  operations lead. It also keeps "default လုပ်" and "ယာယီ patch", which are developer vocabulary
  (glossary 3.1). At 7,920 characters it needs no further trim.
- **L12 and L13 cover titles stay as the curriculum sets them.** They are 37 and 40 code points against
  the K1 safe maximum of 34, which assumes pure Burmese. The kit measured a 37-code-point mixed title at
  492 of 586 pt at the same 30 pt bold, and L13's title has 13 Latin letters. The deck builder checks
  both thumbnails. A title comes back to you only if it overflows.
- **L13 says STAMP as one word and doesn't expand it.** Its glossary row says "stamp". It is named once,
  as Leveson's model behind STPA and CAST, and both of those get their full English names.

## Open questions for Chan (Module 3)

The numbers continue from Module 2.

32. **Real names in the audio.** All of these follow the curriculum specs:
    - L12 names five researchers: James Reason, Jens Rasmussen, Erik Hollnagel, Richard Cook and David
      Woods. Dekker is already dropped.
    - L13 names Nancy Leveson.
    - L10 says "PagerDuty ရဲ့ public incident လမ်းညွှန်" as an example of a public severity scale.

    Two rules point the other way. Glossary 3.5 allows a person's name only when a law or method
    carries it, so only Leveson would stay. The curriculum also says sources are credited in `sources`
    and never in the audio. Should the names stay, or should the lines describe the ideas without them?
    Each name dropped saves about 20–40 characters.

33. **Burmese words to confirm by ear.** None has a fixed glossary wording yet, so whichever you choose
    goes into the glossary:
    - "စောင့်ကြည့်ချိန်" for wait and watch (L10 narration, recap and notes.md).
    - "အဖွဲ့တွေကြား ညှိပေးသူ" for the company-wide coordinator (L09; the B3 label says "ညှိပေးသူ"). The
      alternatives are the English "coordinator", or the glossary's "incident response team", but that
      names a team, not one person.
    - "Bank X ကိုပါ အပြစ်ဖို့မိခဲ့တာပါ" (L11 Scene 7), or "Bank X ကို မတရား အပြစ်တင်မိခဲ့တာပါ".
    - "ချောက်ကမ်းပါး ပြုတ်ကျ" for decompensation (L12 narration, chapter label, B3 label and recap;
      notes.md adds "(decompensation)" in brackets). Glossary 4.2 says never to say "decompensation",
      so this Burmese image carries the idea.
34. **Pronunciation probe additions** (glossary 4.2–4.3):
    - Researchers' names: Rasmussen, Hollnagel, Leveson, Woods, and Reason (it should sound like the
      English word).
    - Safety-I and Safety-II should sound like "Safety One" and "Safety Two". The hyphenated token may
      come out as "Safety I I".
    - PagerDuty, if it stays.
    - Words not yet in 4.2: bystander, triage, scribe, payroll, throttle, auto-refund and callback.
      Idempotency is already listed and comes back in L11 and L13.
