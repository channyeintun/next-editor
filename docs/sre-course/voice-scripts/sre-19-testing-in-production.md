# Lesson 19 · Production ထဲမှာ စမ်းသပ်ခြင်း

slug: sre-19-testing-in-production · budget: 7600 characters (±5%)

## Scene 1 · Hook: pricing's canary passed, Bill Pay broke

chapter: Canary pass ပေမဲ့ Bill Pay ပျက်

> ⟪page l19_p01⟫ routing config ပြောင်းတိုင်း check သုံးဆင့် ဖြတ်ရပြီး live config ကိုလည်း Git နဲ့ ညတိုင်း တိုက်ကြည့်ပါတယ်။ ဒီတစ်ပတ် ဝန်ဆောင်ခ တွက်တဲ့ pricing က version ၈ ကို rollout လုပ်တော့ traffic နည်းနည်းဆီ အရင် ပို့တဲ့ canary က pass ဖြစ်ပြီး dashboard တွေလည်း အစိမ်းရောင်ပါ။
> ဒါပေမဲ့ Bill Pay မှာ မီတာခ ပေးလို့ မရဘူးဆိုတဲ့ တိုင်ကြားချက်တွေ ဝင်လာပါတယ်။ ခွဲကြည့်တော့ version ၈ ဆီ ရောက်တဲ့ Bill Pay call တွေရဲ့ ၃၀ ရာခိုင်နှုန်းက timeout ဖြစ်နေတာပါ။ ဒါဆို ဘယ်သူ့ဘက်ကို ကြည့်နေခဲ့တာလဲ?

On screen:

- l19_p01 (K1): 19 | Production ထဲမှာ စမ်းသပ်ခြင်း | pricing canary pass၊ Bill Pay ပျက် | pricing v8: အားလုံး အစိမ်း | v8 ကနေ Bill Pay timeout: 30% | ဘယ်သူ့ဘက်ကို ကြည့်နေခဲ့လဲ? | (small loop badge, တည်ဆောက် lit)

## Scene 2 · The canary: a comparison, not a glance at graphs

chapter: Canary ဆိုတာ နှိုင်းယှဉ်တာ

> ⟪close page⟫ ⟪board B1 step 1⟫ canary တစ်ခု ဘယ်လို အလုပ်လုပ်လဲ အရင် ကြည့်ရအောင်။ canary မှာ request ၁ ရာခိုင်နှုန်းကိုပဲ version အသစ်ဆီ အရင် ပို့ပြီး တစ်ချိန်တည်း version ဟောင်း run နေတဲ့ အရွယ်တူ အုပ်စု တစ်ခုကိုလည်း ယှဉ်ဖို့ ခွဲထားပါတယ်၊ အဲဒီ အုပ်စုကို baseline လို့ ခေါ်ပါတယ်။
> ⟪board B1 step 2⟫ အုပ်စု နှစ်ခုရဲ့ error နဲ့ latency ကို ဘေးချင်းယှဉ်ပြီး အသစ်က ပိုဆိုးလား စစ်တာကို canary analysis လို့ ခေါ်ပါတယ်၊ graph ကို မျက်စိနဲ့ ထိုင်ကြည့်တာ မဟုတ်ပါဘူး။ တစ်ချိန်တည်း ယှဉ်တော့ နေ့လယ်စာချိန်မှာ နှစ်ဖက်လုံး နှေးရင် version ကြောင့် မဟုတ်မှန်း သိပါတယ်။ code အသစ်က user အစစ်နဲ့ production config အစစ်ကို ပထမဆုံး တွေ့တဲ့ နေရာမို့ canary က တခြား test တွေ မမိတာကို မိတတ်ပါတယ်။
> ⟪board B1 step 3⟫ ကောင်းရင် ၁ ရာခိုင်နှုန်းကနေ ၁၀၊ ၅၀ ရာခိုင်နှုန်း၊ ပြီးမှ အားလုံးဆီ တိုးပြီး ပိုဆိုးရင် ချက်ချင်း rollback လုပ်ပါတယ်။ အဆင့်တစ်ခုစီကြားမှာ ပြဿနာ ပေါ်မလား စောင့်ကြည့်တဲ့ အချိန်ကို bake time လို့ ခေါ်ပြီး ထိတဲ့ user နည်းတဲ့ အစပိုင်းကို မြန်မြန်၊ user များတဲ့ နောက်ပိုင်းကို ဖြည်းဖြည်း သွားပါတယ်။

