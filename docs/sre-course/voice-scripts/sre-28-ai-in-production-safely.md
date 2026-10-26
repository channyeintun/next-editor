# Lesson 28 · AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း

slug: sre-28-ai-in-production-safely · budget: 8400 characters (±5%)

## Scene 1 · Hook: Ops Buddy asks for production access

chapter: Production access တောင်းတဲ့ Ops Buddy

> ⟪page l28_p01⟫ Ask Padauk မှာ အခု AI အတွက် user ကြုံရတာကို တိုင်းတဲ့ service level indicator၊ SLI တွေ ရှိပြီး နေ့တိုင်း အဖြေ နမူနာ စစ်နေသလို fraud model ကလည်း data မကောင်းရင် training ကို ရပ်ပါတယ်။ ဒီနေ့တော့ production ကို run ဖို့ ကူညီမယ့် AI ဘက်ကို လှည့်ကြည့်ပါမယ်။
> platform အဖွဲ့က alert နဲ့ log တွေကို ဖတ်ပြီး on-call ကို ကူညီမယ့် internal AI agent၊ Ops Buddy ကို ဆောက်ပါတယ်။ ဒါပေမဲ့ သူ့ ပထမ version က admin token နဲ့ production တစ်ခုလုံး ဝင်ခွင့် တောင်းထားပါတယ်။ Ops Buddy ကို ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ?
> ⟪page l28_p01b⟫ AI ကို ဘာလို့ လိုလာတာလဲ? service တွေ များလာတော့ alert တိုင်းကို လူက လိုက်ကြည့်လို့ မမီသလို script တွေကလည်း ကြိုသိထားတဲ့ ပြဿနာကိုပဲ ဖြေရှင်းနိုင်ပါတယ်။ AI ကတော့ ပုံစံမကျတဲ့ chat နဲ့ log တွေကို ဖတ်ပြီး ဘယ်သူမှ rule မရေးထားတဲ့ အခြေအနေမှာလည်း အကြံပေးနိုင်ပါတယ်၊ ဒါပေမဲ့ ရိုးရိုး rule နဲ့ ရပြီးသား နေရာမှာတော့ AI မလိုပါဘူး။
> ⟪page l28_p01c⟫ ပြဿနာက လူနဲ့ agent မှားပုံ မတူတာပါ။ လူ တစ်ယောက် မှားရင် တစ်ခါပဲ မှားပြီး ဘေးက တစ်ယောက်ယောက် သတိထားမိတတ်ပါတယ်။ ၂၀၀ ခါမှာ တစ်ခါပဲ မှားတဲ့ agent က တစ်ရက်ကို action ၁၀၀၀ လုပ်ရင်တော့ အမှား ငါးခုကို ပုံစံတူ မြန်မြန် ထပ်လုပ်ပါလိမ့်မယ်။ input တူရင်တောင် အဖြေ ကွဲနိုင်တဲ့ AI ကို ဘယ်တော့မှ မမှားအောင် လုပ်လို့ မရလို့ ဘယ်လောက် မှားလဲ တိုင်းပြီး ထိန်းရပါတယ်။
> ⟪page l28_p01d⟫ ပြီးတော့ production မှာ အမှားကို ဘေးကင်းကင်း ပိတ်ထားပေးမယ့် sandbox မရှိပါဘူး။ Ask Padauk မှားရင် သူဖွင့်တဲ့ ticket ကို လူက ပြန်စစ်ပေးနိုင်ပေမဲ့ Ops Buddy က နေ့လယ်စာချိန်မှာ rider dispatch worker တွေကို မှားပြီး restart လုပ်ရင် Eats order တွေ ချက်ချင်း ရပ်သွားနိုင်ပါတယ်။

On screen:

- l28_p01 (K1): 28 | AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း | Ops Buddy က production access တောင်းတယ် | လူ မှားရင် တစ်ခါ၊ တစ်ယောက်ယောက် သတိထားမိ | 200 ခါမှာ 1 ခါ မှားတဲ့ agent က ထပ်ခါထပ်ခါ | ဘေးကင်းကင်း ဘယ်လို ဝင်ခွင့်ပေးမလဲ? | (small loop badge, တုံ့ပြန် lit, Ops Buddy icon beside it)
- l28_p01b (K2): AI ဘာလို့ လိုလာလဲ | alert တိုင်းကို လူ လိုက်ကြည့်လို့ မမီ | script က ကြိုသိတဲ့ ပြဿနာမှာပဲ ရ | rule နဲ့ ရပြီးသားဆို AI မလို
- l28_p01c (K7): 200 ခါမှာ 1 ခါ မှားတဲ့ agent | 1000÷200=5 | တစ်ရက် action 1000၊ ပုံစံတူ အမှား 5 ခု
- l28_p01d (K2): production မှာ sandbox မရှိ | Ask Padauk: ticket ပဲ၊ လူ ပြန်စစ် | Ops Buddy: worker restart မှား | Eats order တွေ ချက်ချင်း ရပ်

## Scene 2 · Where Ops Buddy may help

chapter: မှားလည်း နည်းနည်းပဲ ထိတဲ့ နေရာ

> ⟪close page⟫ ⟪board B1 step 1⟫ ဘဏ်မှာ system administrator လုပ်ခဲ့ဖူးတဲ့ ကိုဇော်က admin token ကို ငြင်းလိုက်ပါတယ်။ AI က တစ်ခါခါ မှားမှာ သေချာနေတော့ Padauk ရဲ့ reliability loop ပေါ်မှာ မှားရင် နည်းနည်းပဲ ထိမယ့် နေရာကို ရှာပါတယ်။
> ⟪board B1 step 2⟫ သတိထားမိတဲ့ အဆင့်မှာ Ops Buddy က Facebook နဲ့ Viber ကနေ မစုဆီ ဝင်လာတဲ့ complaint တွေကို အုပ်စုဖွဲ့ပေးပြီး သင်ယူတဲ့ အဆင့်မှာ postmortem အတွက် timeline မူကြမ်း ရေးပေးပါတယ်။ မှားရင် ကုန်ကျစရိတ် နည်းပြီး လူက ရလဒ်ကို အမြဲ ပြန်ဖတ်တဲ့ နေရာတွေပါ။
> ⟪board B1 step 3⟫ incident ကို တုံ့ပြန်တဲ့ အဆင့်မှာတော့ အစပိုင်း အကြံပဲ ပေးပြီး ဆုံးဖြတ်တာက on-call ပါ။ tool ထက် အရင် လိုတာက အပြစ်ပေးခံရမှာ မကြောက်ဘဲ ပြောရဲတဲ့ psychological safety ပါ၊ ဒါကြောင့် Ops Buddy ရဲ့ မှတ်တမ်းကို လူတွေကို အမှတ်ပေးဖို့ ဘယ်တော့မှ မသုံးပါဘူး။ ဘေးကင်းကြောင်း မသေချာခင် အားလုံးကို အတင်း သုံးခိုင်းရင်လည်း ယုံကြည်မှု ပျက်တတ်ပါတယ်။

On screen:

- B1 step (1), cleared (the Padauk loop as furniture, no title, no drawMs, so the board stays at 9 labels): သဘောတူ | သတိထားမိ | တုံ့ပြန် | သင်ယူ | တည်ဆောက် | လူတွေ (the doll in the hub)
- B1 step (2): complaint အုပ်စုဖွဲ့ (green note beside သတိထားမိ) | timeline မူကြမ်း (green note beside သင်ယူ)
- B1 step (3): အစမှာ အကြံပဲ ပေး (orange note beside တုံ့ပြန်)

## Scene 3 · Ko Zaw's dry-run month

chapter: ကိုဇော်ရဲ့ dry run တစ်လ

