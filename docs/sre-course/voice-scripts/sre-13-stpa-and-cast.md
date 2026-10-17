# Lesson 13 · Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST

slug: sre-13-stpa-and-cast · budget: 8400 characters (±5%)

## Scene 1 · Hook: nothing broke, 2,800 wallets froze

chapter: ဘာမှ မပျက်ဘဲ ပိတ်ခံရတဲ့ wallet တွေ

> ⟪page l13_p01⟫ Padauk က အခု ပုံမှန်လို့ ခေါ်နေတဲ့ ဖြတ်လမ်းတွေကို သုံးလ တစ်ခါ ပြန်စစ်နေပြီး Bank X throttle ကိုလည်း tool ဖြစ်အောင် ဆောက်ထားပါပြီ။ ဒီလ လစာထုတ်ရက် မနက်၊ အထည်ချုပ် စက်ရုံ တစ်ခုက payroll feature အသစ်နဲ့ အလုပ်သမား ၃၀၀၀ ရဲ့ wallet တွေထဲ လစာ ထည့်ပါတယ်။
> ⟪page l13_p01b⟫ မိနစ်ပိုင်းအတွင်း wallet ၂၈၀၀ ပိတ်ခံလိုက်ရလို့ အလုပ်သမားတွေ နေ့လယ်စာ ဝယ်လို့ မရ၊ ရွာကို ငွေ ပို့လို့ မရ ဖြစ်ကုန်ပါတယ်။ ဒါပေမဲ့ ပျက်နေတာ ဘာမှ မရှိပါဘူး၊ payroll batch ရော လိမ်လည်တဲ့ ငွေလွှဲတွေကို ပိတ်ပေးတဲ့ fraud engine ရော design အတိုင်း အလုပ်လုပ်ခဲ့တာပါ။ ဒီတစ်ခါ root cause က ဘယ်မှာလဲ?

On screen:

- l13_p01 (K1): 13 | Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST | ဘာမှ မပျက်ဘဲ wallet 2,800 ပိတ်ခံရ | payroll: design အတိုင်း · fraud engine: design အတိုင်း | နှစ်ခု ဆုံတော့ လစာထုတ်ရက်မှာ လစာ သုံးမရ | ဒီတစ်ခါ root cause က ဘယ်မှာလဲ? | (small loop badge, သင်ယူ lit)
- l13_p01b (K7): လစာထုတ်ရက် မနက် | 2,800 / 3,000 | wallet ပိတ်ခံရ၊ ပျက်တာ ဘာမှ မရှိ

## Scene 2 · Worked as designed: before is not because

chapter: အရင်ဖြစ်တာ အကြောင်းရင်း မဟုတ်

