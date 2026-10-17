# Lesson 27 · AI feature တွေရဲ့ reliability

slug: sre-27-reliability-for-ai-features · budget: 8400 characters (±5%)

## Scene 1 · Hook: 99.9% success, wrong refunds

chapter: မှားတဲ့ refund ticket တွေ

> ⟪page l27_p01⟫ Padauk ရဲ့ coding agent တွေက အခု instruction file နဲ့ fee spec ကို ဖတ်ပြီး ပြောင်းလဲမှုတိုင်းမှာ change record ချန်ပါတယ်။ ဒီတစ်ခါတော့ chat ကို မြန်မာလို ဖြေပြီး refund ticket ဖွင့်ပေးနိုင်တဲ့ AI support assistant၊ Ask Padauk ကို launch လုပ်ပါတယ်။
> HTTP မှာ chat တွေရဲ့ ၉၉.၉ ရာခိုင်နှုန်းက အောင်မြင်တယ်လို့ ပြန်လာပါတယ်။ ဒါပေမဲ့ customer မေးတဲ့ transaction အစား တခြား transaction အတွက် refund ticket ဖွင့်ထားတာကို မစုရဲ့ support အဖွဲ့က တွေ့လာပါတယ်။ success code ပြန်လာရုံနဲ့ ဘယ်တော့ မလုံလောက်တော့လဲ?

On screen:

- l27_p01 (K1): 27 | AI feature တွေရဲ့ reliability | 99.9% success၊ refund တွေ မှား | Ask Padauk က chat တိုင်းကို ဖြေခဲ့ | ticket: transaction မှား · HTTP: အားလုံး OK | success code ဘယ်တော့ မလုံလောက်လဲ? | (small loop badge, သဘောတူ lit)

## Scene 2 · AI is still a service

chapter: AI လည်း service တစ်ခုပါပဲ

> ⟪page l27_p02⟫ AI feature မို့ reliability ကို အစကနေ ပြန်သင်ရမလား ဆိုတော့ မလိုပါဘူး။ Ask Padauk လည်း service ပဲမို့ SLO၊ capacity၊ ဘေးကင်းတဲ့ change တွေ အရင်အတိုင်း လိုပါတယ်။ အသစ်က နှစ်ခုပဲ ရှိပါတယ်၊ အဖြေက error မပြဘဲ မှားနိုင်တာနဲ့ request တိုင်းမှာ token ကုန်တာပါ။
> ⟪page l27_p02b⟫ model ကို data နဲ့ သင်ပေးတာက training ဖြစ်ပြီး train ပြီးသား model နဲ့ request တစ်ခုချင်းကို ဖြေတာက inference ပါ။ token က model ခွဲဖတ်တဲ့ စာသား အပိုင်းလေးတွေ ဖြစ်ပြီး တစ်ခါတည်း ဖတ်နိုင်တဲ့ အများဆုံး ပမာဏကို context window လို့ ခေါ်ပါတယ်။ transaction ရှာတာ၊ ticket ဖွင့်တာလို tool တွေကို အဆင့်လိုက် ခေါ်သုံးတဲ့ model က agent ဖြစ်ပြီး tool တစ်ခါ ခေါ်တာက tool call ပါ။
> ⟪page l27_p02c⟫ model ကို provider ဆီက ငှားသုံးရင် အလေ့အထ လေးခု ရှိပါတယ်။ prompt နဲ့ limit သတ်မှတ်တဲ့ အပိုင်းကို user ကို ဖြေတဲ့ အပိုင်းနဲ့ ခွဲထားပြီး quota ကို ရှားပါးတဲ့ resource လို သုံးပါ။ AI အပိုင်းကိုပါ observe လုပ်ပြီး prompt နဲ့ model ကို rollback လုပ်လို့ရအောင် version တပ်ပါ။ ဈေးပေါတဲ့ model ဆီ traffic လွှဲတဲ့ model router ကလည်း reliability ခလုတ် တစ်ခုပါ။

On screen:

