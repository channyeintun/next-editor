# SRE from zero — course guide

A 32-lesson course on Site Reliability Engineering, narrated in Burmese, for developers who have
shipped software but have never run production on purpose. Nothing runs: every lesson teaches with
pages from a branded Google Slides deck and the Excalidraw whiteboard, and ends on a `notes.md` recap.
SRE terms stay in English (SLO, error budget, on-call, postmortem, …), and spoken numbers are Burmese
digits with no thousands separator (၃၀၀၀, ၉၉.၉). All lessons follow one fictional Yangon fintech,
Padauk, and its people, from 25 engineers with no SRE team to a platform group working with AI agents.

The course teaches ideas from _Site Reliability Engineering_, 2nd edition (O'Reilly, 2026) in its own
words, with its own examples and diagrams; every scene credits the book and public sources in
`sources`, never in the narration. See [curriculum.md](./curriculum.md) for the design, the running
example and the copyright approach, and [glossary.md](./glossary.md) for terms and spoken forms.

Every lesson is a studio LessonScript in `src/studio/scripts/` (locale `my-MM`, lesson type
`javascript` with an HTML/CSS placeholder workspace and no runtime actions, `timing.p95Ms: 500`).
Its narration is byte-identical to the voice script in [voice-scripts/](./voice-scripts/), which is
the source of truth for the spoken text.

## Lessons

Lengths are estimates at VoxCPM2's Burmese pace (about 14 characters a second); the real voice
decides the final length. Total: about 270,000 narration characters, roughly 5 h 20 min.

| #   | Script                               | Title                              | Deck   | ≈ min |
| --- | ------------------------------------ | ---------------------------------- | ------ | ----- |
| 1   | `sre-01-why-reliability-now`         | SRE ဘာကြောင့် လိုလာတာလဲ                 | SRE 1  | 9.4   |
| 2   | `sre-02-what-sre-is`                 | SRE ဆိုတာ ဘာလဲ                        | SRE 1  | 9.4   |
| 3   | `sre-03-value-of-reliability`        | Reliability ရဲ့ တန်ဖိုး                 | SRE 1  | 9.4   |
| 4   | `sre-04-production-then-now`         | Production ဘယ်လို ပြောင်းလဲလာလဲ          | SRE 1  | 9.4   |
| 5   | `sre-05-reliability-culture`         | Reliability ယဉ်ကျေးမှု                | SRE 1  | 9.5   |
| 6   | `sre-06-slo-error-budget`            | SLO နဲ့ error budget                 | SRE 2  | 10.5  |
| 7   | `sre-07-slo-from-the-users-side`     | User ဘက်က ကြည့်တဲ့ SLO                  | SRE 2  | 10.5  |
| 8   | `sre-08-observability`               | Monitoring ကနေ observability ဆီ     | SRE 2  | 10.5  |
| 9   | `sre-09-sustainable-on-call`         | ရေရှည် လုပ်နိုင်တဲ့ on-call                 | SRE 3  | 9.5   |
| 10  | `sre-10-working-an-incident`         | Incident တစ်ခုကို အစကနေ အဆုံးထိ           | SRE 3  | 9.5   |
| 11  | `sre-11-postmortems`                 | သင်ခန်းစာ ရတဲ့ postmortem              | SRE 3  | 9.4   |
| 12  | `sre-12-how-complex-systems-fail`    | ရှုပ်ထွေးတဲ့ system တွေ ဘယ်လို ပျက်လဲ          | SRE 3  | 10.5  |
| 13  | `sre-13-stpa-and-cast`               | Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST    | SRE 3  | 10.5  |
| 14  | `sre-14-becoming-an-sre`             | SRE တစ်ယောက် ဖြစ်လာဖို့                  | SRE 4  | 10.5  |
| 15  | `sre-15-where-sre-lives`             | SRE အဖွဲ့ကို ဘယ်မှာ ထားမလဲ                 | SRE 4  | 10.4  |
| 16  | `sre-16-engagement-models`           | Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ           | SRE 4  | 10.5  |
| 17  | `sre-17-toil-and-automation`         | Toil နဲ့ automation                  | SRE 5A | 10.5  |
| 18  | `sre-18-testing-and-config`          | Test နဲ့ config                      | SRE 5A | 9.5   |
| 19  | `sre-19-testing-in-production`       | Production ထဲမှာ စမ်းသပ်ခြင်း           | SRE 5A | 9.5   |
| 20  | `sre-20-capacity-planning`           | Capacity ဘယ်လောက် လိုမလဲ                | SRE 5B | 10.5  |
| 21  | `sre-21-data-you-are-trusted-with`   | ယုံကြည်ပြီး အပ်ထားတဲ့ data                | SRE 5B | 9.5   |
| 22  | `sre-22-backups-and-restores`        | Backup ထက် restore က ပိုအရေးကြီးတယ်     | SRE 5B | 10.5  |
| 23  | `sre-23-containing-failure`          | Failure ကို ဘောင်ခတ်ထားတဲ့ design        | SRE 5C | 10.5  |
| 24  | `sre-24-overload-change-emergency`   | Overload နဲ့ emergency mode          | SRE 5C | 10.4  |
| 25  | `sre-25-platform-engineering`        | မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင်             | SRE 5C | 10.5  |
| 26  | `sre-26-when-ai-writes-the-code`     | AI က code ရေးတဲ့ခေတ်                  | SRE 6A | 10.4  |
| 27  | `sre-27-reliability-for-ai-features` | AI feature တွေရဲ့ reliability         | SRE 6A | 10.5  |
| 28  | `sre-28-ai-in-production-safely`     | AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း | SRE 6A | 10.5  |
| 29  | `sre-29-where-ai-helps-operations`   | AI က operations မှာ ဘယ်နေရာ ကူညီလဲ      | SRE 6A | 9.5   |
| 30  | `sre-30-the-first-sre`               | ပထမဆုံး SRE                          | SRE 6B | 9.5   |
| 31  | `sre-31-sre-in-legacy-and-regulated` | ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE             | SRE 6B | 10.5  |
| 32  | `sre-32-the-road-ahead`              | SRE ရဲ့ ရှေ့ခရီး                        | SRE 6B | 10.5  |

Catalog titles are "SRE from zero N: <title>", so the catalog groups them; add them to one playlist in
this order. Modules: 1 Why SRE (1–5), 2 Agree and notice (6–8), 3 Respond and learn (9–13), 4 People
and teams (14–16), 5 Build it in (17–25), 6 AI, and SRE where you work (26–32).

## Decks

One published Google Slides deck per module group. Each lesson pins its pages by id (`lNN_pMM`, plus
`mN_map` for a module map), so inserting or reordering pages is safe, but **deleting or re-creating a
page breaks later renders of the lessons that use it**. Treat a page as frozen once its lesson has
rendered a draft; fix a typo by editing the page in place.

| Deck                                                                                                                                 | Lessons | Published                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [SRE 1 · Why SRE](https://docs.google.com/presentation/d/1C9xeoD0ksYQ53VJi5r8S5gFbu_6RBb91kui2eONaf0I/edit)                          | 1–5     | [pub](https://docs.google.com/presentation/d/e/2PACX-1vS4U7TvQcusdo_MEF9kN2JK1ZsNNMAjH8rXg9A70KgYuIxf8bq2hjPbDXTUpYAJgQ-AehPOM9zyo_Lx/pub) |
| [SRE 2 · Agree and notice](https://docs.google.com/presentation/d/165jj9ak0l_T_nIVmwoOMjhVdokS0l9b7-yYcMSTekGA/edit)                 | 6–8     | [pub](https://docs.google.com/presentation/d/e/2PACX-1vTsLY-k4iJIy1_51OGMEP-fQyRLCzxkFVy9dkZaKV6aJagL8xA5gwrY-uoRWzw-SWnL7QCLuer5rClc/pub) |
| [SRE 3 · Respond and learn](https://docs.google.com/presentation/d/1T0A6d7zlJqJ_cmomOWcIf5-p2O7dwt3ra_yUTf_Q88c/edit)                | 9–13    | [pub](https://docs.google.com/presentation/d/e/2PACX-1vQnixg1JXyyQxBuQRN8jr_FHKYu5mcxq_tTD394AVnczrYmLIUTsL7LdiELwDrbZscOQJ3KGhQ7rh4y/pub) |
| [SRE 4 · People and teams](https://docs.google.com/presentation/d/1vnvN3W3g-SXEv1ZtUI5A_SEhMuudWc9W7yNDTpsrsx4/edit)                 | 14–16   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vTfwR5EnbT88FJmQyL5j4ly_je1HWDnxxgj25pcz6oc8hrq5Jx2Wnq2RLc2mkrOwTZBmz38VIek4Scb/pub) |
| [SRE 5A · Toil and tests](https://docs.google.com/presentation/d/1TrHtWaT3mz3wlW8Wr9umqPI6U3KvUSbW6ctqUqmtGCA/edit)                  | 17–19   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vSUjGpV7K11ualy0QUFQ7PS3QU2tpW2fht7U6kj23CDggGd66s-wmJg5vKNeX8RVqGstlnWtCqTwzi7/pub) |
| [SRE 5B · Capacity and data](https://docs.google.com/presentation/d/1gwa8AxDXZ-cbKLoBDAGRqEl-2RryDiLMRfmp9CiTz7o/edit)               | 20–22   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vTUSnn3cAtUKx4c4yRdConjd0Twxkz4fmfa9H8rpPK5l7iy9fmB_m8CNRJoOVaeZuIHBi-0LLnVHjQz/pub) |
| [SRE 5C · Design and platforms](https://docs.google.com/presentation/d/1YP2f6eOLvPbogMHqg44SpfCEuI7YhgaQGQuqOyQgstw/edit)            | 23–25   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vQ1uOHEh8RzrKKOs0KFK_cEn1q0d5B8St3MRUgJGkE43-RBG2MysJIG6Y_WRqs4Z-fBgSHPbdM-ynCB/pub) |
| [SRE 6A · AI](https://docs.google.com/presentation/d/1ROIdKHFldyV99umGhr0KkWh8HVeL5eRoQCAgdDyOq74/edit)                              | 26–29   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vS7FWAjVP-nqdl6yRwkaLAvXH1bzU_DGE6SL76_X25_RG8ha2QeMtjdhQDqLuili5asnh9tI1dg_fdg/pub) |
| [SRE 6B · Where you work, and what's next](https://docs.google.com/presentation/d/1GiILa8gE-aFQ-2rOM-Mpi3Y3J0FJ1T4DZ2q97ckMueY/edit) | 30–32   | [pub](https://docs.google.com/presentation/d/e/2PACX-1vTPha97WhPPq9fJLxvmTgai7c5Iejkw-naj2xC1prRy0FX29TJi0dsSB60zkBWfTx8wRrbEjbN1aY0L/pub) |

All pages come from the page kit, [Next Editor · SRE · Page kit](https://docs.google.com/presentation/d/1B08KSgB1rhx_x3jkboJ-igU4LbbPo3hh8m7dpNplttI/edit):
eight brand page designs (cover, three points, compare, grid of three, grid of four, ladder, big number,
module map) with `{{FIELD}}` placeholders. Text is Google Sans everywhere; Google draws Burmese in its
own Myanmar font (setting Noto Sans Myanmar on a box turns the English words serif). Two pages were
built without the "Ops Buddy" icon their scripts mention (`m6_map`, `l29_p01`), because the kit has no
such icon yet.

## Rendering a lesson

1. Choose a Burmese provider: **မြန်မာ · VoxCPM2 (Modal)** with your narrator reference in the voice
   row, or **မြန်မာ · AthanLab (your API key)**. The lessons pin the English Pocket profile and Studio
   swaps in the Burmese one.
2. Open `/studio?plan=<script>`, keep the tab in front (Start render is disabled while it is hidden),
   and press **Start render**. Nothing runs, so no WebContainer boots; the first render fetches the
   module deck (about 1 MB a deck, a second or two).
3. When every check passes, watch the replay, then **Create draft…**, publish, and add the lesson to the
   course playlist in order.

## What to look at while reviewing

- **Wording.** Each module's voice-script review note lists the word choices only you can make:
  [README.md](./voice-scripts/README.md) (Modules 1–2), [review-module-3.md](./voice-scripts/review-module-3.md),
  [review-module-4.md](./voice-scripts/review-module-4.md), [review-module-5.md](./voice-scripts/review-module-5.md),
  [review-module-6.md](./voice-scripts/review-module-6.md). If you change spoken words, change the voice
  script and the YAML together (the narration check below must stay OK) and keep every `[[mark:…]]`.
- **Pronunciation.** canary, rollout, rollback and Padauk keep their written form (your choice from the
  probe). Any other term the voice says wrongly goes into `BURMESE_RESPELLINGS` in
  `src/studio/script/lexicon.ts`, never into the narration.
- **Pacing and the recap pause.** Extra page advances and board steps were added at existing sentence
  ends so nothing holds much past 35 seconds. The pause before each recap answer comes from
  highlighting the question in `notes.md`; at the voice's real pace it is about one to three seconds.
- **Whiteboard fit.** Board label widths were measured, not seen in a render; check that no Burmese
  label runs past its box.

## Maintaining the course

- The authoring contract is [lesson-script-authoring.md](../lesson-script-authoring.md). Each lesson's
  bridge question is the next lesson's opening question, so moving or removing a lesson means updating
  its neighbours.
- Narration check: `bun ~/Documents/sre-course/work/check-narration.ts docs/sre-course/voice-scripts/<script>.md src/studio/scripts/<script>.yaml`
  must print OK, and `bun scripts/studio-director.ts` must report every referenced page found.
- Working files that are not ours to publish (chapter notes on the book) and the deck tooling (page
  plans, the page generator and deck checker) live outside the repo in `~/Documents/sre-course/work/`.
