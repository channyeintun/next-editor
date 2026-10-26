# Lesson 16 · Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ

slug: sre-16-engagement-models · budget: 8400 characters (±5%)

## Scene 1 · Hook: "Please carry our pager"

chapter: pager ကို ယူပေးပါ

> ⟪page l16_p01⟫ မသီရိ၊ ကိုဇော်နဲ့ နောက်တစ်ယောက် ပါတဲ့ Site Reliability Engineering၊ SRE အဖွဲ့က Wallet နဲ့ Top-up အတွက် charter တစ်ခုနဲ့ အလုပ်စလိုက်ပြီး လစဉ် review မှာလည်း ဘယ်အဖွဲ့ကိုမှ အဆင့် မစီတော့ပါဘူး။
> မကြာခင်မှာပဲ မီတာခ၊ ရေခ ပေးလို့ရတဲ့ Bill Pay ရဲ့ ခေါင်းဆောင်က ပြင်လို့မရတဲ့ vendor billing system ကြောင့် ညတိုင်းလိုလို page ဝင်လာလို့ အဖွဲ့ ပင်ပန်းနေပြီ၊ အဲဒီ page တွေ ဖြေရတဲ့ on-call တာဝန်၊ pager ကို SRE က အပြည့် ယူပေးပါလို့ လာတောင်းပါတယ်။ လူ သုံးယောက်ပဲ ရှိတဲ့ SRE အဖွဲ့က pager အစား ဘာကို ယူသင့်လဲ?

On screen:

- l16_p01 (K1): 16 | Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ | "pager ကို ယူပေးပါ" | Bill Pay က SRE support အပြည့် လိုချင် | မသီရိရဲ့ အဖွဲ့မှာ 3 ယောက်ပဲ | SRE က ဘာကို ယူသင့်လဲ? | (small loop badge, the hub လူတွေ lit)

## Scene 2 · The agreement

chapter: Engagement ဆိုတာ

> ⟪page l16_p01b⟫ ရပါတယ်လို့ ဖြေလိုက်ရင် လွယ်ပေမဲ့ အရင်က လုပ်ခဲ့ပုံတွေက အဲဒီ တစ်ခွန်းရဲ့ ကုန်ကျစရိတ်ကို သင်ပေးခဲ့ပါတယ်။ review ကြီး အောင်မှ SRE က လက်ခံရင် design ပြောင်းဖို့ နောက်ကျမှ ရောက်လာပါတယ်။ pager ကို တစ်ခါ ယူပြီးရင် ပြန်ပေးရ ခက်ပြီး developer တွေလည်း production ကို ဆက်မသင်တော့ပါဘူး။
> pager ဘယ်သူ ယူလဲ ဆိုတာနဲ့ support အဆင့် ခွဲရင် အဖွဲ့တိုင်းက Bill Pay လိုပဲ pager ပါတဲ့ အဆင့်ကို လိုချင်ကြပါတယ်။ launch တိုင်းကို review လုပ်ရင်လည်း launch တွေ များလာတာကို SRE လူ တိုးတာနဲ့ မမီတော့ပါဘူး။
> ⟪page l16_p02⟫ ဒါကြောင့် မသီရိက ရတယ်၊ မရဘူးလို့ မဖြေဘဲ engagement တစ်ခု အတူ ရေးကြရအောင်လို့ ပြောပါတယ်။ engagement ဆိုတာ SRE နဲ့ product team ဘယ်လို တွဲလုပ်မလဲ ရေးထားတဲ့ တိုတိုလေး သဘောတူညီချက်ပါ။ ဘယ်သူ ဘာ ပိုင်လဲ၊ ဘယ် ရလဒ်တွေ ရယူမလဲ၊ on-call ကို ဘယ်လို ခွဲယူမလဲ၊ ဘယ်တော့ ဘယ်လို ပြီးမလဲ ဆိုတာ ပါရပါမယ်။
> အဆုံးကို အစကတည်းက ရေးထားမှ engagement က အဆုံးမဲ့ မဖြစ်မှာပါ။ business အတွက် ဘယ် risk တွေ အရေးအကြီးဆုံးလဲ ဆိုတာကိုလည်း နှစ်ဖက် အရင် သဘောတူရပါတယ်။

On screen:

