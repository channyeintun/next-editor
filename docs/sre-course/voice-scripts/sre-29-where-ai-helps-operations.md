# Lesson 29 · AI က operations မှာ ဘယ်နေရာ ကူညီလဲ

slug: sre-29-where-ai-helps-operations · budget: 7600 characters (±5%)

## Scene 1 · Hook: green dashboard, angry comments

chapter: Dashboard အစိမ်း၊ comment တွေ ဒေါသထွက်

> ⟪page l29_p01⟫ lesson ၂၈ မှာ Padauk ရဲ့ AI operations agent၊ Ops Buddy က action card၊ budget နှစ်ခုနဲ့ stop button ဆိုတဲ့ ဘရိတ်တွေ ရလာခဲ့ပါတယ်။
> သောကြာနေ့ ညနေ top-up promo စတော့ dashboard က Top-up success rate ၉၉.၇ ရာခိုင်နှုန်းနဲ့ အစိမ်းရောင် ပြနေပါတယ်။ ဒါပေမဲ့ Operator B နဲ့ app ၅.၃ ကို သုံးသူတွေဆီက top-up မရဘူး၊ သုံးခါတောင် စမ်းပြီးပြီ ဆိုတဲ့ ဒေါသထွက်နေတဲ့ comment တွေ Facebook နဲ့ Viber ကနေ မစုရဲ့ support အဖွဲ့ဆီ ဆက်တိုက် ဝင်လာပါတယ်။ alert ဘာလို့ မတက်ခဲ့တာလဲ?

On screen:

- l29_p01 (K1): 29 | AI က operations မှာ ဘယ်နေရာ ကူညီလဲ | Dashboard အစိမ်း၊ comment တွေ ဒေါသထွက် | success rate: 99.7% | Operator B + app 5.3 user တွေ top-up မရ | alert ဘာလို့ မတက်ခဲ့တာလဲ? | (small loop badge, the whole loop lit, Ops Buddy icon at သတိထားမိ · တုံ့ပြန် · သင်ယူ · တည်ဆောက်)

## Scene 2 · Before: the complaints chart

chapter: ပျမ်းမျှထဲမှာ ပျောက်နေတဲ့ user တွေ

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒီ chart က အဲဒီညနေ မစုရဲ့ အဖွဲ့ဆီ ရောက်လာတဲ့ complaint တွေကို app version နဲ့ operator အလိုက် ခွဲထားတာပါ။ Operator A ဘက်က အုပ်စုတွေမှာ complaint နည်းနည်းစီပဲ ရှိပြီး promo ညတိုင်း မြင်နေကျပါ။
> ⟪board B1 step 2⟫ ဒါပေမဲ့ app ၅.၃ နဲ့ Operator B အုပ်စုမှာတော့ complaint ၃၈ ခု တက်လာပါတယ်၊ app ၅.၃ နဲ့ Operator C ကတော့ ပုံမှန်ပါပဲ။ top-up အားလုံးထဲမှာ ဒီ အုပ်စုက သေးသေးလေးပဲ ဖြစ်တော့ ပေါင်းထားတဲ့ success rate က SLO ၉၉.၅ ရာခိုင်နှုန်းထက် မြင့်နေဆဲမို့ alert မတက်ခဲ့တာပါ။ ပျမ်းမျှက သူတို့ ဒုက္ခကို ဖုံးထားလိုက်တာပါ။
> ⟪board B1 step 3⟫ ဒီ chart ကို ဆွဲပေးတာက Ops Buddy ပါ။ မြန်မာလို အင်္ဂလိပ်လို ရောရေးထားတဲ့ message ၄၂၀ ကို ဖတ်ပြီး ဘယ် version၊ ဘယ် operator၊ ဘာလုပ်ရင်း ဖြစ်လဲ ဆိုတာနဲ့ အုပ်စုဖွဲ့ပေးတာပါ။ တစ်ခုချင်း ဖတ်ရင် မရေမရာ ဖြစ်နေတဲ့ စာတွေကို စုလိုက်တော့မှ ဒီ အနီရောင် bar ပေါ်လာတာပါ။
> ⟪close board⟫ ⟪page l29_p01b⟫ ပျမ်းမျှက နောက်တစ်မျိုးလည်း ဖုံးထားတတ်ပါတယ်။ supermarket chain ရဲ့ ညတိုင်း settlement စစ်တဲ့ job က Padauk API ကို ၅၀၀ ခါ ခေါ်ပြီး တစ်ခါ fail တာနဲ့ job တစ်ခုလုံး fail ပါတယ်။ တစ်ခါချင်းမှာ error ၀.၂ ရာခိုင်နှုန်းပဲ ဆိုရင် dashboard က ၉၉.၈ ရာခိုင်နှုန်း ပြနေပေမဲ့ သူတို့ job ကတော့ ည ၁၀၀ မှာ ၆၃ ညလောက် fail ပါတယ်။
> ပုံမှန်နဲ့ မတူတာကို ရှာတဲ့ anomaly detection ကလည်း promo စတာ၊ traffic လွှဲတာလို ပုံမှန် အပြောင်းအလဲတွေကို ပျက်နေတယ်လို့ ထင်တတ်ပြီး user က top-up တကယ် ရလား မမြင်ပါဘူး။

