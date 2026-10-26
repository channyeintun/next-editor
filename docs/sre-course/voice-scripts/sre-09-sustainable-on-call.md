# Lesson 09 · ရေရှည် လုပ်နိုင်တဲ့ on-call

slug: sre-09-sustainable-on-call · budget: 7600 characters (±5%)

## Scene 1 · Hook + map: Who answers at 2 a.m.?

chapter: မနက် 2 နာရီ ဘယ်သူ ဖြေမလဲ

> ⟪page l09_p01⟫ Padauk ရဲ့ alert တွေကို အခု ယုံလို့ရပါပြီ၊ user အဆင့် check တွေနဲ့ အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert တွေ ရှိလာလို့ပါ။ ဒါပေမဲ့ တစ်ည မနက် ၂ နာရီမှာ Wallet ရဲ့ alert တက်လာတော့ လူ ၆၀ ရှိတဲ့ Viber group ထဲ ရောက်သွားပြီး အဲဒီ group ကို လူတိုင်းက အသံပိတ်ထားကြပါတယ်။
> ဘယ်သူမှ မဖြေလို့ Bank X ဆီ ငွေလွှဲတာတွေ မနက်အထိ fail နေခဲ့ပါတယ်။ မနက်ကျတော့ support lead မစုက လုပ်နေကျအတိုင်း CTO ကိုနေလင်းကိုပဲ ဖုန်းဆက်ပါတယ်။ ဒါဆို မနက် ၂ နာရီမှာ ဘယ်သူ ဖြေမလဲ?
> ⟪page m3_map⟫ Module ၃ မှာ reliability loop ရဲ့ တုံ့ပြန်တဲ့ အဆင့်နဲ့ သင်ယူတဲ့ အဆင့်ကို ဖြတ်သွားပါမယ်။ Padauk မှာ engineer ၄၀ လောက် ရှိပေမဲ့ reliability ကို အချိန်ပြည့် ကြည့်တာ မသီရိ တစ်ယောက်တည်းမို့ product အဖွဲ့တိုင်းက ကိုယ့် service ရဲ့ on-call ကို ကိုယ် ယူရပါမယ်။

On screen:

- l09_p01 (K1): 9 | ရေရှည် လုပ်နိုင်တဲ့ on-call | alert တွေ Viber group ထဲက လူ 60 ဆီ | လူတိုင်းက အသံပိတ်ထား | ဖုန်းတိုင်း CTO ဆီ ရောက် | မနက် 2 နာရီ ဘယ်သူ ဖြေမလဲ? | (small loop badge, တုံ့ပြန် lit)
- m3_map (K8): Module 3 · တုံ့ပြန်၊ သင်ယူ | ပျက်တဲ့အခါ: on-call နဲ့ incident | ပြီးတဲ့နောက်: သင်ယူပြီး system ကို ပြောင်း | (the Padauk loop, တုံ့ပြန် and သင်ယူ lit)

## Scene 2 · Bug, incident, outage

chapter: Bug၊ incident၊ outage