> ⟪close page⟫ ⟪board B1 step 1⟫ မသီရိက အပိုင်း တစ်ခုချင်းကို အရင် ကြည့်တော့ payroll batch က test အားလုံး အောင်ထားပါတယ်။ fraud engine မှာလည်း အကောင့်အသစ်က wallet အများကြီးဆီ ငွေ ရုတ်တရက် လွှဲရင် လက်ခံတဲ့ wallet တွေကို ခဏ ပိတ်ထားတဲ့ rule အသစ် ရှိပါတယ်၊ နှစ်ခုလုံးမှာ bug မရှိပါဘူး။
> ⟪board B1 step 2⟫ ဒါပေမဲ့ နှစ်ခု ဆုံတော့ fraud engine အမြင်မှာ စက်ရုံက wallet ထောင်ချီဆီ တစ်ပြိုင်နက် ငွေလွှဲတဲ့ အကောင့်အသစ် ဖြစ်နေလို့ လစာက လိမ်တဲ့ ပုံစံနဲ့ တူနေတာပါ။ လစာ သုံးမရတာလို user တွေ လက်မခံနိုင်တဲ့ ဆုံးရှုံးမှုကို loss လို့ ခေါ်ပါတယ်၊ အပိုင်းတိုင်း မှန်နေရက်နဲ့ loss ဖြစ်တာမို့ safety ဆိုတာ အပိုင်းတွေ ဆက်ဆံရာကနေ ပေါ်လာတာပါ။
> ⟪board B1 step 3⟫ postmortem မှာ တစ်ယောက်က fraud rule ကို ရှေ့နေ့ ကြာသပတေးမှာ ထည့်ခဲ့လို့ အဲဒါ root cause ပဲလို့ ပြောပါတယ်။ ဒါပေမဲ့ rule က ကြာသပတေး တစ်နေ့လုံး ပြဿနာ မပေးခဲ့ပါဘူး။ timeline က ဘာ အရင် ဖြစ်လဲ ပြပေမဲ့ အရင် ဖြစ်တာတိုင်း အကြောင်းရင်း မဟုတ်ပါဘူး။
> ⟪board B1 step 4⟫ ဒါကြောင့် root cause ဆိုတာ မေးတာ ရပ်လိုက်တဲ့ နေရာ သက်သက်ပါ။ safety ပညာရှင် Nancy Leveson ရဲ့ STAMP model ကလည်း loss တွေကို အပိုင်း ပျက်လို့ထက် ဆက်ဆံပုံကို control မလုံလောက်လို့ ဖြစ်တယ်လို့ ကြည့်ပြီး လူ ဒါမှမဟုတ် software ရဲ့ အမှားကို လက္ခဏာ အဖြစ်ပဲ မြင်ပါတယ်။

On screen:

- B1 step (1), cleared: payroll batch (blue box, left) | fraud engine (blue box, right) | design အတိုင်း (a green check under each box, one green label)
- B1 step (2): (an arrow-down from each box) | ပိတ်ခံရတဲ့ wallet 2,800 (red box below, centred)
- B1 step (3): (short P8 strip under the red box: underline axis, two ticks) | fraud rule: ကြာသပတေး | payroll: သောကြာ | အရင်ဖြစ်တာ ≠ အကြောင်းရင်း (orange text)
- B1 step (4): STAMP: ပျက်လို့ မဟုတ်၊ control မလုံလောက်လို့ (violet text at the bottom)

## Scene 3 · A control loop

chapter: Control loop

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို control ဆိုတာ ဘာလဲ? တစ်ခုခုကို ထိန်းတဲ့ လူ ဒါမှမဟုတ် program ကို controller လို့ ခေါ်ပြီး သူ ပို့တဲ့ command ကို control action လို့ ခေါ်ပါတယ်။ ဒီမှာတော့ fraud engine က controller ဖြစ်ပြီး wallet ပိတ်တာက သူ့ action ပါ။
> ⟪board B2 step 2⟫ action က ထိန်းခံရတဲ့ process ကို ပြောင်းပါတယ်၊ ဒီမှာတော့ wallet တွေပါ။ ရလဒ်ကို ပြန်ပြောပြတဲ့ dashboard လို signal က feedback ဖြစ်ပြီး controller က အဲဒါကို ကြည့်ပြီး နောက် action ကို ဆုံးဖြတ်ပါတယ်။ ဒီ စက်ဝိုင်းက control loop ပါ၊ bug ရှိနေရင်တောင် process ကို ဘေးကင်းတဲ့ ဘောင်ထဲမှာ ထိန်းထားပေးပါတယ်။
> ⟪board B2 step 3⟫ controller တိုင်းမှာ process အကြောင်း ယုံကြည်ချက် တစ်ခု ရှိပါတယ်။ fraud engine က အကောင့်အသစ်က ငွေ အများကြီး လွှဲရင် လိမ်တာပဲလို့ ယုံထားပြီး လစာ ဆိုတာ သူ့ ယုံကြည်ချက်ထဲမှာ မရှိခဲ့ပါဘူး။ ယုံကြည်ချက် မှားရင် logic မှန်နေရင်တောင် action မှားတာပါပဲ။

On screen:

- B2 step (1), cleared (P3 ring: one large ellipse as the track, arrow-right on the top arc): controller / fraud engine (blue node, two lines) | action / wallet ပိတ် (node, two lines)
- B2 step (2) (arrow-down on the right arc): process / wallet တွေ (node, two lines) | feedback / dashboard (node on the way back to the controller, two lines)
- B2 step (3): ယုံကြည်ချက် (မှားနိုင်) (orange ellipse on the controller node)

## Scene 4 · Every controller has…

chapter: —

> ⟪close board⟫ ⟪page l13_p02⟫ ဘယ် controller ကိုမဆို နားလည်ချင်ရင် သူ့ တာဝန်နဲ့ ဆုံးဖြတ်တဲ့ စည်းမျဉ်း၊ မှားနိုင်တဲ့ ယုံကြည်ချက်နဲ့ အဲဒါကို ပြင်ပေးတဲ့ feedback ဆိုတဲ့ သုံးခုကို ကြည့်ပါ၊ ယုံကြည်ချက်က feedback ကောင်းသလောက်ပဲ မှန်ပါတယ်။
> ⟪page l13_p02b⟫ ဥပမာ Operator A နှေးလို့ on-call က traffic တစ်ဝက်ကို Operator B ဆီ လွှဲတယ် ဆိုပါစို့။ dashboard က ၂ မိနစ် နောက်ကျနေလို့ လွှဲတာ မရသေးဘူး ထင်ပြီး ကျန်တာပါ ထပ်လွှဲလိုက်တော့ Operator B ပါ နှေးသွားပါတယ်၊ logic မှန်ပေမဲ့ feedback နောက်ကျခဲ့တာပါ။
> automation များလာလေ အခက်ဆုံး case တွေက လူဆီ ရောက်လာလေပါပဲ၊ မှားပြီး ပိတ်ခံရတဲ့ wallet တွေကို support က ပြန်ဖွင့်ရသလိုပါ။ ဒါကြောင့် control loop ဆွဲရင် လူတွေကိုလည်း controller အဖြစ် ထည့်ဆွဲရပါတယ်။

On screen:

- l13_p02 (K4): controller တိုင်းမှာ ရှိတာ | တာဝန်: ဆုံးဖြတ်တဲ့ စည်းမျဉ်း | ယုံကြည်ချက်: မှားနိုင်တယ် | feedback: ယုံကြည်ချက်ကို ပြင်ပေး
- l13_p02b (K2): on-call က traffic လွှဲတော့ | dashboard က 2 မိနစ် နောက်ကျ | logic မှန်၊ feedback နောက်ကျ | ခက်တဲ့ case တွေ လူဆီ ရောက်

## Scene 5 · STPA in four steps

chapter: STPA အဆင့် လေးဆင့်

> ⟪page l13_p03⟫ payroll ရဲ့ design doc ကို ရေးတုန်းက လစာ ဝင်လာရင် wallet ပေါ်မှာ တခြား ဘယ် controller တွေ action လုပ်မလဲ၊ သူတို့ ဘာကို ယုံထားလဲလို့ မေးခဲ့ရင် ဒီ ပြဿနာကို စာရွက်ပေါ်မှာတင် တွေ့နိုင်ခဲ့မှာပါ။ ဒီလို incident မဖြစ်ခင် ကြိုရှာတဲ့ နည်းက System-Theoretic Process Analysis၊ အတိုကောက် STPA ပါ၊ အဆင့် လေးဆင့် ရှိပါတယ်။
> ⟪page l13_p03b⟫ ပထမ အဆင့်မှာ loss တွေနဲ့ အဲဒီဆီ ဦးတည်နိုင်တဲ့ အန္တရာယ်ရှိတဲ့ အခြေအနေ၊ hazard တွေကို ရေးပါတယ်။ ဒုတိယ အဆင့်မှာ ဘယ်သူက ဘာကို ထိန်းပြီး ဘယ် feedback ပြန်ရလဲ ဆိုတဲ့ ပုံ၊ control structure ကို ဆွဲပါတယ်။
> ⟪page l13_p03c⟫ တတိယ အဆင့်မှာ hazard ဖြစ်စေနိုင်တဲ့ action တွေ၊ unsafe control action တွေကို ရှာပါတယ်။ လုပ်သင့်ရဲ့နဲ့ မလုပ်တာ၊ မလုပ်သင့်ဘဲ လုပ်တာ၊ စောလွန်းတာ ဒါမှမဟုတ် နောက်ကျလွန်းတာ၊ ကြာလွန်းတာ ဒါမှမဟုတ် စောစော ရပ်သွားတာ ဆိုပြီး လေးမျိုး ရှိပါတယ်။
> ⟪page l13_p03d⟫ စတုတ္ထ အဆင့်မှာတော့ အဲဒီ action တွေ ဘာကြောင့် ဖြစ်နိုင်လဲ ရေးပါတယ်၊ ဥပမာ feedback နောက်ကျတာ၊ ပျောက်တာ၊ ယုံကြည်ချက် မှားတာတွေပါ။ run နေတဲ့ system ပေါ်မှာလည်း STPA လုပ်လို့ရပါတယ်။