On screen:

- B1 step (1), cleared (P5 bars on an underline axis): ညနေက complaint: version / operator (title, furniture) | 5.1 / A · 5.2 / A · 5.3 / A (three short blue bars, labels under the axis)
- B1 step (2): 5.3 / B: 38 (tall red bar) | 5.3 / C (short blue bar)
- B1 step (3): Ops Buddy က message 420 ကို အုပ်စုဖွဲ့ (small violet label above the bars)
- l29_p01b (K7): supermarket ရဲ့ ညတိုင်း job | 63% fail | call 500၊ တစ်ခုချင်း error 0.2%၊ dashboard 99.8%

## Scene 3 · Complaints as a signal

chapter: Complaint ကို signal အဖြစ်

> ⟪page l29_p02⟫ ဒါကြောင့် user ရေးတဲ့ complaint ကို signal တစ်ခုအဖြစ် သုံးလို့ရပါတယ်။ metric က ဘယ်နှစ်ခု fail လဲ ဆိုတာပဲ ပြောပေမဲ့ complaint ကတော့ user က ဘာလုပ်ချင်ခဲ့လဲ၊ ဘယ်မှာ၊ ဘယ်အချိန်က ဘာဖြစ်သွားလဲ ဆိုတာကို ကိုယ့်စကားနဲ့ ပြောပြပါတယ်။ စာရေးရတာ အချိန်ပေးရလို့ တကယ် ဒုက္ခရောက်တဲ့သူတွေပဲ ရေးလေ့ ရှိပြီး၊ အုပ်စု ကြီးလေ ပြဿနာ ကြီးလေ ဖြစ်ပါတယ်။
> တစ်စိတ်တစ်ပိုင်းပဲ ပျက်တာကို user တွေက metric ထက် အရင် သိတတ်ပေမဲ့ complaint က metric ကို ကူပေးတာပါ၊ အစားထိုးတာ မဟုတ်ပါဘူး။
> ⟪page l29_p02b⟫ အုပ်စုက သတ်မှတ်ထားတဲ့ အရွယ်ကို ကျော်တော့ Ops Buddy က report တိုတို ရေးပြီး Top-up on-call ကျနေတဲ့ ကိုမင်းဆီ page ပို့ပါတယ်။ version နဲ့ operator ကို သိနေတော့ ထိခိုက်နေတဲ့ user ၂၁၀၀ လောက်ဆီကိုပဲ message ပို့လို့ user ၁၂ သိန်းလုံးကို မလန့်စေရပါဘူး။
> ဒီလို အလုပ်ဖြစ်တာ model တော်လို့ချည်း မဟုတ်ပါဘူး။ spam စစ်ထုတ်တာ၊ ဖုန်းနံပါတ်နဲ့ နာမည် ဖယ်တာ၊ Unicode နဲ့ ဇော်ဂျီ ညှိတာလို model ပတ်ပတ်လည်က pipeline အလုပ်တွေက အများစုပါ။