> ⟪close page⟫ ⟪board B1 step 1⟫ မသီရိက Viber group ကို ပြန်ဖတ်ကြည့်တော့ ပြဿနာ သုံးမျိုး ရောနေတာ တွေ့ရပါတယ်။ user ဒါမှမဟုတ် business ကို ထိခိုက်နေလို့ စနစ်တကျ ညှိပြီး တုံ့ပြန်ရမယ့် ပြဿနာက incident ပါ။ အဲဒီထဲက Wallet ငွေလွှဲ လုံးဝ မရတာလို service ဒါမှမဟုတ် အရေးကြီး feature တစ်ခု သုံးမရတာကတော့ outage မို့ တာဝန်ရှိသူတွေ ချက်ချင်း ဝင်ရပါတယ်။
> ⟪board B1 step 2⟫ software က ရည်ရွယ်ထားတဲ့အတိုင်း အလုပ် မလုပ်တာကတော့ bug ပါ။ promo banner ပေါ်က စာ ပြတ်နေတာလို bug အများစုက ticket ဖွင့်ပြီး အလုပ်ချိန်ထဲ ပြင်ရုံပါပဲ၊ ငွေလွှဲ fail စေတဲ့ bug လို တချို့ကမှ incident ဖြစ်လာတာပါ။
> ⟪board B1 step 3⟫ incident တိုင်းကလည်း bug ကနေ လာတာ မဟုတ်ပါဘူး။ Operator B ရဲ့ system နှေးနေရင် Padauk ရဲ့ code မှာ အမှား မရှိပေမဲ့ top-up တွေ fail နေလို့ incident ပါပဲ။
> ⟪board B1 step 4⟫ ပြဿနာ စတက်ချိန်မှာ ဘယ်အမျိုးအစားလဲ ခွဲရ ခက်လို့ Padauk က ဘာဆိုရင် incident လဲ ဆိုတဲ့ စံနှုန်းကို ကြိုရေးထားပြီး ဘယ်သူမဆို incident ကြေညာလို့ရပါတယ်။ Viber bot ကို command တစ်ကြောင်း ပို့ရုံနဲ့ incident ဖွင့်လို့ရပြီး ပြင်းထန်မှု အဆင့်၊ severity ကိုလည်း default နဲ့ စပေးလို့ လိုရင် နောက်မှ ပြင်ရုံပါပဲ။
> ⟪close board⟫ ⟪page l09_p01b⟫ တစ်ညနေမှာ balance မှားနေတယ် ဆိုတဲ့ message တွေ ဝင်လာတော့ မစုက ကိုယ်တိုင် incident ကြေညာပါတယ်။ မိနစ် ၂၀ အတွင်း app က balance အဟောင်းကို ခဏ ပြနေတာပဲ ဆိုတာ သိရလို့ bug ticket အဖြစ် အဆင့်လျှော့ပါတယ်။ ကိုနေလင်းက မစုကို အားလုံး ရှေ့မှာ ကျေးဇူးတင်ပါတယ်၊ အဆင့်လျှော့တာက ဘာမှ မကုန်ပေမဲ့ မကြေညာဘဲ နေတာကတော့ Bank X ညလို အများကြီး ကုန်လို့ပါ။

On screen:

- B1 step (1), cleared (nested ellipses): incident → စနစ်တကျ တုံ့ပြန် (large orange ellipse) | outage → တာဝန်ရှိသူ ချက်ချင်း (red ellipse nested inside it)
- B1 step (2): bug → ticket (separate blue ellipse, overlapping the incident ellipse)
- B1 step (3): Operator B နှေး (small label inside the incident ellipse, outside the bug ellipse)
- B1 step (4): ကြိုရေးထားတဲ့ စံနှုန်း / ဘယ်သူမဆို ကြေညာ (green text under the ellipses, two lines)
- l09_p01b (K6): မစု ကြေညာတဲ့ ညနေ | balance မှား message | မစု ကြေညာ | bug အဖြစ် လျှော့ | ကျေးဇူးတင် | (caption) အဆင့်လျှော့တာ ဘာမှ မကုန်

## Scene 3 · Who answers?

chapter: Page ကို ဘယ်သူ ဖြေမလဲ

