# Lesson 22 · Backup ထက် restore က ပိုအရေးကြီးတယ်

slug: sre-22-backups-and-restores · budget: 8400 characters (±5%)

## Scene 1 · Hook: a bug older than our backups

chapter: Backup ထက် အသက်ကြီးတဲ့ bug

> ⟪page l22_p01⟫ ဆရာမရဲ့ စာကြောင့် Padauk က data catalog၊ ဖျက်တဲ့ pipeline နဲ့ synthetic test data ကို စသုံးလိုက်ပါတယ်။ ဒီလကုန် စာရင်းပိတ်တော့ finance အဖွဲ့က Wallet ရဲ့ cashback စုစုပေါင်း မကိုက်တာကို တွေ့ပါတယ်။
> ⟪page l22_p01b⟫ ခြေရာခံကြည့်တော့ ၁၁ ရက်အရင်က deploy လုပ်ခဲ့တဲ့ cashback code က round လုပ်ပုံ မှားပြီး wallet တွေထဲ ကျပ် အနည်းငယ်စီ လွဲထည့်နေတာပါ။ မသီရိက bug မဝင်ခင်က backup ကို restore လုပ်ချင်ပေမဲ့ backup တွေကို ၇ ရက်စာပဲ သိမ်းထားပါတယ်။ ဒါဆို နောက်ပြန် ဘယ်အထိ သွားလို့ ရမလဲ?

On screen:

- l22_p01 (K1): 22 | Backup ထက် restore က ပိုအရေးကြီးတယ် | backup ထက် အသက်ကြီးတဲ့ bug | လကုန်: cashback စုစုပေါင်း မကိုက် | (small loop badge, တည်ဆောက် lit)
- l22_p01b (K1): 22 | Backup ထက် restore က ပိုအရေးကြီးတယ် | backup ထက် အသက်ကြီးတဲ့ bug | cashback rounding: ရက် 11 မှ တွေ့ | backup သိမ်းထားတာ: 7 ရက် | နောက်ပြန် ဘယ်အထိ သွားနိုင်လဲ? | (small loop badge, တည်ဆောက် lit)

## Scene 2 · How far back

chapter: နောက်ပြန် ဘယ်အထိ

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒီ lesson မှာ data incident သုံးခုကို ဖြစ်ခဲ့တဲ့ အစဉ်အတိုင်း ကြည့်ပါမယ်။ အပြာရောင် အမှတ်တွေက ညတိုင်း ယူတဲ့ backup၊ data ရဲ့ သီးခြား မိတ္တူတွေပါ၊ အဲဒီကနေ ပြန်ယူတာက restore ပါ။ အနီရောင်က bug ဝင်လာတဲ့ နေ့ပါ၊ bug ကြောင့် မှားတဲ့ data တွေက error မပြဘဲ database copy တိုင်းကို ချက်ချင်း ရောက်သွားပါတယ်။
> ⟪board B1 step 2⟫ bug ကို ၁၁ ရက်မြောက်မှ သတိထားမိပါတယ်၊ ညတိုင်း balance စစ်တဲ့ check က ကျပ် အနည်းငယ် ကွာတာကို lesson ၂၁ က ပုံမှန် reconciliation လို့ ယူဆပြီး ညှိပေးနေခဲ့လို့ပါ။ ၇ ရက်စာပဲ သိမ်းလို့ အဟောင်းဆုံး backup တောင် bug ဝင်ပြီး ၄ ရက်ကြာမှ ယူထားတာပါ။
> ⟪board B1 step 3⟫ ဒါကြောင့် ဘယ် backup မှ bug မဝင်ခင် အချိန်ကို မမီပါဘူး။ backup ကို bug သတိထားမိဖို့ ကြာတဲ့ အချိန်ထက် ပိုကြာကြာ သိမ်းရပေမဲ့ ထာဝရတော့ မသိမ်းနိုင်ပါဘူး၊ lesson ၂၁ က ဖျက်ရမယ့် deadline တွေနဲ့ storage ကုန်ကျစရိတ်က ကန့်သတ်ပါတယ်။ ပြီးတော့ backup ရှိနေရင်တောင် နောက်ဆုံး backup ယူပြီးမှ ဝင်လာတဲ့ write တွေကို ဆုံးရှုံးနိုင်ပါသေးတယ်။
> ⟪board B1 step 4⟫ ဒီတစ်ခါ ကယ်လိုက်တာက ledger ပါ။ ရေးပြီးသား entry ကို မပြင်ဘဲ အသစ်ပဲ ထပ်ရေးတဲ့ append-only စာရင်းမို့ ပြန်ညှိတဲ့ entry အသစ်တွေနဲ့ ပြင်နိုင်ခဲ့ပါတယ်။ ⟪board B1 step 5⟫ balance check ကိုလည်း batch နဲ့ မရှင်းနိုင်တဲ့ ကွာဟချက် တစ်ခုပဲ ရှိရှိ alert တက်အောင် ပြင်လိုက်ပါတယ်၊ စောစော သိလေ ပြင်ရ သက်သာလေပါ။