On screen:

- l13_p03 (K6): STPA လေးဆင့် | loss နဲ့ hazard | control structure | unsafe control action | ဘာကြောင့် ဖြစ်နိုင်လဲ | (caption) incident မဖြစ်ခင်၊ design doc ပေါ်မှာတင်
- l13_p03b (K2): အဆင့် 1 နဲ့ 2 | loss: လက်မခံနိုင်တဲ့ ဆုံးရှုံးမှု | hazard: loss ဆီ ဦးတည်တဲ့ အခြေအနေ | control structure: ဘယ်သူ ဘာကို ထိန်းလဲ
- l13_p03c (K5): action အန္တရာယ်ရှိပုံ လေးမျိုး | မလုပ်: လုပ်သင့်ရဲ့နဲ့ | လုပ်: မလုပ်သင့်ဘဲ | အချိန်: စောလွန်း၊ နောက်ကျလွန်း | ကြာချိန်: ကြာလွန်း၊ စောစော ရပ်
- l13_p03d (K2): အဆင့် 4: ဘာကြောင့် ဖြစ်နိုင်လဲ | feedback နောက်ကျ ဒါမှမဟုတ် ပျောက် | ယုံကြည်ချက် မှား | run နေတဲ့ system မှာလည်း လုပ်လို့ရ

## Scene 6 · STPA on the refund design

chapter: Refund design ကို ကြိုစစ်

> ⟪close page⟫ ⟪board B3 step 1⟫ Top-up အဖွဲ့ကလည်း operator ၁၀ မိနစ်အတွင်း အတည်မပြုရင် auto-refund job က ငွေ ပြန်အမ်းမယ့် design doc ယူလာပါတယ်။ မသီရိ၊ Top-up developer တစ်ယောက်နဲ့ support lead မစုတို့ တစ်မနက်လောက် STPA လုပ်ကြည့်တော့ ငွေဝင်ငွေထွက် စာရင်း၊ ledger ပေါ်မှာ refund ပေးနိုင်တဲ့ controller နှစ်ခု တွေ့ပါတယ်၊ support agent နဲ့ job ပါ။
> ⟪board B3 step 2⟫ ဒီ design မှာတော့ loss က ငွေ ဆုံးတာ ဖြစ်ပြီး hazard က wallet balance နဲ့ operator ဘက်မှာ တကယ် ဖြစ်ခဲ့တာ မကိုက်တာပါ။ job ရဲ့ feedback ဖြစ်တဲ့ success callback ကလည်း traffic များတဲ့ ညနေတွေမှာ နောက်ကျတတ်ပါတယ်။
> ⟪board B3 step 3⟫ ဒီတော့ unsafe control action နှစ်ခု ထွက်လာပါတယ်။ job က callback မလာရင် fail တာပဲလို့ ယုံထားလို့ callback နောက်ကျရင် အောင်မြင်ပြီးသား top-up ကို refund ပေးမိတာနဲ့ support ရော job ရော refund လုပ်လို့ နှစ်ခါ ပြန်အမ်းမိတာပါ။
> ⟪board B3 step 4⟫ design doc မှာ ပြင်တာကတော့ refund မပေးခင် status ကို အရင် စစ်မယ်၊ refund ကို job ကပဲ ပေးပြီး support က တောင်းဆိုရုံပဲ လုပ်မယ်၊ refund တစ်ခုကို တစ်ခါပဲ ဖြစ်အောင် idempotency key ထည့်မယ် ဆိုတာတွေပါ။
> ⟪board B3 step 5⟫ balance မကိုက်တဲ့ hazard ပေါ်တာနဲ့ alert တက်အောင်လည်း ထားလို့ loss တကယ် မဖြစ်ခင် သိရပါမယ်။ design doc မှာ စာပိုဒ် အနည်းငယ်ပဲ ကုန်ပေမဲ့ production ရောက်မှ ပြင်ရရင်တော့ အဖွဲ့ တစ်ဖွဲ့လုံး လိုပြီး ledger data တွေကိုပါ လိုက်ပြင်ရပါတယ်။

