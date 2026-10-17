# Lesson 32 · SRE ရဲ့ ရှေ့ခရီး

slug: sre-32-the-road-ahead · budget: 8400 characters (±5%)

## Scene 1 · Hook: the year-end review, uptime said nothing

chapter: နှစ်ကုန် review

> ⟪page l32_p01⟫ ညသန်းခေါင် incident နောက်မှာ Padauk က incident commander ရဲ့ လုပ်ပိုင်ခွင့်၊ အကာအကွယ် ပါတဲ့ break-glass access နဲ့ vendor ရှေ့က gateway ကို ရလာခဲ့ပါတယ်။ ဒီ နောက်ဆုံး lesson မှာတော့ နှစ်ကုန် review ကနေ Site Reliability Engineering၊ SRE ရဲ့ ရှေ့ခရီးကို ကြည့်ပါမယ်။
> ⟪page l32_p01b⟫ review က Wallet ရဲ့ နောက်ဆုံး သုံးလ uptime နဲ့ စပါတယ်။ ပထမ နှစ်လက ၉၉.၉၄ နဲ့ ၉၉.၉၅ ရာခိုင်နှုန်း ဆိုတော့ အားလုံး စိတ်အေးနေခဲ့ကြပါတယ်။ ဒါပေမဲ့ တတိယလမှာ config ပြောင်းလဲမှု တစ်ခုကို zone အားလုံးဆီ တစ်ပြိုင်နက် push လုပ်လိုက်တော့ ငွေလွှဲတာ ၂ နာရီလောက် ရပ်သွားပြီး ၉၉.၇၁ ရာခိုင်နှုန်းကို ကျသွားပါတယ်။ ဘာလို့ ကြိုမမြင်ခဲ့ကြတာလဲလို့ ကိုနေလင်းက မေးပါတယ်။ uptime က ရှေ့ကို ဘာမှ မပြောခဲ့ရင် ဘာက ကြိုပြောနိုင်မလဲ?

On screen:

- l32_p01 (K1): 32 | SRE ရဲ့ ရှေ့ခရီး | Uptime က နောက်ကိုပဲ ကြည့်တယ် | သုံးလ: 99.94 · 99.95 · 99.71% | ဘယ်ဟာမှ ရှေ့ကို မပြော · risk က အရင် ရှိနှင့် | ဘာက ကြိုပြောနိုင်မလဲ? | (small loop badge, the whole loop lit)
- l32_p01b (K6): Wallet uptime၊ နောက်ဆုံး သုံးလ | လ 1: 99.94% | လ 2: 99.95% | လ 3: 99.71% | (caption) ဘာက ကြိုပြောနိုင်မလဲ?

## Scene 2 · Leading vs trailing

chapter: Leading နဲ့ trailing

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒီ မေးခွန်းကို ဖြေဖို့ မသီရိက incident ပြီးတိုင်း ဘာဖြစ်ခဲ့လဲ ပြန်ရေးတဲ့ postmortem တွေနဲ့ ကံကောင်းလို့သာ incident မဖြစ်ခဲ့တဲ့ near miss တွေကို ပြန်ကြည့်ပါတယ်။ တွေ့ထားပြီး မပြင်ရသေးတဲ့ risk တွေက outage မတိုင်ခင်ကတည်းက ၁၂ ခု၊ ၁၉ ခု၊ ၂၇ ခု ဆိုပြီး လတိုင်း တက်လာနေခဲ့တာပါ။
> ⟪board B1 step 2⟫ uptime ကတော့ ပထမ နှစ်လ ငြိမ်နေပြီး outage ဖြစ်တော့မှပဲ ကျသွားပါတယ်။ risk တွေ စုလာနေတုန်း uptime လို availability ကိန်းဂဏန်းတွေက မလှုပ်ဘဲ user တွေ တကယ် ထိခိုက်ပြီးမှပဲ ပြောင်းတာပါ။
> ⟪board B1 step 3⟫ ဒီလို ဖြစ်ပြီးမှ တိုင်းလို့ရတဲ့ ကိန်းဂဏန်းကို trailing indicator၊ risk လို ပြဿနာ မဖြစ်ခင် ကြိုပြတဲ့ အချက်ကို leading indicator လို့ ခေါ်ပါတယ်။ availability ကို တိုင်းတဲ့ SLO အများစုလည်း trailing indicator တွေပါ၊ အသုံးမဝင်လို့ မဟုတ်ဘဲ ဖြစ်ပြီးသားကိုပဲ ပြနိုင်လို့ပါ။
> lesson ၁ မှာ သင်္ကြန် အကြိုည ပြီးတော့ Padauk ရေးခဲ့တဲ့ ဖြတ်လမ်း အကြွေး စာရင်းကို မှတ်မိသေးလား? အဲဒါက Padauk ရဲ့ ပထမဆုံး risk စာရင်းပါ၊ အကြွေးနဲ့ risk က outage မတိုင်ခင် အရင် ပေါ်တတ်လို့ပါ။