On screen:

- B1 step (1), cleared (P8 timeline, underline axis, short tick rectangles): ညတိုင်း backup (blue ticks above the axis, one label) | rounding bug (red tick near the left, label below)
- B1 step (2): သိ: ရက် 11 (orange tick at the right, label below) | backup သိမ်းထား: 7 ရက် (orange outline bar above the last seven ticks, starting after the bug)
- B1 step (3): နောက်ပြန် မရောက်နိုင် (red text under the bug)
- B1 step (4): ledger: ပြန်ညှိတဲ့ entry အသစ် (green box under the right end)
- B1 step (5): ညှိတာ 1 ခု = alert (orange text beside the green box)

## Scene 3 · Two numbers

chapter: RPO နဲ့ RTO

> ⟪close board⟫ ⟪page l22_p02⟫ ပြီးတော့ မသီရိက tool တွေ ဘာလုပ်နိုင်လဲ ဆိုတာကနေ မစဘဲ မနှင်းနဲ့ finance အဖွဲ့ကို ငွေ data အတွက် မေးခွန်း နှစ်ခု မေးပါတယ်။ ပထမက ဘယ်လောက် ကြာချိန်စာ data ကို ဆုံးရှုံးခံနိုင်လဲ ဆိုတာပါ၊ ဒါကို recovery point objective၊ RPO လို့ ခေါ်ပါတယ်။ ဒုတိယက service ပြန်ကောင်းဖို့ ဘယ်လောက်အထိ ကြာခွင့်ရှိလဲ ဆိုတဲ့ recovery time objective၊ RTO ပါ။
> ⟪page l22_p02b⟫ သူတို့က ledger အတွက် RPO ကို မိနစ်ပိုင်း၊ RTO ကို တစ်နာရီလို့ ဆုံးဖြတ်ပါတယ်။ RPO က backup ကို ဘယ်လောက် ခဏခဏ ယူရမလဲ ဆုံးဖြတ်ပေးပြီး အဲဒါက tool ရွေးတာ၊ data ကို ခွဲထားပုံအထိ သက်ရောက်လို့ စောစော ဆုံးဖြတ်ထားရပါမယ်။
> ⟪page l22_p02c⟫ ဒါပေမဲ့ ဒီ နံပါတ် နှစ်ခုက disaster အတွက်ပါ၊ တစ်ခုခု ပျက်ပြီးမှ စရေတွက်ပါတယ်။ နေ့စဉ် ကျန်းမာရေးကိုတော့ သဘောတူထားတဲ့ reliability ပစ်မှတ်၊ SLO နဲ့ သူ့ error budget က အချိန်ရှိတုန်း ကြိုသတိပေးပါတယ်။

On screen:

- l22_p02 (K4): ငွေ data အတွက် နံပါတ် နှစ်ခု | RPO: data ဘယ်လောက် ဆုံးခံနိုင်လဲ? | RTO: ဘယ်လောက်ကြာမှ ပြန်ရလဲ? | tool ကနေ မဟုတ်၊ business လိုအပ်ချက်ကနေ
- l22_p02b (K2): ledger ရဲ့ ပစ်မှတ် | RPO: မိနစ်ပိုင်း | RTO: 1 နာရီ | RPO က backup ယူတဲ့ အကြိမ်နဲ့ tool ကို ဆုံးဖြတ်
- l22_p02c (K3, left gray / right teal; cells as left / right): RPO၊ RTO / SLO၊ error budget | disaster အတွက် / နေ့စဉ်အတွက် | ပျက်ပြီးမှ စရေတွက် / မပျက်ခင် သတိပေး