> ⟪page l09_p02⟫ ဒါဆို လူကို ချက်ချင်း နှိုးတဲ့ alert၊ page ကို ဘယ်သူ ဖြေမလဲ? လူတိုင်းဆီ ပို့ရင် တစ်ယောက်ယောက် ဖြေမှာပါလို့ အားလုံး ထင်ပြီး ဘယ်သူမှ မဖြေဖြစ်ပါဘူး၊ ဒါကို bystander effect လို့ ခေါ်ပါတယ်။ ကိုနေလင်းလို ခေါင်းဆောင် တစ်ယောက်ကိုပဲ အားကိုးရင်လည်း သူ လေယာဉ်ပေါ် ရောက်နေတဲ့နေ့ အကုန် ရပ်မှာမို့ single point of failure ဖြစ်ပါတယ်။
> ဒါကြောင့် မနက် ၂ နာရီ မေးခွန်းအတွက် Padauk ရဲ့ အဖြေက ချက်ချင်း ဖြေရမယ့် on-call တာဝန်ကို အလှည့်ကျ ယူတဲ့ rotation ပါ။ ဒီည ဘယ်သူ ဖြေရမလဲ ဆိုတာ schedule မှာ နာမည်နဲ့ ပါလို့ ကျန်တဲ့သူတွေ စိတ်အေးအေး အိပ်လို့ရပါတယ်။

On screen:

- l09_p02 (K4): Page ကို ဘယ်သူ ဖြေမလဲ | group တစ်ခုလုံး: လူတိုင်း စောင့် | ခေါင်းဆောင်: သူ မရှိရင် အကုန် ရပ် | rotation: schedule ထဲမှာ နာမည်ပါ တစ်ယောက်

## Scene 4 · The coverage clock

chapter: ဘယ်အချိန်၊ ဘယ်လောက် မြန်မြန်

> ⟪close page⟫ ⟪board B2 step 1⟫ rotation ဆွဲဖို့ မသီရိက service တိုင်းအတွက် မေးခွန်း တစ်ခုတည်း မေးပါတယ်၊ ဒီ page ကို မနက် ၇ နာရီအထိ စောင့်ခိုင်းရင် ဘာ ဆုံးရှုံးမလဲ ဆိုတာပါ။ Wallet ရဲ့ burn-rate page က သဘောတူထားတဲ့ ပစ်မှတ် ဖြစ်တဲ့ service level objective၊ SLO ရဲ့ ပျက်ခွင့်ကို အရမ်း မြန်မြန် သုံးနေမှ ဝင်လာတာမို့ စောင့်ခိုင်းရင် ငွေလွှဲတဲ့ user တွေ မိနစ်တိုင်း ပိုဒုက္ခရောက်ပါမယ်။ ဒါကြောင့် Wallet ကို တစ်နေ့ ၂၄ နာရီ၊ ရက်တိုင်း စောင့်ပြီး ၅ မိနစ်အတွင်း စတုံ့ပြန်ရပါတယ်။
> ⟪board B2 step 2⟫ Eats ကတော့ ညဘက် ဆိုင်တွေ ပိတ်လို့ မနက် ၇ နာရီကနေ ည ၁၁ နာရီအထိပဲ စောင့်ပါတယ်။ merchant တွေဆီ ငွေလွှဲတဲ့ settlement job ကလည်း ပျက်ရင် နာရီအနည်းငယ် နောက်မှ ပြန် run လို့ရလို့ ရုံးချိန်ထဲမှာပဲ ကြည့်ပါတယ်။
> ⟪board B2 step 3⟫ promo banner ပြတဲ့ service ကတော့ ပျက်ရင် app က banner မပြရုံပဲမို့ page လုံးဝ မပို့ဘဲ မနက်ကျမှ ticket နဲ့ ပြင်ပါတယ်။ တစ်နေ့ ၂၄ နာရီ on-call က ပိုက်ဆံလည်း ကုန်၊ လူလည်း ပင်ပန်းလို့ တကယ် လိုမှ ထားရပါတယ်။
> ⟪board B2 step 4⟫ page ဝင်ပြီး စတုံ့ပြန်ရမယ့် ကြာချိန်ကို response time လို့ ခေါ်ပါတယ်။ ၅ မိနစ်ဆိုရင် laptop ကို ဘယ်သွားသွား ယူသွားရပြီး ရုံးသွားတဲ့ လမ်းပေါ် မရောက်ခင် နောက်လူကို လွှဲထားရပါတယ်။ page က primary ဆီ အရင် ရောက်ပြီး သူက ကြည့်နေပါပြီလို့ ack မလုပ်ရင် secondary ဆီ ဆက်သွားပါတယ်။
> ⟪board B2 step 5⟫ ၃ မိနစ်ထက် မြန်ရရင်တော့ ဖုန်း အားသွင်းဖို့ ခဏ ထားခဲ့ရင်တောင် မမီတော့လို့ အမြဲ အသင့်ဖြစ်နေတဲ့ လူ နှစ်ယောက် လိုပြီး၊ မိနစ် ၃၀ ဆိုရင်တော့ ကလေး ကျောင်းကြိုတာလို ပုံမှန် ဘဝ နေလို့ရပါတယ်။