- l27_p02 (K4): AI လည်း service တစ်ခုပါပဲ | အရင်အတိုင်း: SLO၊ capacity၊ ဘေးကင်းတဲ့ change | အသစ်: အဖြေ မှားနိုင် | အသစ်: request တိုင်း token ကုန်
- l27_p02b (K5): ဝေါဟာရ လေးခု | training: model ကို data နဲ့ သင်တာ | inference: train ပြီးသား model နဲ့ ဖြေတာ | token: model ဖတ်တဲ့ စာသား အပိုင်းလေး | agent: tool တွေ ဆက်တိုက် ခေါ်သုံးတဲ့ model
- l27_p02c (K5): model ငှားသုံးရင် အလေ့အထ လေးခု | သတ်မှတ်တဲ့ အပိုင်းနဲ့ ဖြေတဲ့ အပိုင်း ခွဲ | quota ကို ရှားပါးသလို သုံး | AI အပိုင်းကိုပါ observe | prompt၊ model ကို version တပ်

## Scene 3 · The answer spectrum

chapter: အလယ်က အဖြေတွေ

> ⟪close page⟫ ⟪board B1 step 1⟫ လစာထုတ်ရက် ညနေမှာ provider ရဲ့ rate limit ကို ထိတော့ model router က အခမဲ့ user တွေရဲ့ chat ကို fallback အဖြစ် ဈေးပေါတဲ့ model ဆီ လွှဲပါတယ်။ အဖြေတွေကို bar တစ်ခုပေါ် စီကြည့်ရင် ဘယ်ဘက်အစွန်မှာ server error တွေ ရှိပါတယ်၊ အဲဒီညက error မတက်လာလို့ dashboard က အစိမ်းရောင်ပါပဲ။
> ⟪board B1 step 2⟫ အလယ်မှာတော့ HTTP က အောင်မြင်တယ်လို့ ပြပေမဲ့ အားနည်းတဲ့ fallback အဖြေတွေ ရှိပြီး ညာဘက်အစွန်မှာ ကောင်းတဲ့ အဖြေတွေ ရှိပါတယ်။ ဈေးပေါတဲ့ model ရဲ့ အဖြေ ဝေဝါးလို့ user တွေ စကားလုံး ပြောင်းပြီး ထပ်မေးနေတာကို မစု သတိထားမိပါတယ်။
> ⟪board B1 step 3⟫ lesson ၇ မှာ ကြိုပြောခဲ့သလို AI မှာ အောင်မြင်တာနဲ့ ပျက်တာ နှစ်မျိုးတည်း မရှိတော့ပါဘူး။ HTTP က ဘယ်ဘက်အစွန်ကိုပဲ မြင်ပေမဲ့ user ကတော့ bar တစ်ခုလုံးကို ခံစားရပါတယ်။ error မဟုတ်ပေမဲ့ အားနည်းတဲ့ အဖြေကို degraded answer လို့ ခေါ်ပြီး SLO ထဲမှာ ရေတွက်ရပါတယ်။
> ⟪board B1 step 4⟫ မသီရိက fallback အဖြေတိုင်းကို degraded လို့ မှတ်ပြီး အဖြေ ၂ ရာခိုင်နှုန်းကို နေ့တိုင်း အမှတ်ပေး စစ်ခိုင်းပါတယ်။ ဒီတော့မှ လစာထုတ်ရက် ညနေမှာ Ask Padauk က available ဖြစ်နေပေမဲ့ အဖြေ ၃၀ ရာခိုင်နှုန်းက degraded ဖြစ်နေတာ ပေါ်လာပါတယ်။

On screen:

- B1 step (1), cleared (P5, one long segmented bar on an underline axis): error (500) (red, the left segment)
- B1 step (2): အားနည်း / fallback အဖြေ (200 ပဲ!) (orange, the middle segment, two lines) | အဖြေ ကောင်း (green, the right segment)
- B1 step (3): HTTP မြင်တာ ဒီလောက်ပဲ (red text above the red end) | user က bar တစ်ခုလုံးကို ခံစားရ (violet text under the whole bar)
- B1 step (4): degraded လို့ မှတ် · နေ့တိုင်း 2% စစ် (blue, at the bottom) | available၊ ဒါပေမဲ့ 30% degraded (violet, under it)

## Scene 4 · Ask Padauk's SLIs

chapter: Ask Padauk ရဲ့ SLI တွေ