On screen:

- l29_p02 (K2): Complaint ကို signal အဖြစ် | user က ဘာ၊ ဘယ်မှာ၊ ဘယ်တော့ ပြော | အုပ်စု အရွယ်က ပြဿနာ အရွယ် | metric ကို ကူ၊ အစား မထိုး
- l29_p02b (K7): ထိခိုက်တဲ့ user | 2,100 | 12 သိန်းလုံး မဟုတ်၊ သူတို့ဆီပဲ message

## Scene 4 · During

chapter: Incident အတွင်း

> ⟪close page⟫ ⟪board B2 step 1⟫ ကိုမင်းက incident ကြေညာလိုက်တော့ Ops Buddy က ဘာမှ မပြောင်းဘဲ ဖတ်ပြီး ရေးပေးတာကနေ စပါတယ်။ နောက်မှ ဝင်လာသူတွေအတွက် ဘာသိပြီ၊ ဘာလုပ်ပြီးပြီ ဆိုတဲ့ summary ရေးပေးပြီး shift လွှဲဖို့ handoff မူကြမ်းလည်း ပြင်ထားပေးလို့ ဘာဖြစ်နေတာလဲ ဆိုတဲ့ မေးခွန်းတွေ channel ထဲမှာ အများကြီး နည်းသွားပါတယ်။
> ⟪board B2 step 2⟫ အကြောင်းရင်း မသိခင် user ထိခိုက်မှုကို အရင် ရပ်တဲ့ mitigation အတွက်တော့ Ops Buddy က lesson ၁၀ မှာ ရေးခဲ့တဲ့ fix စာရင်းထဲကနေ rollback၊ traffic လွှဲတာ၊ capacity တိုးတာလို တစ်ခုကို ရွေးပါတယ်။ fail တွေ စတဲ့ အချိန်က app ၅.၃ user တွေကို top-up လမ်းကြောင်းအသစ်ဆီ ပို့တဲ့ promo config ပြောင်းလဲမှုနဲ့ ကိုက်နေလို့ အဲဒါကို rollback လုပ်ဖို့ အကြံပေးပြီး ယုံကြည်မှု မြင့်တယ်လို့လည်း ပြပါတယ်။
> ⟪board B2 step 3⟫ ဆုံးဖြတ်တာကတော့ ကိုမင်းပါ၊ အထောက်အထားကို စစ်ပြီး approve လုပ်တော့ မကြာခင် top-up တွေ ပြန်ဝင်လာပါတယ်။ ⟪board B2 step 4⟫ Padauk က ယုံကြည်မှု မျဉ်း တစ်ခုလည်း သတ်မှတ်ထားပြီး အဲဒီ မျဉ်းအောက်က အကြံဆိုရင် Ops Buddy က လုံးဝ မပြပါဘူး။ မသေချာတဲ့ ခန့်မှန်းချက်ကို တစ်ခါ မြင်လိုက်ရရင် ပင်ပန်းနေတဲ့ on-call က အဲဒီဘက်ကိုပဲ လိုက်စဉ်းစားမိပြီး လမ်းလွဲသွားတတ်လို့ပါ။

On screen:

- B2 step (1), cleared (P6, one lane left to right): incident အတွင်း (lane title) | နောက်မှ ဝင်သူ / summary (two lines) → handoff / မူကြမ်း (two lines)
- B2 step (2): → rollback အကြံ / ယုံကြည်မှု မြင့် (two lines)
- B2 step (3): လူက approve (green box below the rollback box)
- B2 step (4): ယုံကြည်မှု မျဉ်း: ဒီအောက်ဆို ဘာမှ မပြ (thin orange threshold rectangle under the lane, label beside it)

