# Lesson 20 · Capacity ဘယ်လောက် လိုမလဲ

slug: sre-20-capacity-planning · budget: 8400 characters (±5%)

## Scene 1 · Hook: Thingyan is six weeks away

chapter: သင်္ကြန် ရောက်ဖို့ ခြောက်ပတ်

> ⟪page l20_p01⟫ ခေါ်သုံးတဲ့ service တိုင်းက version အလိုက် ကိန်းဂဏန်းကို မြင်ရပြီး loyalty fault test ကိုလည်း ညတိုင်း run ပါတယ်။ အခု သင်္ကြန် ရောက်ဖို့ ခြောက်ပတ်ပဲ လိုပါတော့တယ်။ ပြီးခဲ့တဲ့ နှစ်က ညသန်းခေါင်မှာ တစ်စက္ကန့်ကို request ၃၀၀၀ အတွက်ပဲ တည်ဆောက်ထားတဲ့ Top-up ဆီ ၂၀၀၀၀ လောက် ဝင်လာခဲ့ပြီး အများစုက retry တွေပါ။
> တချို့က server ကို ခုနစ်ဆ တိုးချင်ပေမဲ့ finance အဖွဲ့က ပွဲရက် အနည်းငယ်အတွက် ဒီလောက် ငွေ မသုံးချင်ပါဘူး။ ဒီနှစ်အတွက် ဘယ်လောက်အထိ ပြင်ဆင်ထားရမလဲ?
> ⟪page l20_p01b⟫ ဒီ မေးခွန်းကို ဖြေဖို့ user တွေ လိုချင်မယ့် အလုပ်ပမာဏ၊ demand နဲ့ ကိုယ် ပေးနိုင်တဲ့ resource၊ supply ကို ချိန်ပြီး မလောက်ရင် risk ဘယ်လောက် လက်ခံမလဲ ဆုံးဖြတ်ရပါတယ်၊ ဒီလို ကြိုပြင်ဆင်တာက capacity planning ပါ။

On screen:

- l20_p01 (K1): 20 | Capacity ဘယ်လောက် လိုမလဲ | သင်္ကြန် ရောက်ဖို့ ခြောက်ပတ် | ပြီးခဲ့တဲ့နှစ်: တစ်စက္ကန့် request 20,000 | Top-up ကို တည်ဆောက်ထားတာ: 3,000 | ဘယ်လောက်အထိ ပြင်ဆင်ထားရမလဲ? | (small loop badge, တည်ဆောက် lit)
- l20_p01b (K4): သုံးခုကို တွဲစဉ်းစား | demand: ဘယ်လောက် လာမလဲ | supply: ဘယ်လောက် ပေးနိုင်လဲ | risk: ဘယ်လောက် လက်ခံမလဲ

## Scene 2 · Is planning worth it?

chapter: Plan လုပ်ဖို့ တန်လား

> ⟪page l20_p02⟫ ဒါပေမဲ့ လေးယောက်ပဲ ရှိတဲ့ မသီရိရဲ့ အဖွဲ့က service တိုင်းကို plan မလုပ်နိုင်လို့ တန်မတန် အရင် မေးရပါတယ်။ ဥပမာ support အဖွဲ့ရဲ့ admin tool လို သေးပြီး ခဏ နှေးလည်း ရတဲ့ service မှာ autoscaling နဲ့ အပို နည်းနည်း ထားတာက engineer အချိန်ထက် သက်သာပါတယ်။ Wallet နဲ့ Top-up လို ကြီးပြီး ငွေနဲ့ ဆိုင်တဲ့ service တွေကတော့ ကြို plan လုပ်ရပါမယ်။
> ⟪page l20_p02b⟫ capacity ဆုံးဖြတ်ချက်တိုင်းမှာ မြန်တာ၊ ဈေးသက်သာတာ၊ မပျက်တာ ဆိုတဲ့ သုံးခုကို ချိန်ရပြီး ဘယ်လို ချိန်မလဲ ဆိုတာကို engineer အကြိုက်နဲ့ မဟုတ်ဘဲ business က ဆုံးဖြတ်ပါတယ်။ spike တိုင်းအတွက် စက်တွေကို အမြဲ ပိုထားရင် ငွေ အလဟဿ ဖြစ်မှာမို့ lesson ၆ မှာ SLO ရဲ့ ပျက်ခွင့်၊ error budget ကို သဘောတူခဲ့သလိုပဲ capacity မလောက်မယ့် risk ကိုလည်း တမင် ရွေးရပါတယ်။