> ⟪close board⟫ ⟪board B2 step 1⟫ ကိုဇော်က Ops Buddy ကို တစ်လလုံး dry run နဲ့ပဲ run ထားပါတယ်၊ တကယ် ဘာမှ မပြောင်းဘဲ လုပ်မယ့်ဟာကိုပဲ မှတ်တမ်းတင်တာပါ။ အကြံ ၄၀ ကို on-call တွေ တကယ် လုပ်ခဲ့တာနဲ့ တိုက်ကြည့်တော့ ၃၁ ခုက မှန်ပြီး ၆ ခုက မမှန်ပေမဲ့ အန္တရာယ် မရှိပါဘူး၊ ကျန်တဲ့ ၃ ခုကတော့ မှားပါတယ်။
> မှားတဲ့ တစ်ခုက Operator B နှေးနေတုန်း Top-up traffic အားလုံးကို Operator A ဆီ လွှဲခိုင်းတာပါ၊ တကယ်သာ လုပ်ခဲ့ရင် Operator A ပါ ဝန်ပိုပြီး ကျသွားမှာပါ။
> ⟪board B2 step 2⟫ ဒီ ရလဒ်တွေကို ကိုဇော်က သောကြာနေ့ session တစ်ခုမှာ senior တွေနဲ့ အလုပ်ဝင်ခါစ engineer တွေကို အတူ ပြပါတယ်။ Ops Buddy က ဘာမှာ တော်ပြီး ဘယ်မှာ မှားတတ်လဲ မြင်တော့ senior တွေက အလွန်အကျွံ မကြောက်တော့သလို လူသစ်တွေလည်း မျက်စိမှိတ် မယုံတော့ပါဘူး။ အဲဒီနောက်မှ SMS code တွေ နှေးလာရင် အဲဒီ provider ကို မျှသုံးနေတဲ့ promo SMS batch ကို ခဏ ရပ်တာကို ပထမဆုံး ကိုယ်တိုင် လုပ်ခွင့်အဖြစ် ပေးပါတယ်။
> ⟪board B2 step 3⟫ ဒါပေမဲ့ ဒီ ရလဒ်က ဒီ model အတွက်ပဲ မှန်လို့ model ကို ပိုကောင်းတဲ့ တစ်ခုနဲ့ လဲတာတောင် production change တစ်ခုလို dry run နဲ့ ပြန်စစ်ပါတယ်။ AI tool တွေက မြန်မြန် ဟောင်းသွားပေမဲ့ ဒီလို အရင် စစ်တဲ့ စည်းမျဉ်းတွေကတော့ ကျန်နေပါတယ်။ Ops Buddy မလုပ်နိုင်သေးတဲ့ အလုပ်တွေကိုလည်း လက်မလျှော့ဘဲ လအနည်းငယ်နေရင် ပြန်စမ်းပါတယ်။

On screen:

- B2 step (1), cleared (P8 timeline; underline axis, labels alternate above and below): 4 ပတ် dry run: အကြံ 40 (tick, above) | review: မှန် 31 · အန္တရာယ်မရှိ 6 · မှား 3 (tick, below, two lines)
- B2 step (2): သောကြာနေ့ session (tick, above) | ပထမဆုံး ကိုယ်တိုင်: / promo SMS ရပ် (green tick, below, two lines)
- B2 step (3): model လဲရင် dry run ပြန်စ (orange tick at the right end, above)

## Scene 4 · The action card

chapter: Action card

> ⟪close board⟫ ⟪board B3 step 1⟫ Ops Buddy ရဲ့ လုပ်ခွင့်တွေကို lesson ၁၇ က failover bot လိုပဲ action card ပေါ်မှာ ရေးပါတယ်။ action card ဆိုတာ action တစ်ခုချင်းအတွက် အကြံပဲ ပေးမလား၊ အရင် မေးမလား၊ လုပ်ပြီးမှ ပြောမလား၊ ဘယ်တော့မှ မလုပ်ရဘူးလား ဆိုတာနဲ့ undo လုပ်နည်း၊ ရပ်ရမယ့် အခြေအနေကို ရေးထားတဲ့ ကတ်ပါ။ promo SMS ရပ်တာနဲ့ Top-up instance တစ်ခု တိုးတာက မိနစ်ပိုင်းအတွင်း undo လုပ်လို့ရလို့ လုပ်ပြီးမှ ပြောပါတယ်။
> ⟪board B3 step 2⟫ operator traffic ၁၀ ရာခိုင်နှုန်း လွှဲတာနဲ့ တစ်နေတဲ့ dispatch worker ကို restart လုပ်တာကတော့ မှားရင် ပိုထိလို့ on-call ကို အရင် မေးရပါတယ်။ ဒါပေမဲ့ အဆင့်တိုင်းကို approve လုပ်ခိုင်းရင် ကြာတော့ လူက မဖတ်တော့ဘဲ approve ကိုပဲ နှိပ်ပေးတတ်ပါတယ်။ ဒါကြောင့် review တိုင်းကို နောက်တစ်ဆင့် တက်ဖို့ feedback အဖြစ် သုံးပါတယ်။
> ⟪board B3 step 3⟫ Wallet ရဲ့ ledger ကိုတော့ ဘယ်တော့မှ မထိရပါဘူး။ ဒီလို လုပ်ခွင့်ကို agent တစ်ခုလုံးအတွက် မဟုတ်ဘဲ action တစ်ခုချင်း ဘယ်လောက် အရေးကြီးလဲ၊ မှားရင် ဘယ်လောက် ဆုံးရှုံးမလဲ ချိန်ပြီး ဆုံးဖြတ်တာပါ။
> ⟪board B3 step 4⟫ ဥပမာ operator traffic လွှဲတာကို လုပ်ပြီးမှ ပြော အဆင့် တင်ချင်ရင် approve ခံခဲ့တဲ့ မှတ်တမ်း ကောင်းကောင်း၊ အရင် အခြေအနေကို ပြန်ယူတဲ့ rollback ကို စမ်းပြီးသား ဖြစ်တာ၊ test တွေနဲ့ budget တွေ ရှိမှ တင်ပါတယ်။ လုပ်ခွင့် နည်းနည်းပဲ ပေးထားတာက ပိုကောင်းတဲ့ action တွေလည်း အများကြီး ရှိပါတယ်။