On screen:

- B1 step (1), cleared (P5 bars, three months): မပြင်ရသေးတဲ့ risk (title) | 12 · 19 · 27 (three rising blue bars)
- B1 step (2): Wallet uptime: 99.94% · 99.95% (two level green bars to the right) | 99.71% (red third bar)
- B1 step (3): leading (blue label over the risk bars) | trailing (ink label over the uptime bars)

## Scene 3 · Thiri's risk sheet

chapter: မသီရိရဲ့ risk sheet

> ⟪board B2 step 1⟫ မသီရိက တစ်နှစ်စာ postmortem ၃၁ ခုနဲ့ near miss ၁၂ ခုထဲက တွေ့သမျှ risk ကို spreadsheet တစ်ခုထဲ စုပါတယ်။ risk တစ်ခုချင်း ဘယ်လောက် ဖြစ်နိုင်လဲ၊ ဖြစ်ရင် ဘယ်လောက် ထိခိုက်မလဲ ရေးထားတဲ့ ဒီ စာရင်းက risk sheet ပါ။
> ⟪board B2 step 2⟫ ပြီးတော့ incident နဲ့ risk တစ်ခုစီကို retry၊ capacity လို ကြိုသတ်မှတ်ထားတဲ့ အမျိုးအစား တစ်ခုစီ ပေးပါတယ်။ incident ၃၁ ခုကို ရေတွက်ကြည့်တော့ retry ကြောင့် ၇ ခု၊ capacity မလောက်လို့ ၅ ခု၊ တခြား ၈ ခု ထွက်လာပါတယ်။
> ⟪board B2 step 3⟫ ကျန်တဲ့ ၁၁ ခုကတော့ config ကို check မလုပ်ဘဲ နေရာတိုင်းဆီ တစ်ပြိုင်နက် push လုပ်တာကနေ လာပါတယ်။ အဖွဲ့တိုင်းမှာ push ပုံ ကိုယ်စီ ရှိလို့ မတူသလို ထင်ရပေမဲ့ incident သုံးခုမှာ တစ်ခုလောက်က ပုံစံ တစ်ခုတည်းကနေ လာနေတာပါ။
> ⟪board B2 step 4⟫ ဒါကြောင့် အဖွဲ့တိုင်းကို သီးသန့် ပြင်ခိုင်းမယ့်အစား Wallet၊ Top-up၊ Eats အားလုံး သုံးတဲ့ shared config service ထဲမှာ check နဲ့ zone တစ်ခုပြီးမှ တစ်ခု ဖြန့်တဲ့ rollout ကို တစ်ခါတည်း ထည့်လိုက်ပါတယ်။ ဒါက lesson ၂၅ က shift down၊ reliability အလုပ်ကို developer တစ်ယောက်ချင်းဆီ မပုံဘဲ platform ထဲ ထည့်ပေးတာပါ၊ developer တိုင်းကို အကုန် သယ်ခိုင်းရင် ဘယ်သူမှ မနိုင်လို့ပါ။
> ⟪board B2 step 5⟫ risk ရှာတာကိုလည်း ဆက်လုပ်ရပါတယ်။ အခု postmortem တိုင်းရဲ့ အဆုံးမှာ တွေ့ခဲ့တဲ့ risk တွေ ဆိုတဲ့ ခေါင်းစဉ် ပါလာပြီး ဒီ incident နဲ့ မဆိုင်တဲ့ risk ကိုတောင် ချရေးပါတယ်။ design review မှာလည်း လူတွေရော agent တွေပါ risk အသစ်တွေ ထပ်ရှာပေးပါတယ်။

On screen:

- B2 step (1), cleared (P5 bars, furniture): risk sheet (title) | postmortem 31 · near miss 12 (box under the title)
- B2 step (2): retry: 7 | capacity: 5 | တခြား: 8 (three blue bars)
- B2 step (3): config push: 11 (the tallest bar, blue, circled; the four bars add up to 31)
- B2 step (4), cleared: Wallet · Top-up · Eats (one row of labels) | shared config service / check + zone အလိုက် rollout (wide green slab under the row, two lines)
- B2 step (5): postmortem: "တွေ့ခဲ့တဲ့ risk" | design review: လူ + agent (two orange labels under the slab)

## Scene 4 · What Padauk kept, what it changed

chapter: ထိန်းထားတာနဲ့ ပြောင်းလိုက်တာ

> ⟪close board⟫ ⟪page l32_p02⟫ နောက်နှစ်အတွက် ဘာ ပြင်ဆင်ရမလဲလို့ ကိုနေလင်း မေးတော့ မသီရိက အဖြေကို နှစ်ပိုင်း ခွဲပြပါတယ်။ လူကို အပြစ်မရှာတဲ့ blameless review၊ user journey ပေါ်က SLO နဲ့ ပြဿနာ ရှိရင် rollback ကို အရင်လုပ်တဲ့ အလေ့အထကို ဆက်ထိန်းထားပါတယ်။ ပြောင်းသွားတာကတော့ code ကို ဘယ်သူ ရေးလဲ၊ service ဘယ်နှခု run လဲ ဆိုတာနဲ့ အပတ်စဉ် release train ပါ။
> ⟪page l32_p02b⟫ လူတွေက မိဘဆီ ငွေပို့တာလို နေ့စဉ် ကိစ္စတွေကို Padauk နဲ့ လုပ်လာလေ ပျက်တဲ့ တစ်မိနစ်ရဲ့ တန်ဖိုး ကြီးလာလေမို့ ဒီ အလုပ်က နှစ်တိုင်း ပိုအရေးကြီးလာမှာပါ။ ရှေ့ကို ဘယ်သူမှ တိတိကျကျ မသိနိုင်လို့ သတိနဲ့ပဲ ခန့်မှန်းရပေမဲ့ ဒီနေ့ အလေ့အထတွေ သက်သက်နဲ့တော့ agent တွေ ပါလာတဲ့ နောက်တစ်ဆင့်မှာ မလုံလောက်ပါဘူး။ user တွေ ယုံလို့ရတဲ့ service ဆိုတဲ့ ပန်းတိုင်က မပြောင်းပေမဲ့ အဲဒီကို ရောက်တဲ့ နည်းတွေကိုတော့ ပြန်စဉ်းစားနေရပါမယ်။

On screen:

- l32_p02 (K3, left gray / right teal; cells as left / right): ထိန်းထားတာ / ပြောင်းလိုက်တာ | blameless review / code ရေးတဲ့သူ | journey ပေါ်က SLO / service အရေအတွက် | rollback အရင် / release train
- l32_p02b (K2): ဒီအလုပ် ပိုအရေးကြီးလာမယ် | Padauk ကို အားကိုးသူ နှစ်တိုင်း များလာ | ရှေ့ကို သတိနဲ့ ခန့်မှန်း | ဒီနေ့ အလေ့အထ သက်သက်နဲ့ မလုံလောက်

## Scene 5 · The release train

chapter: Release train