- l16_p01b (K5): ရပါတယ်လို့ ဖြေရင်… | review ကြီးပြီးမှ: SRE နောက်ကျ | pager ယူပြီးရင်: ပြန်ပေးရ ခက် | pager နဲ့ အဆင့်ခွဲ: အားလုံး pager လို | launch တိုင်း review: SRE မမီ
- l16_p02 (K2): Engagement မှာ ပါရမှာ | ဘယ်သူ ဘာပိုင်လဲ၊ ဘယ် ရလဒ်လဲ | on-call ကို ဘယ်လို ခွဲယူမလဲ | ဘယ်တော့ ဘယ်လို ပြီးမလဲ

## Scene 3 · Team shapes and their traps

chapter: SRE အဖွဲ့ ပုံစံတွေ

> ⟪page l16_p03⟫ Bill Pay တောင်းတာကို လက်ခံရင် မသီရိရဲ့ အဖွဲ့က ဘာမဆို on-call ယူပေးတဲ့ kitchen sink အဖွဲ့ ဖြစ်သွားပြီး engineering လုပ်ချိန် မကျန်တော့ပါဘူး။ ops အဖွဲ့ကို SRE လို့ နာမည်ပဲ ပြောင်းပြီး ဘယ်သူမှ code မရေးရင်လည်း ဒီ ပုံစံပဲ ဖြစ်ပြီး ဘာမှ မပြောင်းပါဘူး။
> product team ထဲ ဝင်လုပ်တဲ့ embedded SRE က system ကို နီးနီးကပ်ကပ် သိပေမဲ့ တစ်ယောက်တည်း ဖြစ်လို့ တခြား SRE တွေနဲ့ လုပ်ပုံ ကွဲသွားတတ်ပါတယ်။ လိုမှ လာမေးတဲ့ consulting ကတော့ system ကို နက်နက် မသိပါဘူး။
> ⟪page l16_p03b⟫ product SRE၊ infrastructure SRE၊ tool ဆောက်တဲ့ tools SRE လို ပုံစံတွေလည်း ရှိပြီး ကုမ္ပဏီ အများစုက ရောသုံးကြပါတယ်။ Padauk ကြီးလာရင် Wallet မှာ product SRE၊ rider tracking ထဲမှာ embedded SRE၊ မျှသုံးတဲ့ cluster မှာ infrastructure SRE ထားပြီး ကျန်တဲ့ အဖွဲ့တွေကို အပတ်စဉ် လာမေးလို့ရတဲ့ office hours နဲ့ ကူဖို့ မသီရိ ပုံကြမ်း ဆွဲထားပါတယ်။

On screen:

- l16_p03 (K4): SRE အဖွဲ့ ပုံစံနဲ့ ထောင်ချောက် | kitchen sink: အကုန်လုံး on-call | embedded: တစ်ယောက်တည်း၊ လုပ်ပုံ ကွဲ | consulting: system ကို နက်နက် မသိ
- l16_p03b (K5): Padauk ရဲ့ နောင် ပုံစံ | Wallet: product SRE | rider tracking: embedded SRE | shared cluster: infrastructure SRE | ကျန်တဲ့ အဖွဲ့တွေ: office hours

## Scene 4 · Bill Pay's outcomes

chapter: Bill Pay ရဲ့ ရလဒ်တွေ

