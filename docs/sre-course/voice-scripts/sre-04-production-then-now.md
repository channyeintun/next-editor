# Lesson 4 · Production ဘယ်လို ပြောင်းလဲလာလဲ

slug: sre-04-production-then-now · budget: 7600 characters (±5%)

## Scene 1 · Hook: all servers green, users can't pay

chapter: Production အရင်နဲ့ အခု

> ⟪page l04_p01⟫ reliability အတွက် လူနဲ့ အချိန် ပေးဖို့ CTO ကိုနေလင်း သဘောတူပြီးကတည်းက မသီရိက ပထမနှစ် စာရင်းကို တစ်ခုချင်း လုပ်နေပါတယ်။ တစ်ရက် ညနေမှာတော့ Bank Y ကို ငွေလွှဲတာ အကြာကြီး စောင့်နေရတယ် ဆိုတဲ့ post တွေ တက်လာတာကို support အဖွဲ့ကို ဦးဆောင်တဲ့ မစု သတိထားမိပါတယ်။
> မသီရိက dashboard ကို ဖွင့်ကြည့်တော့ status check တွေ အားလုံး up ဖြစ်ပြီး အစိမ်းရောင် ပြနေပါတယ်။ ဒါပေမဲ့ user တချို့အတွက်တော့ 2 နာရီလောက် Bank Y ကို ငွေလွှဲလို့ မရသလောက် နှေးနေခဲ့ပါတယ်။ ဒါဆို ဘယ်သူ မှန်လဲ၊ dashboard လား၊ user တွေလား?

On screen:

- l04_p01 (K1): 4 | Production ဘယ်လို ပြောင်းလဲလာလဲ | server အားလုံး အစိမ်း၊ user တွေ ငွေလွှဲမရ | status check တွေ: အားလုံး up | Bank Y ငွေလွှဲ: 2 နာရီ နှေးနေ | ဘယ်သူ မှန်လဲ? | (small loop badge, သတိထားမိ lit)

## Scene 2 · Then and now: from hand-kept servers to workloads

chapter: —

> ⟪page l04_p02⟫ ဒီမေးခွန်းကို မဖြေခင် production ဘယ်လို ပြောင်းလဲလာလဲ အရင် ကြည့်ရအောင်။ ဘယ်ဘက်က အရင်ခေတ်မှာ server တွေကို ကိုယ်တိုင် ဝယ်ပြီး တစ်လုံးချင်း လက်နဲ့ ပြုစုခဲ့ကြပါတယ်။ server အသစ် လိုရင် ticket တင်ပြီး ရက်သတ္တပတ်ချီ စောင့်ရသလို၊ system ကောင်းမကောင်းကိုလည်း server ရဲ့ uptime နဲ့ပဲ တိုင်းခဲ့ကြပါတယ်။
> ညာဘက်က အခုခေတ်မှာတော့ Padauk လို ကုမ္ပဏီ အသေးတွေကတောင် cloud ကနေ စက် ငှားပြီး code ကို container တွေ၊ request ဝင်လာမှ run တဲ့ function တွေအဖြစ် run ပါတယ်။ developer က လိုတာကို ticket မတင်ဘဲ self-service နဲ့ ကိုယ်တိုင် ယူနိုင်လို့ မိနစ်ပိုင်းပဲ ကြာပါတယ်။
> ဒီလို server တစ်လုံးချင်းအစား container၊ function လို workload တွေကို platform ပေါ်မှာ run ပြီး user ခံစားရတာကို ကြည့်တဲ့ ပုံစံကို workload-centric လို့ ခေါ်ပါတယ်။ ပြဿနာက Padauk ရဲ့ dashboard က server up လား ဆိုတဲ့ အရင်ခေတ် မေးခွန်းကိုပဲ ဖြေနေသေးတာပါ။

On screen:

- l04_p02 (K3, left gray / right teal; cells as left / right): အရင် / အခု | လက်နဲ့ ပြုစုတဲ့ server / container နဲ့ function | ticket တင်၊ ပတ်ချီ စောင့် / self-service၊ မိနစ်ပိုင်း | server uptime / user ခံစားရတာ