On screen:

- B3 step (1), cleared (a card: actions in a left column, one mode box per group in a right column): promo SMS batch ရပ် | Top-up instance 1 ခု တိုး | လုပ်ပြီးမှ ပြော (one green box spanning both rows)
- B3 step (2): operator traffic 10% လွှဲ | တစ်နေတဲ့ dispatch worker / restart (two lines) | အရင် မေး (one orange box spanning both rows)
- B3 step (3): ledger ကို ထိ | ဘယ်တော့မှ မလုပ် (red box)
- B3 step (4): အဆင့်တင်ရင်: မှတ်တမ်း · rollback · test · budget (orange note under the card)

## Scene 5 · Before Ops Buddy touches production

chapter: Production မထိခင်

> ⟪close board⟫ ⟪page l28_p02⟫ ကိုဇော် admin token ကို ငြင်းတာ lesson ၂၂ ရဲ့ cleanup script ကြောင့်ပါ။ AI နဲ့ ရေးထားတဲ့ အဲဒီ script ကို admin credential နဲ့ run လိုက်တော့ merchant ၁၀၀၀၀ ကို ဖျက်မိခဲ့ပါတယ်။ agent ဆိုရင် ဒီလို အမှားကို ပိုမြန်မြန် လုပ်နိုင်ပါတယ်။
> ဒါကြောင့် Ops Buddy ကို read-only နဲ့ စပြီး least privilege နဲ့ပဲ ထားပါတယ်။ action တိုင်း မလုပ်ခင် dry run နဲ့ ဘာပြောင်းမလဲ ပြရပြီး တကယ် အလုပ်လုပ်တဲ့ stop button လည်း ရှိရပါမယ်။ စမ်းရုံနဲ့တောင် admin token မပေးပါနဲ့။

On screen:

- l28_p02 (K2): Production မထိခင် | read-only နဲ့ စ၊ least privilege | action တိုင်း မလုပ်ခင် dry run | တကယ် အလုပ်လုပ်တဲ့ stop button

## Scene 6 · Two budgets and a brake

chapter: Budget နှစ်ခုနဲ့ stop button