On screen:

- B3 step (1), cleared: support agent | auto-refund job (two boxes on top, each with an arrow-down) | wallet ledger (box below both)
- B3 step (2): operator callback (box on the right, with an arrow-down) | feedback နောက်ကျ (orange label beside the arrow)
- B3 step (3): refund ပေးပြီးမှ success ရောက် (red tag on the job) | နှစ်ခုလုံး refund (red tag between the two controllers)
- B3 step (4), cleared (the step 1–2 structure redrawn as furniture): status ကို အရင် စစ် | refund ပေးသူ တစ်ခုတည်း | idempotency key (green labels)
- B3 step (5): alert: balance မကိုက် (orange box beside the ledger)

## Scene 7 · CAST on the frozen wallets

chapter: ပိတ်ခံရတဲ့ wallet တွေအပေါ် CAST

> ⟪close board⟫ ⟪board B4 step 1⟫ ပိတ်ခံရတဲ့ wallet တွေလို ဖြစ်ပြီးသွားတဲ့ incident ကိုတော့ Causal Analysis based on Systems Theory၊ အတိုကောက် CAST နဲ့ ပြန်ခွဲပါတယ်၊ ဘယ်သူ မှားလဲ မမေးဘဲ control တွေ ဘာလို့ မတားနိုင်ခဲ့လဲ မေးတာပါ။ မသီရိက org chart အတိုင်း မဟုတ်ဘဲ အဲဒီနေ့က တကယ် အလုပ်လုပ်ခဲ့တဲ့ structure ကို ဆွဲပါတယ်။
> ⟪board B4 step 2⟫ support မှာ wallet အများကြီးကို တစ်ခါတည်း ပြန်ဖွင့်တဲ့ tool မရှိသလို on-call ကို ခေါ်တဲ့ လမ်းလည်း မရှိခဲ့ပါဘူး။ on-call မှာလည်း wallet ပိတ်တာ များလာရင် တက်မယ့် alert မရှိလို့ Facebook post တွေ ပြန့်လာမှ သိခဲ့ပါတယ်။
> ⟪board B4 step 3⟫ ပုံ ဆွဲလိုက်တော့ payroll နဲ့ fraud rule တွေ ဆက်ဆံပုံကို ဘယ်သူ ပိုင်လဲ ဆိုတဲ့ မေးခွန်း ပေါ်လာပါတယ်၊ ဘယ်သူမှ မပိုင်ပါဘူး။ ပိုင်ရှင် မရှိတဲ့ နေရာ၊ ပိုင်ရှင် ထပ်နေတဲ့ နေရာတွေမှာ အကြောင်းရင်းတွေ ပုန်းနေတတ်ပါတယ်။
> ⟪board B4 step 4⟫ fraud dashboard ကလည်း ပိတ်လိုက်တဲ့ ၂၈၀၀ ကို အောင်မြင်မှုလို့ ရေတွက်ခဲ့ပါတယ်။ feedback က မှားတဲ့ အရာကို တိုင်းနေလို့ fraud အဖွဲ့က rule ကောင်းနေတယ်လို့ပဲ ယုံခဲ့ကြတာပါ။