On screen:

- l20_p02 (K2): အရင်ဆုံး: plan လုပ်ဖို့ တန်လား | သေးပြီး နှေးလည်း ရ: autoscale၊ အပို ဝယ် | ကြီးပြီး အရေးကြီး: ကြို plan | လက်ခံမယ့် risk ကို ရွေး
- l20_p02b (K4): ချိန်ရမယ့် သုံးခု | မြန်တာ: စောင့်စရာ မလို | ဈေးသက်သာတာ: bill နဲ့ လူ့အချိန် | မပျက်တာ: peak မှာ ရပ်တည်

## Scene 3 · The forecast fan

chapter: Forecast ဆိုတာ range

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒါဆို Top-up မှာ ဘယ်လောက် လာမလဲ? အရင် data ကနေ ခန့်မှန်းတဲ့ forecast မှာ demand ကို သုံးမျိုး ခွဲကြည့်ပါတယ်။ ပထမက user အသစ်တွေကြောင့် တဖြည်းဖြည်း တက်တာမို့ ပြီးခဲ့တဲ့ သုံးလပတ် နှစ်ခုက တက်နှုန်းအတိုင်း ဆက်ဆွဲရုံပါပဲ။
> ⟪board B1 step 2⟫ ဒုတိယက လစာထုတ်ရက်၊ သင်္ကြန်၊ operator promotion လို ကြိုသိတဲ့ event တွေမို့ ပြက္ခဒိန်ထဲ ချရေးထားရပါတယ်။ bar တိုင်းမှာ အပြာက ဖြစ်နိုင်ဆုံး၊ ခရမ်းက ဖြစ်လာနိုင်တဲ့ အမြင့်ဆုံးပါ၊ ဝေးဝေး ကြည့်လေ မသေချာလေမို့ ခရမ်းက ရှည်လာပါတယ်။ ဒီလို ဂဏန်း တစ်ခုတည်း မပေးဘဲ ခန့်မှန်းတာကို forecast range လို့ ခေါ်ပါတယ်။
> ⟪board B1 step 3⟫ ပြီးခဲ့တဲ့ နှစ်ရဲ့ forecast ကို တကယ် ဖြစ်ခဲ့တာနဲ့ ပြန်တိုက်ကြည့်တော့ သင်္ကြန်ညရဲ့ top-up အရေအတွက်ကို ပုံမှန် peak ရဲ့ ၂ ဆလို့ ခန့်မှန်းခဲ့ပေမဲ့ တကယ်က ၂.၆ ဆ ဖြစ်ခဲ့ပါတယ်။ ဒါကြောင့် ငွေပေးချေတဲ့ လမ်းကြောင်းအတွက် range ရဲ့ အမြင့်ဘက်အထိ ပြင်ဆင်ပါတယ်။
> ⟪board B1 step 4⟫ တတိယကတော့ တခြား wallet app တစ်ခု ပျက်သွားလို့ သူ့ user တွေ ရုတ်တရက် ပြောင်းလာတာလို ဘယ် forecast ကမှ မဖမ်းနိုင်တဲ့ အရာတွေပါ။ ဒါတွေကို အပို capacity၊ buffer နဲ့ အရေးမကြီးတာ ပိတ်ပြီး demand လျှော့တာနဲ့ ရင်ဆိုင်ရပေမဲ့ ဘယ်အထိ ပြင်ဆင်မလဲ ကြိုသတ်မှတ်ရပါတယ်။ စက် မှာတာကနေ သုံးလို့ရတဲ့အထိ ကြာချိန်၊ lead time တိုတာကတော့ ပိုတိကျတဲ့ ခန့်မှန်းချက်ထက်တောင် တန်ဖိုးရှိပါတယ်။