On screen:

- B2 step (1), cleared (P5 horizontal bars over a 24-hour underline axis): 0 | 24 (axis ends) | Wallet: 24 နာရီ၊ 5 မိနစ် (green bar, full width)
- B2 step (2): Eats: 7–23 (blue bar from 7 to 23) | settlement: 9–17 (shorter blue bar from 9 to 17)
- B2 step (3): promo banner: page မပို့ (orange label on its own row, no bar)
- B2 step (4): 5 မိနစ်: laptop အမြဲ / primary → secondary (small orange note under the axis, two lines)
- B2 step (5): 3 မိနစ်အောက်: 2 ယောက် / 30 မိနစ်: ပုံမှန် ဘဝ (second orange note beside it, two lines)

## Scene 5 · A rotation people can sustain

chapter: ရေရှည် လုပ်နိုင်တဲ့ rotation

> ⟪close board⟫ ⟪page l09_p02b⟫ rotation စတဲ့ ပထမ အပတ်မှာ Wallet ရဲ့ on-call ကျနေသူဆီ တစ်ညကို page ၁၀ ခုလောက် ဝင်ပါတယ်။ အများစုက Viber group ထဲမှာ ဘယ်သူမှ မဖတ်ခဲ့လို့ မပြင်ခဲ့တဲ့ alert အဟောင်းတွေမို့ မသီရိက လူ ထပ်မထည့်ခင် အဲဒီ alert တွေကို အရင် ပြင်ခိုင်းပါတယ်၊ မဟုတ်ရင် page တွေကို လူတွေ ပြန်လျစ်လျူရှု လာမှာပါ။
> ⟪page l09_p03⟫ incident တစ်ခုကို ပြင်ပြီး မှတ်တမ်းတင်တာ နာရီ အတော်များများ ကြာတတ်လို့ တစ်ယောက်ရဲ့ တာဝန်ကာလ၊ shift တစ်ခုမှာ incident နှစ်ခုလောက်က အများဆုံးပါ၊ ဒီထက် များရင် ပြင်တာ နှေးပြီး သင်ယူဖို့ အချိန် မကျန်တော့ပါဘူး။ မီးပျက်တာ၊ လိုင်းကျတာ ခဏခဏ ဖြစ်လို့ on-call ကျသူတိုင်း အရန် မီးနဲ့ ဒုတိယ SIM ကတ်လည်း ထားပါတယ်။ Eats လို လူ နည်းတဲ့ အဖွဲ့မှာ schedule မကိုက်ရင်တော့ လူကို burnout မဖြစ်စေဘဲ response time ပစ်မှတ်ကို ဖြေလျှော့ပါတယ်။
> ⟪page l09_p03b⟫ page နည်းလွန်းရင်လည်း တကယ် ဝင်လာတဲ့နေ့ကျ tool တွေကို ဘယ်လို သုံးရမလဲ မေ့နေတတ်ပါတယ်။ ဒါကြောင့် မသီရိက rotation ကျန်းမာလား သိဖို့ ဈေးအပေါဆုံး ကိန်းဂဏန်း နှစ်ခုကို လတိုင်း ရေတွက်ပါတယ်၊ shift တစ်ခုစီရဲ့ page အရေအတွက်နဲ့ alert မတက်ခင် user က တွေ့ခဲ့တဲ့ incident အရေအတွက်ပါ။