> ⟪close board⟫ ⟪page l27_p03⟫ ဒါဆို refund အမှားကို ဘယ် ကိန်းဂဏန်းက ဖမ်းမလဲ? မသီရိက user ကြုံရတာကို တိုင်းတဲ့ SLI တွေကို ဒုက္ခ တစ်ခုချင်းကနေ ဆွဲထုတ်ပါတယ်။ refund မှားတာအတွက် transaction မှန်မှန် ရွေးတဲ့ ရာခိုင်နှုန်း၊ အဖြေ အသုံးမဝင်တာအတွက် ၅ မိနစ်အတွင်း ထပ်မမေးရတဲ့ chat ရာခိုင်နှုန်း၊ စောင့်ရတာအတွက် ပထမ စာလုံး ပေါ်တဲ့အထိ ကြာချိန်၊ time to first token ၂ စက္ကန့်အတွင်း ဆိုတာတွေပါ။ fallback အဖြေကိုတော့ degraded လို့ ရေတွက်ပါတယ်။
> ⟪page l27_p03b⟫ prompt အသစ်ကို user မမြင်ခင်ရော ဘယ်လို စစ်မလဲ? အဖြေ မှန်ကို ကြိုသိထားတဲ့ မေးခွန်း စုစည်းမှု၊ golden set နဲ့ AI အဖြေကို စနစ်တကျ စစ်တာကို eval လို့ ခေါ်ပါတယ်။ Padauk က တကယ့် complaint ၅၀ နဲ့ golden set လုပ်ပြီး eval ရမှတ်ကို SLI၊ အောင်မျဉ်းကို SLO အဖြစ် ထားပါတယ်။ အဖြေတွေက စကားလုံး ကွဲတတ်လို့ စာလုံးချင်း တိုက်မစစ်ဘဲ ID၊ ငွေပမာဏနဲ့ format ကိုပဲ စစ်ပါတယ်။
> ⟪page l27_p03c⟫ agent ရဲ့ SLI အနေနဲ့ tool call အောင်မြင်တာ၊ ID validation ဖြတ်တာ၊ ticket format မှန်တာကိုလည်း တိုင်းပါတယ်။ မနှင်းနဲ့ မသီရိက refund မှန်မှန် ရဖို့ ဆိုတဲ့ product ပန်းတိုင်ကို အရင် သဘောတူပါတယ်။ ပထမ SLO ကို မီနိုင်တဲ့ ဂဏန်းမှာ ထားပြီး နောက်မှ မြှင့်မှာပါ၊ degraded အဖြေတွေကလည်း အဲဒီ SLO ရဲ့ error budget ကို သုံးပါတယ်။

On screen:

- l27_p03 (K5): Ask Padauk ရဲ့ SLI တွေ | transaction မှန်မှန် ရွေး | 5 မိနစ်အတွင်း ထပ်မမေးရ | ပထမ စာလုံး 2 စက္ကန့်အတွင်း | fallback ကို degraded လို့ ရေတွက်
- l27_p03b (K7): Ask Padauk ရဲ့ eval | eval ရမှတ် = SLI | အောင်မျဉ်းက SLO၊ golden set က complaint 50
- l27_p03c (K2): agent ရဲ့ SLI နဲ့ ပထမ SLO | tool call၊ ID validation၊ ticket format | product ပန်းတိုင်ကို အရင် သဘောတူ | မီနိုင်တဲ့ SLO နဲ့ စ၊ နောက်မှ မြှင့်

## Scene 5 · Capacity is cost

chapter: Capacity ကို ကျပ်နဲ့ တွက်

