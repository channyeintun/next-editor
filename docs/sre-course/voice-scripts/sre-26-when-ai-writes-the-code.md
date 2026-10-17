# Lesson 26 · AI က code ရေးတဲ့ခေတ်

slug: sre-26-when-ai-writes-the-code · budget: 8400 characters (±5%)

## Scene 1 · Hook + map: the month the coding agents arrived

chapter: Agent တွေ ရောက်လာတဲ့လ

> ⟪page l26_p01⟫ Padauk ရဲ့ platform အဖွဲ့က အခု golden path၊ shared gateway client နဲ့ exception စာရင်းကို ထိန်းနေပါပြီ။ ဒီလမှာတော့ code ကို ကိုယ်တိုင် ရေး၊ ပြင်၊ test လုပ်ပေးတဲ့ coding agent တွေကို အဖွဲ့တိုင်းက စသုံးလာကြပါတယ်။
> engineer ၆၀ လောက် ရှိတဲ့ အဖွဲ့က အရင်အတိုင်း ဖြစ်ပေမဲ့ merge တွေက တစ်ရက်ကို ၁၅ ကနေ ၁၂၀ အထိ ခုန်တက်သွားပါတယ်။ incident တွေလည်း တစ်လကို ၃ ခုကနေ ပထမလမှာပဲ ၁၁ ခု ဖြစ်ပြီး ဆက်တက်နေပါတယ်။ ဒါဆို Site Reliability Engineering၊ SRE အလုပ်မှာ ဘာတွေ ပြောင်းသွားမလဲ?
> ⟪page m6_map⟫ Module ၆ မှာ AI က reliability loop ရဲ့ အဆင့်တိုင်းကို ရောက်လာပါတယ်။ code ရေးတာ၊ feature အဖြစ် run တာ၊ operations မှာ ကူတာကို အရင် ကြည့်ပြီး၊ ဘယ်ကုမ္ပဏီမှာမဆို SRE ကို ဘယ်လို စမလဲ၊ ရှေ့ဆက် ဘာလာမလဲ ဆိုတာနဲ့ အဆုံးသတ်ပါမယ်။

On screen:

- l26_p01 (K1): 26 | AI က code ရေးတဲ့ခေတ် | merge: တစ်ရက် 15 → 120 | အဖွဲ့ အတူတူ၊ agent တွေ နေရာတိုင်း | incident: 3 → 11၊ ဆက်တက်နေ | ဘာတွေ ပြောင်းသွားမလဲ? | (small loop badge, the whole loop lit)
- m6_map (K8): Module 6 · AI နဲ့ ကိုယ့်ကုမ္ပဏီ | code ရေး၊ feature အဖြစ် run၊ operations မှာ ကူ | ဘယ် ကုမ္ပဏီမှာမဆို၊ ရှေ့ဆက် ဘာလာမလဲ | (the Padauk loop, every station lit, the Ops Buddy icon at the stations AI touches)

## Scene 2 · Code is cheap now

chapter: Code ဈေးပေါလာပြီ

> ⟪page l26_p02⟫ lesson ၁ မှာ software ဆောက်ရတာ ခဏပဲ ကြာပြီး run ရတာက နှစ်နဲ့ချီ ကြာတယ်လို့ ပြောခဲ့ပါတယ်။ agent တွေက ဆောက်တဲ့ အပိုင်းကိုပဲ တိုစေလို့ code ရေးတာ လတိုင်း ဈေးပေါလာပေမဲ့ ကုန်ကျစရိတ်က ပျောက်မသွားဘဲ တခြား နေရာကို ရွေ့သွားတာပါ။
> ဘေးကင်းကင်း run ရတာက အရင်လိုပဲ ခက်ပြီး code ကို နားလည်ရတာကတော့ ပိုခက်လာပါတယ်။ ဥပမာ agent ရေးပြီး review မှာ ခဏပဲ ကြည့်ခဲ့တဲ့ code တစ်ခု ညဘက် ပျက်တော့ on-call ကျနေတဲ့သူက အဲဒီ code ကို ပထမဆုံး အကြိမ် ဖတ်ရပါတယ်။

On screen:

- l26_p02 (K4): Code ဈေးပေါပြီ၊ ဘာက မပေါလဲ? | ရေးတာ: လတိုင်း ပိုပေါ | run တာ: ဘေးကင်းဖို့ အရင်လိုပဲ ခက် | နားလည်တာ: အရင်ထက် ပိုခက်