## Scene 4 · Replication spreads the mistake

chapter: Replication က အမှားကိုပါ ကူးတယ်

> ⟪close page⟫ ⟪board B2 step 1⟫ ဒုတိယ incident မှာတော့ developer တစ်ယောက်က test merchant တွေ ရှင်းဖို့ cleanup script ကို AI coding assistant နဲ့ ရေးပြီး admin credential နဲ့ run လိုက်ပါတယ်။ နာမည် မပြောင်းရသေးတဲ့ staging database နဲ့ production database က စာလုံး တစ်လုံးပဲ ကွာလို့ production ထဲက တကယ့် merchant ၁၀၀၀၀ ကို ဖျက်မိသွားပြီး ဆိုင်တွေ ငွေလက်ခံလို့ မရတော့ပါဘူး။
> ⟪board B2 step 2⟫ database မှာ write လက်ခံတဲ့ primary နဲ့ သူ့ကို လိုက်ကူးတဲ့ copy သုံးခု ရှိပါတယ်၊ ဒီလို ကူးထားတာက replication၊ copy တစ်ခုချင်းက replica ပါ။ zone တစ်ခု ပျက်ရင် replica က ကယ်ပေးပေမဲ့ delete တွေကိုလည်း ချက်ချင်း ကူးလို့ merchant တွေ နေရာတိုင်းမှာ ပျောက်ကုန်ပါတယ်၊ ဒါကြောင့် replication က backup မဟုတ်ပါဘူး။
> ⟪board B2 step 3⟫ primary ပျက်လို့ replica ကို ပြောင်းသုံးတဲ့ failover မှာလည်း ခဏ နောက်ကျပြီး လိုက်ကူးတဲ့ asynchronous replica ဆိုရင် မကူးရသေးတဲ့ write တွေ ပျောက်ပါတယ်။ write တိုင်း replica ဆီ ရောက်မှ ပြီးတဲ့ synchronous ကတော့ ပိုနှေးပေမဲ့ ပြန်ယူရ ပိုရိုးရှင်းပါတယ်။
> ⟪board B2 step 4⟫ merchant တွေကိုတော့ data ကို ဓာတ်ပုံရိုက်သလို နာရီတိုင်း မှတ်ထားတဲ့ snapshot ကနေ restore လုပ်ပြီး write တိုင်းကို မှတ်ထားတဲ့ write log ကနေ script မ run ခင်အထိ ပြန်ထည့်လို့ ပြန်ရခဲ့ပါတယ်။ အခုတော့ backup တွေကို သီးခြား account ထဲမှာ read-only ထားလို့ production ကို ရေးနိုင်တဲ့ လူ၊ script၊ AI ဘယ်သူမှ မှားလို့ဖြစ်စေ၊ တမင်ဖြစ်စေ backup ကို မဖျက်နိုင်ပါဘူး။

On screen:

- B2 step (1), cleared (P2 comb): cleanup script / delete 10,000 (red box, two lines) → primary → (the bus)
- B2 step (2): replica | replica | replica (three boxes off the bus, all red)
- B2 step (3): async failover / မကူးရသေးတဲ့ write ပျောက် (orange note under the comb, two lines)
- B2 step (4): သီးခြား backup / account သီးခြား၊ read-only (two nested green rectangles apart from the comb, two lines)

## Scene 5 · Snapshot and backup

chapter: Snapshot နဲ့ backup