> ⟪page l27_p04⟫ capacity စီစဉ်ပုံလည်း ပြောင်းပါတယ်။ Ask Padauk ရဲ့ request တွေက top-up ထက် အများကြီး နည်းပေမဲ့ တစ်ခုချင်းက ဈေးကြီးပြီး chat ရှည်လေ token ကုန်လေမို့ ကုန်ကျငွေလည်း မညီပါဘူး။ ဒါကြောင့် request တစ်ခုရဲ့ ကုန်ကျငွေကို request အရေအတွက်နဲ့ မြှောက်ပြီး capacity ကို ကျပ်နဲ့ စီစဉ်ပါတယ်။ request နည်းရင် ဂရုမစိုက်တဲ့ alert၊ ကုန်ကျငွေ တူတယ်လို့ ယူဆတဲ့ alert တွေကလည်း ပြဿနာကို ဖုံးထားတတ်ပါတယ်။
> ⟪page l27_p04b⟫ Padauk က request တိုင်းရဲ့ token၊ latency နဲ့ ကုန်ကျငွေကို မှတ်ထားပါတယ်။ အရန် quota ကလည်း မသုံးရင်တောင် ပိုက်ဆံ ကုန်ပါတယ်။ load test မှာလည်း အဖြေ အရည်အသွေးကိုပါ စစ်ပါတယ်။ feature အသစ်ကို chat ၅ ရာခိုင်နှုန်းမှာ အရင် တိုင်းပြီး launch မလုပ်ခင် bill ကို ချဲ့တွက်ပါတယ်၊ provider ပြောင်းဖို့ ခလုတ် တစ်ခုလည်း ထားပါတယ်။ ကိုယ်ပိုင် model train ဖို့ GPU စီမံတာကိုတော့ ဒီသင်တန်းမှာ ချန်ထားပါမယ်။

On screen:

- l27_p04 (K7): AI capacity ကို ကျပ်နဲ့ စီစဉ်ပါ | ကုန်ကျငွေ × အရေအတွက် | request တစ်ခုရဲ့ ကုန်ကျငွေ × request အရေအတွက်
- l27_p04b (K2): AI capacity စစ်စရာ | request တိုင်း token၊ latency၊ ကုန်ကျငွေ မှတ် | load test မှာ အဖြေ အရည်အသွေးပါ စစ် | 5% မှာ တိုင်းပြီး bill ချဲ့တွက်

## Scene 6 · Bad data stops the line

chapter: Data မကောင်းရင် ရပ်

> ⟪close page⟫ ⟪board B2 step 1⟫ model ရဲ့ ဆုံးဖြတ်ချက်ကို code ထက် train ခဲ့တဲ့ data က ပိုသတ်မှတ်ပါတယ်။ လိမ်လည်တဲ့ ငွေချေမှုကို ရှာပေးတဲ့ Padauk ရဲ့ fraud model က transactions table ကနေ ညတိုင်း train ပါတယ်။ သင်္ကြန် မတိုင်ခင် log ပြောင်းတဲ့ change တစ်ခုကြောင့် column တစ်ခု ဗလာ ဖြစ်သွားပေမဲ့ training မစခင် data အသစ်လား၊ row လုံလောက်လား၊ ဗလာ column ရှိလား စစ်တဲ့ check ရှိပါတယ်။
> ⟪board B2 step 2⟫ ပုံမှန်ဆိုရင် check အောင်မှ train ပြီး model အသစ်က eval gate ကို ဖြတ်မှ user တွေအတွက် model ကို run ထားတဲ့ serving ဆီ ရောက်ပါတယ်။ ဗလာ column နဲ့ train မိရင်တော့ model က ယုံယုံကြည်ကြည်နဲ့ မှားမှာပါ။
> ⟪board B2 step 3⟫ ဒီတစ်ခါ check က training ကို ရပ်လို့ model ဟောင်းက ဆက်အလုပ်လုပ်ပြီး on-call ဆီ alert ရောက်ပါတယ်။ check တွေကို ဈေးပေါတာကနေ ဈေးကြီးတာအထိ အလွှာလိုက် ထားပါတယ်။ data အသစ်လား အမြဲ စစ်ပြီး fraud score တွေ တကယ့် လိမ်လည်မှုနဲ့ ကွာလာလား စောင့်ကြည့်ပါတယ်၊ လူ ဒါမှမဟုတ် ဒုတိယ model က နမူနာ ပြန်စစ်တာကိုတော့ ရံဖန်ရံခါပဲ လုပ်ပါတယ်။
> ⟪board B2 step 4⟫ ရပ်တာ မှန်ပေမဲ့ ဟောင်းနေတဲ့ model လည်း outage တစ်မျိုးမို့ သင်္ကြန် မနက်မှာ eval အောင်ထားတဲ့ model အသစ် ရှိရမယ် ဆိုတဲ့ freshness SLO ထားပါတယ်။ training က ညတိုင်း သူ့ဘာသာ run နေပြီ ဆိုရင် production မို့ မသီရိရဲ့ အဖွဲ့က တာဝန်ယူပြီး စမ်းသပ်နေတုန်းမှာတော့ အကြံပဲ ပေးပါတယ်။

