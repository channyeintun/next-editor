# CSS course — course guide

A 43-lesson CSS course narrated in Burmese. It covers everything in
[web.dev Learn CSS](https://web.dev/learn/css) (all 38 modules, every section) and ends with a
Tailwind CSS lesson. CSS terms stay in English and the code is shown as written. Every lesson is a
studio LessonScript in `src/studio/scripts/` (locale `my-MM`) that runs a plain HTML and CSS site
with Vite in the WebContainer. CSS is typed live into a linked stylesheet while the preview updates,
and whiteboards draw the models (the box model, the cascade, axes, grid lines, stacking order). All
lessons share one small site, a Yangon tea shop (ရွှေလက်ဖက်ရည်ဆိုင်), so learners meet the same page,
classes and data from lesson to lesson.

The Burmese narration has **not** been reviewed by Chan yet. Each lesson was built by Opus 5.5 in six
stages: a verified design with an English draft, a Burmese voice script, an independent Burmese edit,
a technical and a learner review, and a fix pass. Every committed YAML passes the Director, the
offline compile check (`bun scripts/studio-compile-check.ts`) and a full replay against real Vite and
Chrome (`bun scripts/studio-verify-lesson.ts`), with zero failures. Each YAML's narration is identical
to the voice script it was built from. If the wording changes, change it in the YAML and keep the
marks (`[[mark:…]]`) in place and order.

## Lessons

Lengths are estimates at Burmese VoxCPM2 pace (70 ms per character); the real voice decides the final
length. Total ≈ 10 hours 46 minutes.

| #   | Script                                  | Title                                             | ≈ min |
| --- | --------------------------------------- | ------------------------------------------------- | ----- |
| 1   | `css-course-01-basics`                  | CSS course 1: CSS အခြေခံ                          | 18    |
| 2   | `css-course-02-box-model`               | CSS course 2: Box model                           | 19    |
| 3   | `css-course-03-selectors`               | CSS course 3: Selector တွေ အပိုင်း 1              | 15    |
| 4   | `css-course-04-complex-selectors`       | CSS course 4: Selector တွေ အပိုင်း 2              | 15    |
| 5   | `css-course-05-cascade`                 | CSS course 5: Cascade နဲ့ layer တွေ               | 15    |
| 6   | `css-course-06-specificity`             | CSS course 6: Specificity                         | 15    |
| 7   | `css-course-07-inheritance`             | CSS course 7: Inheritance                         | 15    |
| 8   | `css-course-08-nesting`                 | CSS course 8: Nesting                             | 15    |
| 9   | `css-course-09-color`                   | CSS course 9: အရောင် ရေးနည်းတွေ                   | 15    |
| 10  | `css-course-10-sizing-units`            | CSS course 10: Unit တွေနဲ့ အရွယ်အစား              | 15    |
| 11  | `css-course-11-custom-properties`       | CSS course 11: Custom property တွေ                | 15    |
| 12  | `css-course-12-functions`               | CSS course 12: CSS function တွေ                   | 15    |
| 13  | `css-course-13-layout-flow`             | CSS course 13: Layout နည်းလမ်းတွေ                 | 15    |
| 14  | `css-course-14-position-transform`      | CSS course 14: Position နဲ့ transform             | 15    |
| 15  | `css-course-15-flexbox`                 | CSS course 15: Flexbox အပိုင်း 1၊ axis နဲ့ wrap   | 14    |
| 16  | `css-course-16-flex-sizing`             | CSS course 16: Flexbox အပိုင်း 2၊ item အရွယ်အစား  | 15    |
| 17  | `css-course-17-flex-alignment`          | CSS course 17: Flexbox အပိုင်း 3၊ alignment       | 15    |
| 18  | `css-course-18-grid`                    | CSS course 18: Grid အပိုင်း 1၊ track နဲ့ fr       | 13    |
| 19  | `css-course-19-grid-placement`          | CSS course 19: Grid အပိုင်း 2၊ line နဲ့ placement | 14    |
| 20  | `css-course-20-grid-areas`              | CSS course 20: Grid အပိုင်း 3၊ area နဲ့ subgrid   | 15    |
| 21  | `css-course-21-logical-properties`      | CSS course 21: Logical property တွေ               | 14    |
| 22  | `css-course-22-spacing`                 | CSS course 22: Spacing                            | 14    |
| 23  | `css-course-23-z-index`                 | CSS course 23: Z-index နဲ့ stacking context       | 14    |
| 24  | `css-course-24-overflow`                | CSS course 24: Overflow                           | 15    |
| 25  | `css-course-25-media-container-queries` | CSS course 25: Media query နဲ့ container query    | 15    |
| 26  | `css-course-26-pseudo-elements`         | CSS course 26: Pseudo-element တွေ                 | 15    |
| 27  | `css-course-27-pseudo-classes`          | CSS course 27: Pseudo-class တွေ                   | 15    |
| 28  | `css-course-28-focus-cursors`           | CSS course 28: Focus နဲ့ cursor                   | 15    |
| 29  | `css-course-29-lists-counters`          | CSS course 29: List နဲ့ counter                   | 14    |
| 30  | `css-course-30-typography`              | CSS course 30: Typography အပိုင်း 1၊ font         | 15    |
| 31  | `css-course-31-text-layout`             | CSS course 31: Typography အပိုင်း 2၊ စာသား        | 15    |
| 32  | `css-course-32-gradients`               | CSS course 32: Gradient                           | 15    |
| 33  | `css-course-33-backgrounds`             | CSS course 33: နောက်ခံ                            | 15    |
| 34  | `css-course-34-borders-shadows`         | CSS course 34: Border နဲ့ shadow                  | 16    |
| 35  | `css-course-35-shapes-clipping`         | CSS course 35: Path၊ shape၊ clipping နဲ့ masking  | 15    |
| 36  | `css-course-36-filters`                 | CSS course 36: Filter                             | 14    |
| 37  | `css-course-37-blend-modes`             | CSS course 37: Blend mode                         | 15    |
| 38  | `css-course-38-transitions`             | CSS course 38: Transition                         | 15    |
| 39  | `css-course-39-animations`              | CSS course 39: Animation နဲ့ keyframe             | 16    |
| 40  | `css-course-40-anchor-positioning`      | CSS course 40: Anchor positioning                 | 15    |
| 41  | `css-course-41-popover-dialog`          | CSS course 41: Popover နဲ့ dialog                 | 16    |
| 42  | `css-course-42-view-transitions`        | CSS course 42: View transition                    | 16    |
| 43  | `css-course-43-tailwind`                | CSS course 43: Tailwind CSS                       | 16    |

Lessons 1 and 2 were the pilot and run longer (18–19 minutes); every later lesson was held to 12–16.

Thumbnails (1280×720) are in [css-course-thumbnails/](./css-course-thumbnails/). They are rendered
from [css-course-thumbnail.html](./css-course-thumbnail.html) with
`bun docs/css-course-thumbnails/render.ts`, and each card's code line is a real line from that
lesson. The template is editable in Chrome like the React and Rust ones. Its mascot, Boxy, is an
original box-model drawing: no CSS, W3C or Tailwind mark is used.

## Coverage of web.dev Learn CSS

The curriculum assigned all 1,050 concepts of the web.dev modules (plus two course extras: media
query basics and `@layer` syntax) to exactly one lesson, and each lesson's reviews checked them.

| web.dev module                                                                           | Lesson(s)              |
| ---------------------------------------------------------------------------------------- | ---------------------- |
| [welcome](https://web.dev/learn/css/welcome)                                             | 1                      |
| [box-model](https://web.dev/learn/css/box-model)                                         | 1, 2, 13               |
| [selectors](https://web.dev/learn/css/selectors)                                         | 1, 3, 4, 26, 27        |
| [nesting](https://web.dev/learn/css/nesting)                                             | 8                      |
| [the-cascade](https://web.dev/learn/css/the-cascade)                                     | 1, 5, 7                |
| [specificity](https://web.dev/learn/css/specificity)                                     | 6, 7, 8                |
| [inheritance](https://web.dev/learn/css/inheritance)                                     | 7                      |
| [color](https://web.dev/learn/css/color)                                                 | 9                      |
| [sizing](https://web.dev/learn/css/sizing)                                               | 10, 25                 |
| [layout](https://web.dev/learn/css/layout)                                               | 13, 14, 15, 16, 18, 19 |
| [flexbox](https://web.dev/learn/css/flexbox)                                             | 15, 16, 17             |
| [grid](https://web.dev/learn/css/grid)                                                   | 18, 19, 20             |
| [logical-properties](https://web.dev/learn/css/logical-properties)                       | 21                     |
| [custom-properties](https://web.dev/learn/css/custom-properties)                         | 11, 38                 |
| [spacing](https://web.dev/learn/css/spacing)                                             | 14, 21, 22             |
| [pseudo-elements](https://web.dev/learn/css/pseudo-elements)                             | 26, 29, 41             |
| [pseudo-classes](https://web.dev/learn/css/pseudo-classes)                               | 4, 6, 27, 28           |
| [borders](https://web.dev/learn/css/borders)                                             | 21, 34                 |
| [shadows](https://web.dev/learn/css/shadows)                                             | 34, 36                 |
| [focus](https://web.dev/learn/css/focus)                                                 | 28                     |
| [cursors-and-pointers](https://web.dev/learn/css/cursors-and-pointers)                   | 23, 25, 28             |
| [z-index](https://web.dev/learn/css/z-index)                                             | 23                     |
| [anchor-positioning](https://web.dev/learn/css/anchor-positioning)                       | 40, 41                 |
| [popover-and-dialog](https://web.dev/learn/css/popover-and-dialog)                       | 41                     |
| [functions](https://web.dev/learn/css/functions)                                         | 11, 12, 14             |
| [paths-shapes-clipping-masking](https://web.dev/learn/css/paths-shapes-clipping-masking) | 35                     |
| [gradients](https://web.dev/learn/css/gradients)                                         | 32                     |
| [animations](https://web.dev/learn/css/animations)                                       | 39                     |
| [filters](https://web.dev/learn/css/filters)                                             | 36                     |
| [blend-modes](https://web.dev/learn/css/blend-modes)                                     | 37                     |
| [lists](https://web.dev/learn/css/lists)                                                 | 26, 29                 |
| [counters](https://web.dev/learn/css/counters)                                           | 29                     |
| [transitions](https://web.dev/learn/css/transitions)                                     | 38, 39, 41             |
| [view-transitions-spas](https://web.dev/learn/css/view-transitions-spas)                 | 42                     |
| [overflow](https://web.dev/learn/css/overflow)                                           | 24, 31                 |
| [backgrounds](https://web.dev/learn/css/backgrounds)                                     | 32, 33, 37             |
| [typography](https://web.dev/learn/css/typography)                                       | 10, 21, 26, 30, 31, 34 |
| [container-queries](https://web.dev/learn/css/container-queries)                         | 25                     |
| [conclusion](https://web.dev/learn/css/conclusion)                                       | 43                     |
| [Tailwind CSS](https://tailwindcss.com/docs)                                             | 43                     |

## The workspace

- **Lessons 1–42:** `vite` 5.4.21 only, `pnpm install` with no lockfile, and no PostCSS or Vite
  config. `index.html` links `/base.css` (the pinned tea-shop styles) and `/styles.css`, the file
  typed live. CSS edits hot-swap the `<link>` with no reload.
- **Never `url(` or `@import` in a typed stylesheet.** With either in the file, Vite runs PostCSS
  on every save, and every half-typed state shows its error overlay. Images live as `data:` URIs in
  custom properties in a pinned `images.css`, and `styles.css` reads them with `var()`.
- `kit.js` holds small data-attribute helpers. It reports a checkbox, popover or dialog state into a
  hidden status line, so `expect.preview` can assert it.
- **Lesson 43 (Tailwind):** `vite` 5.4.21, `tailwindcss` 4.3.3 and `@tailwindcss/vite` 4.3.3. The
  native oxide and lightningcss bindings load in the WebContainer. A cold install takes 55–77 s, so
  `runtime.start` has a 120 s timeout. `webcontainer-fix.js` works around a WebContainer bug: classes
  typed into `index.html` were not regenerated until the CSS file's mtime changed. On real Node it
  does nothing. Every CSS edit in that lesson is a block insert, because the Tailwind plugin shows an
  overlay for any half-typed CSS.

## Rendering a lesson

1. Choose **မြန်မာ · VoxCPM2 (Modal)** with your narrator reference in the voice row. The lessons pin
   the English Pocket profile, and Studio swaps in the Burmese provider at render time.
2. Open `/studio?plan=<script>`, keep the tab in front, and press **Start render**.
3. The site installs and runs live in the WebContainer, so the render needs network access for npm.
   Every preview interaction is checked (`expect.preview`), and any console error in the preview fails
   the render.
4. When every check passes, watch the replay, then **Create draft…**, publish, and add the lesson to the
   course playlist in the order above.

## Replay

The published lesson replays the preview as an rrweb DOM recording. To make this course replay
honestly, the preview replay was fixed on 2026-10-17 (876f08a6, 6e4b2a44, 8fdbf149, 0a728aef,
17fdcd80, 8747f8a4, cfa6a52f, 70ac79f3, f0fc1bb0, b99344fe, 9bf35711):

- CSS `@keyframes` animations play (they used to freeze on frame 0). They restart after a seek and run
  at 1× when the lesson plays faster.
- Popovers are recorded and re-shown in the top layer, nested ones included. Closed dialogs are truly
  closed, so later focus states replay. The top-layer order survives a rebuild.
- Project images referenced from CSS `url()` show, and replay no longer requests the dead dev server.

Still not in the replay, and said so in the narration: `:hover` shows only on the last clicked
element; `:active`, `:visited` and `:target` are explained on whiteboards; a view transition shows
only its final state; light dismiss (clicking outside a popover) cannot be performed.

## What to look at while reviewing

- **The Burmese.** It follows GLOSSARY-style rules distilled from the approved `next-editor-intro-mm`
  narration and the React course corrections (connected spoken register, CSS terms in English, no code
  read aloud), but Chan has not read it yet.
- **Pronunciation.** Terms the Burmese voice may say wrongly are listed as candidates for
  `BURMESE_RESPELLINGS` (`src/studio/script/lexicon.ts`): `rem`, `em`, `vw`/`vh`, `fr`, `OKLCH`,
  `z-index`, `pseudo-class`/`pseudo-element`, `nth-child`, `currentColor`, `flexbox`, `calc`, `var`,
  `keyframe`, `popover`, `Tailwind`, the container units (`cqi`, `cqw`…), `AA`/`AAA` and Tailwind's
  `md`/`lg`/`xl`. Listen to the first render of each and add only the ones that sound wrong.
- **Open questions from the reviews**, one or two per lesson at most:

- **Lesson 1.** Length: 18.0 min at 70 ms/char, against the curriculum's 13. The S1/S2 trims were used up by the accuracy fixes. Ship at this length, or move the course map and credit (about 1.5 min) out of the narration? New English tokens to check by ear on the first render: 'Rules' (Firefox) and 'curly brace'.
- **Lesson 2.** Length: the fixes added content, so the lesson went from 17.7 to 19.4 minutes at 70 ms/char, above the usual 10–15. That is about 1 minute per concept for 21 concepts. Keep it as one lesson, or split it into box areas and sizing / box-sizing? Can a learner inspect a paused, published lesson's live preview with DevTools? If so, lessons 1 and 2 could both invite inspecting the preview directly. For now both say to use your own browser.
- **Lesson 3.** The six new pointer highlights (three on the first-paragraph selector's pieces, three on the ^= $= *= operators) use fixed offsetMs timed at about 70 ms per character, which is roughly VoxCPM2's Burmese speed. With a much slower voice (for example AthanLab at 95 ms per character), each highlight would land about 1–3 s before its word. If you render with a slower voice, it is worth a look in Chrome.
- **Lesson 6.** The :not() demo now turns the normal cards black and white (filter: grayscale) instead of fading them with opacity, so their text stays readable. A filter is used here before the effects lesson teaches it. Keep it, or switch to the plainer `background: none`? That one is less visible in the preview (white vs cream).
- **Lesson 7.** Wording for the first explanation of 'specification': the lesson says 'CSS ရဲ့ တရားဝင် စာတမ်း ဖြစ်တဲ့ specification'. If you would say it differently, this is its first use in the course and later lessons will copy it, so it is worth adding to GLOSSARY.
- **Lesson 8.** The badge now has black text on darkorange so it is readable. White text on darkorange failed contrast at about 2.3:1. If you prefer to keep white text, the alternative is a sienna background, which also means changing the 'one colour, two elements' point. Please confirm black-on-orange is acceptable visually.
- **Lesson 9.** The finished header (#8b5a2bcc over the page) fails contrast for its small text. The tagline is about 1.7:1 and the cream links about 3.7:1. The recap now says so out loud. Should the lesson instead end on a solid, darker header (for example by typing a third background) so learners don't copy an inaccessible header? That would add about 10 s.
- **Lesson 10.** Lesson 10 now types `min-height: 100svh` under the hero's `100vh` after the phone board. The curriculum had small/large/dynamic viewport units as whiteboard only. The new line changes nothing on a desktop, and the narration says so. Keep it, or go back to board-only? The quiz's think-time is 'ခဏ စဉ်းစားကြည့်ပါ။' plus the natural gap between dialogs, which is not a long silent pause. Is that enough on the first render, or do you want a longer pause?
- **Lesson 15.** The quiz now asks about grid columns, before the learner has met grid (lesson 18). It is accurate and points to lesson 19. Please check that the Burmese question "grid မှာရော screen ကျဉ်းသွားရင် column အရေအတွက်က သူ့ဘာသာ လျော့သွားသလား။" sounds natural to you. The review fixes made the narration 175 characters longer (13.6 → 13.8 min). That is still under the 14.7–15 min band of lessons 3–10, so I did not trim further.
- **Lesson 18.** Board E now shows `repeat(12, minmax(0, 1fr))` rather than web.dev's literal `repeat(12, 1fr)`. The facts sheet recommends the minmax form, and the narration explains it by recalling the fr trap. If you prefer to show web.dev's exact code on the board, revert e-code2 and keep only the spoken caveat.
- **Lesson 19.** draw-place-full now uses the reduplicated 'column ဘယ်နှစ်ခု သတ်မှတ်ထားထား' ('however many columns you defined'). Please confirm it sounds natural spoken, or suggest a better phrase.
- **Lesson 20.** Several clauses were added on purpose and need a native read: the definition of string ('quote ထဲမှာ ရေးတဲ့ စာသားကို string လို့ ခေါ်ပါတယ်'), the menu class-name disclaimer, and 'grid မှာ flexbox လို main axis မရှိလို့'. Please check that they sound natural in Burmese.
- **Lesson 22.** Lesson 21's last sentence still promises that lesson 22 will use 'ဒီ နာမည်တွေကို' (the logical names). I answered it inside lesson 22 with one intro sentence and did not edit lesson 21, which is outside my scope. Do you want that clause dropped from lesson 21 as well, or lesson 22's demos retyped with margin-block-end and similar names?
- **Lesson 24.** Length is 15.1 minutes at 70 ms/char, up from 14.7, because scroll-margin is now a live demo as the curriculum asks. That is above the 15-minute target but under the 16-minute ceiling. Is that acceptable, or should more be trimmed?
- **Lesson 25.** After the first Burmese render, confirm that AA, AAA, cqi/cqw/cqh/cqb/cqmin/cqmax, pan x/pan y and manipulation sound right, and add BURMESE_RESPELLINGS entries in lexicon.ts where they don't.
- **Lesson 26.** Accessibility stance (explain-a11y-rule): the lesson now tells learners that a repeated unit like ကျပ် is fine as CSS content, and that the cup size (ခွက်ကြီး, via attr) was added with CSS only to show attr and belongs in the HTML on a real site. Should ကျပ် also move to the HTML on a real site? If so, the sentence needs a small change.
- **Lesson 28.** When you watch the first Chrome render, check that the order button's ring disappears as type-focus-within starts typing, and that the field ring and form tint disappear at select-focus-within. The narration now says both happen because the studio's editor takes focus. Lesson 27's select-range depends on the same behaviour.
- **Lesson 29.** The fixes made the lesson about 11 s longer (13.9 to 14.1 min at 70 ms/char). The recap quiz now asks each question aloud before its answer appears, and that is most of the extra time. Keep it, or go back to the shorter quiz that only gives the answers?
- **Lesson 31.** Nobody has probed the hours clue ('Saturday sits after the first line') with Windows' Myanmar Text font. A much wider font could push Saturday onto line 2 under the default, and explain-collapse's sentence would then be off for those viewers. It held in all four fonts that were probed.
- **Lesson 32.** Stacking-order word: lesson 32 now follows lesson 23's ရှေ့ / အရှေ့ဆုံး for 'the first background layer is in front'. Lesson 33 (backgrounds, in progress) says 'ပထမ ပုံက အပေါ်ဆုံးမှာ' for the same idea. One of the two should be aligned. I suggest lesson 33 also use အရှေ့ဆုံး, since it already frames layers as 'ကြည့်သူနဲ့ အဝေးဆုံး'.
- **Lesson 34.** Board D's shadow copies are grey (#868e96 stroke, #adb5bd fill), which is outside the mid-tone palette, so that a shadow looks like a shadow. Please check in the render that they read well on the dark board.
- **Lesson 38.** No native editor has reviewed the new Burmese sentences yet: the reduced-motion demo ('လက်ဖက်ရည်ကို ပြန်လျှော့ကြည့်ရအောင်။ ကိုယ့် စက်မှာ reduced motion ဖွင့်ထားရင် ချက်ချင်း ကျသွားပြီး…') and the lift list ('ဒီ rule က card တွေရဲ့ transition စာရင်းကို တစ်ခုလုံး အစားထိုးလို့၊ opacity ကို ပြန်ထည့်ရပါတယ်။'). Please check they sound natural in your voice.
- **Lesson 39.** At 70 ms/char the lesson runs 15.5 min, which is over the 12–15 min target but under the 16 min ceiling. Fixing the findings without adding length meant I couldn't trim it below that without cutting assigned concepts.
- **Lesson 40.** Length is 15.4 min at 70 ms/char, slightly over the 12–15 target (it was 15.1 before review). The two added points, accessibility and the early browser warning, are needed. Is that acceptable, or should I cut the draw-calc example sentence and the position-visibility default sentence (about 0.15 min)?
- **Lesson 41.** The lesson runs 15.5 min at 70 ms/char, above the 12–15 target but under the 16 ceiling. Reaching 15.0 would mean cutting about 400 characters, from spans that each carry an assigned concept or a recall. Keep 15.5, or allow those cuts?
- **Lesson 42.** Focus fix (F8): after a back click, show() now returns focus to the picked dish card. In the render, the studio's scripted click counts as keyboard focus, so a blue focus ring shows on that card in the menu. A real mouse click shows none. The narration does not mention it. Keep the ring, which is honest keyboard behaviour, or drop the focus move?
- **Lesson 43.** Newly spoken tokens 'md၊ lg၊ xl နဲ့ 2xl' and 'anchor positioning' may need BURMESE_RESPELLINGS entries after the first Burmese render. At 15.97 min (70 ms/char) the lesson sits right under the 16-minute ceiling. Any later addition needs a matching cut.

## Maintaining the course

- The authoring contract is [lesson-script-authoring.md](./lesson-script-authoring.md); the voice rules
  are [studio-persona.md](./studio-persona.md).
- Lessons point back to earlier lessons and close by naming the next one, so moving or removing a
  lesson means updating its neighbours. Lesson 43 closes the course.
- Edits are insert-only. CSS is typed keystroke by keystroke into `styles.css`; HTML changes are block
  inserts of complete elements (each one reloads the preview); JavaScript is pinned complete.