> ⟪close page⟫ ⟪board B3 step 1⟫ ဥပမာ Padauk ရဲ့ အပတ်စဉ် release train က တစ်ပတ်လုံးက ပြောင်းလဲမှုတွေကို တစ်တွဲတည်း စုပြီး တစ်ရက်တည်းမှာ ထုတ်ပါတယ်။ coding agent တွေ ရောက်လာတော့ တစ်တွဲမှာ ပြောင်းလဲမှုက ၉၀ လောက်ကနေ ၆၀၀ လောက် ဖြစ်လာပါတယ်။ ငွေလွှဲ တချို့ fail လာတဲ့ ပတ်မှာ ဘယ်ဟာကြောင့်လဲ ရှာရတာ နာရီနဲ့ချီ ကြာပြီး တစ်တွဲလုံး rollback လုပ်ရင်လည်း Bank X စောင့်နေတဲ့ fix ကိုပါ ပြန်ဖြုတ်ရမှာပါ။
> ⟪board B3 step 2⟫ ဒါကြောင့် Padauk က train ကို ဖျက်ပြီး ပြောင်းလဲမှု တစ်ခုချင်းကို ကိုယ်ပိုင် pipeline နဲ့ ပို့ပါတယ်။ test တွေ အောင်ရင် canary အဆင့် ရောက်ပါတယ်၊ version အသစ်ကို traffic ၁ ရာခိုင်နှုန်းဆီ အရင် ပို့ပြီး version ဟောင်းနဲ့ နှိုင်းယှဉ်တဲ့ အဆင့်ပါ။ ကောင်းမှ အားလုံးဆီ ဖြန့်ပြီး ပျက်နေရင် အဲဒီ တစ်ခုတည်းကို ဖမ်းမိလို့ သူ့ကိုပဲ rollback လုပ်ပါတယ်။
> ⟪board B3 step 3⟫ ဒီ လမ်းကြောင်းကို ပြောင်းလဲမှု ၆၀၀ လုံးက တစ်ခုစီ သီးသန့် ဖြတ်ပါတယ်။ code များလာလေ release ကို သေးသေးလေးတွေ ခွဲထုတ်ရလေ ဖြစ်ပြီး လူ့ အမြန်နှုန်းအတွက် ဆောက်ထားတဲ့ tool တွေကိုလည်း agent တွေနဲ့ ကိုက်အောင် ပြန်ဒီဇိုင်း ဆွဲရပါတယ်။

On screen:

- B3 step (1), cleared (P6 lanes, top lane): အပတ်စဉ် release train: ပြောင်းလဲမှု ~600 (big red box) | ဘယ်ဟာက ပျက်စေတာလဲ? (red text under it)
- B3 step (2) (bottom lane, P1 flow): change → tests → 1% → all | ပျက်တာ တစ်ခုတည်း ဖမ်းမိ (green label under the 1% box)
- B3 step (3): × 600၊ တစ်ခုစီ သီးသန့် (violet label beside the bottom lane)

## Scene 6 · Before any deploy

chapter: Deploy မလုပ်ခင်

> ⟪close board⟫ ⟪page l32_p02c⟫ agent တွေကြောင့် service တွေလည်း ၃၅ ခုကနေ ၉၀ အထိ များလာပါတယ်။ တစ်ညမှာ top-up တွေ နှေးလို့ on-call က လိုက်ရှာတော့ top-up လမ်းကြောင်းထဲမှာ agent ဆောက်ခဲ့တဲ့ operator balance checker ဆိုတဲ့ service ကို တွေ့ပါတယ်။ owner မရှိလို့ ဘယ်သူ့ကို နှိုးရမလဲ၊ ဘာက သူ့ကို မှီနေလဲ ဘယ်သူမှ မသိပါဘူး။
> ⟪page l32_p03⟫ ဒါကြောင့် အခု ဘယ် service မဆို deploy မလုပ်ခင် owner၊ အရေးပါမှုနဲ့ dependency တွေကို စာရင်းလုပ်ထားတဲ့ service catalog ထဲမှာ entry ရှိရပါမယ်။ နာမည်ပါတဲ့ owner နဲ့ rollback လုပ်နည်း မပါရင် pipeline က deploy ကို လက်မခံပါဘူး။
> ⟪page l32_p03b⟫ agent တွေ production ထဲမှာ ကိုယ်တိုင် အလုပ်လုပ်လာတာက ရှေ့လာမယ့် အကြီးဆုံး ပြောင်းလဲမှု ဖြစ်နိုင်ပြီး လူတွေက ကိုယ်တိုင် လုပ်တာကနေ ကြီးကြပ်တာဆီ ရွှေ့လာပါတယ်။ ကြီးကြပ်တယ် ဆိုတာ ထိုင်ကြည့်နေရုံ မဟုတ်ဘဲ ပန်းတိုင် ပေးတာ၊ အထောက်အထား စစ်တာ၊ approve လုပ်တာ၊ လိုရင် ရပ်လိုက်တာပါ။ မကြုံဖူးတဲ့ ပြဿနာ အသစ်တွေကိုတော့ လူတွေကပဲ ဝင်ယူရပါတယ်။

On screen:

- l32_p02c (K7): service အရေအတွက် | 35 → 90 | တစ်ခုမှာ owner မရှိခဲ့
- l32_p03 (K2): Deploy မလုပ်ခင် | catalog entry | နာမည်ပါတဲ့ owner | rollback လုပ်နည်း
- l32_p03b (K6): ကြီးကြပ်တာက အလုပ် | ပန်းတိုင် ပေး | အထောက်အထား စစ် | approve | ရပ်

## Scene 7 · What Padauk learned to value

chapter: Padauk တန်ဖိုးထားလာတာ

> ⟪page l32_p04⟫ review အဆုံးမှာ မသီရိက Padauk တန်ဖိုးထားလာတဲ့ အရာ သုံးခုကို ရေးပါတယ်။ မသိတာကို မသိဘူးလို့ ဖွင့်ပြောတာ၊ တခြားသူ ဆက်လုပ်နိုင်အောင် စာနဲ့ ချရေးတာနဲ့ ဘေးကင်းတဲ့ လမ်းကို အလွယ်ဆုံး လမ်း ဖြစ်အောင် လုပ်တာပါ။ ဒါဆိုရင် reliability က မှတ်ထားရမယ့် စည်းကမ်း မဟုတ်တော့ဘဲ အလိုလို ရနေတဲ့ default ဖြစ်လာပါတယ်။
> ⟪page l32_p04b⟫ မသီရိရဲ့ အလုပ်လည်း ပြောင်းသွားပါတယ်။ သင်္ကြန် မတိုင်ခင် သူ မထိဖူးတဲ့ rider dispatch system ကို စစ်ရတော့ code ကို ထိုင်ဖတ်မယ့်အစား agent တွေကို ဒီသင်တန်းက principle တွေနဲ့ စစ်ခိုင်းပါတယ်။ call တိုင်းမှာ timeout ရှိလား၊ load များရင် request တချို့ကို ငြင်းတဲ့ load shedding ရှိလား၊ deploy တိုင်း canary ကို ဖြတ်လား၊ အရန်လမ်း fallback ရှိလား ဆိုတာပါ။
> ⟪page l32_p04c⟫ agent တွေ ယူလာတဲ့ အထောက်အထားကို ကြည့်ပြီး မသီရိက သင်္ကြန် မတိုင်ခင် ပြင်မယ့် နှစ်ခုကို ရွေးပါတယ်။ ဒီလို နယ်ပယ် တစ်ခုတည်းမှာ နက်တာထက် system အများကြီးကို principle တွေနဲ့ ကြည့်ပြီး agent တွေကို လမ်းညွှန်တဲ့ SRE ကို generalist လို့ ခေါ်ပါတယ်။ ဘာကြောင့်လဲ မေးတတ်တာ၊ အလွှာ အများကြီးကို နည်းနည်းစီ သိတာနဲ့ အဖြေ မရှင်းချိန်မှာ ကောင်းကောင်း ဆုံးဖြတ်တတ်တာကတော့ ဘယ်ခေတ်မှာမဆို အသုံးဝင်ပါတယ်။
> ⟪page l32_p04d⟫ service တွေ များလာတုန်း toil က ၄၅ ရာခိုင်နှုန်းအထိ ပြန်တက်ခဲ့ပေမဲ့ အခု ၁၅ ရာခိုင်နှုန်းပဲ ကျန်ပြီး တစ်ပတ်ကို page ဝင်တာလည်း ၂၀ ကနေ ၆ ခုအထိ လျော့သွားပါတယ်၊ အဖွဲ့က လူ အတူတူပါပဲ။ AI ကြောင့် အလုပ်အကိုင်တွေ ဘယ်လို ပြောင်းမလဲ စိုးရိမ်တာ သဘာဝကျပြီး ဘယ်သူမှလည်း ကတိ မပေးနိုင်ပါဘူး။ Padauk မှာတော့ အလုပ် မပျောက်သွားဘဲ ပုံစံ ပြောင်းသွားပြီး ပိုခက်တဲ့ ပြဿနာတွေအတွက် အချိန် ရလာပါတယ်။

On screen:

- l32_p04 (K4): Padauk တန်ဖိုးထားလာတာ | မသိတာကို မသိဘူး ပြော | တခြားသူ လုပ်နိုင်အောင် ချရေး | ဘေးကင်းတဲ့ လမ်းကို အလွယ်ဆုံး ဖြစ်အောင်
- l32_p04b (K5): မသီရိရဲ့ principle check | timeout | load shedding | canary | fallback
- l32_p04c (K2): Generalist | system အများကြီးကို principle နဲ့ ကြည့် | agent က အထောက်အထား ယူလာ | သင်္ကြန် မတိုင်ခင် ပြင်စရာ 2 ခု
- l32_p04d (K7): toil | 45% → 15% | page တစ်ပတ် 20 → 6၊ လူ အတူတူ

## Scene 8 · The course on one loop

chapter: Loop ပေါ်က ခရီး

> ⟪close page⟫ ⟪board B4 step 1⟫ ဒါဆို ဒီသင်တန်း တစ်ခုလုံးကို Padauk ရဲ့ reliability loop၊ ပြဿနာ ဖြစ်တိုင်း ပတ်ရတဲ့ စက်ဝိုင်းပေါ်မှာ နောက်ဆုံး တစ်ပတ် ပတ်ကြည့်ရအောင်။ ခရီးက lesson ၁ ရဲ့ သင်္ကြန် အကြိုညကနေ စခဲ့တာပါ၊ အဲဒီတုန်းက top-up တွေ ငွေ နှစ်ခါ ဖြတ်နေပြီး SRE တစ်ယောက်မှ မရှိသေးပါဘူး။
> ⟪board B4 step 2⟫ သဘောတူတဲ့ အဆင့်မှာ finance က ၁၀၀ ရာခိုင်နှုန်း လိုချင်ခဲ့ပေမဲ့ Top-up အတွက် ၉၉.၅ ရာခိုင်နှုန်း SLO ကို သဘောတူခဲ့ပါတယ်။ သတိထားမိတဲ့ အဆင့်မှာ SLO တွေ အစိမ်းရောင် ဖြစ်နေရက်နဲ့ Eats order တွေ ရပ်နေခဲ့လို့ journey တစ်ခုလုံးကို တိုင်းတတ်လာပါတယ်။
> ⟪board B4 step 3⟫ တုံ့ပြန်တဲ့ အဆင့်မှာ လစာထုတ်ရက် top-up incident ကို role တွေ ခွဲပြီး handle လုပ်ခဲ့တယ်၊ သင်ယူတဲ့ အဆင့်မှာ ကိုနေလင်း ဝင်ထိုင်ခဲ့တဲ့ blameless review ရှိခဲ့တယ်၊ တည်ဆောက်တဲ့ အဆင့်မှာတော့ သင်ခန်းစာတွေကို platform ထဲ ထည့်ခဲ့ပါတယ်။
> ⟪board B4 step 4⟫ ဒီ loop ကို လည်စေခဲ့တာ tool တွေ မဟုတ်ဘဲ အလယ်က လူတွေပါ။ သတင်းဆိုး ပြောဖို့ ချီတုံချတုံ ဖြစ်ခဲ့တဲ့ ကိုမင်းက အခု Padauk Parcel ရဲ့ SRE ဖြစ်နေပြီး reliability ကို အပိုတာဝန်အဖြစ် စခဲ့တဲ့ မသီရိကလည်း generalist ဖြစ်လာပါပြီ။ reliability က ဘယ်တော့မှ ပြီးမသွားလို့ ဒီ loop လည်း မရပ်ပါဘူး။

On screen:

- B4 step (1), cleared (the Padauk loop as furniture, no drawMs): Padauk reliability loop | သဘောတူ | သတိထားမိ | တုံ့ပြန် | သင်ယူ | တည်ဆောက် | လူတွေ (the doll in the hub)
- B4 step (2): check at သဘောတူ | check at သတိထားမိ
- B4 step (3): check at တုံ့ပြန် | check at သင်ယူ | check at တည်ဆောက်
- B4 step (4): circle around လူတွေ (the hub; checks and the circle only, the station stories are spoken, not drawn, so the board stays inside the 9-label limit)

## Scene 9 · Your next step

chapter: နောက်တစ်လှမ်း