> ⟪close board⟫ ⟪page l22_p03⟫ snapshot က data ရှိတဲ့ storage ထဲမှာပဲ ယူတာမို့ မြန်ပြီး ဈေးပေါပါတယ်၊ ဒီတစ်ခါလို မှားဖျက်တာကနေ ကယ်နိုင်ပေမဲ့ storage ကိုယ်တိုင် ပျက်ရင်တော့ အတူ ပျက်ပါတယ်။ backup ကတော့ တခြားနေရာမှာ သီးခြား ကူးထားလို့ ပိုနှေးပေမဲ့ storage ပျက်လည်း ကျန်ပါတယ်၊ ဒါကြောင့် နှစ်မျိုးလုံး ထားရပါမယ်။
> ⟪page l22_p03b⟫ Padauk က သုံး နှစ် တစ် rule ကို လိုက်ပါတယ်၊ မိတ္တူ သုံးခု ထားမယ်၊ storage နှစ်မျိုးမှာ သိမ်းမယ်၊ တစ်ခုကို တခြားနေရာမှာ ထားမယ် ဆိုတာပါ။ merchant တွေတုန်းကလိုပဲ backup ပေါ်မှာ write log ကို လိုတဲ့ မိနစ်အထိ ပြန်ထည့်တာကို point-in-time recovery လို့ ခေါ်ပါတယ်၊ RPO ကို အရမ်း သေးစေလို့ ledger မှာ ဖွင့်ထားပါတယ်။
> ⟪page l22_p03c⟫ backup ကို ပြန်ဖွင့်ဖို့ encryption key နဲ့ ဘယ်ထဲမှာ ဘာရှိလဲ ပြတဲ့ metadata လည်း လိုလို့ ledger ရဲ့ key နဲ့ metadata ကို login ပါ သီးခြားဖြစ်တဲ့ တခြား cloud account မှာ backup ယူထားပါတယ်။ backup နည်းကိုလည်း ဆန်းပြားတာထက် ပြဿနာ တက်ချိန်မှာ restore လုပ်ရ လွယ်တဲ့ ရိုးရှင်းတဲ့ နည်းကို ရွေးပါတယ်။

On screen:

- l22_p03 (K3, left gray / right teal; cells as left / right): Snapshot / Backup | မြန်၊ ဈေးပေါ / သီးခြား၊ ပိုနှေး | storage နဲ့ အတူ ပျက် / storage ပျက်လည်း ကျန် | တစ်မျိုးပဲ ထား / နှစ်မျိုးလုံး: 3-2-1
- l22_p03b (K2): 3-2-1 နဲ့ point-in-time | မိတ္တူ 3 ခု · storage 2 မျိုး | တစ်ခုကို တခြားနေရာမှာ | ledger: point-in-time recovery
- l22_p03c (K2): Restore လုပ်နိုင်တဲ့ backup | key နဲ့ metadata ကိုလည်း backup ယူ | account သီးခြား၊ login သီးခြား | ဆန်းပြားတာထက် ရိုးရှင်းတာ

## Scene 6 · One mistake can't reach everything

chapter: အမှား တစ်ခု နေရာတိုင်း မရောက်အောင်

> ⟪close page⟫ ⟪board B3 step 1⟫ merchant incident ရဲ့ postmortem မှာ developer ကို အပြစ်မရှာဘဲ script တစ်ခုက production တစ်ခုလုံးကို ဘာကြောင့် ထိနိုင်ခဲ့လဲလို့ မေးပါတယ်။ စာလုံး တစ်လုံး မှားတာက ဘယ်သူ့မှာမဆို ဖြစ်နိုင်ပါတယ်၊ ပြဿနာက ဘယ်သူမှ ထပ်မစစ်ဘဲ ဖျက်လို့ရပြီး ဖျက်လိုက်တာနဲ့ အပြီး ပျောက်သွားတာပါ။
> ⟪board B3 step 2⟫ ဒါကြောင့် အခု ဖျက်တာကို အဆင့်လိုက် လုပ်ပါတယ်၊ lesson ၂၁ က soft delete လိုပဲ ဖျက်လိုက်တဲ့ data ကို trash ထဲမှာ ရက်အနည်းငယ် ထားတော့ ပြန်ယူလို့ရပါတယ်။ data အများကြီး ဖျက်တဲ့ script ကိုလည်း ဒုတိယ လူတစ်ယောက် အတည်ပြုမှ run လို့ရပါတယ်။
> ⟪board B3 step 3⟫ script တစ်ခါ run ရင် ဖျက်နိုင်တဲ့ အရေအတွက်ကို ကန့်သတ်ထားပြီး backup တွေကလည်း script မရောက်နိုင်တဲ့ နေရာမှာ ရှိပါတယ်။ အန္တရာယ်ရှိတဲ့ data ပြောင်းလဲမှုတွေကိုလည်း နေရာတိုင်းမှာ တစ်ပြိုင်နက် မလုပ်ဘဲ zone တစ်ခုပြီးမှ တစ်ခု လုပ်ပါတယ်။ ဒီ incident က lesson ၂၈ မှာ AI agent တွေကို read-only နဲ့ပဲ စပေးရတဲ့ အကြောင်းရင်း ဖြစ်လာပါမယ်။