## Scene 3 · The production wall

chapter: Production နံရံ

> ⟪close page⟫ ⟪board B1 step 1⟫ ပြောင်းလဲမှု တစ်ခုက design၊ code ရေးပြီး test၊ deploy ဆိုတဲ့ အဆင့်တွေ ဖြတ်ပြီးမှ user ဆီ ရောက်ပြီး အကြာကြီး run ရပါတယ်။ ဘယ်လောက် စိတ်ချရဖို့ လိုလဲ ဆိုတာကို design မှာကတည်းက ဆုံးဖြတ်ရလို့ SRE က run တဲ့ အဆင့်ကျမှ မဟုတ်ဘဲ design ကတည်းက ပါရပါမယ်။
> ⟪board B1 step 2⟫ agent တွေ ရောက်လာတော့ အဆင့် တစ်ခုမှ မပျောက်ပါဘူး။ အဆင့်တိုင်း တိုသွားပြီး build နဲ့ test လည်း ပေါင်းသွားတော့ code တွေ အဆပေါင်းများစွာ ပိုထွက်လာပါတယ်။ ဒါပေမဲ့ deploy ရှေ့က ဒီ အနီရောင် နံရံကို ကျော်ရတာကတော့ မလွယ်လာပါဘူး။ ဟိုဘက်မှာ user အစစ်တွေနဲ့ Bank X ကို ပေးထားတဲ့ ကတိတွေ ရှိလို့ ဘယ်သူ ရေးတဲ့ code ပဲ ဖြစ်ဖြစ် အမှားရဲ့ ဒဏ်က အတူတူပါပဲ။ ဒါကို production နံရံလို့ ခေါ်ပါမယ်။
> ⟪board B1 step 3⟫ code တစ်ကြောင်း ပြောင်းရုံနဲ့ reliability က ဘယ်အဆင့်မှာမဆို ပျက်နိုင်လို့ အဆင့်တိုင်းမှာ အလုပ် လုပ်ရပါတယ်။ ဒါပေမဲ့ အဆင့်တွေ တိုလာတော့ အမှားကို သတိထားမိပြီး ပြင်ဖို့ အချိန်က နည်းသွားပါတယ်။
> မြန်မြန် release လုပ်တော့ user တွေ feature ကို ကြိုက်လား ချက်ချင်း သိရပေမဲ့ reliability ပြဿနာကတော့ ကိုယ့်ဘာသာ ထွက်မပြောပါဘူး။ ဥပမာ timeout မပါတဲ့ call တစ်ခုဟာ test pass ဖြစ်ပေမဲ့ လစာထုတ်ရက် ညကျမှ ပြဿနာ ပေါ်လာတတ်ပါတယ်။ ဒါကြောင့် အလုပ်လုပ်တယ် ဆိုတာနဲ့ စိတ်ချရတယ် ဆိုတာ မတူပါဘူး။

On screen:

- B1 step (1), cleared (P6 lanes, English labels; top lane): design → build + test → deploy → run
- B1 step (2): with AI (bottom lane title) | design → build + test → deploy → run (the same boxes, narrower) | production (a thick red vertical rectangle before deploy, spanning both lanes, label above it)
- B1 step (3): code တစ်ကြောင်း ပြောင်းရုံနဲ့ / ဘယ်အဆင့်မှာမဆို reliability ပျက်နိုင် (orange, two lines, under the top lane)

## Scene 4 · What the 11 incidents were

chapter: Incident 11 ခု