> ⟪close page⟫ ⟪board B4 step 1⟫ Ops Buddy ကို သီးသန့် budget နှစ်ခုနဲ့ ထိန်းပါတယ်။ ပထမက service level objective၊ SLO ပစ်မှတ်က ခွင့်ပြုထားတဲ့ ပျက်ခွင့်၊ service ရဲ့ error budget ပါ၊ Top-up ဆိုရင် တစ်လကို fail ဖြစ်တဲ့ top-up ၁၀၀၀၀ ပါ။ ဒုတိယက Ops Buddy ကိုယ်ပိုင် safety budget ပါ၊ on-call က သူ့ action ကို ပြန် undo လုပ်ပေးရတိုင်း၊ သူ့ အကြံကို ဘေးမကင်းလို့ ငြင်းရတိုင်း လျော့သွားပါတယ်။
> ⟪board B4 step 2⟫ Top-up ရဲ့ error budget ကုန်ရင် Ops Buddy က Top-up မှာ ကိုယ်တိုင် ဘာမှ မလုပ်တော့ဘဲ အကြံပဲ ပေးပါတယ်။ safety budget ကုန်ရင်တော့ service ကောင်းနေရင်တောင် အဖွဲ့က review မလုပ်မချင်း ကိုယ်တိုင် လုပ်ခွင့် အားလုံး ရပ်ပါတယ်။ ဒါ့အပြင် action မလုပ်ခင် ဖွင့်ထားတဲ့ incident ရှိလား စစ်ပါတယ်၊ သင်္ကြန် change freeze အတွင်းမှာလည်း ကိုယ့်ဘာသာ ရပ်နေပါတယ်။
> ⟪board B4 step 3⟫ နောက်ဆုံး ဘရိတ်က stop button ပါ။ on-call ကျနေတဲ့ ဘယ်သူမဆို ခွင့်မတောင်းဘဲ နှိပ်လိုက်တာနဲ့ Ops Buddy ရဲ့ access အားလုံး ချက်ချင်း ပြတ်ပါတယ်။ ရပ်လို့ရမှန်း သိထားမှ on-call တွေက Ops Buddy နဲ့ စိတ်ချလက်ချ တွဲလုပ်ရဲကြတာပါ။

On screen:

- B4 step (1), cleared (P5, two bars side by side): service ရဲ့ error budget (blue bar) | Ops Buddy ရဲ့ safety budget (violet bar)
- B4 step (2): service budget ကုန် → အကြံပဲ ပေး (red arrow-down and red label under the first bar) | safety budget ကုန် → ရပ် (red arrow-down and red label under the second bar)
- B4 step (3): STOP (red ellipse to the right of the bars)

## Scene 7 · One undoable unit

chapter: Undo လုပ်လို့ရမှ လုပ်

> ⟪close board⟫ ⟪board B5 step 1⟫ အခြေခံ စည်းကမ်းက undo လုပ်နည်း မသိရင် action မလုပ်ရဘူး ဆိုတာပါ။ action ကို လုပ်ပြီးရင် ငြိမ်လာအောင် warm-up အချိန် စောင့်ပြီးမှ ကောင်းလား ကြည့်ပါတယ်။ ဥပမာ promo SMS batch ကို ရပ်ရင် provider ဆီ ရောက်ပြီးသား message တွေ ကုန်အောင် မိနစ်အနည်းငယ် စောင့်ပြီးမှ SMS code latency ကို ကြည့်ပါတယ်။
> ⟪board B5 step 2⟫ SMS code ပြန်မြန်လာရင် batch ကို ဆက်ရပ်ထားပြီး ငြိမ်မှ promo ကို ဖြည်းဖြည်း ပြန်ပို့ပါတယ်။ မမြန်လာရင်တော့ promo က အကြောင်းရင်း မဟုတ်လို့ batch ကို အလိုအလျောက် ပြန်ဖွင့်ပြီး on-call ဆီ page ပို့ပါတယ်။
> ⟪board B5 step 3⟫ ဒီ အဆင့်တွေကို တစ်ဝက်တစ်ပျက် မကျန်အောင် unit တစ်ခုတည်းအဖြစ် run ပြီး audit log ထဲမှာလည်း တစ်ခုတည်းအဖြစ် မှတ်ပါတယ်။ lesson ၂၆ မှာ release တစ်ခုလုံးကို rollback မလုပ်နိုင်ခဲ့ပေမဲ့ agent ရဲ့ action တစ်ခုချင်းကတော့ သေးပြီး undo လုပ်လို့ ရရပါမယ်။ data ဖျက်တာ၊ schema ပြောင်းတာလို ပြန်ယူလို့ မရတဲ့ အလုပ်တွေကတော့ လူတွေ လက်ထဲမှာပဲ ကျန်ပါတယ်။
> ⟪board B5 step 4⟫ Ops Buddy ကိုယ်တိုင်လည်း SLO ရှိတဲ့ service တစ်ခုပါ။ ဘယ်လောက် မြန်လဲ၊ အကြံ လက်ခံတဲ့ နှုန်းနဲ့ ဘယ်လောက် အသုံးဝင်လဲ၊ ဘယ်လောက် ဘေးကင်းလဲ တိုင်းပြီး အရင် incident တွေမှာ လူတွေ လုပ်ခဲ့တာနဲ့ အမြဲ တိုက်စစ်ပါတယ်၊ incident ပြီးတိုင်း စစ်စရာ case တစ်ခု တိုးပါတယ်။ သူ ဖတ်တဲ့ service map နဲ့ deploy မှတ်တမ်း နောက်ကျနေရင် သူ့ အကြံလည်း မှားမှာပါ။