On screen:

- l09_p02b (K7): Wallet ရဲ့ ပထမ အပတ် | တစ်ညကို page 10 | အများစု alert အဟောင်း: အရင် ပြင်
- l09_p03 (K2): ရေရှည် လုပ်နိုင်တဲ့ rotation | shift တစ်ခုမှာ incident 2 ခုလောက်ထိ | အရန် မီးနဲ့ ဒုတိယ SIM | schedule မကိုက်ရင် ပစ်မှတ်ကို ဖြေလျှော့
- l09_p03b (K2): Rotation ကျန်းမာလား | page နည်းလွန်းရင် tool သုံးပုံ မေ့ | လတိုင်း: shift တစ်ခုရဲ့ page အရေအတွက် | လတိုင်း: user က alert ထက် အရင် တွေ့တာ

## Scene 6 · Incident roles

chapter: Incident commander နဲ့ role တွေ

> ⟪close page⟫ ⟪board B3 step 1⟫ တစ်လလောက် ကြာတော့ စနေနေ့ ညနေမှာ Bank X ဆီ ငွေလွှဲတာတွေ ထပ် fail လာပါတယ်။ ဒီတစ်ခါတော့ Wallet ရဲ့ on-call ကျနေတဲ့ junior developer က ၂ မိနစ်အတွင်း ack လုပ်ပြီး incident ကြေညာပါတယ်၊ သူပဲ incident commander အဖြစ် ဦးဆောင်ပါတယ်။ incident commander က incident တစ်ခုလုံးကို ညှိပြီး ဆုံးဖြတ်တဲ့သူပါ၊ ကိုယ်တိုင် ပြင်တာထက် လူတိုင်း ဘာလုပ်ရမလဲ သိအောင် စီစဉ်ပေးတာက သူ့ အလုပ်ပါ။
> ⟪board B3 step 2⟫ သူက role သုံးခု ခွဲပေးပါတယ်။ communications lead က support နဲ့ ကိုနေလင်းကို ပုံမှန် update ပေးလို့ ပြင်နေတဲ့သူတွေကို ဘယ်သူမှ လာမမေးတော့ပါဘူး။ secondary က operations lead အဖြစ် တကယ် ပြင်တဲ့ အလုပ်ကို ဦးဆောင်ပြီး scribe က ဘာဖြစ်လဲ၊ ဘာဆုံးဖြတ်လဲ အချိန်နဲ့ တကွ မှတ်ပါတယ်။ incident သေးရင် တစ်ယောက်က role နှစ်ခု ယူလို့ရပါတယ်။
> ⟪board B3 step 3⟫ ကိုနေလင်း call ထဲ ဝင်လာပေမဲ့ incident commander က CTO ဘာပြောမလဲ စောင့်မနေဘဲ သူ့ကို Bank X ရဲ့ တာဝန်ရှိသူဆီ ဖုန်းဆက်ဖို့ အလုပ် ခွဲပေးလိုက်ပါတယ်။ ရာထူး ဘယ်လောက်ပဲ ရှိရှိ incident commander က ဦးဆောင်တယ်လို့ ကြိုသဘောတူထားလို့ပါ။
> ⟪board B3 step 4⟫ ဒါပေမဲ့ Wallet နဲ့ Top-up နှစ်ဖွဲ့လုံး ပါလာပြီး Wallet ကို ကယ်ဖို့ Top-up ကို ခဏ ပိတ်မလားလို ဘယ်အဖွဲ့က ဆုံးဖြတ်ရမလဲ မရှင်းတဲ့ incident တွေလည်း ရှိပါတယ်။ အဲဒီအခါ ကုမ္ပဏီ တစ်ခုလုံးရဲ့ rotation သေးသေးလေးကနေ အဖွဲ့တွေကြား ညှိပေးသူ တစ်ယောက် ခေါ်ပါတယ်။ သူက ကိုယ်တိုင် မပြင်ဘဲ ဆုံးဖြတ်ချက်တွေ မြန်မြန် ထွက်အောင် လုပ်ပေးပြီး နောက်ဆက်တွဲ အလုပ်ကိုတော့ service ပိုင်တဲ့ အဖွဲ့က ယူပါတယ်။ incident အရမ်းကြီးရင် အဖွဲ့တွေရဲ့ incident commander တွေကို အပေါ်ကနေ ညှိပါတယ်။