> ⟪close board⟫ ⟪page l32_p05⟫ သင်တန်း ပြီးသွားပေမဲ့ ကိုယ့်အဖွဲ့မှာ ဒီလ စလုပ်လို့ရတာ သုံးခု ရှိပါတယ်။ နောက် postmortem ရဲ့ အဆုံးမှာ တွေ့ခဲ့တဲ့ risk တွေ ဆိုတဲ့ ခေါင်းစဉ် ထည့်ပါ။ spreadsheet တစ်ခုနဲ့ ကိုယ့် risk sheet ကို စပြီး risk တိုင်းကို အမျိုးအစား ပေးကြည့်ပါ။ ပြီးတော့ lesson တစ်ခုကို ရွေးပြီး ဒီလအတွင်း ကိုယ့်အဖွဲ့နဲ့ စမ်းကြည့်ပါ။

On screen:

- l32_p05 (K2): နောက်တစ်လှမ်း | postmortem မှာ "တွေ့ခဲ့တဲ့ risk" ထည့်ပါ | risk sheet တစ်ခု စပါ | ဒီလ lesson တစ်ခု စမ်းပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ နှစ်ကုန် review ကနေ မှတ်စရာတွေပါ။ ⟪select leading indicator⟫ leading indicator က outage မဖြစ်ခင် ကြိုပြတဲ့ risk လို အချက်ပါ။ ⟪select risk sheet⟫ risk sheet က risk တွေကို အမျိုးအစားနဲ့ တစ်နေရာတည်း စုထားလို့ အကြီးဆုံး ပုံစံကို မြင်ပြီး တစ်ခါတည်း ပြင်နိုင်စေပါတယ်။
> ⟪select service catalog⟫ service catalog က service တိုင်းရဲ့ owner နဲ့ dependency ကို deploy မလုပ်ခင် စာရင်းသွင်းထားတာပါ။ ⟪select generalist⟫ generalist က principle တွေနဲ့ agent တွေကို လမ်းညွှန်တဲ့ SRE ဖြစ်ပြီး၊ ⟪select reliability loop⟫ reliability loop ကတော့ အလယ်က လူတွေ လည်စေတဲ့ အဆင့် ငါးဆင့် စက်ဝိုင်းပါ။
> ⟪select မေးခွန်း⟫ သင်တန်းရဲ့ နောက်ဆုံး မေးခွန်းပါ။ ဒီနေ့ ကိုယ့်အဖွဲ့က reliability loop ရဲ့ ဘယ်အဆင့်မှာ အားအနည်းဆုံးလဲ၊ ဒီအပတ်မှာ လုပ်နိုင်တဲ့ ခြေလှမ်း တစ်ခုက ဘာလဲ?
> ⟪pause 3s⟫ အဖြေ မှန် တစ်ခုတည်း မရှိပါဘူး၊ အရေးကြီးတာက အဆင့် တစ်ခုကို ရွေးပြီး ခြေလှမ်း သေးသေးလေး တစ်ခုနဲ့ စလိုက်တာပါ။ Padauk ရဲ့ ဇာတ်လမ်းက ဒီမှာ မပြီးသေးပါဘူး၊ reliability လိုပဲ ဆက်သွားနေမှာပါ။ ဒီသင်တန်းကို အဆုံးထိ လိုက်ကြည့်ပေးလို့ ကျေးဇူးတင်ပါတယ်။

On screen:

- notes.md: # SRE ရဲ့ ရှေ့ခရီး | (blank line) | - leading indicator — outage မဖြစ်ခင် ကြိုပြတဲ့ အချက်၊ risk လို | - risk sheet — risk တွေကို နေရာ တစ်ခု၊ အမျိုးအစားနဲ့ စု၊ အကြီးဆုံး ပုံစံကို တစ်ခါ ပြင် | - service catalog — service တိုင်းရဲ့ owner နဲ့ dependency၊ deploy မလုပ်ခင် | - generalist — principle တွေနဲ့ agent တွေကို လမ်းညွှန်တဲ့ SRE | - reliability loop — သဘောတူ → သတိထားမိ → တုံ့ပြန် → သင်ယူ → တည်ဆောက်၊ အလယ်မှာ လူတွေ | (blank line) | မေးခွန်း: ကိုယ့်အဖွဲ့က loop ရဲ့ ဘယ်အဆင့်မှာ အားအနည်းဆုံးလဲ? ဒီအပတ် လုပ်နိုင်တဲ့ ခြေလှမ်း တစ်ခုက ဘာလဲ?