> ⟪close board⟫ ⟪board B2 step 1⟫ မသီရိက incident ၁၁ ခုကို အကြောင်းရင်းအလိုက် ခွဲကြည့်ပါတယ်။ agent မရောက်ခင် လမှာတော့ config မှားတာ တစ်ခု၊ retry ကြောင့် တစ်ခု၊ database ရဲ့ data ပုံစံ၊ schema ပြောင်းတာကြောင့် တစ်ခု၊ စုစုပေါင်း သုံးခုပဲ ရှိခဲ့ပါတယ်။
> ⟪board B2 step 2⟫ agent ရောက်ပြီးတဲ့ လမှာတော့ config နဲ့ retry က သုံးခုစီ၊ schema က နှစ်ခု ဖြစ်လာပြီး၊ အလုပ်တူ helper function တွေ ထပ်နေလို့ ဖြစ်တဲ့ အမျိုးအစား အသစ် သုံးခုလည်း ပေါ်လာပါတယ်။
> ⟪board B2 step 3⟫ merge ၁၅ ကနေ ၁၂၀ ဆိုတာ ရှစ်ဆပါ။ တခြား ဘာမှ မပြောင်းဘဲ ပြောင်းလဲမှုပဲ များလာရင် ပြဿနာလည်း အဲဒီနှုန်းနီးပါး များလာတတ်ပြီး အဲဒီထက် နည်းတာ ရှားပါတယ်။ ရိုးရိုး ပြဿနာတွေကို automation က ဖြေရှင်းပေးလေ လူဆီ ရောက်လာတာက ခက်ပြီး ရှားပါးတဲ့ ပြဿနာတွေ ဖြစ်လေပါပဲ။
> ⟪close board⟫ ⟪page l26_p02b⟫ အဲဒီလို ပြဿနာ တစ်ခုက လစာထုတ်ရက် ညမှာ ရောက်လာပါတယ်။ Bank X ကို ငွေလွှဲတာတွေ timeout ဖြစ်လာတော့ AI assistant က database pool ပြည့်နေလို့ပါ၊ server အားလုံး restart လုပ်ပါလို့ သေချာတဲ့ လေသံနဲ့ အကြံပေးပါတယ်။
> on-call ကျနေတဲ့ ကိုမင်းကတော့ ပြောင်းလဲမှုတွေရဲ့ timeline ကို ကြည့်ပါတယ်။ agent ထည့်ခဲ့တဲ့ retry၊ fraud rule အသစ်နဲ့ Bank X ရဲ့ လစာ batch သုံးခု တစ်ပြိုင်တည်း ဆုံနေတာ တွေ့တော့ retry ကို deploy ပြန်မလုပ်ဘဲ ဖွင့်ပိတ်လို့ရတဲ့ ခလုတ်၊ feature flag နဲ့ ပိတ်လိုက်ပါတယ်။
> ⟪page l26_p02c⟫ assistant က ဒီလို ပေါင်းစပ်မှုမျိုးကို တစ်ခါမှ မမြင်ဖူးခဲ့ပါဘူး၊ ဒါပေမဲ့ သေချာသလို ပြောခဲ့ပြီး မှားသွားတာပါ။ ပြီးတော့ ဘာဖြစ်ခဲ့လဲ ဆိုတာ Bank X နဲ့ ကိုနေလင်းကို ရှင်းပြပြီး တာဝန်ယူရမှာကလည်း လူပါ။ ဒါကြောင့် incident တွေမှာ လူ ဆက်ရှိနေရပါမယ်။

On screen:

- B2 step (1), cleared (P5 bars): agent မတိုင်ခင် (blue legend) | config 1 · retry 1 · schema 1 (blue bars)
- B2 step (2): agent ရောက်ပြီး (violet legend) | config 3 · retry 3 · schema 2 (violet bars beside the blue ones) | helper ထပ် 3 (a new violet bar with no blue partner)
- B2 step (3): ပြောင်းလဲမှု များရင် ပြဿနာလည်း များ၊ နည်းတာ ရှား (orange label above the bars)
- l26_p02b (K3, left gray / right teal; cells as left / right): လစာထုတ်ရက် ည | AI assistant ပြောတာ / timeline ပြတာ | database pool ပြည့်နေ / 3 ခု တစ်ပြိုင်တည်း ဆုံ | server အားလုံး restart / retry flag ပိတ်
- l26_p02c (K2): incident မှာ လူ ဘာလို့ လိုလဲ | ဒီ ပေါင်းစပ်မှုကို မမြင်ဖူး | သေချာသလို ပြောပေမဲ့ မှား | Bank X ကို ရှင်းပြတာ လူ

## Scene 5 · Roll back or roll forward?

chapter: Rollback လား roll forward လား