On screen:

- B2 step (1), cleared (P1 flow, short English box labels, left to right): table → check (orange) → training | fresh? rows? ဗလာ column? (small orange text under the check)
- B2 step (2): → eval gate → serving
- B2 step (3): ရပ်၊ model ဟောင်း ဆက်သုံး၊ alert (red, arrow-down from the check)
- B2 step (4): freshness SLO: သင်္ကြန် မနက် model အသစ် (blue, under the flow)

## Scene 7 · What counts as a change?

chapter: ဘာတွေက change လဲ

> ⟪close board⟫ ⟪page l27_p05⟫ log ပြောင်းတာလေးတောင် model ကို ထိခဲ့ပါတယ်။ AI feature မှာ model အသစ်၊ provider က တိတ်တိတ် update လုပ်တာ၊ prompt စာကြောင်း တစ်ကြောင်း၊ template နဲ့ setting ပြင်တာတွေက code မပြောင်းဘဲ အပြုအမူကို ပြောင်းလို့ change တွေပါပဲ။ ဒါကြောင့် အားလုံးကို eval နဲ့ အရင် စစ်ပြီးမှ chat အနည်းငယ်ဆီ ပို့ကြည့်တဲ့ canary နဲ့ ထုတ်ပါတယ်။
> ⟪page l27_p05b⟫ canary မှာ အဖြေ နှေးလာတာရော ညံ့လာတာရော rollout ကို ရပ်စေပါတယ်။ lesson ၇ က Hyrum's law လိုပဲ ကတိ မပေးခဲ့တဲ့ ticket ပုံစံကိုတောင် support tool က အားကိုးနေနိုင်လို့ ပျမ်းမျှ ရမှတ် တက်ရုံနဲ့ မလုံလောက်ဘဲ workflow တစ်ခုလုံးကို စမ်းရပါတယ်။ ဒီ guardrail တွေက ပြဿနာကို စောစော မိစေလို့ Padauk က ပိုမြန်မြန် ထုတ်နိုင်လာပါတယ်။

On screen:

- l27_p05 (K2): ဘာတွေက change လဲ? | model အသစ်၊ ဒါမှမဟုတ် တိတ်တိတ် update | prompt၊ template ဒါမှမဟုတ် setting | အားလုံး eval နဲ့ canary ကို ဖြတ်
- l27_p05b (K2): rollout ကို ဘာက ရပ်လဲ | နှေးလာရင် ရပ် · ညံ့လာရင် ရပ် | ပျမ်းမျှ ရမှတ် တက်ရုံ မလုံလောက် | workflow တစ်ခုလုံးကို စမ်းပါ

## Scene 8 · The agent's blast radius

chapter: Agent ရဲ့ blast radius