On screen:

- B1 step (1), cleared (P2 comb): user တွေ → (bus) → baseline (version ဟောင်း) | canary (version အသစ်) 1%
- B1 step (2): (an arrow-right out of each group) → နှိုင်းယှဉ် (violet)
- B1 step (3), cleared (green P1 strip): 1% → 10% → 50% → အားလုံး | rollback (red branch under the strip)

## Scene 3 · Callers feel it

chapter: ခေါ်သုံးတဲ့ဘက်က ကြည့်ပါ

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို ဘာ လွဲသွားလဲ? ငွေချေတဲ့ checkout၊ Eats နဲ့ Bill Pay တို့က pricing ကို ခေါ်သုံးပါတယ်။ အပြာရောင် bar တွေက version ၇ က ဖြေတဲ့အခါ အဲဒီ သုံးခုဘက်က စောင့်ရတဲ့ latency ပါ။
> ⟪board B2 step 2⟫ version ၈ ကတော့ ဝန်ဆောင်ခ ရှာတိုင်း ၆၀၀ millisecond လောက် ပိုကြာပါတယ်။ checkout နဲ့ Eats က ပိုကြာကြာ စောင့်နိုင်လို့ နည်းနည်း နှေးရုံပါပဲ၊ Bill Pay ကတော့ ၁ စက္ကန့်ပဲ စောင့်လို့ version ၈ က ဖြေတဲ့ call အတော်များများ timeout ဖြစ်ပါတယ်။ ဒါပေမဲ့ pricing ရဲ့ canary က version ၈ ပိုနှေးတာကို ကိုယ့် ပစ်မှတ်အတွင်းမှာပဲမို့ လက်ခံလိုက်ပြီး Bill Pay လက်လျှော့ပြီးမှ ပို့တဲ့ အဖြေကိုတောင် အောင်မြင်တယ်လို့ မှတ်လို့ pass ဖြစ်ခဲ့တာပါ။
> ⟪board B2 step 3⟫ version ၈ က pricing call တွေရဲ့ ၂ ရာခိုင်နှုန်းလောက်ပဲ ဖြေနေသေးလို့ စုစုပေါင်း latency ကလည်း မလှုပ်သလောက်ပါ။ ဖြည်းဖြည်း ဖြန့်တာကိုက ပြဿနာကို ဖုံးထားလို့ ကိုယ့်ဘက်ကိုပဲ ကြည့်ရင် ခေါ်သုံးတဲ့သူတွေရဲ့ ဒုက္ခကို မမြင်ရပါဘူး။
> ⟪board B2 step 4⟫ ဒါကြောင့် pricing က အဖြေတိုင်းမှာ ဘယ် version က ဖြေလဲ ဆိုတာ header နဲ့ တွဲပို့ပြီး service တိုင်း မျှသုံးတဲ့ client library က call တိုင်းကို အဲဒီ version အလိုက် ခွဲမှတ်ပေးပါတယ်။ ခေါ်သုံးတဲ့ service တိုင်း ဘာမှ ထပ်မရေးဘဲ ဒီ bar တွေကို ရပြီး ပေးရတဲ့ အဖိုးကတော့ သိမ်းရမယ့် metric label တွေ များလာတာပါ။
> ⟪board B2 step 5⟫ အခုဆို ခေါ်သုံးတဲ့ ဘယ်သူ့ဘက်မှာမဆို version အသစ်ရဲ့ ကိန်းဂဏန်း ဆိုးလာတာနဲ့ rollout က အလိုအလျောက် ရပ်ပါတယ်။ ဒီ နည်းကို change supervision လို့ ခေါ်ပြီး lesson ၈ က အလိုအလျောက် rollback ကို ချဲ့ထားတာပါ။

On screen:

- B2 step (1), cleared (P5 bars): v7 ကနေ latency (blue legend) | checkout | Eats | Bill Pay (labels under three short blue bars)
- B2 step (2): v8 ကနေ (violet legend; a violet bar beside each blue bar, all three the same amount taller, since v8 adds the same ~600 ms to every lookup) | Bill Pay timeout: 1 စက္ကန့် (thin orange threshold drawn over the Bill Pay pair only; its violet bar crosses it)
- B2 step (3): v8 က call တွေရဲ့ 2% ပဲ (small orange note under the axis)
- B2 step (4): header: ဖြေတဲ့ version (blue label above the bars)
- B2 step (5): rollout ရပ် (red box beside the Bill Pay bars)