## Scene 5 · After

chapter: နောက်တစ်နေ့

> ⟪close board⟫ ⟪board B3 step 1⟫ user ထိခိုက်မှုကို ရပ်တာနဲ့ ဘာကြောင့်လဲ နားလည်တာက သီးခြား အလုပ်ပါ။ နောက်တစ်နေ့မှာ Ops Buddy က trace နဲ့ log တွေကနေ ဖြစ်နိုင်တဲ့ အကြောင်းရင်း၊ hypothesis တွေ ထုတ်ပေးပြီး မှန်မမှန်ကိုတော့ engineer တွေက data နဲ့ စစ်ပါတယ်။
> ⟪board B3 step 2⟫ စစ်ကြည့်တော့ app ၅.၃ ရဲ့ လမ်းကြောင်းအသစ်က top-up အဖြေ နောက်ကျရင် idempotency key မပါဘဲ ပြန်ပို့တာ တွေ့ရပါတယ်။ ဒီ key က request တစ်ခုကို ဘယ်နှခါ ပို့ပို့ တစ်ခါပဲ လုပ်အောင် တွဲပေးတဲ့ သီးသန့် နံပါတ်ပါ၊ key မပါတော့ Operator B က ဒုတိယ request ကို ထပ်နေတယ်ဆိုပြီး ငြင်းလိုက်တာပါ။
> ⟪board B3 step 3⟫ postmortem မူကြမ်းကိုလည်း Ops Buddy က chat နဲ့ alert မှတ်တမ်းတွေကနေ ရေးပေးပေမဲ့ ဘယ်မှာ ကံကောင်းခဲ့လဲ၊ ဘာ ပြင်မလဲ ဆိုတဲ့ သင်ခန်းစာကိုတော့ အဖွဲ့က ကိုယ်တိုင် ရေးပါတယ်။ ⟪board B3 step 4⟫ ဆင်တူ incident အဟောင်းတွေကို ရှာပြီး dashboard ဆောက်ပေးတာ၊ alert တက်ရင် ဘာလုပ်ရမလဲ အဆင့်လိုက် ရေးထားတဲ့ playbook ကို ကိုမင်း တကယ် လုပ်ခဲ့တာနဲ့ တိုက်ပြီး ပြင်ဖို့ အကြံပေးတာတွေလည်း လုပ်ပါတယ်။
> ⟪board B3 step 5⟫ ပြီးတော့ incident တစ်ခုက အားနည်းချက်ကို codebase တိုင်းမှာ လိုက်ရှာတဲ့ fleet scan နဲ့ idempotency key မပါတဲ့ payment call ၇ ခု ထပ်တွေ့ပါတယ်။ lesson ၁ မှာ ယူခဲ့ပြီး lesson ၁၁ မှာ ငွေ နှစ်ခါ ဖြတ်မိစေခဲ့တဲ့ အကြွေးမျိုးကို ဒီတစ်ခါတော့ user မထိခင် ဆပ်လိုက်တာပါ။

On screen:

- B3 step (1), cleared (P6, one lane left to right): နောက်တစ်နေ့ (lane title) | hypothesis / trace · log ကနေ (two lines) | လူက စစ် (small green label under it)
- B3 step (2): → အကြောင်းရင်း / key မပါတဲ့ retry (two lines)
- B3 step (3): → postmortem / မူကြမ်း (two lines) → သင်ခန်းစာ / လူက ရေး (green, two lines)
- B3 step (4): incident အဟောင်း · dashboard · playbook (small blue note under the lane)
- B3 step (5): fleet scan: payment call 7 ခု ထပ်တွေ့ (orange box at the bottom)

## Scene 6 · The toil loop

chapter: Toil ကနေ playbook ဆီ