> ⟪page l26_p03⟫ အဲဒီလမှာပဲ Top-up မှာ SMS တစ်စောင်ကို နှစ်ခါ ပို့နေတဲ့ bug ပေါ်လာပါတယ်။ ပုံမှန်ဆို အရင် ကောင်းခဲ့တဲ့ version ကို ပြန်ပြောင်းတဲ့ rollback လုပ်ရုံပါ။ ဒါပေမဲ့ အဲဒီ deploy က schema ကိုပါ ပြောင်းထားလို့ version ဟောင်းက data အသစ်ကို မဖတ်နိုင်တော့ပါဘူး။
> ဒီတော့ ပြင်ထားတဲ့ version ကို ရှေ့ဆက် တင်တဲ့ roll forward ကို ရွေးပြီး fix ကို flag နောက်မှာ ထားပါတယ်။ user ၅ ရာခိုင်နှုန်းဆီ အရင် ဖွင့်ပြီး version ဟောင်းနဲ့ နှိုင်းယှဉ်ကြည့်တဲ့ canary မှာ ကောင်းနေမှ ဆက်ဖွင့်ပါတယ်။
> ⟪page l26_p03b⟫ ပြောင်းလဲမှုတွေက လူ လိုက်ကြည့်နိုင်တာထက် ပိုမြန်မြန် ရောက်လာရင် ပြန်သွားစရာ သန့်တဲ့ version မရှိတော့လို့ roll forward က rollback နေရာကို မကြာခဏ ယူလာမယ်လို့ မျှော်လင့်ရပါတယ်။ ဒါပေမဲ့ rollback သန့်သန့် လုပ်လို့ရရင်တော့ lesson ၁၀ မှာလိုပဲ rollback အရင်ပါ။
> ပြင်ရတာ ဈေးပေါလာလို့ ကာကွယ်တဲ့ အလုပ်ကို ခေါင်းဆောင်တွေ ငွေ မစိုက်တော့ရင်တော့ မှားပါမယ်၊ မြန်မြန် ပြန်ကောင်းတာက အကြောင်းရင်းကို ပြင်တာကို အစားမထိုးပါဘူး။
> ⟪page l26_p03c⟫ တစ်နေကုန် deploy လုပ်နေတော့ ဘယ် version run နေလဲ ဆိုတာ အဖြေ တစ်ခုတည်း မရှိတော့သလို staging ကလည်း production နဲ့ မတူတော့ပါဘူး။ အဲဒီအတွက် Padauk က request တိုင်းမှာ ဘယ် build၊ ဘယ် flag တွေ၊ app ဘယ် version နဲ့ run ခဲ့လဲ မှတ်ထားပါတယ်။

On screen:

- l26_p03 (K2): Rollback လား roll forward လား? | rollback သန့်ရင်: rollback အရင် | schema ပြောင်းထားရင်: flag နောက်က forward | 5% အရင်၊ canary က စောင့်ကြည့်
- l26_p03b (K2): ပြောင်းလဲမှု အရမ်း မြန်လာရင် | လူ တစ်ခုချင်း မကြည့်နိုင်တော့ | roll forward ပိုအဓိက ဖြစ်လာ | မြန်မြန် ပြင်တာက ကာကွယ်တာကို မအစားထိုး
- l26_p03c (K2): ဘယ် version run နေလဲ? | တစ်နေကုန် deploy: အဖြေ တစ်ခုတည်း မရှိ | staging က production နဲ့ မတူတော့ | request တိုင်း: build၊ flag၊ app version

## Scene 6 · Coherence drift

chapter: Coherence drift