## Scene 4 · Why test in production?

chapter: Production ထဲမှာ ဘာလို့ စမ်းလဲ

> ⟪close board⟫ ⟪page l19_p02⟫ production ထဲမှာ စမ်းတာ အန္တရာယ် မများဘူးလားလို့ မေးစရာ ရှိပါတယ်။ ဒါပေမဲ့ staging ကို production နဲ့ ဘယ်လောက် ဆင်တူအောင် လုပ်ထားထား user အစစ်တွေရဲ့ အပြုအမူကို အတိအကျ မကူးနိုင်ပါဘူး။ ဒါကြောင့် user နည်းနည်းကိုပဲ ထိအောင် ထားပြီး မြန်မြန် ပြန်ဖြုတ်နိုင်ရင် testing in production က အယုံရဆုံး test ဖြစ်ပါတယ်။ ပြီးတော့ feature တွေကိုပဲ မဟုတ်ဘဲ ပျက်တာကိုပါ ကြိုစမ်းရပါမယ်။
> ⟪page l19_p02b⟫ postmortem က user ဒုက္ခရောက်ပြီးမှ သင်ပေးပြီး system ပြောင်းလဲတဲ့ အမြန်နှုန်းကိုလည်း မမီပါဘူး။ ကြိုစမ်းရင်တော့ user မထိခင် သိရပြီး ပုံမှန် ပြန်စမ်းနေလို့ အပြောင်းအလဲတွေကိုပါ မီပါတယ်။ လူ အပြည့်အဝ နားမလည်တဲ့ code များလာလေ ဒီလို စမ်းတာက အဓိက စစ်ချက် ဖြစ်လာလေပါ။

On screen:

- l19_p02 (K2): Production ထဲမှာ ဘာလို့ စမ်းလဲ | staging က user အစစ်ကို မကူးနိုင် | နည်းနည်းပဲ ထိ၊ မြန်မြန် ပြန်ဖြုတ် | feature တင် မဟုတ်၊ ပျက်တာကိုပါ စမ်း
- l19_p02b (K3, left gray / right teal; cells as left / right): postmortem ကနေ သင် / ကြိုစမ်းပြီး သင် | user ဒုက္ခရောက်ပြီးမှ / user မထိခင် | အပြောင်းအလဲကို မမီ / ပုံမှန် ပြန်စမ်း

## Scene 5 · A fault experiment

chapter: Fault experiment

> ⟪page l19_p03⟫ ပျက်တာကို ကြိုစမ်းတဲ့ နည်းက fault experiment ပါ၊ ပျက်စီးမှု တစ်ခုကို production ထဲ တမင် inject လုပ်ပြီး system ဘယ်လို တုံ့ပြန်လဲ ကြည့်တာပါ။ ဒါကို စနစ်တကျ ပုံမှန် လုပ်တာကို chaos engineering လို့ ခေါ်ပေမဲ့ ကျပန်း ဖျက်တာ မဟုတ်ပါဘူး၊ လူတိုင်း ဖတ်လို့ရတဲ့ Principles of Chaos Engineering ထဲက အဆင့်တွေအတိုင်း သွားပြီး ထိခိုက်နိုင်တဲ့ နယ်ပယ်၊ blast radius ကို အမြဲ ကန့်သတ်ပါတယ်။
> ⟪page l19_p03b⟫ steady state ဆိုတာ ပုံမှန် ကျန်းမာနေတဲ့ ပုံကို သဘောတူထားတဲ့ ပစ်မှတ် ဖြစ်တဲ့ service level objective၊ SLO လိုပဲ user ခံစားရတဲ့ ကိန်းဂဏန်းနဲ့ ရေးတာပါ။ Padauk ရဲ့ checkout အတွက်ဆို ၉၉.၅ ရာခိုင်နှုန်း အောင်မြင်ပြီး request ၉၅ ရာခိုင်နှုန်းက ၁.၅ စက္ကန့်အတွင်း ပြီးရပါမယ်။ hypothesis ကတော့ စမ်းပြီး စစ်မယ့် ယူဆချက်ပါ၊ point ပေးတဲ့ loyalty service က error ပြန်ပေးပေး၊ ၃ စက္ကန့် နှေးနှေး checkout က ဒီ steady state ထဲမှာ ဆက်ရှိမယ်လို့ ယူဆပါတယ်။

On screen:

- l19_p03 (K6): Fault experiment | steady state | hypothesis | inject | နှိုင်းယှဉ် | blast radius ကန့်သတ် | (caption) ကျပန်း မဖျက်ဘဲ အဆင့်လိုက်
- l19_p03b (K7): checkout ရဲ့ steady state | 99.5% · p95 < 1.5 s | hypothesis: loyalty ပျက်လည်း ဒီအတိုင်း

## Scene 6 · The loyalty test

chapter: Soft ဖြစ်နေသေးလား

> ⟪close page⟫ ⟪board B3 step 1⟫ point မရရင်တောင် ငွေချေတာ ဆက်ဖြစ်ရမှာမို့ loyalty က soft dependency ပါ၊ မရှိရင်လည်း အဓိက အလုပ် ဆက်လုပ်နိုင်ရမယ့် dependency ပါ။ မစခင် မသီရိရဲ့ အဖွဲ့က ဘာစမ်းမလဲ၊ ဘာကြည့်မလဲ၊ ဘယ်သူမဆို ချက်ချင်း ပြန်ရပ်နိုင်တဲ့ အဆင့်တွေ ပါတဲ့ plan ကို ရေးပြီး loyalty အဖွဲ့ကို review လုပ်ခိုင်းပါတယ်။
> ⟪board B3 step 2⟫ loyalty ကို တကယ် မဖျက်ဘဲ checkout ဘက်ကနေ ထွက်တဲ့ call တွေကိုပဲ နှေးအောင် လုပ်ပါတယ်၊ dependency ပျက်တာကို ကိုယ့်ဘက်ကနေ စမ်းတာပါ။ မနက် ၂ နာရီမှာ traffic ၁ ရာခိုင်နှုန်းမှာပဲ ၃ စက္ကန့် delay ကို inject လုပ်ပြီး အဲဒီ rule ကလည်း အချိန်ပြည့်ရင် ကိုယ့်ဘာသာ ပျောက်သွားပါတယ်။
> ⟪board B3 step 3⟫ ရလဒ်ကတော့ hypothesis နဲ့ မတူပါဘူး၊ checkout က point မပါဘဲ ဆက်သွားမယ့်အစား ၃ စက္ကန့်လုံး ထိုင်စောင့်နေလို့ steady state ရဲ့ ၁.၅ စက္ကန့်ကို ကျော်သွားပါတယ်။ ရှာကြည့်တော့ loyalty call မှာ timeout မသတ်မှတ်ထားလို့ default ၃၀ စက္ကန့် ဖြစ်နေတာပါ၊ loyalty တကယ် ရပ်သွားရင် checkout တိုင်း ၃၀ စက္ကန့်အထိ စောင့်ရမှာပါ။
> ⟪board B3 step 4⟫ ပြင်တာက ရိုးရိုးလေးပါ၊ loyalty ကို ၃၀၀ millisecond ပဲ စောင့်ပြီး မဖြေရင် point ကို နောက်မှ ထည့်ပေးတာပါ။ code ပြောင်းရင်း soft dependency တစ်ခုက ဘယ်သူမှ မသိဘဲ မရှိမဖြစ် dependency ဖြစ်သွားတတ်လို့ ဒီ test ကို အခု ညတိုင်း run ပါတယ်။ ရလဒ် မလှပေမဲ့ မဖုံးဘဲ မျှပေးတော့ တခြား အဖွဲ့တွေလည်း ကိုယ့် timeout တွေကို ပြန်စစ်ကြပါတယ်။

On screen:

- B3 step (1), cleared (P1 flow): checkout → loyalty points (soft) (orange box)
- B3 step (2): inject: 3 စက္ကန့် နှေး (red, on the arrow)
- B3 step (3): default timeout: 30 စက္ကန့်! (red, under checkout)
- B3 step (4): timeout 300 ms + point နောက်မှ ပေး (green box) | အခု ညတိုင်း run (green label)

## Scene 7 · Scale up, then a game day

chapter: သင်္ကြန် game day