On screen:

- B3 step (1), cleared (P2 comb, downward): incident commander (blue box at the top) | (arrow-down into a thin horizontal bus)
- B3 step (2): communications | operations | scribe (three boxes under the bus, each with an arrow-down from it)
- B3 step (3): ရာထူး မရွေး incident commander ဦးဆောင် (violet text under the three boxes)
- B3 step (4): ညှိပေးသူ / အဖွဲ့ များရင် ခေါ် (violet box to the right of the incident commander box, two lines)

## Scene 7 · When it's big

chapter: Incident ကြီးတဲ့အခါ

> ⟪close board⟫ ⟪page l09_p04⟫ ဒီ rotation မှာ ဘယ်သူတွေ ပါလဲ? Padauk မှာ reliability အဖွဲ့ သီးသန့် မရှိသေးလို့ ဆန္ဒရှိတဲ့ senior engineer ငါးယောက်က ကိုယ့် product အလုပ်ကို ဆက်လုပ်ရင်း incident ကြီးမှပဲ page ခံမယ့် swarm တစ်ခု ဖွဲ့ကြပါတယ်။ incident ကြီးရင်လည်း CTO မဟုတ်ဘဲ incident commander က ဦးဆောင်မယ်လို့ ကြိုသဘောတူထားပြီး business အကြောင်းကို ကြိုမျှထားပါတယ်။
> ⟪page l09_p04b⟫ လူစုံ သဘောတူမှ ဆုံးဖြတ်တာရော CTO ကို စောင့်တာရော ပိုနှေးပါတယ်။ ခေါင်းဆောင်တွေက engineer တွေ business ကို မသိမှာ မစိုးရိမ်ရအောင် swarm က အကြီးဆုံး merchant တွေ၊ ချိတ်ထားတဲ့ bank တွေ၊ ဒီအပတ် run နေတဲ့ promo တွေကို စာမျက်နှာ တစ်ခုထဲမှာ ကြိုရေးထားပါတယ်။
> swarm ကို စောစော ခေါ်ရပေမဲ့ ခက်တဲ့ incident တိုင်း လွှဲပေးနေရင် product အဖွဲ့တွေ ကိုယ့် system ကို ကိုယ် မပြင်တတ်တော့ပါဘူး။ swarm အလုပ်ကိုလည်း ရာထူးတိုးတဲ့အခါ ထည့်တွက်ပါတယ်။

On screen:

- l09_p04 (K2): Incident ကြီးတဲ့အခါ | ဆန္ဒရှိတဲ့ senior တွေ၊ ကြီးမှ page | incident commander ဦးဆောင်၊ ကြိုသဘောတူ | business အကြောင်းကို ကြိုမျှ
- l09_p04b (K3, left gray / right teal; cells as left / right): ပိုနှေး / ပိုမြန် | လူစုံ သဘောတူမှ / incident commander ဆုံးဖြတ် | CTO ကို စောင့် / business စာမျက်နှာ ကြိုရေး

## Scene 8 · This week

chapter: —

> ⟪page l09_p05⟫ မနက် ၂ နာရီ မေးခွန်းကို ကိုယ့်အဖွဲ့မှာလည်း ဒီအပတ် ဖြေထားလို့ရပါတယ်။ ဘာဆိုရင် incident လဲ ဆိုတာကို စာကြောင်း အနည်းငယ်နဲ့ ချရေးပါ။ group chat ထဲ ပို့နေတဲ့ alert တစ်ခုကို rotation ဆီ ပြောင်းပို့ပါ။ ပြီးတော့ ဘယ်သူတွေ incident commander လုပ်နိုင်လဲ ကြိုသဘောတူထားပါ။