> ⟪close page⟫ ⟪board B1 step 1⟫ engagement ရေးတဲ့နေ့မှာ မသီရိနဲ့ Bill Pay ခေါင်းဆောင်က user တွေနဲ့ business ကို ဘာက ဒုက္ခ အပေးဆုံးလဲ မေးပြီး ရလဒ်တွေကို အရေးကြီးတဲ့ အစဉ်နဲ့ စီပါတယ်။ ပထမက ဘေလ် ကောက်တဲ့ဘက်က timeout ကြောင့် pending မှာ ပိတ်မိနေတဲ့ ငွေချေမှု မရှိရ၊ ဒုတိယက ဘေလ် နောက်ဆုံးရက် reminder တွေ ပို့ချိန် လူတွေ တပြိုင်နက် ဝင်လာလည်း Wallet မနှေးရ ဆိုတာပါ။
> ⟪board B1 step 2⟫ တတိယက ပြေစာ တစ်မိနစ်အတွင်း ရောက်ရ၊ စတုတ္ထက vendor ဆီက file အမှားကို မနက် ၆ နာရီ မတိုင်ခင် ဖမ်းမိရ ဆိုတာပါ။ ဒါတွေက SRE လုပ်ပေးရမယ့် task စာရင်း မဟုတ်ဘဲ user နဲ့ business တကယ် ခံစားရမယ့် ရလဒ်တွေပါ။ ဘယ်သူ ဘာ လုပ်မလဲ ဆိုတာကိုတော့ ရလဒ်တွေ သဘောတူပြီးမှ ခွဲပါတယ်။
> ⟪board B1 step 3⟫ SRE သုံးယောက်မှာ Wallet နဲ့ Top-up အလုပ်လည်း ရှိလို့ လူအင်အားက ထိပ်ဆုံး နှစ်ခုအတွက်ပဲ လောက်ပါတယ်။ အဲဒီ နှစ်ခုအတွက် နှစ်ဖက်က engineer တွေ ၈ ပတ်ကနေ ၁၀ ပတ်အထိ အတူ လုပ်မယ့် project တွေ ဖွဲ့ပြီး project ပြီးရင် SRE က နောက် ရလဒ်ဆီ ရွှေ့ပါတယ်။ engagement တစ်ခုလုံးအတွက် တာဝန်ခံ tech lead ကတော့ ကိုဇော်ပါ။
> ⟪board B1 step 4⟫ ticket၊ မေးခွန်းလို ကြားဖြတ် အလုပ်ကိုတော့ အဖွဲ့ နှစ်ခုလုံး ခွဲယူပါတယ်။ project မရတဲ့ အဖွဲ့တွေတောင် postmortem review၊ office hours၊ incident ကြီးမှာ ဝင်ကူတာလို အခြေခံ အကူအညီကို အမြဲ ရပါတယ်။ ရလဒ် စာရင်းကိုလည်း သုံးလ တစ်ခါ ပြန်စီပါတယ်။

On screen:

- B1 step (1), cleared (a column of four ranked cards on the left, two-line labels): 1 · pending မှာ / ပိတ်မိတာ မရှိ | 2 · reminder peak မှာ / Wallet မနှေး
- B1 step (2): 3 · ပြေစာ / 1 မိနစ်အတွင်း | 4 · file အမှားကို / မနက် 6 မတိုင်ခင် ဖမ်းမိ
- B1 step (3): SRE လူအင်အား (thin red bar under card 2) | 8–10 ပတ် / အတူ project (box on the right; arrow-right from cards 1–2)
- B1 step (4): အမြဲ ရ: postmortem review · / office hours · incident ကြီးမှာ ကူ (full-width violet base bar under the column and the box, two lines) | သုံးလ တစ်ခါ ပြန်စီ (blue label beside the column)

## Scene 5 · Who carries which pager

chapter: ဘယ် pager ကို ဘယ်သူ ယူမလဲ

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို pager ကို SRE က ဘာလို့ မယူတာလဲ? ပြီးခဲ့တဲ့ သင်္ကြန်က ကံစမ်းမဲ service ကို ကြည့်ပါ။ ပွဲတော် ခဏပဲ ဆိုပြီး SRE က pager ကို ယူပေးခဲ့ပေမဲ့ launch ပြီးတော့ developer တွေက project အသစ်ဆီ ရွှေ့သွားလို့ လတွေ ကြာတဲ့အထိ ပိုင်ရှင်မဲ့ service ရဲ့ page တွေကို SRE ကပဲ ဖြေနေရပါတယ်။
> ⟪board B2 step 2⟫ ဒါကြောင့် အဲဒီ service ကို ဆောက်ခဲ့တဲ့ အဖွဲ့ဆီ ပြန်ပေးပါတယ်။ on-call တာဝန်ကို developer တွေဆီ ပြန်လွှဲတာကို handback လို့ ခေါ်ပြီး ဒီတစ်ခါတော့ ရက်စွဲ၊ runbook၊ training နဲ့ ကြိုစီစဉ်ပြီး လွှဲတာပါ၊ office hours လည်း ဆက်ရှိပါတယ်။ lesson ၃ မှာတော့ service က သဘောတူထားတဲ့ reliability ပစ်မှတ် ဖြစ်တဲ့ service level objective၊ SLO ကို ခဏခဏ မမီလို့ ပြန်လွှဲတာပါ။
> ⟪board B2 step 3⟫ Bill Pay အတွက်တော့ on-call ကို ခွဲယူပါတယ်။ app ရဲ့ page တွေကို developer တွေက အရင် ဖြေပြီး မျှသုံးတဲ့ database နဲ့ ဘေလ် ကောက်တဲ့ ကုမ္ပဏီတွေဆီ ချိတ်တဲ့ gateway ရဲ့ page တွေကိုတော့ SRE က ယူပါတယ်။ ဒီနေ့ release မှာ ဘာ ပြောင်းသွားလဲ ဆိုတာ developer တွေပဲ သိလို့ ညဘက်မှာလည်း ဆက်သွယ်လို့ ရနေရပါတယ်။ on-call ကနေ နှစ်ဖက်လုံး production ကို သင်ယူကြပါတယ်။