> ⟪close board⟫ ⟪board B4 step 1⟫ fault experiment တွေကို လှေကားထစ်လို တစ်ဆင့်ချင်း ကြီးအောင် လုပ်ပါတယ်၊ call တစ်ခု နှေးအောင် လုပ်တာကနေ dependency တစ်ခုလုံး fail ဖြစ်အောင် ဆက်တက်ပါတယ်။
> ⟪board B4 step 2⟫ နောက်တစ်ဆင့်မှာ service နှစ်ခုကြားက network link ကို ဖြတ်ကြည့်ပါတယ်၊ zone တစ်ခုကိုလည်း drain လုပ်ပြီး traffic ကို တခြား zone တွေဆီ လွှဲကြည့်ပါတယ်။ database connection ကုန်တာလို resource ပြတ်တာကို စမ်းရင်လည်း service က crash မဖြစ်ဘဲ ရှင်းတဲ့ error ပြပြီး alert တက်ရပါမယ်။
> ⟪board B4 step 3⟫ အမြင့်ဆုံး အဆင့်က region တစ်ခုလုံး ဆုံးရှုံးတာပါ။ Padauk မှာ region တစ်ခုပဲ ရှိလို့ ဒါကိုတော့ စာရွက်ပေါ်မှာပဲ လေ့ကျင့်ပါတယ်၊ ခေါင်းဆောင်တွေကလည်း ဒါကို သင်္ကြန် game day ခေါင်းစဉ်အဖြစ် ရွေးပါတယ်။
> ⟪close board⟫ ⟪page l19_p03c⟫ game day ဆိုတာ ပျက်စီးမှုကို တမင် ဖန်တီးပြီး အဖွဲ့လိုက် ကြိုလေ့ကျင့်တဲ့ နေ့ပါ။ region ပျောက်ပြီ ဆိုတဲ့ ခေါင်းစဉ်အောက်မှာ အဖွဲ့တိုင်း ကိုယ့် test ကိုယ် ထည့်ပါတယ်၊ ဥပမာ Wallet က မနေ့က backup ကို တကယ် restore လုပ်ကြည့်ပြီး support ကတော့ settlement ကို ပြန် run တတ်တဲ့ ကိုအောင် ခွင့်ယူထားရင် ဘာလုပ်မလဲ ဆွေးနွေးပါတယ်။
> ⟪page l19_p03d⟫ Wallet နဲ့ Eats က တစ်ဖွဲ့ test ကို တစ်ဖွဲ့ စစ်ပေးပြီး တက်သင့်တဲ့ alert တွေ တကယ် တက်လားလည်း ကြည့်ပါတယ်။ တွေ့သမျှကို နောက် သုံးလပတ် plan ထဲ ထည့်ပါတယ်၊ ဒါက အမှတ်ပေးတဲ့ audit မဟုတ်ဘဲ ပိုကောင်းလာဖို့ပါ။
> ⟪page l19_p03e⟫ test တွေက ဖြစ်နိုင်တဲ့ အခြေအနေ တချို့ကိုပဲ စမ်းနိုင်ပါတယ်။ wallet balance ဘယ်တော့မှ သုညအောက် မရောက်ရဘူး ဆိုတဲ့ သေးပြီး အရေးကြီးတဲ့ rule မျိုးအတွက်တော့ model checker ဆိုတဲ့ tool က အဆင့်တွေရဲ့ အစဉ်တိုင်းကို စမ်းပေးပါတယ်။ ဒီတော့ request နှစ်ခု တစ်ပြိုင်နက် ဝင်လာရင် balance စစ်တာနဲ့ ငွေနှုတ်တာကြားက ကွက်လပ်ကို ရှာပေးနိုင်ပါတယ်။

On screen:

- B4 step (1), cleared (P7 staircase rising left to right): call တစ်ခု နှေး → dependency တစ်ခု fail
- B4 step (2): link တစ်ခု ဖြတ် → zone တစ်ခု drain
- B4 step (3): region ပျောက် / (စာရွက်ပေါ်မှာ) (top step, orange, two lines)
- l19_p03c (K4): သင်္ကြန် game day | ခေါင်းစဉ်: "region ပျောက်ပြီ" | Wallet: မနေ့က backup ကို restore | support: ကိုအောင် ခွင့်ယူထားရင်
- l19_p03d (K2): game day ပြီးရင် | တစ်ဖွဲ့ test ကို တစ်ဖွဲ့ စစ် | မှန်တဲ့ alert တက်လား ကြည့် | တွေ့တာကို နောက် သုံးလပတ် plan ထဲ
- l19_p03e (K7): သေးပြီး အရေးကြီးတဲ့ rule | balance ≥ 0 | model checker က အစဉ်တိုင်းကို စမ်း

## Scene 8 · This week

chapter: —