On screen:

- B1 step (1), cleared (P5 bars; underline axis): Top-up forecast (title, furniture) | ပြီးခဲ့တဲ့ သုံးလပတ် 2 ခု (two blue bars at the left, slowly rising)
- B1 step (2): ဖြစ်နိုင်ဆုံး (blue lower part of four forecast bars) | ဖြစ်လာနိုင် (violet extension on each bar, widening to the right) | သင်္ကြန် (the tallest forecast bar, labelled)
- B1 step (3): ပြီးခဲ့တဲ့နှစ်: forecast 2× · တကယ် 2.6× (orange note above the သင်္ကြန် bar)
- B1 step (4): မမျှော်လင့်တာ (red bar at the right end) | buffer + demand လျှော့ (red note under it)

## Scene 4 · Plan in top-ups, not CPUs

chapter: CPU မဟုတ်ဘဲ top-up နဲ့ တွက်

> ⟪close board⟫ ⟪page l20_p03⟫ forecast ကို CPU တွေ၊ request တွေနဲ့ မတွက်ဘဲ top-up နဲ့ တွက်ပါတယ်၊ request ထဲမှာ retry တွေ ရောနေတတ်ပြီး product နဲ့ finance အဖွဲ့ကလည်း top-up ဆိုမှ နားလည်လို့ပါ။ top-up ၁၀၀၀ ခုအတွက် cloud ကို ကျပ် ဘယ်လောက် ပေးရလဲ ဆိုတဲ့ အချိုးကိုလည်း ကြည့်ပါတယ်။
> ⟪page l20_p03b⟫ top-up အရေအတွက် မတက်ဘဲ ဒီ အချိုး ခုန်တက်ရင် regression တစ်ခုက capacity ကို စားနေတာပါ။ ဥပမာ app version အသစ်က status ကို ပိုခဏခဏ မေးလာလို့ အချိုး ၃၀ ရာခိုင်နှုန်း ခုန်တက်တာကို alert က ဖမ်းမိလို့ သင်္ကြန် မတိုင်ခင် ပြင်လိုက်ပါတယ်။
> ⟪page l20_p03c⟫ ဒါပေမဲ့ forecast က လိုချင်သမျှ ပါတဲ့ wish list ပါ။ supply နဲ့ budget ထဲမှာ တကယ် ဝယ်မယ်လို့ သဘောတူထားတာကတော့ plan of record ပါ၊ provider က လိုတာရဲ့ ၈၀ ရာခိုင်နှုန်းပဲ အချိန်မီ ပေးနိုင်လို့ plan က ပိုနည်းပါတယ်။ ကွာဟချက်ကို ဆုံးရှုံးနိုင်တဲ့ top-up နဲ့ တွက်ပြတော့ business က rewards screen လို အပိုတွေကို ညသန်းခေါင်မှာ ခဏ ပိတ်ဖို့ ကြိုဆုံးဖြတ်ပါတယ်။
> ⟪page l20_p03d⟫ supply ဘက်မှာလည်း ဘယ်နေရာမှာမဆို run လို့ရလား၊ lesson ၄ က ပြည်တွင်း စည်းမျဉ်းလို တစ်ခုခုက နေရာ ကန့်သတ်ထားလား၊ lead time ဘယ်လောက်လဲ၊ ဘယ်အထိ တိုးပြီး ပြန်လျှော့နိုင်လဲ မေးရပြီး တစ်ရက်အတွင်း ရနိုင်တာနဲ့ အများဆုံး ရနိုင်တာကိုလည်း သိထားရပါမယ်။

On screen:

- l20_p03 (K2): CPU မဟုတ်ဘဲ top-up နဲ့ တွက် | top-up 1,000 ခုရဲ့ cloud ကျပ် | top-up မတက်ဘဲ ခုန်ရင် regression | wish list နဲ့ plan: ကွာဟချက်ကို ဈေးတွက်
- l20_p03b (K7): top-up 1,000 ခုရဲ့ cloud ကုန်ကျစရိတ် | +30% | app အသစ်က status ကို ခဏခဏ မေး
- l20_p03c (K3, left gray / right teal; cells as left / right): Wish list / Plan of record | လိုချင်သမျှ / တကယ် ဝယ်မယ့် အစီအစဉ် | အကန့်အသတ် မထည့် / provider ပေးနိုင်တာ 80% | ကွာဟချက် မမြင်ရ / အပိုတွေ ကြိုပိတ်
- l20_p03d (K4): Supply ကို မေးရမယ့် သုံးခု | ဘယ်မှာ: နေရာမရွေး run ရလား | ဘယ်လောက်ကြာ: lead time | ဘယ်အထိ: တိုး၊ ပြန်လျှော့

## Scene 5 · Zone arithmetic

chapter: Zone တစ်ခု ပျက်ရင်

> ⟪close page⟫ ⟪board B2 step 1⟫ Wallet က zone သုံးခုထဲက နှစ်ခုမှာပဲ instance ၆ ခုစီ run ပြီး peak မှာ ၆၅ ရာခိုင်နှုန်းစီ သုံးနေပါတယ်။ zone တစ်ခုက ပြဿနာ တစ်ခုတည်းကြောင့် အတူတူ ပျက်နိုင်တဲ့ failure domain ပါ။ ကိုဇော် တွက်ကြည့်တော့ zone တစ်ခု ပျက်ရင် ကျန်တဲ့ ၆ ခုက ၁၂ ခုစာ ထမ်းရလို့ ၁၃၀ ရာခိုင်နှုန်း ဖြစ်ပြီး ပြိုသွားမှာပါ။
> ⟪board B2 step 2⟫ ဒါကြောင့် Wallet ကို zone သုံးခုလုံးမှာ instance ၅ ခုစီ ဖြန့်လိုက်ပါတယ်၊ ၃ ခုပဲ ထပ်တိုးရတာပါ။ ပုံမှန်မှာ ၅၂ ရာခိုင်နှုန်းစီပဲ သုံးပြီး zone တစ်ခု ပျက်ရင်တောင် ကျန်တဲ့ ၁၀ ခုက ၇၈ ရာခိုင်နှုန်းနဲ့ ခံနိုင်ပါတယ်။
> ⟪board B2 step 3⟫ zone နှစ်ခုတည်းဆိုရင် failover ဖြစ်တဲ့အခါ ကျန်တဲ့ zone က database connection တွေပါ နှစ်ဆ ဖြစ်တတ်ပါတယ်။ ဒါကြောင့် ကျန်တဲ့ zone တွေမှာရော database မှာပါ load ကို ခံနိုင်လောက်တဲ့ နေရာ ကြိုထားရပါမယ်။
> ⟪board B2 step 4⟫ failover လုပ်ဖို့ သုံးမယ့် console နဲ့ scaling API ကိုယ်တိုင်ကလည်း ပျက်တဲ့ zone ထဲမှာ ရှိနေနိုင်ပါတယ်။ ဒါကြောင့် traffic လွှဲတဲ့ drain အဆင့်တွေကို playbook ထဲ ရေးပြီး သင်္ကြန် မတိုင်ခင် တကယ် လေ့ကျင့်ထားပါတယ်။
> ⟪board B2 step 5⟫ cloud ကလည်း အကန့်အသတ်မဲ့ မဟုတ်ပါဘူး၊ သင်္ကြန်ညမှာ တခြား ကုမ္ပဏီတွေလည်း တစ်ပြိုင်နက် စက် တောင်းကြမှာမို့ autoscaling ကို အားမကိုးဘဲ ကြိုငှားထားပါတယ်။ စည်းမျဉ်းကတော့ test ကလွဲရင် ဘယ် service မှ zone တစ်ခုတည်းမှာ မ run ရပါဘူး။