On screen:

- B5 step (1), cleared (P1 flow, four boxes left to right): လုပ် → warm-up → စောင့်ကြည့် → ကောင်းလား?
- B5 step (2): ဆက်ထား (green box to the right of ကောင်းလား?) | အလိုအလျောက် undo (red box under ကောင်းလား?, after a red arrow-down)
- B5 step (3): audit လုပ်ထားတဲ့ unit တစ်ခု (outer rectangle around the flow, label on its top edge) | ဥပမာ: promo SMS ရပ်၊ SMS code မြန်မှ ပြန်ပို့ (small text under the rectangle)
- B5 step (4): Ops Buddy ရဲ့ SLO: မြန် · အသုံးဝင် · ဘေးကင်း (blue box at the bottom)

## Scene 8 · What people do now

chapter: လူတွေရဲ့ နေရာသစ်

> ⟪close board⟫ ⟪page l28_p03⟫ ဒါဆို AI က Site Reliability Engineering၊ SRE လုပ်တဲ့ လူတွေကို အစားထိုးမလား? မထိုးပါဘူး၊ သူတို့ နေရာ ပြောင်းသွားတာပါ။ အဆင့်တိုင်းကို ကိုယ်တိုင် လုပ်နေမယ့်အစား အပေါ်ကနေ ပန်းတိုင်နဲ့ ကန့်သတ်ချက် သတ်မှတ်တယ်၊ အထောက်အထား စစ်ပြီး approve လုပ်တယ်၊ လိုရင် ရပ်တယ်၊ ခက်တဲ့ ပြဿနာ အသစ်တွေကို ယူပါတယ်။ ဒါကို human over the loop လို့ ခေါ်ပါတယ်။
> ⟪page l28_p03b⟫ reliability အလုပ် ဈေးသက်သာလာရင် SRE အလုပ် နည်းမယ် ထင်ရပေမဲ့ တကယ်တော့ ပိုများလာတတ်ပါတယ်၊ ဒါက Jevons paradox ပါ။ Padauk လည်း ချွေတာတဲ့ အချိန်နဲ့ SLO မရှိသေးတဲ့ service တွေကို SLO ထည့်ပါတယ်။ senior တွေ သတိကြီးတာ အကြောင်း ရှိလို့ အတင်း မခိုင်းဘဲ dry run မှတ်တမ်းလို အထောက်အထားနဲ့ ယုံလာအောင် လုပ်ပါတယ်။
> tool တွေ ပြောင်းသွားလည်း အမြဲ စစ်တာ၊ AI ကိုယ်တိုင် reliable ဖြစ်တာ၊ လုပ်ခွင့်ကို တစ်ဆင့်ချင်း ပေးတာနဲ့ AI က လူကို ကူညီတာကတော့ ကျန်နေမှာပါ။

On screen:

- l28_p03 (K2): လူတွေ အခု ဘာလုပ်လဲ | ပန်းတိုင်နဲ့ ကန့်သတ်ချက် သတ်မှတ် | အထောက်အထား စစ်၊ approve၊ ရပ် | ခက်တဲ့ ပြဿနာ အသစ်တွေကို ယူ
- l28_p03b (K4): SRE အလုပ် မနည်းသွားဘူး | Jevons paradox: ဈေးသက်သာရင် ပိုသုံး | senior: သတိကြီးတာ အကြောင်းရှိ | ယုံကြည်မှု: အတင်း မဟုတ်၊ အထောက်အထား

## Scene 9 · This week

chapter: —