## Scene 3 · Capacity is now a spending decision

chapter: Capacity နဲ့ cloud bill

> ⟪close page⟫ ⟪board B1 step 1⟫ cloud ကြောင့် ပထမဆုံး ပြောင်းသွားတာက capacity ပါ။ ဒီ bar တွေက Padauk ရဲ့ လအလိုက် traffic ဖြစ်ပြီး ဧပြီလမှာ သင်္ကြန်ကြောင့် အများကြီး မြင့်ပါတယ်။ ကိုယ်ပိုင် server ခေတ်မှာတော့ စက်ရဖို့ လနဲ့ချီ ကြာလို့ တစ်နှစ်လုံးရဲ့ အမြင့်ဆုံး လကို ခံနိုင်အောင် ကြိုဝယ်ထားရပါတယ်။
> ⟪board B1 step 2⟫ ဒီ လိမ္မော်ရောင် မျဉ်းက peak အတွက် ကြိုဝယ်ထားတဲ့ capacity ပါ။ မျဉ်းအောက်က နေရာလွတ်တွေကတော့ မသုံးဘဲ အလဟဿ ဖြစ်နေတဲ့ ငွေတွေပါ။ cloud မှာတော့ သုံးသလောက်ပဲ ပေးရလို့ capacity ဆိုတာ ငွေ ဘယ်လောက် သုံးမလဲ ဆိုတဲ့ ဆုံးဖြတ်ချက် ဖြစ်လာပါတယ်။
> ⟪board B1 step 3⟫ ဒီတော့ သင်္ကြန် မတိုင်ခင် capacity တိုးပြီး ပွဲပြီးရင် ပြန်လျှော့နိုင်ပါတယ်၊ load အလိုက် စက်ကို အလိုအလျောက် တိုးပေး လျှော့ပေးတာကို autoscaling လို့ ခေါ်ပါတယ်။ ဒါပေမဲ့ peak ည တစ်ညမှာ autoscaling မှာ အကန့်အသတ် မရှိတဲ့အပြင် retry loop တစ်ခုက request တွေကို ထပ်ခါထပ်ခါ ပို့နေတော့ စက်တွေ ဆက်တိုးပြီး cloud bill 2 ဆ ဖြစ်သွားလို့ အခု အကန့်အသတ် ထည့်ထားပါပြီ။
> ငွေကိစ္စက တစ်ခါ စီစဉ်ရုံနဲ့ မပြီးပါဘူး၊ ဥပမာ merchant တွေဆီ ငွေလွှဲတဲ့ settlement job က နောက်ကျလို့ရလို့ စျေးပေါပေမဲ့ provider က ပြန်ယူနိုင်တဲ့ spot instance ပေါ်မှာ run ပြီး payment API ကိုတော့ ကြိုငှားထားတဲ့ စက်တွေပေါ်မှာ ထားပါတယ်။ database ကို provider က run ပေးတဲ့ managed service နဲ့ သုံးရင်တောင် ကိုယ့် design နဲ့ code ကတော့ ကိုယ့်တာဝန်ပါပဲ။
> cloud မှာ ပျက်ပုံကလည်း ပြောင်းလာပါတယ်။ customer တွေ မျှသုံးပြီး စက်နဲ့ setting တွေကို စီမံတဲ့ provider ရဲ့ control plane မှာ 1 နာရီလောက် ပြဿနာ တက်ရင် ထိခိုက်မယ့် နယ်ပယ်၊ blast radius က customer ထောင်ချီအထိ ကျယ်နိုင်ပါတယ်။ အဲဒီအချိန်မှာ ကိုယ့် app ဆက်အလုပ်လုပ်နိုင်အောင် ကိုယ်ပဲ ကြိုပြင်ထားရပါမယ်။

On screen:

- B1 step (1): Padauk ရဲ့ တစ်နှစ်စာ traffic (title) | ဇန်နဝါရီ | ဒီဇင်ဘာ (the two ends of the underline axis; twelve monthly blue bars) | သင်္ကြန် (over the tall April bar)
- B1 step (2): peak အတွက် ကြိုဝယ်ထား (thin orange threshold) | အလဟဿ ဖြစ်နေတဲ့ ငွေ (in the empty space under the line)
- B1 step (3): လိုသလို တိုး၊ လျှော့ (green, a stepped outline hugging the bars) | အကန့်အသတ် မရှိ + retry = bill 2 ဆ (red)