On screen:

- B4 step (1), cleared (P1 flow, three boxes left to right): payroll batch → fraud engine → ပိတ်ခံရတဲ့ wallet (red)
- B4 step (2): support: အစုလိုက် ပြန်ဖွင့်တဲ့ tool မရှိ / on-call လမ်း မရှိ (red text under the flow, two lines) | on-call: wallet ပိတ်တာ alert မရှိ (red text, one line)
- B4 step (3): payroll × fraud rule: ဘယ်သူ ပိုင်လဲ? ဘယ်သူမှ (orange, between the first two boxes)
- B4 step (4): fraud dashboard: "ပိတ်တာ 2,800" = အောင်မြင်? (orange, above the fraud engine box)

## Scene 8 · CAST, step by step

chapter: —

> ⟪close board⟫ ⟪page l13_p04⟫ CAST မှာ အဆင့် ငါးဆင့် ရှိပါတယ်။ ပထမ အဆင့်မှာ loss နဲ့ hazard ကို ရေးပြီး timeline ကိုတော့ မေးခွန်း ထုတ်ဖို့ပဲ သုံးပါတယ်၊ ဥပမာ fraud အဖွဲ့က payroll launch ကို ဘာလို့ မသိခဲ့လဲ ဆိုတာမျိုးပါ။ အပြစ်လည်း မရှာ၊ အဖြေလည်း မချသေးပါဘူး။ ဒုတိယ အဆင့်က ခုနက ဆွဲခဲ့တဲ့ structure ပါ။
> ⟪page l13_p04b⟫ တတိယ အဆင့်မှာ controller တစ်ခုချင်း လုပ်ခဲ့တာ အဲဒီအချိန်က ဘာကြောင့် အဓိပ္ပာယ် ရှိခဲ့လဲ ရှာပါတယ်။ fraud အဖွဲ့က လိမ်တာ များလာတာ မြင်ခဲ့ပြီး payroll အဖွဲ့ကလည်း သေချာ test လုပ်ခဲ့ပါတယ်။ ဆုံးဖြတ်ချက်ကို ပုံသွင်းခဲ့တဲ့ ယုံကြည်ချက်၊ feedback၊ အချိန် ဖိအားတွေကို မပြင်ဘဲ လူကိုပဲ လဲရင် နောက်လူလည်း ဒီလိုပဲ ဆုံးဖြတ်မှာပါ။
> ⟪page l13_p04c⟫ စတုတ္ထ အဆင့်မှာ controller အားလုံးကို ထိတဲ့ အချက်တွေ ရှာပါတယ်၊ ဥပမာ launch တိုင်းမှာ ဒီ wallet ပေါ် တခြား ဘယ်သူ action လုပ်လဲလို့ မေးတဲ့ review မရှိတာပါ။ engineer ၄၀ လောက် ရှိလာတော့ launch တိုင်းကို လူတိုင်း မသိတော့ဘဲ control တွေ တဖြည်းဖြည်း အားနည်းသွားတာပါ။
> ⟪page l13_p04d⟫ ပဉ္စမ အဆင့်မှာ အကြံပြုချက် တိုင်းကို တွေ့ခဲ့တဲ့ အချက်ဆီ ပြန်ချိတ်ပြီး ဒီ incident ကိုပဲ တားမှာလား၊ ဆင်တူ incident တွေကိုပါ တားမှာလားလို့ မေးပါတယ်။ rule ကနေ စက်ရုံကို ချန်တာ၊ ပြန်ဖွင့်တဲ့ ခလုတ် ထည့်တာလို local fix တွေက လက္ခဏာကိုပဲ ကုလို့ rule တွေ ဆက်ဆံပုံ ဘယ်သူ ပိုင်မလဲ၊ support က on-call ကို ဘာလို့ မခေါ်နိုင်ခဲ့လဲလို့ ဆက်မေးရပါတယ်။