On screen:

- B2 step (1), cleared: Wallet: zone 2 ခု × instance 6 · 65% (two blue boxes, top row) | (red strike on one zone) | ကျန်တဲ့ zone: 130% (red)
- B2 step (2): zone 3 ခု × instance 5 · 52% (+3) (three blue boxes, second row) | (strike on one zone) | 78% (green)
- B2 step (3): database connection ×2 (orange) | ကျန်တဲ့ zone တွေမှာ နေရာ ကြိုထား (green label across the bottom)
- B2 step (4): drain: playbook ထဲ ရေး၊ ကြိုလေ့ကျင့် (orange note, two lines)
- B2 step (5): သင်္ကြန်အတွက် ကြိုငှား · test ကလွဲရင် zone တစ်ခုတည်း မရ (orange note, two lines)

## Scene 6 · Peak of sums

chapter: Pool တစ်ခုတည်း မျှသုံး

> ⟪close board⟫ ⟪board B3 step 1⟫ ပြင်ဆင်ရင်း မသီရိ တွေ့တာက အဖွဲ့တိုင်း ကိုယ့် peak အတွက် server တွေကို သီးသန့် ကြိုငှားထားတာပါ၊ Wallet ၂၀၊ Eats ၃၀၊ Top-up ၁၅ လုံးပါ။ ဒါပေမဲ့ Wallet က နေ့လယ် ၁၂ နာရီ၊ Eats က ည ၇ နာရီ၊ Top-up က ညသန်းခေါင်မှာ peak ရောက်ပါတယ်။
> ⟪board B3 step 2⟫ peak တွေကို ပေါင်းရင် ၆၅ လုံးဖြစ်ပြီး ဒါကို sum of peaks လို့ ခေါ်ပါတယ်။ traffic ကို အချိန်အလိုက် ပေါင်းပြီးမှ ကြည့်ရင်တော့ အမြင့်ဆုံး အချိန်မှာတောင် ၄၀ လုံးပဲ လိုပြီး ဒါက peak of sums ပါ။ ဒါကြောင့် pool တစ်ခုကို မျှသုံးပြီး buffer ထည့်ရင် ၄၆ လုံးလောက်နဲ့ လုံလောက်ပါတယ်၊ အဖွဲ့တစ်ခုစီ သုံးခွင့်ရှိတဲ့ အများဆုံး ပမာဏ၊ quota ကိုတော့ pool ထဲကနေ ခွဲပေးပါတယ်။
> ⟪board B3 step 3⟫ ဒါပေမဲ့ အဖွဲ့အားလုံး တစ်ပြိုင်နက် ပိုတောင်းရင် pool ထဲမှာ ဘာမှ မကျန်တော့ပါဘူး။ ဒါကြောင့် peak တွေ ထပ်နိုင်တဲ့ သင်္ကြန်ညကိုတော့ သီးသန့် event အဖြစ် plan လုပ်ပါတယ်။
> ⟪board B3 step 4⟫ ပေးရတဲ့ resource ထဲက တကယ် သုံးတဲ့ ရာခိုင်နှုန်း၊ utilization ကို ပေးရတာ လျှော့ပြီးဖြစ်စေ၊ အသုံးဝင်တဲ့ အလုပ် ပိုလုပ်ပြီးဖြစ်စေ မြှင့်နိုင်ပါတယ်။ ဒါပေမဲ့ zone အပိုနဲ့ database ရဲ့ အရန် replica လို စက်တွေက တမင် အားနေအောင် ထားတာပါ၊ utilization လှအောင် အဲဒါတွေကိုပါ ဖြည့်ပစ်ရင် တကယ် ပျက်တဲ့နေ့ ခံစရာ မကျန်တော့ပါဘူး။

On screen:

- B3 step (1), cleared (P6 lanes): Wallet · 12:00 | Eats · 19:00 | Top-up · 00:00 (three lanes, one blue peak block each at its own hour)
- B3 step (2): သီးသန့်: 65 (blue total bar) | မျှသုံး: 40 + buffer ≈ 46 (violet total bar)
- B3 step (3): အားလုံး တစ်ပြိုင်နက် တောင်းရင် ဘာမှ မကျန် (red note)
- B3 step (4): utilization = သုံးတာ ÷ ပေးရတာ (blue) | zone အပို: တမင် ချန်ထား (orange)

## Scene 7 · Keep batch away from payments

chapter: —

> ⟪close board⟫ ⟪page l20_p04⟫ pool ကို မျှသုံးရင် settlement report ထုတ်တဲ့ job တွေက ငွေပေးချေမှုကို မနှေးစေဖို့လည်း စီစဉ်ရပါတယ်။ report တွေကို ဈေးပေါတဲ့ သီးခြား စက်တွေပေါ် ထားရင် ရိုးရှင်းပြီး အာမခံချက် ခိုင်ပေမဲ့ စက် ထပ်ပေးရလို့ ပိုကုန်ပါတယ်။
> pool တစ်ခုတည်းမှာ ဦးစားပေး label တပ်ပြီး ငွေပေးချေမှုကို အမြဲ အရင် ဖြေရင်တော့ သက်သာပေမဲ့ label မှားရင် report တွေက ငွေပေးချေမှုကို နှေးစေနိုင်ပါတယ်။ Padauk ကတော့ lesson ၄ ကတည်းက settlement job တွေကို provider က ပြန်ယူနိုင်တဲ့ spot instance ပေါ်မှာ ခွဲ run နေပါတယ်။

On screen:

- l20_p04 (K3, left gray / right teal; cells as left / right): Report job ကို ငွေပေးချေမှုနဲ့ ခွဲထား | သီးခြား စက် / pool + ဦးစားပေး label | ရိုးရှင်း၊ အာမခံချက် ခိုင် / ဈေးသက်သာ၊ label ကောင်းဖို့ လို | ကုန်ကျစရိတ် ပိုများ / report က ငွေပေးချေမှုကို နှေးစေနိုင်

## Scene 8 · Our degradation profile

chapter: Degradation profile

> ⟪page l20_p05⟫ capacity မလောက်တဲ့ ညစာချိန်အတွက် Eats အဖွဲ့က load ဘယ်လောက် ရောက်ရင် ဘာကို အရင် ပိတ်မလဲ၊ ဘာကို ဘယ်တော့မှ မပိတ်ဘူးလဲ ကြိုရေးထားပါတယ်၊ ဒါကို degradation profile လို့ ခေါ်ပါတယ်။ capacity ရဲ့ ၁၀၀ ရာခိုင်နှုန်းမှာ နည်းနည်း နှေးတာကို လက်ခံပါတယ်၊ ၁၂၀ မှာ အကြံပြု menu လို အပိုတွေ ပိတ်ပြီး ၁၅၀ မှာ order အသစ်တွေကို တန်းစီ စောင့်ခိုင်းပါတယ်။ ငွေပေးချေမှုကိုတော့ ဘယ်တော့မှ မပျောက်စေရပါဘူး။
> ⟪page l20_p05b⟫ ပြီးခဲ့တဲ့ သောကြာ ညစာချိန်မှာ load ၁၃၀ ရာခိုင်နှုန်း ရောက်တော့ အကြံပြု menu ပိတ်သွားပေမဲ့ order နဲ့ ငွေပေးချေမှု အားလုံး ပြီးခဲ့ပါတယ်။ request တိုင်းမှာ ဘယ်လောက် အရေးကြီးလဲ ဆိုတဲ့ label ပါလို့ ဝန်ပိုရင် အရင် ငြင်းလို့ရတဲ့ sheddable request တွေကိုပဲ ရွေးပိတ်နိုင်တာပါ။
> ⟪page l20_p05c⟫ စက် ထပ်တိုးတာထက် demand လျှော့တာက ပိုသက်သာပေမဲ့ ငြင်းလိုက်တဲ့ request တိုင်းကို ရေတွက်ထားမှ မနှင်းက ဆုံးရှုံးတဲ့ အရောင်းကို တွက်ပြီး server ထပ်ငှားမလား ဆုံးဖြတ်နိုင်ပါတယ်။ capacity မလောက်တဲ့ incident အတွက် playbook ကိုလည်း ကြိုရေးထားပါတယ်။