## Scene 4 · Ticket path vs golden path

chapter: Golden path နဲ့ guardrail

> ⟪board B2 step 1⟫ ဒုတိယ ပြောင်းလဲမှုက service အသစ် တစ်ခု production ရောက်ပုံပါ။ Padauk က လျှပ်စစ် မီတာခ ပေးလို့ရမယ့် Bill Pay ကို ထုတ်တော့မှာပါ။ အပေါ်ဘက်က လမ်းဟောင်းမှာ developer က ticket တင်ပြီး ops ဆီက server ကို 2 ပတ်လောက် စောင့်ရပါတယ်။ ရလာတဲ့ server မှာလည်း monitoring မပါလို့ ပျက်ရင် user တွေ မတိုင်မချင်း ဘယ်သူမှ မသိပါဘူး။
> ⟪board B2 step 2⟫ ဒါကြောင့် မသီရိက template တစ်ခု ဆောက်လိုက်ပါတယ်။ အောက်ဘက်က လမ်းသစ်မှာ developer က template ကို ရွေးလိုက်ရုံနဲ့ metric၊ alert၊ backup တွေ ပါပြီးသား service ရပါတယ်။ ဒီလို လိုက်သွားရုံနဲ့ reliability အများစု ပါလာတဲ့ standard လမ်းကို golden path လို့ ခေါ်ပါတယ်။
> lesson 1 က ပြောခဲ့တဲ့ developer က ကိုယ်ရေးတာကို ကိုယ်တိုင် run တဲ့ ပုံစံကို you build it, you run it လို့ ခေါ်ပါတယ်။ ဒါပေမဲ့ server၊ network၊ storage၊ security အားလုံးကို တစ်ယောက်တည်း မကျွမ်းကျင်နိုင်လို့ အဲဒါတွေကို platform က ထမ်းပေးမှ ဖြစ်နိုင်တာပါ။
> ⟪board B2 step 3⟫ template ထဲမှာ check တွေလည်း ပါပါတယ်။ Bill Pay ရဲ့ ပထမဆုံး deploy မှာ developer တစ်ယောက်က lesson 2 က ဝန်ဆောင်ခ typo လိုပဲ config မှာ typo ရိုက်မိပေမဲ့ check က deploy မလုပ်ခင်မှာပဲ ရပ်ပေးလိုက်ပါတယ်။ ဒီလိုနဲ့ Bill Pay က 2 ပတ် မစောင့်ရဘဲ monitoring အပြည့်နဲ့ production ရောက်သွားပြီး အဲဒီ template က Padauk ရဲ့ ပထမဆုံး golden path ဖြစ်လာပါတယ်။

On screen:

- B2 step (1): developer → ticket: 2 ပတ် → ops → server၊ monitoring မပါ (top lane; the last box red, two lines: server၊ / monitoring မပါ)
- B2 step (2): developer → template → metric၊ alert၊ backup ပါတဲ့ service (bottom lane; the last box green, three lines: metric၊ alert၊ / backup ပါတဲ့ / service, so the lane still fits once the check box joins it in step 3)
- B2 step (3): check (orange box on the bottom lane) | typo (red, stopped at the check)

## Scene 5 · Guardrails, not gates

chapter: —