> ⟪close board⟫ ⟪board B4 step 1⟫ incident မရှိတဲ့ ရက်တွေမှာတော့ AI က toil ကို လျှော့ပေးပါတယ်။ လက်နဲ့ ထပ်ခါထပ်ခါ လုပ်ရတဲ့ toil ရဲ့ အဓိပ္ပာယ်က lesson ၁၇ ကတည်းက မပြောင်းပါဘူး၊ အသစ်က automation ဆောက်တာကိုယ်တိုင် မြန်လာတာပါ။ merchant တွေရဲ့ ticket နဲ့ chat တွေကို Ops Buddy က အုပ်စုဖွဲ့ကြည့်တော့ အများဆုံးက မနေ့က settlement file ကို ပြန်ပို့ပေးပါ ဆိုတာပါ၊ တစ်ဆိုင်တည်းက နှစ်ခါ တောင်းတာတွေကိုလည်း ပေါင်းပေးပါတယ်။
> ⟪board B4 step 2⟫ engineer တွေ အရင်က file ပြန်ပို့ခဲ့ပုံတွေကနေ Ops Buddy က playbook မူကြမ်း ရေးပြီး လူက review လုပ်ပါတယ်။ file ကို ဖတ်ပြီး ပြန်ပို့ရုံမို့ action card မှာ ကိုယ်တိုင် လုပ်ပြီးမှ ပြောခွင့် ရပါတယ်၊ ငွေ ရွှေ့ရမယ့် ကိစ္စတွေနဲ့ မမြင်ဖူးသေးတဲ့ ကိစ္စတွေကတော့ လူဆီ ရောက်ပါတယ်။
> ⟪board B4 step 3⟫ merchant တစ်ဆိုင်က file ထဲမှာ ဘာမှ မပါဘူးလို့ ပြန်ပြောတော့ ticket ပြန်ပွင့်ပြီး playbook မှာ မပို့ခင် file ထဲ data ရှိလား စစ်တဲ့ အဆင့် ထပ်တိုးလာပါတယ်။ ဒီလို agent ဖြေရှင်းပြီးသား ticket ပြန်ပွင့်တဲ့ နှုန်း၊ reopen rate က agent ကို တိုင်းတဲ့ အဓိက number ပါ။
> ⟪board B4 step 4⟫ ငွေ မရောက်ဘူး ဆိုတဲ့ ticket တွေမှာတော့ engineer မကြည့်ခင် merchant ID နဲ့ transaction ID ကို Ops Buddy က အရင် မေးထားပေးပါတယ်။

On screen:

- B4 step (1), cleared (P3 ring, clockwise): settlement file ပြန်ပို့ (title, furniture) | ticket နဲ့ chat ထဲက / toil ရှာ (node, two lines) → ထပ်တာ ပေါင်း (node, after the top-arc arrow-right)
- B4 step (2): → လူ့ fix ကနေ / playbook (node, two lines) → ကန့်သတ်ချက်နဲ့ / agent ဒါမှမဟုတ် လူ (node, two lines, after the right-arc arrow-down)
- B4 step (3): ပြန်ပွင့်လား? (red node closing the ring back to the start)
- B4 step (4): အချက်အလက် အရင် မေး (side box outside the ring, feeding the first node)

## Scene 7 · Beyond toil

chapter: Toil ထက် ပိုကြီးတဲ့ အကျိုး