On screen:

- l20_p05 (K6): Eats ရဲ့ degradation profile | 100%: နည်းနည်း နှေး | 120%: အပိုတွေ ပိတ် | 150%: order တန်းစီ | ဘယ်တော့မှ: ငွေပေးချေမှု မပျောက်
- l20_p05b (K7): သောကြာ ညစာချိန် | 130% | အကြံပြု menu ပိတ်၊ order နဲ့ ငွေပေးချေမှု အကုန် ရ
- l20_p05c (K2): ကြိုပြင်ထားပါ | demand လျှော့တာက စက်တိုးတာထက် သက်သာ | ငြင်းတဲ့ request တိုင်းကို ရေတွက် | capacity incident: playbook ကြိုရေး

## Scene 9 · What capacity really costs

chapter: တကယ့် ကုန်ကျစရိတ်

> ⟪page l20_p06⟫ capacity ရဲ့ ကုန်ကျစရိတ်ကလည်း cloud bill တစ်ခုတည်း မဟုတ်ပါဘူး။ ကြိုငှားပြီး အားနေတဲ့ server တွေ၊ engineer တွေရဲ့ နာရီတွေ၊ မလောက်လို့ ဆုံးရှုံးတဲ့ order တွေကိုပါ ပေါင်းတွက်ရပါတယ်။
> ⟪page l20_p06b⟫ ဒီတော့ Padauk က သင်္ကြန်အတွက် server ကို ခုနစ်ဆ မတိုးခဲ့ပါဘူး။ plan of record အတိုင်း ကြိုငှားတယ်၊ Wallet ကို zone သုံးခုလုံးမှာ ဖြန့်တယ်၊ အဖွဲ့တွေ pool တစ်ခုကို မျှသုံးတယ်၊ ကျော်လာရင် ဘာကို ပိတ်မလဲ degradation profile မှာ ရေးထားပါတယ်။ capacity planning ဆိုတာ risk ဘယ်လောက် ထမ်းမလဲ ရွေးတာမို့ failure ကိုလည်း ခဏခဏ စမ်းရပြီး product နဲ့ finance အဖွဲ့နဲ့ အတူ ဆုံးဖြတ်ရပါတယ်။

On screen:

- l20_p06 (K5): Capacity ရဲ့ တကယ့် ကုန်ကျစရိတ် | cloud bill | ကြိုငှားပြီး အားနေတဲ့ စက် | engineer နာရီ | ဆုံးရှုံးတဲ့ order
- l20_p06b (K2): Padauk ရဲ့ သင်္ကြန် plan | plan of record အတိုင်း ကြိုငှား | Wallet: zone 3 ခု · pool မျှသုံး | ကျော်ရင်: degradation profile

## Scene 10 · This week

chapter: —

> ⟪page l20_p07⟫ လစာထုတ်ရက်၊ ပွဲတော်၊ promotion လို ကိုယ့် peak ရက်တွေကို ဒီအပတ် ပြက္ခဒိန် တစ်ခုထဲ ချရေးပါ။ အမြင့်ဆုံး peak မှာ zone တစ်ခု ပျက်ရင် ကျန်တာတွေ ခံနိုင်လား တွက်ကြည့်ပါ။ ပြီးတော့ request ၁၀၀၀ ခုအတွက် cloud ကို ကျပ် ဘယ်လောက် ပေးရလဲ စပြီး မှတ်ထားပါ။

On screen:

- l20_p07 (K2): ဒီအပတ် လုပ်စရာ | peak ပြက္ခဒိန် ရေးပါ | peak မှာ zone တစ်ခု ပျက်ရင် ခံနိုင်လား? | request 1,000 ခုရဲ့ cloud ကျပ် မှတ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ သင်္ကြန် ပြင်ဆင်ရင်း သိခဲ့တာတွေပါ။ ⟪select forecast range⟫ forecast range က demand ကို ဂဏန်း တစ်ခုတည်းအစား အနိမ့်ကနေ အမြင့်အထိ ခန့်မှန်းတာ ဖြစ်ပြီး၊ ⟪select plan of record⟫ plan of record က wish list မဟုတ်ဘဲ တကယ် ဝယ်မယ်လို့ သဘောတူထားတဲ့ အစီအစဉ်ပါ။ ⟪select ကျန်တဲ့ zone တွေမှာ နေရာ ကြိုထား⟫ zone တစ်ခု ပျက်ရင် ကျန်တဲ့ zone တွေ load ကို ခံနိုင်အောင် နေရာ ကြိုထားရပါမယ်။
> ⟪select peak of sums⟫ peak of sums က ပေါင်းထားတဲ့ traffic ရဲ့ peak ဖြစ်လို့ peak တွေကို ပေါင်းတာထက် နည်းပါတယ်။ ⟪select utilization⟫ utilization က ပေးရတဲ့ resource ထဲက တကယ် သုံးနေတဲ့ ရာခိုင်နှုန်းဖြစ်ပြီး၊ ⟪select degradation profile⟫ degradation profile ကတော့ load ဘယ်လောက်မှာ ဘာကို ပိတ်မလဲ၊ ဘာကို ဘယ်တော့မှ မပိတ်ဘူးလဲ ကြိုရေးထားတာပါ။
> ⟪select မေးခွန်း⟫ ကိုဇော် တွက်ခဲ့တဲ့ ပုစ္ဆာကို ဂဏန်း ပြောင်းပြီး မေးပါမယ်။ zone နှစ်ခုမှာ instance ၁၂ ခုက ၆၀ ရာခိုင်နှုန်းစီ သုံးနေတုန်း zone တစ်ခု ပျက်သွားရင် ကျန်တဲ့ instance တွေက load ဘယ်လောက် ထမ်းရမလဲ?
> ⟪pause 3s⟫ ကျန်တဲ့ ၆ ခုက ၁၂ ခုစာ ထမ်းရလို့ ၁၂၀ ရာခိုင်နှုန်းပါ။ သင်္ကြန် ပြင်ဆင်နေတုန်းမှာပဲ မစုရဲ့ support အဖွဲ့ဆီ user တစ်ယောက်က သူ့ account ကို ဖျက်ပေးပါလို့ တောင်းဆိုလာပါတယ်။ သူ့ data တွေက တကယ်တော့ ဘယ်မှာ ရှိနေလဲ?

On screen:

- notes.md: # Capacity ဘယ်လောက် လိုမလဲ | (blank line) | - forecast range — demand ကို ဂဏန်း တစ်ခု မဟုတ်ဘဲ အနိမ့်ကနေ အမြင့်အထိ ခန့်မှန်း | - plan of record — wish list မဟုတ်၊ တကယ် ဝယ်မယ့် capacity အစီအစဉ် | - ကျန်တဲ့ zone တွေမှာ နေရာ ကြိုထား — zone တစ်ခု ပျက်ရင် ကျန်တာတွေ load ကို ခံနိုင်ရမယ် | - peak of sums — ပေါင်းထားတဲ့ traffic ရဲ့ peak၊ peak တွေ ပေါင်းတာထက် နည်း | - utilization — ပေးရတဲ့ resource ထဲက တကယ် သုံးနေတဲ့ ရာခိုင်နှုန်း | - degradation profile — load ဘယ်လောက်မှာ ဘာ ပိတ်မလဲ၊ ဘာ ဘယ်တော့မှ မပိတ်ဘူးလဲ | (blank line) | မေးခွန်း: zone 2 ခု၊ instance 12 ခု၊ 60% စီ။ zone တစ်ခု ပျက်ရင် ကျန်တဲ့ instance တွေက ဘယ်လောက် ထမ်းရမလဲ?