> ⟪close board⟫ ⟪page l04_p03⟫ ခုနက check လို ကန့်သတ်ချက်ကို guardrail လို့ ခေါ်ပါတယ်။ လမ်းဘေးက အကာလိုပဲ အန္တရာယ်ရှိတဲ့ နေရာကို မကျော်အောင် ကာပေးပြီး ဘေးကင်းတဲ့ အလုပ်ကိုတော့ ဆက်သွားခွင့် ပေးပါတယ်။ ဂိတ်မှာဆိုရင် ပြောင်းလဲမှု တစ်ခုချင်းကို လူ တစ်ယောက်က ခွင့်ပြုတဲ့အထိ ရပ်စောင့်ရပါတယ်။ guardrail မှာတော့ check တွေကို လမ်းထဲမှာ ထည့်ထားပြီး monitoring နဲ့ backup ကလည်း အစကတည်းက ပါလို့ developer တွေ ပိုမြန်လာပေမဲ့ risk မတိုးပါဘူး။
> စည်းမျဉ်းတွေကို code နဲ့ ရေးပြီး pipeline ကို စစ်ခိုင်းလို့လည်း ရပါတယ်။ ဥပမာ မှတ်ပုံတင် အချက်အလက်တွေကို ပြည်တွင်းမှာပဲ ထားရမယ်လို့ စည်းမျဉ်းက ဆိုတယ် ဆိုပါစို့။ အဲဒီ data ကို ပြည်ပ ရောက်စေမယ့် deploy မှန်သမျှကို pipeline က တားပေးပါတယ်။

On screen:

- l04_p03 (K2): ဂိတ် မဟုတ်ဘဲ guardrail | ခွင့်ပြုချက် အစား လမ်းထဲမှာ check | monitoring နဲ့ backup အစကတည်းက ပါ | developer မြန်၊ risk မတိုး

## Scene 6 · Gray failure

chapter: Gray failure

> ⟪close page⟫ ⟪board B3 step 1⟫ ဒါဆို Bank Y ညနေကို ပြန်သွားရအောင်။ အပေါ်ဘက်က status check က server တိုင်းကို မိနစ်တိုင်း မေးကြည့်ပြီး ပြန်ဖြေရင် up လို့ ပြတာမို့ ညနေ တစ်ခုလုံး အစိမ်းရောင်ပါပဲ။ ဒါပေမဲ့ ဒီ check က server ပြန်ဖြေနိုင်သေးလားလို့ပဲ မေးတာပါ၊ user ရဲ့ ငွေလွှဲ ဘယ်လောက် ကြာလဲ ဆိုတာ မမေးပါဘူး။
> ⟪board B3 step 2⟫ အောက်ဘက်ကတော့ Android app အဟောင်းကနေ Bank Y ကို ငွေလွှဲတာတွေထဲက 5 စက္ကန့်ထက် ကြာတဲ့ ရာခိုင်နှုန်းကို မိနစ် 30 စီ ပြထားတာပါ။ လိမ္မော်ရောင် မျဉ်းက နှေးတာ 1 ရာခိုင်နှုန်းထက် မပိုရဘူး ဆိုတဲ့ ပစ်မှတ်ပါ။ lesson 3 မှာ ပြောခဲ့သလို ဒီလို သဘောတူထားတဲ့ ပစ်မှတ်ကို service level objective၊ အတိုကောက် SLO လို့ ခေါ်ပါတယ်။ ပထမ 1 နာရီမှာ 1 ရာခိုင်နှုန်း မပြည့်လို့ မျဉ်းအောက်မှာပါ။
> ⟪board B3 step 3⟫ နောက် 2 နာရီမှာတော့ 20 ရာခိုင်နှုန်းလောက်အထိ တက်သွားပြီး၊ ဒါက lesson အစက 2 နာရီပါ။ ဒီလို server တွေ up နေပေမဲ့ Android app အဟောင်း သုံးသူတွေလို user တချို့အတွက် နှေးနေတာ၊ တစ်ဝက်တစ်ပျက် ပျက်နေတာမျိုးကို gray failure လို့ ခေါ်ပါတယ်။ ငွေလွှဲ အားလုံးရဲ့ ပျမ်းမျှက ကောင်းနေတုန်းပဲ ဖြစ်ပြီး ဒုက္ခက user အုပ်စု တစ်ခုမှာပဲ စုနေလို့ dashboard မှာ မမြင်ရတာပါ။

On screen:

- B3 step (1): status check: အားလုံး UP (one green box, top lane)
- B3 step (2): Bank Y ငွေလွှဲ 5 စက္ကန့်ထက် ကြာတဲ့ % (Android app အဟောင်း) (bottom lane label, two lines) | 0.4% · 0.6% · 19% · 23% · 24% · 21% (six blue bars, one per 30 minutes) | ပစ်မှတ်: နှေးတာ 1% ထက် မပို (thin orange threshold)
- B3 step (3): the last four bars turn red | Bank Y: Android app အဟောင်း user တွေအတွက် နှေး (red)