On screen:

- B2 step (1), cleared (P6, top lane): design → launch → developer / တွေ ရွှေ့ → SRE မှာ / pager ကျန် (red)
- B2 step (2) (middle lane, green): ကြိုစီစဉ်ထားတဲ့ handback (lane title) | ရက်စွဲ + runbook + training → office hours ဆက်ရှိ
- B2 step (3) (bottom lane, blue): Bill Pay (lane title) | app page → developer | database + gateway page → SRE

## Scene 6 · An SLO before any code

chapter: code မရေးခင် SLO

> ⟪close board⟫ ⟪board B3 step 1⟫ SRE အကူအညီက architecture ပြောင်းရတာ အသက်သာဆုံး ဖြစ်တဲ့ design အဆင့်မှာ အထိရောက်ဆုံးပါ။ ဒါကြောင့် Eats ရဲ့ rider matching ကို စတော့ product manager မနှင်းက code မရေးခင် မသီရိနဲ့ SLO ကို အရင် သတ်မှတ်ပါတယ်၊ order ၉၅ ရာခိုင်နှုန်းကို စက္ကန့် ၄၅ အတွင်း rider နဲ့ တွဲပေးရမယ် ဆိုတာပါ။
> ပစ်မှတ်ကို Wallet ထက် နိမ့်ထားတာက rider တွေ ဒီ feature ကို မြန်မြန် လိုချင်လို့ပါ၊ ဘာလို့ နိမ့်လဲ၊ ဘယ်တော့ မြှင့်မလဲ ဆိုတာကိုလည်း ချရေးထားပါတယ်။
> ⟪board B3 step 2⟫ SLO ကို အရင် သိတော့ design ကိုလည်း ညှိပါတယ်။ peak ချိန်မှာ order တွေ fail မဖြစ်ဘဲ တန်းစီ စောင့်နိုင်အောင် queue ထည့်တယ်၊ retry လုပ်မိလည်း rider နှစ်ယောက်နဲ့ မတွဲမိအောင် order တိုင်းမှာ key တစ်ခု ပါတယ်၊ peak မှာ ဓာတ်ပုံလို အရေးမကြီးတဲ့ အပိုင်းကို ခဏ ပိတ်ပါတယ်။
> ⟪board B3 step 3⟫ ပထမ version ကလည်း dashboard၊ runbook နဲ့ rollback လုပ်နည်း ပါပြီးသား ထွက်ပါတယ်။ ဘာလုပ်လဲ မဟုတ်ဘဲ ဘယ်လောက် မြန်ရမလဲ၊ စိတ်ချရရမလဲ ဆိုတဲ့ လိုအပ်ချက်တွေကို nonfunctional requirement လို့ ခေါ်ပြီး roadmap မှာ မေ့ကျန်တတ်လို့ SRE က အသံ ထွက်ပေးရပါတယ်။
> ဥပမာ ပြီးခဲ့တဲ့ ညစာ peak မှာ Eats နှေးတုန်းက မသီရိက ဆုံးရှုံးခဲ့တဲ့ order နဲ့ refund တွေကို ငွေနဲ့ တွက်ပြပြီး postmortem ကိုလည်း မနှင်းကို အဓိက ရည်ရွယ်ပြီး ရေးခဲ့ပါတယ်။

On screen:

- B3 step (1), cleared (P1 flow, three boxes left to right; three-line labels to fit the 240 px boxes): SLO အရင် / 45 စက္ကန့်အတွင်း / 95% (blue)
- B3 step (2): design ကို ညှိ / queue · order key / ဓာတ်ပုံ ပိတ်
- B3 step (3): v1 မှာ ပါပြီးသား / dashboard · runbook / rollback (green)

## Scene 7 · Questions we stopped answering