> ⟪close board⟫ ⟪page l29_p03⟫ ဒါဆို AI ရဲ့ တန်ဖိုးကို သက်သာသွားတဲ့ နာရီနဲ့ပဲ တိုင်းမလား? toil က အပတ်ရဲ့ ၃၀ ရာခိုင်နှုန်း ဆိုပါစို့၊ AI နဲ့ ၁၀ ဆ မြန်အောင် လုပ်နိုင်ရင် toil က ၃ ရာခိုင်နှုန်းပဲ ကျန်ပြီး engineering အချိန်က ၇၀ ကနေ ၉၇ ရာခိုင်နှုန်း ဖြစ်လာပါတယ်။ toil ကို လုံးဝ ဖျောက်နိုင်ရင်တောင် ၁၀၀ ရာခိုင်နှုန်းကို မကျော်နိုင်ပါဘူး၊ toil ဖယ်တာက အချိန်ကိုပဲ ပြန်ပေးနိုင်လို့ အကန့်အသတ် ရှိတာပါ။
> ⟪page l29_p03b⟫ ပိုကြီးတဲ့ အကျိုးက ဈေးကြီးလို့ အရင်က မလုပ်နိုင်ခဲ့တဲ့ အလုပ်အသစ်တွေပါ။ ဥပမာ design review နဲ့ launch review ကို AI က အရင် စစ်ပေးတာ၊ fault တစ်ခုကို တမင် inject လုပ်တဲ့ fault experiment မှာ fault တကယ် ဖြစ်ခဲ့လား၊ system ခံနိုင်ခဲ့လား စစ်တာ၊ run နေတဲ့ config ကို စည်းမျဉ်းတွေနဲ့ တိုက်စစ်တာတွေပါ။ ပြင်ရမယ်ဆိုရင်တော့ lesson ၂၈ ရဲ့ action card အောက်မှာပဲ ပြင်ပါတယ်။
> ⟪page l29_p03c⟫ AI tool တွေကိုလည်း အဖွဲ့တွေက အရင် စမ်းပြီး အလုပ်ဖြစ်တာကိုမှ platform အဖွဲ့က အားလုံးအတွက် ယူပါတယ်။ on-call ကလည်း သိပြီးသား fix တွေကနေ ပြဿနာ အမျိုးအစား အသစ်တွေဆီ ရွေ့သွားပါတယ်။
> ops အလုပ်ကို လုပ်ရင်း နားလည်ပြီးမှ engineering နဲ့ မလိုတော့အောင် လုပ်တာက Site Reliability Engineering၊ SRE စကတည်းက ရှိခဲ့တဲ့ အယူအဆပါ။ AI ကြောင့် ကွာသွားတာက merchant chat တွေလို လူ ဖတ်မှ နားလည်ခဲ့တဲ့ အလုပ်တွေပါ အဲဒီလို ဖယ်လို့ ရလာတာပါ။

On screen:

- l29_p03 (K7): toil ဖယ်တာရဲ့ အကန့်အသတ် | အများဆုံး 97% | toil 30%၊ 10 ဆ မြန်ရင် engineering 70% → 97%
- l29_p03b (K4): AI ကြောင့် တတ်နိုင်လာတဲ့ အလုပ် | design review: launch review ပါ၊ AI က အရင် စစ် | fault experiment: ဖြစ်ခဲ့လား၊ ခံနိုင်ခဲ့လား | config: စည်းမျဉ်းနဲ့ တိုက်
- l29_p03c (K2): အလုပ် ဘယ်လို ပြောင်းလဲ | အဖွဲ့တွေ စမ်း၊ platform က ယူ | on-call က ပြဿနာ အသစ်တွေဆီ | ops အလုပ်ကို engineering နဲ့ ဖယ်

## Scene 8 · This week

chapter: —

> ⟪page l29_p04⟫ agent မရှိသေးလည်း ဒီအပတ် စလို့ရတာ သုံးခုပါ။ complaint တွေကို app version နဲ့ ဒေသ အလိုက် ခွဲကြည့်ပါ။ နောက်ဆုံး incident ရဲ့ chat ကနေ AI ကို timeline မူကြမ်း ရေးခိုင်းပြီး ကိုယ်တိုင် ပြန်စစ်ပါ။ ပြီးတော့ ခဏခဏ လုပ်နေရတဲ့ fix တစ်ခုကို playbook အဖြစ် ချရေးပါ။

On screen:

- l29_p04 (K2): ဒီအပတ် လုပ်စရာ | complaint ကို version၊ ဒေသ အလိုက် ခွဲပါ | timeline ကို AI နဲ့ မူကြမ်း ရေးပါ | ခဏခဏ လုပ်ရတဲ့ fix ကို playbook လုပ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ AI ကူခဲ့တဲ့ နေရာတွေပါ။ ⟪select complaint အုပ်စုဖွဲ့တာ⟫ complaint အုပ်စုဖွဲ့တာက ပျမ်းမျှထဲမှာ ပျောက်နေတဲ့ အုပ်စုကို ရှာပေးပါတယ်။ ⟪select ယုံကြည်မှု မျဉ်း⟫ ယုံကြည်မှု မျဉ်းအောက်က AI အကြံကိုတော့ on-call ကို လုံးဝ မပြပါဘူး။ ⟪select playbook⟫ playbook ကို လူတွေ အောင်မြင်ခဲ့တဲ့ fix တွေကနေ ရေးပါတယ်။
> ⟪select reopen rate⟫ reopen rate က agent ဖြေရှင်းပြီးသား ticket ပြန်ပွင့်တဲ့ နှုန်းပါ။ ⟪select toil ဖယ်တာရဲ့ အကန့်အသတ်⟫ toil ဖယ်တာရဲ့ အကန့်အသတ်က ဘယ်လောက် မြန်မြန် ဖယ်ဖယ် အချိန်ကိုပဲ ပြန်ရတာပါ။ ⟪select fleet scan⟫ fleet scan ကတော့ အားနည်းချက် တစ်ခုကို codebase တိုင်းမှာ လိုက်ရှာတာပါ။
> ⟪select မေးခွန်း⟫ supermarket ရဲ့ job လိုပဲ တွက်ကြည့်ပါ။ ညတိုင်း run တဲ့ job က API ကို ၅၀၀ ခါ ခေါ်ပြီး တစ်ခါချင်းမှာ error ၀.၁ ရာခိုင်နှုန်း ဆိုရင် run တစ်ခါမှာ error အနည်းဆုံး တစ်ခု ကြုံဖို့ ဘယ်လောက် ဖြစ်နိုင်လဲ?
> ⟪pause 3s⟫ ၃၉ ရာခိုင်နှုန်းလောက်ပါ၊ error ထက်ဝက် လျော့ပေမဲ့ ည ၅ ညမှာ ၂ ညလောက် ကြုံရဆဲပါ။ ဒီနေ့ ပြောခဲ့တာတွေက Padauk ရဲ့ ကိုယ်ပိုင် platform နဲ့ အဖွဲ့ကို အားကိုးထားပါတယ်။ အခု Padauk က မန္တလေးက delivery startup လေး တစ်ခုကို ဝယ်ပြီး ကိုမင်းက အဲဒီမှာ ပထမဆုံး SRE အဖြစ် သွားပါတယ်။ ကိုမင်း ဘယ်ကနေ စမလဲ?

On screen:

- notes.md: # AI က operations မှာ ဘယ်နေရာ ကူညီလဲ | (blank line) | - complaint အုပ်စုဖွဲ့တာ — version၊ operator အလိုက် စုပြီး ပျမ်းမျှထဲက အုပ်စုကို ရှာ | - ယုံကြည်မှု မျဉ်း — အဲဒီအောက်ဆို AI အကြံကို မပြ | - playbook — လူ အောင်မြင်ခဲ့တဲ့ fix တွေကနေ ရေးတဲ့ အဆင့်တွေ | - reopen rate — agent ဖြေရှင်းပြီးသား ticket ပြန်ပွင့်တဲ့ နှုန်း | - toil ဖယ်တာရဲ့ အကန့်အသတ် — အချိန်ပဲ ပြန်ရ၊ 100% ထက် မကျော် | - fleet scan — incident တစ်ခုက အားနည်းချက်ကို codebase တိုင်းမှာ ရှာ | (blank line) | မေးခွန်း: call 500၊ တစ်ခုချင်း error 0.1%။ run တစ်ခါမှာ error အနည်းဆုံး တစ်ခု ကြုံဖို့ ဘယ်လောက်လဲ?