## Scene 7 · Server says, user feels

chapter: —

> ⟪close board⟫ ⟪page l04_p04⟫ အခု အစက မေးခွန်းကို ဖြေလို့ရပါပြီ။ server ဘက်က အားလုံး up ဖြစ်နေပေမဲ့ user ဘက်ကတော့ Bank Y ကို ငွေလွှဲလို့ မရပါဘူး။ ငွေလွှဲ အားလုံးရဲ့ ပျမ်းမျှက 2 စက္ကန့်ပဲ ရှိပေမဲ့ Android app အဟောင်း user တွေထဲက 5 ယောက်မှာ 1 ယောက်က 20 စက္ကန့်လောက် စောင့်နေရလို့ dashboard အစိမ်းရောင် ဖြစ်နေချိန်မှာ ဒေါသထွက်နေတဲ့ post တွေ တက်လာတာပါ။
> နှစ်ဘက်လုံးရဲ့ ကိန်းဂဏန်းတွေ မှန်ပေမဲ့ reliability ကို ဆုံးဖြတ်တာက user ဘက်ပါ။ server ဘက်က dashboard ကိုပဲ ကြည့်နေရင် user တွေ ဒုက္ခရောက်ပြီး post တင်မှ သိရပါတယ်။ user ဘက်ကနေ တိုင်းထားရင်တော့ နှေးတာ 1 ရာခိုင်နှုန်း ကျော်တာနဲ့ သိရလို့ post တွေ မတက်ခင် ပြင်ဖို့ အချိန် ရပါသေးတယ်။

On screen:

- l04_p04 (K3, left gray / right teal; cells as left / right): server က ပြောတာ / user က ခံစားရတာ | အားလုံး up / Bank Y ကို ငွေလွှဲမရ | ပျမ်းမျှ 2 စက္ကန့် / 5 ယောက်မှာ 1 ယောက် 20 စက္ကန့် | အစိမ်းရောင် dashboard / ဒေါသထွက်နေတဲ့ post တွေ

## Scene 8 · Seeing production now

chapter: —

> ⟪page l04_p05⟫ အဲဒီညနေက မသီရိက အချိန် ဘယ်မှာ ကုန်နေလဲ ရှာဖို့ service တိုင်းရဲ့ log ကို တစ်ခုပြီး တစ်ခု ဖွင့်ခဲ့ရပါတယ်။ ငွေလွှဲ request တစ်ခုက gateway၊ payment service၊ ဘဏ် ဆိုပြီး ဖြတ်သွားတာမို့ အစအဆုံး ခြေရာခံပေးတဲ့ trace ရှိရင် ဘယ်နေရာ နှေးနေလဲ မိနစ်ပိုင်းနဲ့ မြင်ရမှာပါ။
> ပြဿနာကို အရင်ဆုံး ပြနိုင်တာက metric အများကြီး မဟုတ်ဘဲ ငွေလွှဲရဲ့ SLO ပါ၊ SLO လွဲမှ အသေးစိတ်ကို ဝင်ရှာရပါတယ်။ metric မှာ ဖုန်းနံပါတ်လို label ထည့်မိရင် metric အရေအတွက် အဆမတန် များလာပြီး bill တက်တတ်လို့ label ကို နည်းနည်းပဲ ထားသင့်ပါတယ်။ data ကိုလည်း support အဖွဲ့ပါ ကြည့်လို့ရအောင် မျှသုံးပါ။ ဒါတွေကို lesson 8 မှာ ဆက်လေ့လာပါမယ်။

On screen:

- l04_p05 (K2): production ကို ကြည့်ပုံ | request တစ်ခုကို service တွေ ဖြတ်ပြီး လိုက်ကြည့် | SLO အရင်၊ လွဲမှ အသေးစိတ် ရှာ | metric label နည်းနည်း၊ data မျှသုံး

## Scene 9 · This week

chapter: —