On screen:

- l13_p04 (K6): CAST အဆင့်ဆင့် | loss နဲ့ မေးခွန်း | တကယ့် structure | တစ်ခုချင်းရဲ့ အကြောင်း | ဘုံ အချက် | ပြန်ချိတ်တဲ့ plan | (caption) အပြစ်မရှာ၊ အဖြေ မချသေး
- l13_p04b (K2): အဲဒီအချိန်က အဓိပ္ပာယ် ရှိခဲ့ | fraud အဖွဲ့: လိမ်တာ များလာတာ မြင် | payroll အဖွဲ့: ကိုယ့် feature ကို test | လူ လဲရင် နောက်လူလည်း ဒီလိုပဲ
- l13_p04c (K2): controller အားလုံးကို ထိတဲ့ အချက် | launch မှာ တခြား controller တွေကို မမေး | engineer 40: launch တိုင်းကို လူတိုင်း မသိ | ကြီးလာရင် control အားနည်း
- l13_p04d (K3, left gray / right teal; cells as left / right): local fix / system မေးခွန်း | rule ကနေ စက်ရုံကို ချန် / rule ဆက်ဆံပုံ ဘယ်သူ ပိုင်? | ပြန်ဖွင့်တဲ့ ခလုတ် / support က on-call ဘာလို့ မခေါ်နိုင်?

## Scene 9 · The shift

chapter: ကြိုကြည့်တဲ့ အမြင်

> ⟪page l13_p05⟫ ဒီ incident နောက် Padauk ရဲ့ အမြင် ပြောင်းသွားပါတယ်။ root cause တစ်ခုကို ရှာမယ့်အစား အချက်တွေနဲ့ structure ကို ပြင်ပြီး၊ လူကို အပြစ်မရှာတဲ့ blameless ဖြစ်ရုံ မကဘဲ ဆုံးဖြတ်ချက်ကို ဘာက ပုံသွင်းခဲ့လဲ စနစ်တကျ ခွဲပါတယ်။ ပျက်ပြီးမှ မြန်မြန် တုံ့ပြန်ရုံနဲ့လည်း မရပ်ဘဲ loss တွေကို ကြိုစာရင်းလုပ်ပြီး အဆိုးဆုံးကို အရင် ပြင်ပါတယ်။
> ⟪page l13_p05b⟫ fault injection test တွေက တစ်ခုခုကို တမင် ပျက်အောင် လုပ်ပြီးမှ စပေမဲ့ STPA က ဘာမှ မပျက်ဘဲ ဖြစ်တဲ့ loss တွေကို ရှာပြီး နောက် ဘယ် test လုပ်ရမလဲ ဆိုတာကိုပါ ပြပေးပါတယ်၊ lesson ၁၉ မှာ ပြန်တွေ့ရပါမယ်။ incident ပြီးရင် CAST က ပိုသက်သာပြီး STPA က ပိုကျယ်ပါတယ်။ စချင်ရင် လူ နှစ်ယောက် သုံးယောက်၊ design doc တစ်ခုနဲ့ အရင်က မထင်မှတ်ဘဲ ပြဿနာ ပေးခဲ့ဖူးတဲ့ system ကနေ စပါ။

On screen:

- l13_p05 (K3, left gray / right teal; cells as left / right): အရင် / အခု | root cause ရှာ / အချက်နဲ့ structure ပြင် | blameless / blameless + စနစ်တကျ ခွဲ | မြန်မြန် တုံ့ပြန် / loss စာရင်း၊ အဆိုးဆုံး အရင်
- l13_p05b (K2): ဘယ်လို စမလဲ | STPA က ဘယ် fault test လုပ်ရမလဲ ပြ | incident ပြီးရင် CAST က သက်သာ | လူ 2–3 ယောက်၊ design doc တစ်ခု

## Scene 10 · This week