> ⟪close page⟫ ⟪board B3 step 1⟫ helper ထပ်တဲ့ incident တွေကို ကြည့်ရအောင်။ Eats ရဲ့ ပို့ခကို round လုပ်ဖို့ agent တွေက task လေးခုမှာ helper လေးခု ရေးခဲ့ပါတယ်။ အနီးဆုံး ကျပ် ၅၀ ကို round လုပ်တာ၊ အမြဲ round up လုပ်တာ၊ ကျပ် ၁၀ ကို round လုပ်တာနဲ့ ဘာမှ round မလုပ်တာပါ။ တစ်ခုချင်း ကြည့်ရင် မှန်နေလို့ review မှာလည်း အောင်ခဲ့ပါတယ်။
> ⟪board B3 step 2⟫ ဒါပေမဲ့ ငွေဖြတ်တဲ့ code နဲ့ refund code က မတူတဲ့ helper တွေကို သုံးနေလို့ refund တွေက ဖြတ်ခဲ့တဲ့ ငွေနဲ့ မကိုက်တော့ပါဘူး။ နောက်ပိုင်း rounding ကို ပြင်ခိုင်းတဲ့ agent ကလည်း helper မှားကို သွားပြင်ပါတယ်။ agent တစ်ခုချင်းက ဖိုင် နည်းနည်းကိုပဲ မြင်လို့ ကိုယ့်အပိုင်းမှာ မှန်နေပေမဲ့ system တစ်ခုလုံးရဲ့ design ကတော့ တဖြည်းဖြည်း မညီညွတ်တော့ပါဘူး။ ဒါကို coherence drift လို့ ခေါ်ပါတယ်။
> ⟪board B3 step 3⟫ အဖြေကတော့ design စည်းမျဉ်းတွေကို လူရော agent ပါ ဖတ်ရအောင် စာနဲ့ ချရေးထားတာပါ။ platform အဖွဲ့က ပို့ခ တွက်ပုံကို fee spec အဖြစ် ရေးပြီး ငွေတွက်တဲ့ code ကို money module တစ်ခုတည်းထဲ စုပါတယ်။ agent တွေ အလုပ်မစခင် ဖတ်ရတဲ့ agent instruction file မှာလည်း ဒီ module ကိုပဲ သုံးဖို့ ရေးထားပြီး၊ module အပြင်မှာ round လုပ်ရင် lint rule က တားပါတယ်။
> ⟪board B3 step 4⟫ agent က helper မှားကို ဘာလို့ ပြင်ခဲ့လဲ၊ လစာထုတ်ရက် ညက retry ကို ဘာလို့ ထည့်ခဲ့လဲ ဆိုတာ ဘယ်သူမှ မသိခဲ့ပါဘူး၊ agent ရဲ့ အကြောင်းပြချက်ကို နောက်မှ မမြင်ရလို့ပါ။ ဒါကြောင့် အခု agent ပြောင်းလဲမှု တိုင်းမှာ ဘယ် task အတွက်လဲ၊ ဘာကြောင့်လဲ၊ ဘယ် test တွေ run ခဲ့လဲ ဆိုတာကို change record အဖြစ် မှတ်ပါတယ်။
> ⟪board B3 step 5⟫ metric ထည့်ရတာ လွယ်လာတော့ metric တွေမှာလည်း ဒီ drift ဖြစ်ပြီး incident တစ်ခုမှာ top-up အောင်မြင်နှုန်း သုံးမျိုး မတူဘဲ ပြနေခဲ့ပါတယ်။ အခုတော့ journey တစ်ခုစီမှာ owner ရှိတဲ့ service level indicator၊ SLI တစ်ခုတည်းပဲ ထားပါတယ်။

On screen:

- B3 step (1), cleared (P2 fan-in; four boxes stacked on the left): 50 ကို round | round up | 10 ကို round | round မလုပ်
- B3 step (2): (the four boxes comb into a bus) → refund ≠ ဖြတ်ငွေ (red box, the comb's target)
- B3 step (3): fee spec + money module + agent instruction file (green box, three lines, under the red box)
- B3 step (4): change record: task · ဘာကြောင့် · test (blue text at the bottom)
- B3 step (5): journey တစ်ခု၊ SLI တစ်ခု (blue text under it)

## Scene 7 · What changes, what doesn't

chapter: ပြောင်းတာနဲ့ မပြောင်းတာ

> ⟪close board⟫ ⟪page l26_p04⟫ ဒီလကို ပြန်ကြည့်ရင် အဆင့်တစ်ခုစီရဲ့ ကြာချိန်နဲ့ code ရေးတဲ့သူ ပြောင်းသွားပေမဲ့ ပြောင်းလဲမှု တစ်ခုစီမှာ ပါတဲ့ bug နဲ့ deploy မှားရင် ပေးရတဲ့ တန်ဖိုးကတော့ မပြောင်းပါဘူး။ အဖွဲ့ နယ်နိမိတ် မပီပြင်တော့ပေမဲ့ system တစ်ခုလုံးကို မြင်နေတဲ့သူ လိုတာလည်း မပြောင်းပါဘူး။
> ⟪page l26_p04b⟫ အရင်က Eats ရဲ့ ပြောင်းလဲမှုက Wallet code ကို ထိရင် Wallet အဖွဲ့က review လုပ်ရပါတယ်။ အခုတော့ engineer တစ်ယောက်နဲ့ agent တစ်ခုက နှစ်ဖက်လုံးကို တစ်ခါတည်း ပြင်နိုင်လို့ အဲဒီ စစ်ဆေးမှုကို ကျော်သွားနိုင်ပါတယ်။ ဒါကြောင့် ledger ကို ထိရင် Wallet review ဆက်လိုမယ်လို့ Padauk က တမင် ဆုံးဖြတ်ပါတယ်။
> ⟪page l26_p04c⟫ မသုံးဖြစ်တဲ့ ကျွမ်းကျင်မှုကလည်း တဖြည်းဖြည်း ပျောက်တတ်လို့ Padauk က လစဉ် incident role-play ကို AI assistant ပိတ်ပြီး လုပ်ပါတယ်။ အများအားဖြင့် မှန်တဲ့ tool က ရှားပါးတဲ့ ပြဿနာမှာ အားအနည်းဆုံး ဖြစ်တတ်လို့ ဒီညလည်း မှန်မယ်လို့ မယူဆဘဲ ကိုမင်းလိုပဲ tool ရဲ့ အကြံကို ခလုတ် မနှိပ်ခင် စစ်ကြည့်ပါ။

On screen:

- l26_p04 (K3, left gray / right teal; cells as left / right): ပြောင်းတာ / မပြောင်းတာ | အဆင့်တစ်ခုစီရဲ့ ကြာချိန် / ပြောင်းလဲမှုတစ်ခုစီရဲ့ bug | code ရေးတဲ့သူ / deploy မှားရင် ပေးရတဲ့ တန်ဖိုး | အဖွဲ့ နယ်နိမိတ် မပီပြင်တော့ / တစ်ခုလုံးကို မြင်တဲ့သူ
- l26_p04b (K2): နယ်နိမိတ် မပီပြင်တော့ရင် | Eats ပြောင်းလဲမှုက Wallet code ကို ထိ | agent က နှစ်ဖက်လုံး တစ်ခါတည်း ပြင် | ledger ထိရင် Wallet review ဆက်လို
- l26_p04c (K2): ကျွမ်းကျင်မှုကို ထိန်းပါ | assistant ပိတ်ပြီး incident လေ့ကျင့် | အများအားဖြင့် မှန် ≠ ဒီည မှန် | ခလုတ် မနှိပ်ခင် အကြံကို စစ်

## Scene 8 · Where SRE work moves

chapter: SRE အလုပ် ဘယ်ကို ရွေ့မလဲ

> ⟪page l26_p05⟫ ဒါဆို SRE အလုပ်က ဘယ်ကို ရွေ့မလဲ? deploy မတိုင်ခင် spec နဲ့ guardrail ရေးတာ၊ ပြောင်းလဲမှုတွေကို သေးသေးလေး ခွဲပြီး flag နဲ့ canary နောက်က ထုတ်တာဘက်ကို ပိုရွေ့လာဖွယ် ရှိပါတယ်။ agent တွေက လစာထုတ်ရက်၊ သင်္ကြန်လို Padauk ရဲ့ လက်တွေ့ ကမ္ဘာကို နည်းနည်းပဲ သိသေးလို့ system တစ်ခုလုံးကို မြင်နေတဲ့သူလည်း ဆက်လိုပါမယ်။
> production ကို run ရတာကတော့ ဆက်ခက်နေဦးမှာပါ။ SRE တွေ tool အများကြီး ပိုလိုလာပေမဲ့ အများစုကို ကိုယ့်ဘာသာ လုပ်ခွင့် ပေးလောက်အောင် မယုံရသေးလို့ ဦးဆောင်တာက လူပါ။

On screen:

- l26_p05 (K4): SRE အလုပ် ဘယ်ကို ရွေ့မလဲ | deploy မတိုင်ခင်: spec၊ guardrail | ပြောင်းလဲမှု သေးသေး၊ flag၊ canary | system တစ်ခုလုံးကို မြင်ထား

## Scene 9 · This week

chapter: —

> ⟪page l26_p06⟫ agent တွေနဲ့ အလုပ်လုပ်တဲ့ အဖွဲ့ သေးသေးလေးမှာ ဒီအပတ် လုပ်ကြည့်ဖို့ သုံးခုပါ။ agent တွေ ဖတ်ရမယ့် design စည်းမျဉ်းတွေကို စာနဲ့ ချရေးပါ။ ငွေတွက်တာ၊ retry လို risk များတဲ့ ပြောင်းလဲမှု တစ်ခုကို feature flag နောက်မှာ ထားပါ။ ပြီးတော့ AI assistant ပိတ်ပြီး incident တစ်ခုကို လေ့ကျင့်ကြည့်ပါ။

On screen:

- l26_p06 (K2): ဒီအပတ် လုပ်စရာ | agent ဖတ်မယ့် design စည်းမျဉ်း ရေးပါ | risk များတဲ့ ပြောင်းလဲမှုကို flag နောက် ထားပါ | AI ပိတ်ပြီး incident တစ်ခု လေ့ကျင့်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ agent တွေ ရောက်လာတဲ့ လမှာ သုံးခဲ့တဲ့ စကားလုံးတွေပါ။ ⟪select production နံရံ⟫ production နံရံက code ဘယ်လောက် မြန်မြန် ရေးရေး production ထဲ ဘေးကင်းကင်း ဝင်ရတာ မလွယ်လာဘူး ဆိုတာပါ။ ⟪select rollback အရင်⟫ rollback သန့်သန့် လုပ်လို့ရရင် rollback အရင် လုပ်ပြီး၊ မရရင်တော့ flag နောက်မှာ ၅ ရာခိုင်နှုန်းကစ canary နဲ့ roll forward လုပ်ပါတယ်။
> ⟪select coherence drift⟫ coherence drift က အပိုင်းလိုက် မှန်နေပေမဲ့ system တစ်ခုလုံးရဲ့ design မညီညွတ်တော့တာပါ။ ⟪select fee spec⟫ fee spec က ပို့ခ တွက်ပုံကို လူရော agent ပါ ဖတ်ဖို့ တစ်နေရာတည်းမှာ ရေးထားတာ ဖြစ်ပြီး၊ ⟪select change record⟫ change record က ပြောင်းလဲမှု တိုင်းရဲ့ task၊ အကြောင်းပြချက်နဲ့ run ခဲ့တဲ့ test တွေပါ။
> ⟪select မေးခွန်း⟫ agent တွေကြောင့် ကိုယ့်အဖွဲ့ရဲ့ merge တွေ နှစ်ဆ ဖြစ်လာပြီး တခြား ဘာမှ မပြောင်းရင် incident တွေ ဘာဖြစ်လာမယ်လို့ ထင်လဲ?
> ⟪pause 3s⟫ incident တွေလည်း နှစ်ဆလောက် များလာမှာပါ၊ အဲဒီထက် နည်းဖို့ကတော့ ရှားပါတယ်။ AI က code ရေးရုံ မကဘဲ feature တစ်ခုလည်း ဖြစ်လာပါတယ်။ မြန်မာလို ဖြေပေးတဲ့ AI support assistant၊ Ask Padauk က chat တွေရဲ့ ၉၉.၉ ရာခိုင်နှုန်းမှာ success code ပြန်ပေးပေမဲ့ refund ticket တွေကို မှားတဲ့ transaction တွေအတွက် ဖွင့်နေပါတယ်။ success code ပြန်လာရုံနဲ့ ဘယ်တော့ မလုံလောက်တော့လဲ?

On screen:

- notes.md: # AI က code ရေးတဲ့ခေတ် | (blank line) | - production နံရံ — code ဘယ်လောက် မြန်မြန် ရေးရေး production ထဲ ဘေးကင်းကင်း ဝင်ရတာ မလွယ်လာ | - rollback အရင်၊ roll forward ဘေးကင်းကင်း — rollback သန့်ရင် rollback၊ မသန့်ရင် flag နောက်မှာ 5% ကစ canary နဲ့ | - coherence drift — အပိုင်းလိုက် မှန်ပေမဲ့ system တစ်ခုလုံးရဲ့ design မညီညွတ်တော့ | - fee spec — ပို့ခ တွက်ပုံကို လူရော agent ပါ ဖတ်ဖို့ တစ်နေရာတည်းမှာ ရေး | - change record — ပြောင်းလဲမှုတိုင်းရဲ့ task၊ အကြောင်းပြချက်၊ run ခဲ့တဲ့ test | (blank line) | မေးခွန်း: agent တွေကြောင့် merge 2 ဆ ဖြစ်လာတယ်။ တခြား ဘာမှ မပြောင်းရင် incident တွေ ဘာဖြစ်မလဲ?