On screen:

- l09_p05 (K2): ဒီအပတ် လုပ်စရာ | ဘာဆိုရင် incident လဲ ချရေးပါ | group alert တစ်ခုကို rotation နဲ့ လဲပါ | ဘယ်သူတွေ incident commander လုပ်နိုင်လဲ သဘောတူပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ Viber group ကနေ rotation ဆီ ရောက်လာတဲ့ လမ်းကို ပြန်လျှောက်ကြည့်ရအောင်။ ⟪select incident⟫ incident က user ဒါမှမဟုတ် business ကို ထိခိုက်လို့ စနစ်တကျ တုံ့ပြန်ရမယ့် ပြဿနာဖြစ်ပြီး ဘယ်သူမဆို ကြေညာလို့ရပါတယ်။ ⟪select outage⟫ outage က အဲဒီထဲက service ဒါမှမဟုတ် အရေးကြီး feature လုံးဝ သုံးမရတာပါ။ ⟪select rotation⟫ rotation က page တိုင်းမှာ နာမည်ပါတဲ့ တစ်ယောက် ရှိအောင် on-call ကို အလှည့်ကျ ယူတာပါ။
> ⟪select response time⟫ response time က page ဝင်ပြီး ဘယ်လောက် မြန်မြန် စတုံ့ပြန်ရမလဲ ဆိုတာ ဖြစ်ပြီး၊ ⟪select incident commander⟫ incident commander က ရာထူး မရွေး incident ကို ဦးဆောင်ပြီး လူတိုင်း ဘာလုပ်ရမလဲ စီစဉ်ပေးသူပါ။ ⟪select မေးခွန်း⟫ service တစ်ခုက on-call ကျသူကို တစ်ညကို ၆ ခါ page ပို့နေရင် ဘာကို အရင် ပြောင်းမလဲ?
> ⟪pause 3s⟫ လူ ထပ်ထည့်ဖို့ မဟုတ်ပါဘူး။ အလကား တက်နေတဲ့ alert တွေကို အရင် ပြင်ပါ၊ ဒါမှမဟုတ် ပိတ်ပါ၊ ပြီးမှ response time ပစ်မှတ်ကို ပြန်စစ်ပါ။ လစာထုတ်ရက် ညနေ ၆ နာရီ ၄၀ မှာတော့ Top-up ရဲ့ burn-rate page ဝင်လာပြီး support ကလည်း ဖုန်းဘေလ် မဝင်ဘူးလို့ ပြောလာပါတယ်။ ဘယ်ကနေ စမလဲ?

On screen:

- notes.md: # ရေရှည် လုပ်နိုင်တဲ့ on-call | (blank line) | - incident — user ဒါမှမဟုတ် business ထိခိုက်လို့ စနစ်တကျ တုံ့ပြန်ရမယ့် ပြဿနာ၊ ဘယ်သူမဆို ကြေညာ | - outage — service ဒါမှမဟုတ် အရေးကြီး feature လုံးဝ သုံးမရ | - rotation — on-call ကို အလှည့်ကျ ယူ၊ page တိုင်းမှာ နာမည်ပါ တစ်ယောက် | - response time — page ဝင်ပြီး ဘယ်လောက် မြန်မြန် စတုံ့ပြန်ရမလဲ | - incident commander — ရာထူး မရွေး ဦးဆောင်၊ ကိုယ်တိုင် မပြင်ဘဲ စီစဉ် | (blank line) | မေးခွန်း: service တစ်ခုက on-call ကျသူကို တစ်ညကို page 6 ခါ ပို့နေတယ်။ ဘာကို အရင် ပြောင်းမလဲ?