> ⟪page l28_p04⟫ AI helper တစ်ခုကို ကိုယ့် production နဲ့ ချိတ်ဖို့ စဉ်းစားနေရင် ဒီအပတ် ဒီ သုံးခုကနေ စပါ။ AI helper ကို read-only access ပဲ ပေးပါ။ သူ ဘယ်တော့မှ မလုပ်ရမယ့် action တွေကို စာရင်း ချရေးပါ။ ပြီးတော့ ဘာ လုပ်ခွင့်မှ မပေးခင် stop button ကို အရင် ဆောက်ပါ။

On screen:

- l28_p04 (K2): ဒီအပတ် လုပ်စရာ | AI helper ကို read-only ပဲ ပေးပါ | ဘယ်တော့မှ မလုပ်ရမယ့် action ရေးပါ | stop button ကို အရင် ဆောက်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ Ops Buddy ကို ဘေးကင်းအောင် ထားတဲ့ နည်းတွေပါ။ ⟪select action card⟫ action card က action တစ်ခုချင်းရဲ့ လုပ်ခွင့်၊ undo လုပ်နည်းနဲ့ ရပ်ရမယ့် အခြေအနေကို ရေးထားတဲ့ ကတ်ပါ။ ⟪select budget နှစ်ခု⟫ budget နှစ်ခုမှာ service ရဲ့ error budget ကုန်ရင် Ops Buddy က အကြံပဲ ပေးပြီး safety budget ကုန်ရင် ရပ်ပါတယ်။
> ⟪select stop button⟫ stop button က on-call ဘယ်သူမဆို ချက်ချင်း နှိပ်လို့ရတဲ့ ဘရိတ်ပါ။ ⟪select undo လုပ်လို့ရတဲ့ action⟫ undo လုပ်လို့ရတဲ့ action က မကောင်းရင် အလိုအလျောက် ပြန် undo လုပ်တဲ့ action အသေးလေးပါ။ ⟪select dry run⟫ dry run ကတော့ တကယ် မပြောင်းဘဲ လုပ်မယ့်ဟာကိုပဲ မှတ်တမ်းတင်တာပါ။
> ⟪select မေးခွန်း⟫ card ကို ကိုယ်တိုင် ဖြည့်ကြည့်ပါ။ Ops Buddy လုပ်ချင်တဲ့ action တစ်ခုကို ဘယ်လို undo လုပ်ရမလဲ ဘယ်သူမှ မသိဘူး ဆိုရင် သူ့ action card မှာ ဘာ ရေးမလဲ?
> ⟪pause 3s⟫ ဘယ်တော့မှ မလုပ်ရဘူးလို့ ရေးပါတယ်၊ အဲဒီ action က လူတွေ လက်ထဲမှာပဲ ကျန်ပါတယ်။ ဘရိတ်တွေ ရှိလာပြီ ဆိုတော့ AI က တကယ် ဘယ်မှာ ကူညီလဲ? သောကြာနေ့ promo တစ်ခုမှာ dashboard က ၉၉.၇ ရာခိုင်နှုန်း အောင်မြင်တယ်လို့ ပြနေပေမဲ့ Facebook မှာ ဒေါသထွက်နေတဲ့ comment တွေ ပြည့်နေပါတယ်။ alert ဘာလို့ မတက်ခဲ့တာလဲ?

On screen:

- notes.md: # AI ကို production ထဲ ဘေးကင်းကင်း ထည့်ခြင်း | (blank line) | - action card — action တစ်ခုချင်း: လုပ်ခွင့် · undo နည်း · ရပ်ရမယ့် အခြေအနေ | - budget နှစ်ခု — service budget ကုန်: အကြံပဲ · safety budget ကုန်: ရပ် | - stop button — on-call ဘယ်သူမဆို ချက်ချင်း နှိပ်လို့ရတဲ့ ဘရိတ် | - undo လုပ်လို့ရတဲ့ action — သေးပြီး မကောင်းရင် အလိုအလျောက် ပြန် undo | - dry run — တကယ် မပြောင်းဘဲ လုပ်မယ့်ဟာကို မှတ်တမ်းတင် | (blank line) | မေးခွန်း: undo နည်း ဘယ်သူမှ မသိတဲ့ action။ Ops Buddy ရဲ့ action card မှာ ဘာ ရေးမလဲ?