chapter: ဂိတ်စောင့်ကနေ ကူညီသူ

> ⟪close board⟫ ⟪page l16_p04⟫ ဒါပေမဲ့ လူ သုံးယောက်နဲ့ design တိုင်းမှာ ဝင်ထိုင်လို့ မရပါဘူး။ မသီရိဆီ Viber ကနေ alert ဘယ်လို ထည့်ရမလဲ၊ လစာထုတ်ရက်မှာ deploy လုပ်လို့ ရလား ဆိုတဲ့ မေးခွန်းတွေလည်း နေ့တိုင်း ဝင်လာလို့ အပတ်တိုင်း ရေတွက်ကြည့်ပါတယ်။ အများဆုံး မေးတဲ့ သုံးခုကို lesson ၄ က service အသစ် ဆောက်တိုင်း သုံးတဲ့ golden path template ထဲမှာ check တွေ အဖြစ် ထည့်လိုက်တော့ နောက်တစ်လမှာ အဲဒီ မေးခွန်းတွေ မလာတော့ပါဘူး။
> ⟪page l16_p04b⟫ ဒါက SRE အကူအညီကို ချဲ့တဲ့ လှေကားပါ။ မေးတာကို ဖြေပေးတာကနေ ကိုယ်တိုင် ဖြေတတ်အောင် သင်ပေးတာ၊ နောက်ဆုံး template ထဲက check တွေနဲ့ မေးစရာကိုပါ မလိုအောင် လုပ်ပေးတာအထိ တက်သွားပါတယ်။ ဒီလိုနဲ့ SRE က launch တိုင်းကို တားစစ်တဲ့ ဂိတ်စောင့်ကနေ ကူညီပေးသူ ဖြစ်လာပြီး risk များတဲ့ launch ကိုပဲ review လုပ်ပါတော့တယ်။

On screen:

- l16_p04 (K2): ထပ်မမေးရတော့တဲ့ မေးခွန်း | SRE ဆီ Viber မေးခွန်းကို အပတ်တိုင်း ရေတွက် | အများဆုံး 3 ခုကို check ဖြစ်အောင် ပြောင်း | နောက်လဆို အဲဒီ မေးခွန်းတွေ မလာတော့
- l16_p04b (K6): SRE အကူအညီကို ချဲ့ပုံ | ဖြေပေး | ဖြေတတ်အောင် သင် | မေးစရာ မလိုအောင် လုပ် | (caption) ဂိတ်စောင့် မဟုတ်ဘဲ ကူညီသူ

## Scene 8 · When one customer matters a lot

chapter: customer ကြီး တစ်ခု

> ⟪page l16_p04c⟫ အဲဒီ သုံးလပတ်ထဲမှာပဲ Padauk for Business ရဲ့ developer တစ်ယောက်က merchant တွေဆီ နေ့တိုင်း ပို့တဲ့ settlement file ထဲက column တစ်ခုကို နေရာ ရွှေ့လိုက်ပါတယ်။ SLO တိုင်း အစိမ်းရောင် ဖြစ်နေပေမဲ့ နောက်တစ်မနက် အကြီးဆုံး customer ဖြစ်တဲ့ supermarket chain က ထပ်ပြီး ဖုန်းဆက်လာပါတယ်၊ သူတို့ရဲ့ import script က file ကို ဖတ်မရတော့လို့ပါ။
> ⟪page l16_p05⟫ chain က ကတိ မပေးထားတဲ့ column အစဉ်ကို အားကိုးနေခဲ့တာပါ။ lesson ၇ က Hyrum's law အတိုင်းပဲ user များလာရင် ကတိ မပေးထားတဲ့ အပြုအမူကိုတောင် တစ်ယောက်ယောက်က အားကိုးလာတတ်ပါတယ်။
> SLO က user အများကြီးကို ပေါင်းကြည့်တာမို့ complaint တစ်ခုက သိပ်မပေါ်ပါဘူး။ ဒါပေမဲ့ customer ကြီး တစ်ခုရဲ့ complaint ကတော့ outage တစ်ခုလောက် အရေးကြီးလို့ သူ့ account manager ကနေ အရင် ပြောရပါတယ်။
> ⟪page l16_p05b⟫ တခြား merchant တွေက ပုံစံသစ်နဲ့ အဆင်ပြေနေလို့ rollback မလုပ်ဘဲ merchant အလိုက် file ပုံစံဟောင်းကို ရွေးလို့ရတဲ့ setting ထည့်ပေးပါတယ်။ user သန်းချီ ဆိုရင်တော့ rollback ကို အရင် လုပ်ပါတယ်၊ ပြင်တာလည်း အားလုံးအတွက် တစ်ခါတည်းပါ။ customer ကြီး တစ်ခုအတွက်တော့ အရင် ပြောပြီးမှ ပြင်ပါတယ်။