chapter: —

> ⟪page l13_p06⟫ ဒီအပတ် postmortem နဲ့ design doc တွေကို မျက်လုံးအသစ်နဲ့ ကြည့်ပါ။ postmortem တစ်ခုကို ဖတ်ပြီး ဘယ်နေရာမှာ မေးတာ ရပ်သွားလဲ ရှာကြည့်ပါ။ ကိုယ့် system ထဲက control loop တစ်ခုကို ယုံကြည်ချက် ပါအောင် ဆွဲကြည့်ပါ။ ပြီးတော့ review လုပ်နေတဲ့ design doc တစ်ခုပေါ်မှာ STPA ကို စမ်းကြည့်ပါ။

On screen:

- l13_p06 (K2): ဒီအပတ် လုပ်စရာ | postmortem တစ်ခု: ဘယ်မှာ ရပ်ခဲ့လဲ? | control loop တစ်ခု ဆွဲပါ | design doc ပေါ်မှာ STPA စမ်းပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ ဒီ စကားလုံးတွေက control loop ကနေ လာတာပါ။ ⟪select control loop⟫ control loop က action လုပ်၊ feedback ပြန်ရပြီး ယုံကြည်ချက်ကို ပြင်တဲ့ စက်ဝိုင်းပါ။ ⟪select hazard⟫ hazard က loss ဆီ ဦးတည်နေတဲ့ အခြေအနေမို့ alert ထားဖို့ ကောင်းတဲ့ နေရာပါ။ ⟪select unsafe control action⟫ unsafe control action ကတော့ hazard ဖြစ်စေတဲ့ action ပါ။
> ⟪select STPA⟫ STPA က incident မဖြစ်ခင် design ပေါ်မှာ ကြိုရှာတာ ဖြစ်ပြီး၊ ⟪select CAST⟫ CAST ကတော့ ဖြစ်ပြီးမှ တကယ့် structure နဲ့ ပြန်ခွဲတာပါ။ ⟪select မေးခွန်း⟫ fraud dashboard က ပိတ်လိုက်တဲ့ ၂၈၀၀ ကို သတင်းကောင်းလို့ ပြခဲ့ပါတယ်။ control loop ရဲ့ ဘယ်အပိုင်း မှားခဲ့တာလဲ?
> ⟪pause 3s⟫ feedback ပါ၊ ပိတ်တဲ့ အရေအတွက်ကိုပဲ ရေတွက်ပြီး ပိတ်ခံရတဲ့သူတွေ တကယ် လိမ်တာလား မတိုင်ခဲ့လို့ပါ။ ဒီ incident တွေမှာ reliability ဘက်ကို ထမ်းခဲ့ရတာ မသီရိ တစ်ယောက်တည်းပါ။ Padauk က ဘယ်လို လူမျိုးကို ခန့်ရမလဲ၊ လူသစ်တွေကရော ဘေးကင်းကင်း ဘယ်လို သင်ယူကြမလဲ?

On screen:

- notes.md: # Root cause ထက် ပိုကြည့်တဲ့ STPA နဲ့ CAST | (blank line) | - control loop — controller → action → process → feedback → ယုံကြည်ချက် ပြင် | - hazard — loss မဖြစ်သေးပေမဲ့ အဲဒီဆီ ဦးတည်တဲ့ အခြေအနေ၊ alert ထားစရာ | - unsafe control action — hazard ဖြစ်စေတဲ့ action: မလုပ် · မှားလုပ် · အချိန်မှား · ကြာချိန်မှား | - STPA — incident မဖြစ်ခင် design ပေါ်မှာ ကြိုရှာ | - CAST — incident ပြီးမှ တကယ့် structure နဲ့ ပြန်ခွဲ | (blank line) | မေးခွန်း: fraud dashboard က "ပိတ်တာ 2,800" ကို သတင်းကောင်းလို့ ပြခဲ့တယ်။ control loop ရဲ့ ဘယ်အပိုင်း မှားခဲ့လဲ?