> ⟪close page⟫ ⟪board B3 step 1⟫ Ask Padauk က chat ဖတ်၊ transaction ရှာပြီး ticket ဖွင့်ပါတယ်။ ရှာတဲ့ အဆင့်မှာ transaction နှစ်ခုရဲ့ ID ကို ရောမိတော့ နောက်အဆင့်တွေက မစစ်ဘဲ ယုံလိုက်လို့ အမှားက အဆုံးထိ ပါသွားတာပါ။
> ⟪board B3 step 2⟫ ဒါကြောင့် agent မှားရင် ထိခိုက်မယ့် နယ်ပယ်၊ blast radius ကို ကျဉ်းအောင် လုပ်ပါတယ်။ ID က ဒီ customer ရဲ့ transaction ဟုတ်လား၊ ငွေပမာဏ ကိုက်လား ဆိုတာကို ရိုးရိုး code နဲ့ validate လုပ်ပြီး agent ကို ticket ဖွင့်ခွင့်ပဲ ပေးထားလို့ ငွေကို လူက အတည်ပြုမှ ပြန်အမ်းပါတယ်။
> ⟪board B3 step 3⟫ tool call တိုင်းကို input၊ output နဲ့ log မှာ မှတ်ပြီး prompt နဲ့ အဖြေတွေကို personal data ဖယ်ပြီးမှ သိမ်းလို့ ဘယ်အဆင့်က စမှားလဲ ပြန်ရှာလို့ ရပါတယ်။
> ⟪close board⟫ ⟪page l27_p05c⟫ agent လုပ်ခွင့်ရှိတဲ့ အဆင့် အရေအတွက်ကို step budget အဖြစ် ကန့်သတ်ပြီး ကျော်ရင် လူဆီ လွှဲရပါမယ်။ ယုံလို့မရတဲ့ chat ဖတ်ခွင့်၊ wallet data မြင်ခွင့်နဲ့ message လွတ်လွတ် ပို့ခွင့် သုံးခုကိုလည်း agent တစ်ခုတည်းမှာ အတူ မပေးပါနဲ့။ ဒါကြောင့် SMS tool က verify လုပ်ထားတဲ့ customer နံပါတ်ကိုပဲ ပို့နိုင်အောင် prompt နဲ့ မဟုတ်ဘဲ ရိုးရိုး code နဲ့ ကန့်သတ်ထားပါတယ်။
> ⟪page l27_p05d⟫ ဘာလို့ prompt နဲ့ မထိန်းတာလဲ? model ရဲ့ စည်းမျဉ်းနဲ့ user စာက လမ်းကြောင်း တစ်ခုတည်းကနေ ဝင်လာလို့ စာထဲမှာ ညွှန်ကြားချက် ဝှက်ထည့်ပြီး model ကို မလုပ်သင့်တာ လုပ်ခိုင်းနိုင်ပါတယ်၊ ဒါက prompt injection ပါ။ ဒါကြောင့် အဝင်ရော အထွက်ရော စစ်ရပြီး download လုပ်တဲ့ model နဲ့ dataset တွေကလည်း dependency တွေမို့ library တွေလိုပဲ သတိထားရပါတယ်။

On screen:

- B3 step (1), cleared (P6 lanes; top lane, English boxes): read chat → find transaction → open refund ticket | ID မှား (red tag carried along under all three boxes)
- B3 step (2) (bottom lane, the same three boxes): ID ကို validate (green shield between the first and second boxes) | ticket ပဲ၊ ငွေ မရွှေ့ (green shield on the last box)
- B3 step (3): tool call တိုင်း log (blue, under the bottom lane)
- l27_p05c (K2): agent ကို ဘောင်ခတ်ပါ | step budget ကျော်ရင် လူဆီ လွှဲ | chat · wallet data · message ပို့ခွင့်: သုံးခု မတွဲ | SMS: verify လုပ်ထားတဲ့ နံပါတ်ကိုပဲ
- l27_p05d (K2): prompt injection | စည်းမျဉ်းနဲ့ user စာ လမ်းတစ်ခုတည်း | အဝင်ရော အထွက်ရော စစ်ပါ | download လုပ်တဲ့ model၊ dataset က dependency

## Scene 9 · Launching an AI feature

chapter: AI feature ကို launch လုပ်ပုံ

> ⟪page l27_p06⟫ ပြင်ပြီးတော့ Ask Padauk ကို အဆင့်လိုက် ပြန် launch လုပ်ပါတယ်။ အရင်ဆုံး complaint အစစ် ၅၀ နဲ့ eval လုပ်တယ်၊ အရည်အသွေးပါ စစ်တဲ့ load test လုပ်တယ်၊ model ဟောင်းဆီ ပြန်သွားတဲ့ rollback နဲ့ ချက်ချင်း ပိတ်တဲ့ ခလုတ်ကို စမ်းထားပြီးမှ chat ၅ ရာခိုင်နှုန်းနဲ့ စပါတယ်။
> complaint တွေနဲ့ နေ့တိုင်း အဖြေ ၂ ရာခိုင်နှုန်း စစ်တဲ့ ရလဒ်တွေကို နောက်တစ်ခေါက် ပြင်ဖို့ ပြန်သုံးပါတယ်။ prototype က ရက်ပိုင်းပဲ ကြာပေမဲ့ production ကတော့ အများကြီး ပိုကြာပါတယ်။

On screen:

- l27_p06 (K6): AI feature ကို launch လုပ်ပုံ | complaint 50 အစစ် | rollback စမ်းပြီး | chat 5% | နေ့တိုင်း 2% စစ်

## Scene 10 · This week

chapter: —

> ⟪page l27_p07⟫ AI feature ရှိရင် ဒီအပတ် စမ်းကြည့်ဖို့ သုံးခုပါ။ fallback အဖြေတိုင်းကို degraded လို့ မှတ်ပြီး ရေတွက်ပါ။ user မေးခွန်း အစစ်ကနေ case ၅၀ ပါတဲ့ golden set တစ်ခု စုပါ။ ကိုယ့် agent ကိုလည်း တကယ် လိုတဲ့ permission လောက်ပဲ ပေးတဲ့ least privilege ဖြစ်အောင် ပြင်ပါ။

On screen:

- l27_p07 (K2): ဒီအပတ် လုပ်စရာ | fallback အဖြေကို degraded လို့ မှတ်ပါ | case 50 ပါတဲ့ golden set စုပါ | agent ကို least privilege ပဲ ပေးပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ Ask Padauk ကနေ ရလာတဲ့ ဝေါဟာရတွေပါ။ ⟪select inference⟫ inference က train ပြီးသား model နဲ့ request တစ်ခုချင်းကို ဖြေတာ ဖြစ်ပြီး၊ ⟪select token⟫ token က model ဖတ်တဲ့ စာသား အပိုင်းလေးပါ၊ ကုန်ကျငွေလည်း ဒီကလာပါတယ်။ ⟪select eval⟫ eval က AI အဖြေကို စနစ်တကျ စစ်တာ ဖြစ်ပြီး ရမှတ်က SLI ပါ။ ⟪select golden set⟫ golden set က အဖြေ မှန်ကို ကြိုသိထားတဲ့ မေးခွန်းတွေပါ။
> ⟪select degraded answer⟫ degraded answer က error မဟုတ်ပေမဲ့ SLO ထဲမှာ ရေတွက်ရတဲ့ အားနည်းတဲ့ အဖြေ ဖြစ်ပြီး၊ ⟪select prompt injection⟫ prompt injection က model ဖတ်မယ့် စာထဲ ညွှန်ကြားချက် ဝှက်ထည့်တာပါ။ ⟪select မေးခွန်း⟫ AI feature က request တိုင်းကို အောင်မြင်တယ်လို့ ပြန်ပေးနေရင် အဖြေ မှားတာကို ဘယ် SLI က ဖမ်းမလဲ?
> ⟪pause 3s⟫ ဥပမာ transaction မှန်မှန် ရွေးတဲ့ ရာခိုင်နှုန်း၊ ဒါမှမဟုတ် ၅ မိနစ်အတွင်း ထပ်မမေးရတဲ့ chat ရာခိုင်နှုန်းပါ။ အခု ဘက်ပြောင်းကြည့်ရအောင်၊ Padauk ရဲ့ internal AI operations agent၊ Ops Buddy က production ဝင်ခွင့် တောင်းလာပါတယ်။ AI agent တစ်ခုကို ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ?

On screen:

- notes.md: # AI feature တွေရဲ့ reliability | (blank line) | - inference — train ပြီးသား model နဲ့ request တစ်ခုချင်းကို ဖြေတာ | - token — model ဖတ်တဲ့ စာသား အပိုင်းလေး၊ ကုန်ကျငွေလည်း ဒီကလာ | - eval — AI အဖြေကို စနစ်တကျ စစ်တာ၊ ရမှတ်က SLI | - golden set — အဖြေ မှန်ကို ကြိုသိထားတဲ့ မေးခွန်းတွေ | - degraded answer — error မဟုတ်ပေမဲ့ အားနည်းတဲ့ အဖြေ၊ SLO ထဲမှာ ရေတွက် | - prompt injection — model ဖတ်မယ့် စာထဲ ဝှက်ထည့်တဲ့ ညွှန်ကြားချက် | (blank line) | မေးခွန်း: AI feature က request တိုင်း 200 ပြန်ပေးတယ်။ အဖြေ မှားတာကို ဖမ်းမယ့် SLI တစ်ခု ပြောပါ။