On screen:

- l16_p04c (K2): settlement file ပြောင်းတဲ့ နေ့ | column တစ်ခု နေရာ ရွှေ့ | SLO အားလုံး အစိမ်း | chain ရဲ့ import script ပျက်
- l16_p05 (K2): customer ကြီး တစ်ခု အရေးကြီးရင် | complaint တစ်ခုက outage ဖြစ်နိုင် | ကတိ မပေးထားတာကို အားကိုးထား | သူ့ account manager ကို အရင် ပြော
- l16_p05b (K3, two plain columns, no better/worse colouring; cells as left / right): user သန်းချီ / customer ကြီး တစ်ခု | rollback အရင် / account manager က အရင် ပြော | အားလုံးကို ပြင် / customer အလိုက် setting

## Scene 9 · Bill Pay now and next year

chapter: Bill Pay အခုနဲ့ နောက်နှစ်

> ⟪page l16_p06⟫ သုံးလ ကြာတော့ engagement ကို ပြန်ကြည့်ပါတယ်။ အခု SRE က Bill Pay ရဲ့ မီးတွေကို ငြိမ်းပေးနေတုန်းပါ၊ စဖို့ သင့်တော်တဲ့ နေရာ ဖြစ်ပေမဲ့ အမြဲ နေရမယ့် နေရာ မဟုတ်ပါဘူး။ နောက်နှစ်မှာ Bill Pay အဖွဲ့က ကိုယ်တိုင် run ပြီး SRE က product တစ်ခုကို နက်နက် ကူတာနဲ့အတူ product တိုင်း သုံးတဲ့ ဘုံ check တွေကိုလည်း ဆောက်ပါမယ်။
> အောင်မြင်မှုကိုလည်း outage မရှိတာထက် ဘေလ် ငွေ အချိန်မီ ရောက်တာ၊ refund နည်းလာတာနဲ့ တိုင်းပြီး business ပြောင်းရင် engagement ကို ပြန်ရေးပါမယ်။

On screen:

- l16_p06 (K3, left gray / right teal; cells as left / right): Bill Pay: အခု / နောက်နှစ် | SRE က မီးငြိမ်း / သူ့ အဖွဲ့ကိုယ်တိုင် run | product 1 ခုကို နက်နက် / product တိုင်းအတွက် ဘုံ check | အောင်မြင်: outage မရှိ / အောင်မြင်: အချိန်မီ၊ refund နည်း

## Scene 10 · This week

chapter: —

> ⟪page l16_p07⟫ တခြား အဖွဲ့ တစ်ခုနဲ့ တွဲလုပ်နေရင် ဒီအပတ် ဒီ သုံးခုကို စမ်းကြည့်ပါ။ အဲဒီ အဖွဲ့နဲ့ ကိုယ့် engagement ကို စာကြောင်း ငါးကြောင်းနဲ့ ရေးကြည့်ပါ။ task တွေ မဟုတ်ဘဲ ရယူချင်တဲ့ ရလဒ် သုံးခုကို အရေးကြီးတဲ့ အစဉ်နဲ့ စီကြည့်ပါ။ ပြီးတော့ ဘယ် page ကို ဘယ်သူ ယူမလဲ ဆိုတာ အတူ သဘောတူထားပါ။

On screen:

- l16_p07 (K2): ဒီအပတ် လုပ်စရာ | engagement ကို 5 ကြောင်းနဲ့ ရေးပါ | task မဟုတ်ဘဲ ရလဒ် 3 ခု စီပါ | ဘယ် page ဘယ်သူ ယူမလဲ သဘောတူပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ Bill Pay နဲ့ တွဲလုပ်ခဲ့ပုံကို ပြန်ကြည့်ရအောင်။ ⟪select engagement⟫ engagement က SRE နဲ့ product team ဘယ်လို တွဲလုပ်မလဲ၊ ဘယ်တော့ ပြီးမလဲ ရေးထားတဲ့ သဘောတူညီချက်ပါ။ ⟪select အစဉ်စီထားတဲ့ ရလဒ်⟫ အစဉ်စီထားတဲ့ ရလဒ်က အလုပ်ကို task နဲ့ မဟုတ်ဘဲ ရလဒ်နဲ့ စီတာပါ၊ ထိပ်ဆုံးတွေကို အချိန် ကန့်သတ်ထားတဲ့ project တွေနဲ့ လုပ်ပါတယ်။
> ⟪select on-call ခွဲယူတာ⟫ on-call ခွဲယူတာက app page ကို developer က၊ database နဲ့ gateway page ကို SRE က ယူတာပါ။ ⟪select ကြိုစီစဉ်ထားတဲ့ handback⟫ ကြိုစီစဉ်ထားတဲ့ handback က ရက်စွဲ၊ runbook၊ training နဲ့ on-call ပြန်လွှဲတာပါ။ ⟪select nonfunctional requirement⟫ nonfunctional requirement က ဘယ်လောက် မြန်ရမလဲ၊ စိတ်ချရရမလဲ ဆိုတာပါ၊ ⟪select Hyrum's law⟫ Hyrum's law ကတော့ ကတိ မပေးထားတာကိုတောင် တစ်ယောက်ယောက် အားကိုးလာမယ် ဆိုတာပါ။
> ⟪select စစ်စရာ လေးခု⟫ engagement တိုင်းမှာ စစ်စရာ လေးခု ရှိပါတယ်၊ SRE ကို reliability အလုပ်ပေါ်မှာ ထားသလား၊ business ကို အကျိုး အများဆုံး ပေးသလား၊ SRE ကို အလုပ် မပိစေဘူးလား၊ တွဲလုပ်ရ လွယ်သလား ဆိုတာပါ။ ⟪select မေးခွန်း⟫ Bill Pay က pager တစ်ခုလုံး ယူပေးပါလို့ ထပ်တောင်းရင် အဲဒီအစား ဘာ ကမ်းလှမ်းမလဲ?
> ⟪pause 3s⟫ အစဉ်စီထားတဲ့ ရလဒ်တွေ၊ အတူ လုပ်မယ့် project တစ်ခုနဲ့ ပြီးမယ့် ရက် ပါတဲ့ on-call ခွဲယူမှုကို ကမ်းလှမ်းနိုင်ပါတယ်။ Module ၅ မှာ SRE အဖွဲ့ လေးယောက် ဖြစ်လာပေမဲ့ အလုပ်ချိန်ကို တိုင်းကြည့်တော့ တစ်ပတ်ရဲ့ တစ်ဝက်ကျော်က လက်နဲ့ ထပ်ခါထပ်ခါ လုပ်ရတဲ့ toil ဖြစ်နေပါတယ်။ ဘယ်ကနေ စမလဲ?

On screen:

- notes.md: # Product team နဲ့ ဘယ်လို တွဲလုပ်မလဲ | (blank line) | - engagement — SRE နဲ့ product team ဘယ်လို တွဲလုပ်မလဲ၊ ဘယ်တော့ ပြီးမလဲ ရေးထားတဲ့ သဘောတူညီချက် | - အစဉ်စီထားတဲ့ ရလဒ် — task မဟုတ်ဘဲ ရလဒ်၊ ထိပ်ဆုံးတွေကို အချိန် ကန့်သတ်ထားတဲ့ project နဲ့ လုပ် | - on-call ခွဲယူတာ — app page က developer၊ database နဲ့ gateway page က SRE | - ကြိုစီစဉ်ထားတဲ့ handback — ရက်စွဲ၊ runbook၊ training နဲ့ on-call ပြန်လွှဲ | - nonfunctional requirement — ဘယ်လောက် မြန်ရမလဲ၊ စိတ်ချရရမလဲ | - Hyrum's law — ကတိ မပေးထားတဲ့ အပြုအမူကိုတောင် တစ်ယောက်ယောက် အားကိုး | - စစ်စရာ လေးခု — reliability ပေါ်မှာလား · business အကျိုး အများဆုံးလား · SRE အလုပ် မပိဘူးလား · တွဲလုပ်ရ လွယ်လား | (blank line) | မေးခွန်း: Bill Pay က pager တစ်ခုလုံး ယူပေးပါလို့ ထပ်တောင်းရင် pager အစား ဘာ ကမ်းလှမ်းမလဲ?