On screen:

- B3 step (1), cleared (P1 flow): cleanup script → production (စာလုံး 1 လုံး ကွာ) (red box)
- B3 step (2): trash: ရက်အနည်းငယ် | ဒုတိယ အတည်ပြုသူ (green guard boxes along the arrow)
- B3 step (3): ဖျက်နိုင်တာ ကန့်သတ် | backup: မရောက်နိုင် (two more green guards)

## Scene 7 · The drill

chapter: ပထမဆုံး restore drill

> ⟪close board⟫ ⟪board B4 step 1⟫ တတိယ ပြဿနာကိုတော့ Padauk ကိုယ်တိုင် ရှာတွေ့တာပါ။ Eats ရဲ့ backup တွေကို တစ်ခါမှ မစမ်းဖူးလို့ မသီရိရဲ့ အဖွဲ့က ပထမဆုံး restore drill၊ backup ကို တကယ် restore လုပ်ပြီး ကြာချိန်နဲ့ data မှန်လား စစ်တာကို လုပ်ပါတယ်။ payment နဲ့ order database ၉၀၀ gigabyte ကို restore လုပ်တာ ၇ နာရီ ကြာခဲ့ပါတယ်၊ ပစ်မှတ် RTO က တစ်နာရီပဲ ရှိတာပါ။
> ⟪board B4 step 2⟫ ခွဲကြည့်တော့ machine ရှာရတာ ၂ နာရီ၊ data ကူးတာ ၄ နာရီ၊ စစ်တာ ၁ နာရီ ကြာခဲ့ပါတယ်။ drill က တကယ့် restore နဲ့ machine တူတူ သုံးရလို့ ဒီ ၂ နာရီက တကယ့် outage မှာလည်း ကုန်မှာပါ။ ပြီးတော့ RTO ထဲမှာ ပြဿနာ သတိထားမိဖို့နဲ့ ဘာလုပ်မလဲ ဆုံးဖြတ်ဖို့ အချိန်တွေလည်း ပါလို့ restore ကိုယ်တိုင်က တစ်နာရီထက် အများကြီး တိုရပါမယ်။
> ⟪board B4 step 3⟫ ပြန်ယူထားတဲ့ data ကို စစ်တဲ့ program၊ validator ကလည်း order မရှိတဲ့ payment တွေကို တွေ့ပါတယ်၊ payment database ကို order database ထက် နှစ်နာရီ နောက်ကျမှ backup ယူထားလို့ပါ။ ဒါကြောင့် အခု database နှစ်ခုကို အချိန် တစ်ခုတည်းအထိ ပြန်ယူပါတယ်၊ data ကို အပိုင်းလေးတွေ ခွဲပြီး တစ်ပြိုင်နက် restore လုပ်ပါတယ်၊ restore test ကိုလည်း အပတ်တိုင်း အလိုအလျောက် run ပါတယ်။

On screen:

- B4 step (1), cleared (P5 bar on a P8 axis): 900 GB restore: 7 နာရီ (long red bar) | ပစ်မှတ်: 1 နာရီ (thin orange threshold near the start)
- B4 step (2): machine ရှာ: 2 နာရီ | ကူး: 4 နာရီ | စစ်: 1 နာရီ (ticks splitting the bar's timeline, labels alternating above and below)
- B4 step (3): validator: order မရှိတဲ့ payment (orange) | data ခွဲ · အပတ်တိုင်း restore test (green)

## Scene 8 · Proof is a restore

chapter: —

> ⟪close board⟫ ⟪page l22_p04⟫ backup job အစိမ်းရောင် ပြနေတာက copy တစ်ခု ရေးပြီးသွားတယ် ဆိုတာပဲ ပြောပါတယ်၊ data ပြန်ရမယ်လို့ သက်သေပြတာက အောင်မြင်တဲ့ restore ပါ။ ဒါကြောင့် restore ကို အချိန်ဇယားနဲ့ စမ်းပါ၊ fail ရင်ဖြစ်စေ၊ RTO ထက် ကြာရင်ဖြစ်စေ alert တက်အောင် ထားပြီး ပြန်ရတဲ့ data အဓိပ္ပာယ် ရှိလားလည်း စစ်ပါ။
> ⟪page l22_p04b⟫ site တစ်ခုလုံး ပြန်ယူတာတင် မဟုတ်ဘဲ cashback လို မှားရေးခဲ့တဲ့ write တွေ၊ user တစ်ယောက်ရဲ့ data စတဲ့ restore အမျိုးအစား တိုင်းကို စမ်းရပါမယ်။ ဒီ စမ်းသပ်မှုအတွက် machine နဲ့ အချိန်ကိုလည်း feature တစ်ခုလိုပဲ budget တောင်းရပါမယ်။

On screen:

- l22_p04 (K2): သက်သေက restore | restore ကို အချိန်ဇယားနဲ့ စမ်း | fail ရင်၊ နှေးရင် alert | ပြန်ရတဲ့ data အဓိပ္ပာယ်ရှိလား စစ်
- l22_p04b (K4): restore အမျိုးအစား တိုင်း | site တစ်ခုလုံး | မှားရေးခဲ့တဲ့ write တွေ | user တစ်ယောက်ရဲ့ data

## Scene 9 · Padauk's data list

chapter: Padauk ရဲ့ data စာရင်း

> ⟪page l22_p05⟫ ပြဿနာ သုံးခု ပြီးတော့ Padauk က သတိရမှ backup ထည့်တာကို ရပ်ပြီး database အသစ်တိုင်းမှာ အလိုအလျောက် ထည့်ပါတယ်။ data catalog ထဲက data တွေကို အုပ်စု အနည်းငယ် ခွဲပြီး အုပ်စုတိုင်းကို RPO နဲ့ RTO ပေးပါတယ်။
> ငွေ data ကို point-in-time recovery နဲ့ ကာကွယ်ပြီး အပတ်တိုင်း restore စမ်းပါတယ်။ settlement file လို ပြန်ထုတ်လို့ရတဲ့ data ကိုတော့ ပြန်ထုတ်ရတာ နှေးမှ ကာကွယ်ပြီး test data လို backup မလိုတဲ့ data ကိုလည်း မလိုဘူးလို့ ရေးထားပါတယ်။
> ⟪page l22_p05b⟫ restore က စမ်းထားပြီးသား လမ်းပါ၊ အဲဒါ မရတော့မှ ကျန်တာကို ဆယ်ယူရတာက recovery ပါ။ recovery မှာ ဘာလုပ်မလဲ ဆိုတာကို မနက် ၃ နာရီမှ မဆုံးဖြတ်ဘဲ အခုကတည်းက ဆုံးဖြတ်ထားပါတယ်။ ဥပမာ ledger ပျောက်ရင် Wallet ကို လုံးဝ မပိတ်ဘဲ balance တွေ ပြန်ယူနေဆဲလို့ ပြတဲ့ read-only အနေနဲ့ အရင် ဖွင့်ပါမယ်။
> ⟪page l22_p05c⟫ recovery လုပ်နေတုန်း balance တွေကို လက်နဲ့ မပြင်ဘဲ review လုပ်ပြီးသား code ကနေပဲ ပြင်ပါတယ်၊ တကယ် လက်နဲ့ ပြင်ရမယ်ဆိုရင်တော့ CTO ကိုနေလင်းရဲ့ စာနဲ့ ခွင့်ပြုချက် လိုပါတယ်။ ဒီ plan ကိုလည်း ခေါင်းဆောင်တွေက လက်မှတ်ထိုး အတည်ပြုထားပါတယ်။

On screen:

- l22_p05 (K4): Padauk ရဲ့ data စာရင်း | ငွေ: point-in-time၊ အပတ်တိုင်း စမ်း | ပြန်ထုတ်လို့ရ: နှေးရင် ကာကွယ် | backup မလို: ရေးထား
- l22_p05b (K2): Recovery ကို ကြိုဆုံးဖြတ် | restore: စမ်းထားတဲ့ လမ်း | recovery: ကျန်တာကို ဆယ်ယူ | ledger ပျောက်ရင် Wallet read-only
- l22_p05c (K2): Recovery စည်းကမ်း | balance ကို လက်နဲ့ မပြင် | review လုပ်ထားတဲ့ code ကနေပဲ | လက်နဲ့ ပြင်ရင် CTO စာနဲ့ ခွင့်ပြု

## Scene 10 · This week

chapter: —

> ⟪page l22_p06⟫ မသီရိရဲ့ drill လိုပဲ backup တစ်ခုကို ဒီအပတ် တကယ် restore လုပ်ကြည့်ပြီး ဘယ်လောက် ကြာလဲ အချိန် မှတ်ပါ။ ငွေ data အတွက် RPO နဲ့ RTO ကို business ဘက်က လူနဲ့ အတူ ချရေးပါ။ ပြီးတော့ data ဖျက်တဲ့ လုပ်ဆောင်ချက် တစ်ခုကို လူ နှစ်ယောက် အတည်ပြုမှ လုပ်လို့ရအောင် ပြောင်းပါ။

On screen:

- l22_p06 (K2): ဒီအပတ် လုပ်စရာ | backup တစ်ခု restore လုပ်ပြီး အချိန် မှတ်ပါ | ငွေ data ရဲ့ RPO နဲ့ RTO ရေးပါ | ဖျက်တာ တစ်ခုကို လူ 2 ယောက် လိုအောင် လုပ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ incident သုံးခုကို အတိုချုပ်ရရင် ဒီလိုပါ။ ⟪select RPO⟫ RPO က ဘယ်လောက် ကြာချိန်စာ data ကို ဆုံးရှုံးခံနိုင်လဲ၊ ⟪select RTO⟫ RTO က ပြန်ကောင်းဖို့ ဘယ်လောက် ကြာခွင့်ရှိလဲ ဆိုတာ ဖြစ်ပြီး နှစ်ခုလုံး disaster အတွက်ပါ။ ⟪select replication ≠ backup⟫ replication က replica တိုင်းဆီ အမှားကိုပါ ချက်ချင်း ကူးပေးလို့ backup မဟုတ်ပါဘူး။
> ⟪select snapshot⟫ snapshot က မြန်ပြီး ဈေးပေါပေမဲ့ storage ပျက်ရင် အတူ ပျက်ပါတယ်။ ⟪select 3-2-1⟫ သုံး နှစ် တစ် rule က မိတ္တူ သုံးခု၊ storage နှစ်မျိုး၊ တခြားနေရာမှာ တစ်ခု ထားတာ ဖြစ်ပြီး၊ ⟪select restore drill⟫ restore drill က backup ကို တကယ် restore လုပ်ပြီး ကြာချိန်နဲ့ data မှန်လား စစ်တာပါ။ ⟪select မေးခွန်း⟫ ဒါဆို backup ကို ၆ နာရီ တစ်ခါ ယူတယ် ဆိုရင် အဆိုးဆုံး RPO က ဘယ်လောက်လဲ?
> ⟪pause 3s⟫ ၆ နာရီစာ write တွေပါ၊ နောက် backup မယူခင် ခဏလေးမှာ ပျက်ရင် အဲဒီကြားက write တွေ အကုန် ဆုံးရှုံးနိုင်လို့ပါ။ တစ်ညမှာတော့ ဈေးနှုန်းစာရင်း ထုတ်တဲ့ job တစ်ခုက တစ်ဝက်ကိုပဲ ပို့လိုက်လို့ ည ၁ နာရီမှာ top-up တွေ နေရာတိုင်း ရပ်သွားပါတယ်။ ကြိုမစီစဉ်ထားတဲ့ failure ကို ဘယ်လို ဘောင်ခတ်မလဲ?

On screen:

- notes.md: # Backup ထက် restore က ပိုအရေးကြီးတယ် | (blank line) | - RPO — ဆုံးရှုံးခံနိုင်တဲ့ data ကို အချိန်နဲ့ ပြော | - RTO — ပျက်ပြီး ပြန်ကောင်းဖို့ ကြာခွင့် | - replication ≠ backup — replica တိုင်းဆီ အမှားကိုပါ ချက်ချင်း ကူး | - snapshot — မြန်၊ ဈေးပေါ၊ storage ပျက်ရင် အတူ ပျက် | - 3-2-1 — မိတ္တူ 3 ခု · storage 2 မျိုး · တခြားနေရာမှာ 1 ခု | - restore drill — တကယ် restore လုပ်ပြီး ကြာချိန်နဲ့ data စစ် | (blank line) | မေးခွန်း: backup ကို 6 နာရီ တစ်ခါ ယူတယ်။ အဆိုးဆုံး RPO က ဘယ်လောက်လဲ?