> ⟪page l04_p06⟫ ဒီအပတ်အတွက်ကတော့ အဖွဲ့ သေးသေးလေးမှာတောင် လုပ်လို့ရတာ သုံးခုပါ။ ပထမ၊ app version အဟောင်း ဒါမှမဟုတ် ဘဏ် တစ်ခုတည်းအတွက်ပဲ နှေးနေတာမျိုး၊ dashboard မမြင်ရတဲ့ failure တစ်ခုကို ရှာကြည့်ပါ။ ဒုတိယ၊ ကိုယ့် autoscaling မှာ အကန့်အသတ် ရှိလား စစ်ကြည့်ပါ။ တတိယ၊ service အသစ် တစ်ခု စဆောက်တာကနေ production ရောက်တဲ့အထိ ဘယ်လောက် ကြာလဲ အချိန် မှတ်ကြည့်ပါ။

On screen:

- l04_p06 (K2): ဒီအပတ် လုပ်စရာ | dashboard မမြင်ရတဲ့ failure တစ်ခု ရှာပါ | autoscaling မှာ အကန့်အသတ် ရှိလား စစ်ပါ | service အသစ် production ရောက်ချိန် မှတ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ ဒီနေ့ အချက် ငါးခုကို notes ထဲမှာ စုထားပါတယ်။ ⟪select workload-centric⟫ workload-centric က server တစ်လုံးချင်းအစား workload နဲ့ user ဘက်က ရလဒ်ကို ကြည့်တာပါ။ ⟪select golden path⟫ golden path က template ကို ရွေးရုံနဲ့ metric၊ alert၊ backup ပါလာတဲ့ standard လမ်းပါ။ ⟪select guardrail⟫ guardrail က ခွင့်ပြုချက် စောင့်ရတဲ့ ဂိတ် မဟုတ်ဘဲ လမ်းထဲက check ပါ။
> ⟪select gray failure⟫ gray failure က server တွေ up နေပေမဲ့ user အုပ်စု တစ်ခုအတွက် နှေးနေတာမျိုးပါ။ ⟪select user ဘက်က တိုင်းတာ⟫ ဒါကြောင့် reliability ကို user ဘက်ကနေ တိုင်းထားမှ စောစော သိပြီး ပြင်ချိန် ရပါတယ်။ ကဲ၊ ဒီ lesson ရဲ့ မေးခွန်းပါ။ ကိုယ့် dashboard က အစိမ်းရောင် ပြနေတုန်းမှာ user အုပ်စု တစ်ခုရဲ့ request 20 ရာခိုင်နှုန်းက နှေးနေတယ်။ ဒါ ဘယ်လို failure မျိုးလဲ?
> ⟪pause 3s⟫ ဒါက gray failure ပါ။ နောက် lesson ကတော့ ည 9 နာရီမှာ စပါမယ်။ promo ကြီး မစခင်မှာ SMS code တွေ နှေးလာတာကို developer ကိုမင်း သတိထားမိပါတယ်။ သူက အဖွဲ့ထဲ ရောက်တာ မကြာသေးသလို ပြီးခဲ့တဲ့လကလည်း သူ့မေးခွန်းကို တစ်ယောက်က ရယ်ခဲ့ဖူးပါတယ်။ ကိုမင်း ပြောရဲပါ့မလား?

On screen:

- notes.md: # Production ဘယ်လို ပြောင်းလဲလာလဲ | (blank line) | - workload-centric — server တစ်လုံးချင်းထက် workload နဲ့ user ရလဒ်ကို ကြည့် | - golden path — template နဲ့ ဘေးကင်းတဲ့ standard လမ်း | - guardrail — ခွင့်ပြုချက် အစား လမ်းထဲက check | - gray failure — server up၊ user တချို့အတွက် နှေး | - user ဘက်က တိုင်းတာ — server မဟုတ်ဘဲ user ခံစားရတာကို တိုင်း | (blank line) | မေးခွန်း: dashboard က အစိမ်း၊ ဒါပေမဲ့ user အုပ်စု တစ်ခုရဲ့ request 20% က နှေးနေတယ်။ ဒါ ဘယ်လို failure လဲ?