> ⟪page l19_p04⟫ production ထဲ စမ်းတာကို ဒီအပတ် စာရွက်ပေါ်ကနေ စပါ။ soft dependency တစ်ခုအတွက် steady state၊ hypothesis နဲ့ ပြန်ရပ်နည်း ပါတဲ့ fault experiment တစ်ခု ရေးကြည့်ပါ။ ကိုယ် ခေါ်သုံးနေတဲ့ service တစ်ခုရဲ့ latency ကို ဖြေတဲ့ version အလိုက် ခွဲကြည့်ပါ။ ပြီးတော့ တစ်နာရီ game day တစ်ခုကို calendar ထဲ ထည့်ထားပါ။

On screen:

- l19_p04 (K2): ဒီအပတ် လုပ်စရာ | fault experiment တစ်ခု ရေးပါ | latency ကို ဖြေတဲ့ version အလိုက် ခွဲပါ | တစ်နာရီ game day တစ်ခု ချိန်းပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ notes ထဲက ခြောက်ခုကို pricing နဲ့ loyalty ပုံပြင်နဲ့ တွဲမှတ်ပါ။ ⟪select canary⟫ canary က version အသစ်ကို traffic နည်းနည်းဆီ အရင် ပို့တာ ဖြစ်ပြီး၊ ⟪select baseline⟫ baseline က တစ်ချိန်တည်း version ဟောင်း run နေတဲ့ ယှဉ်စရာ အုပ်စုပါ။ ⟪select change supervision⟫ change supervision က ခေါ်သုံးတဲ့ဘက်က ကိန်းဂဏန်း ဆိုးလာတာနဲ့ rollout ကို အလိုအလျောက် ရပ်ပေးတာပါ။
> ⟪select fault experiment⟫ fault experiment က steady state နဲ့ hypothesis ကနေ စပြီး ပျက်စီးမှုကို ထိန်းချုပ်ပြီး inject လုပ်ကြည့်တာပါ။ ⟪select soft dependency⟫ soft dependency က မရှိရင်လည်း အဓိက အလုပ် ဆက်ဖြစ်ရမယ့် dependency ဖြစ်ပြီး၊ ⟪select game day⟫ game day ကတော့ ပျက်စီးမှုကို အဖွဲ့လိုက် ကြိုလေ့ကျင့်တဲ့ နေ့ပါ။
> ⟪select မေးခွန်း⟫ မေးခွန်း တစ်ခုနဲ့ ပိတ်ရအောင်။ ကိုယ့် canary က ကောင်းနေတယ်လို့ ပြနေရင် အဲဒီ canary က ဘယ် အုပ်စု နှစ်ခုကို နှိုင်းယှဉ်နေရမှာလဲ?
> ⟪pause 3s⟫ version အသစ် run နေတဲ့ canary နဲ့ တစ်ချိန်တည်းမှာ version ဟောင်း run နေတဲ့ baseline ပါ။ ဒီလိုနဲ့ သင်္ကြန် ရောက်ဖို့ ခြောက်ပတ်ပဲ လိုပါတော့တယ်၊ ပြီးခဲ့တဲ့ နှစ်က ညသန်းခေါင်မှာ Top-up ဆီ တစ်စက္ကန့်ကို request ၂၀၀၀၀ ရောက်လာခဲ့ပါတယ်။ ဒီနှစ်အတွက် ဘယ်လောက်အထိ ပြင်ဆင်ထားရမလဲ?

On screen:

- notes.md: # Production ထဲမှာ စမ်းသပ်ခြင်း | (blank line) | - canary — version အသစ်ကို traffic နည်းနည်းဆီ အရင် ပို့ | - baseline — တစ်ချိန်တည်း version ဟောင်း run နေတဲ့ ယှဉ်စရာ အုပ်စု | - change supervision — ခေါ်သုံးတဲ့ဘက်က ကိန်းဂဏန်း ဆိုးရင် rollout ကို အလိုအလျောက် ရပ် | - fault experiment — steady state + hypothesis၊ ပျက်စီးမှုကို ထိန်းချုပ်ပြီး inject | - soft dependency — မရှိလည်း အဓိက အလုပ် ဆက်ဖြစ်ရ၊ ညတိုင်း စမ်း | - game day — ပျက်စီးမှုကို အဖွဲ့လိုက် ကြိုလေ့ကျင့်တဲ့ နေ့ | (blank line) | မေးခွန်း: canary ကောင်းနေတယ်။ ဘယ် အုပ်စု နှစ်ခုကို နှိုင်းယှဉ်နေရမလဲ?
