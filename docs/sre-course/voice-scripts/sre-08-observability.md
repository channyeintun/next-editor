# Lesson 8 · Monitoring ကနေ observability ဆီ

slug: sre-08-observability · budget: 8400 characters (±5%)

## Scene 1 · Hook: Top-up never confirms

chapter: အတည်ပြုချက် မပေါ်တဲ့ Top-up

> ⟪page l08_p01⟫ Eats order တွေ ရပ်ခဲ့ပြီးနောက် Padauk က order တစ်ခုကို အစအဆုံး တိုင်းတဲ့ journey SLO နဲ့ အကြီးဆုံး merchant 10 ခုအတွက် SLO တွေ ထည့်ထားပါတယ်။ ဒီတစ်ပတ်မှာတော့ top-up လုပ်ရင် app က loading လည်နေရုံပဲ ဖြစ်ပြီး ဖုန်းဘေလ် ဝင်ပြီ ဆိုတဲ့ အတည်ပြုချက် ဘယ်တော့မှ မပေါ်ပါဘူး။
> စောင့်မနေနိုင်တဲ့ user တွေက ဖုန်းကတ် ဝယ်ဖြည့်ပြီး refund တောင်းကြပေမဲ့ အဲဒီ top-up တွေက တကယ်တော့ ဘေလ် ဝင်ပြီးသားပါ။ API က success code ပြန်ပေးပြီး dashboard တိုင်းကလည်း အစိမ်းရောင်ချည်းပါ။ system ရဲ့ အထဲကို ဘယ်လို မြင်မလဲ?

On screen:

- l08_p01 (K1): 8 | Monitoring ကနေ observability ဆီ | Top-up အတည်ပြုချက် ဘယ်တော့မှ မပေါ် | API: 200 OK · app: loading လည်နေ · dashboard: အစိမ်း | ဘေလ် ဝင်ပြီးသား top-up တွေကို refund တောင်း | system ရဲ့ အထဲကို ဘယ်လို မြင်မလဲ? | (small loop badge, သတိထားမိ lit)

## Scene 2 · Monitoring vs observability

chapter: Monitoring နဲ့ observability

> ⟪page l08_p01b⟫ မသီရိက graph တွေကို တစ်ခုပြီး တစ်ခု ဖွင့်ကြည့်၊ log တွေကို လက်နဲ့ လိုက်ဖတ်ပြီး senior တွေကိုလည်း ဖုန်းဆက် မေးရပါတယ်။ ဒါပေမဲ့ အကြောင်းရင်း ရှာတွေ့တော့ user တွေ ဒုက္ခရောက်နေတာ 2 ရက် ကြာနေပါပြီ။
> ⟪page l08_p02⟫ Padauk မှာ ရှိခဲ့တာက monitoring ပါ။ ကြိုရွေးထားတဲ့ ကိန်းဂဏန်းတွေကို dashboard မှာ ဆွဲထားပြီး ပျက်နေလား ဆိုတာကို ဖြေပေးပါတယ်။ ဘယ်လို၊ ဘယ်မှာ၊ ဘာကြောင့် ပျက်လဲ ဆိုတာကိုတော့ senior တွေ မှတ်မိတာကိုပဲ အားကိုးခဲ့ရပါတယ်။
> observability ကတော့ data တွေကို ချိတ်ဆက်ပြီး အဖွဲ့တိုင်း မျှသုံးထားလို့ ကြိုမတွေးထားတဲ့ မေးခွန်းအသစ်တွေကိုပါ အချိန်မရွေး မေးပြီး ဖြေလို့ရတာပါ။
> ⟪page l08_p02b⟫ observability ရဲ့ ပထမ ပစ်မှတ်ကတော့ ပြဿနာ သိကတည်းက user တွေ ပြန်အဆင်ပြေတဲ့အထိ ကြာချိန်၊ time to mitigate ကို တိုစေဖို့ပါ၊ ဒီ 2 ရက်ရဲ့ အများစုက ဒီအပိုင်းပါ။ ပြီးမှ ပြဿနာ စဖြစ်ကတည်းက Padauk သိရတဲ့အထိ ကြာချိန်၊ time to detect ကို တိုအောင် လုပ်ပါတယ်၊ ဒီတစ်ခါ user တွေက Padauk ထက် အရင် သိခဲ့လို့ပါ။

On screen:

- l08_p01b (K7): အကြောင်းရင်း ရှာတွေ့တဲ့အထိ | 2 ရက် | graph တစ်ခုချင်း ဖွင့်၊ log ကို လက်နဲ့ ဖတ်
- l08_p02 (K3, left gray / right teal; cells as left / right): Monitoring / Observability | ပျက်နေလား? / ဘယ်လို၊ ဘယ်မှာ၊ ဘာကြောင့်? | ကြိုဆွဲထားတဲ့ dashboard / မေးခွန်းအသစ် အချိန်မရွေး | senior တွေ မှတ်မိတာ / ချိတ်ဆက်ပြီး မျှသုံးတဲ့ data
- l08_p02b (K6): ဘာကို အရင် တိုအောင် လုပ်မလဲ | ပြဿနာ စ | Padauk သိ | user ပြန်အဆင်ပြေ | (caption) သိ → အဆင်ပြေ: time to mitigate (အရင်) · စ → သိ: time to detect

## Scene 3 · Connected signals

chapter: —

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒီ 2 ရက်ကို တိုစေချင်တော့ မသီရိက signal လေးမျိုးကို ချိတ်မိအောင် စုပါတယ်။ metric က အချိန်နဲ့အမျှ တိုင်းထားတဲ့ ကိန်းဂဏန်း၊ log က event တစ်ခုချင်းရဲ့ မှတ်တမ်း၊ trace က request တစ်ခု service တွေကို ဖြတ်သွားတဲ့ လမ်းကြောင်းဖြစ်ပြီး၊ profile ကတော့ code ရဲ့ ဘယ်အပိုင်းက CPU နဲ့ memory ကို အများဆုံး သုံးလဲ ပြပါတယ်။
> ⟪board B1 step 2⟫ signal တိုင်းမှာ service၊ version၊ zone ဆိုတဲ့ label တွေ၊ trace ID နဲ့ code နေရာ တူတူ ပါနေရင် ဘယ်နေရာ၊ ဘယ် request၊ ဘယ် code လဲ ဆိုတာ တစ်ဆက်တည်း ရှာပြီး request တစ်ခုရဲ့ ဇာတ်လမ်းကို မြင်ရပါတယ်။ ဥပမာ refund တောင်းထားတဲ့ top-up တစ်ခုရဲ့ trace ID နဲ့ ရှာရုံနဲ့ ဘေလ်က 3 စက္ကန့်နဲ့ ဝင်ပြီးသားဖြစ်ပြီး status ဖတ်တဲ့ code ကပဲ ဘာမှ ရှာမတွေ့ခဲ့တာ မိနစ်ပိုင်းနဲ့ သိရမှာပါ။
> ⟪board B1 step 3⟫ ဘယ်ကစရမလဲ မသိရင် latency၊ traffic၊ error နဲ့ resource ဘယ်လောက် ပြည့်နေလဲ ပြတဲ့ saturation ဆိုတဲ့ four golden signals ကနေ စပါ။ ဒါပေမဲ့ အဲဒီ 2 ရက်မှာ လေးခုလုံး ကောင်းနေခဲ့ပါတယ်။ signal တွေ ထုတ်ဖို့ကိုတော့ vendor တစ်ခုတည်းနဲ့ မချည်နှောင်ထားတဲ့ open standard၊ OpenTelemetry ကို ရွေးပါတယ်၊ tool တစ်ခုကို နှစ်ချီ သုံးရတတ်လို့ပါ။

On screen:

- B1 step (1), cleared (P2 comb, fan-in; four blue boxes stacked on the left, each with an arrow-right into the bus): metric | log | trace | profile
- B1 step (2): (arrow-right out of the bus) | request တစ်ခုရဲ့ ဇာတ်လမ်း (violet box on the right) | label တူ · trace ID တူ · code နေရာ (small text under it)
- B1 step (3): latency · traffic · error · saturation (small text under the four boxes)

## Scene 4 · Success that hides failure

chapter: Success code နောက်က failure

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို alert ဘာလို့ မတက်ခဲ့တာလဲ? user က Top-up ကို နှိပ်တော့ API က success code ပြန်ပေးပြီး ဘေလ်လည်း 10 စက္ကန့်အတွင်း ဝင်လို့ lesson 6 က Top-up SLO လည်း အစိမ်းရောင်ပါ။ ပြဿနာက Operator A က သူ့ response ထဲက status field နာမည်ကို ကြိုမပြောဘဲ ပြောင်းလိုက်တာပါ။ Padauk ရဲ့ code က နာမည်ဟောင်းကို ရှာမတွေ့တော့ top-up မပြီးသေးဘူးလို့ ယူဆနေခဲ့ပါတယ်။
> ⟪board B2 step 2⟫ app မှာတော့ အတည်ပြုချက် ဘယ်တော့မှ မပေါ်ပါဘူး။ lesson 1 က ငွေ နှစ်ခါ ဖြတ်ခဲ့တာလိုပဲ user တကယ် ဘာရသွားလဲ ဆိုတာကို system က မစစ်ခဲ့တာပါ။ service တစ်ခုချင်း ကောင်းနေတာထက် user လုပ်ချင်တာ ပြီးသွားလား ဆိုတာက ပိုအရေးကြီးပါတယ်။
> ⟪board B2 step 3⟫ ဒါကြောင့် ငွေဖြတ်တဲ့ top-up တိုင်းမှာ ဘေလ်ဝင်ကြောင်း app မှာ 10 စက္ကန့်အတွင်း ပေါ်ရမယ် ဆိုတဲ့ user အဆင့် check ကို ထည့်ပါတယ်။ Operator A လို ပြောင်းလဲမှုမျိုး ထပ်ဖြစ်ရင် ဒီ check က မိနစ်ပိုင်းအတွင်း ကျမှာပါ။
> ⟪board B2 step 4⟫ config ပြောင်းတာ၊ release အသစ် ထုတ်တာ၊ feature ကို user 5 ရာခိုင်နှုန်းဆီ ဖွင့်တာလို Padauk ကိုယ်တိုင် ပြောင်းနေတုန်း ဒီ check ကျရင် အဲဒီ ပြောင်းလဲမှုက အလိုလို ရပ်သွားပါတယ်။ ဒါက ကြိုကာတာပါ၊ lesson 19 မှာ ဆက်ကြည့်ပါမယ်။
> ⟪board B2 step 5⟫ Operator A လို အပြင်က ပြောင်းတာကိုတော့ ကြိုမတားနိုင်လို့ top-up လုပ်တဲ့ critical user journey ရဲ့ SLO မှာ error budget မြန်မြန် ကုန်လာရင် တက်တဲ့ SLO burn alert နဲ့ ဖမ်းပါတယ်။ ကြိုကာတဲ့ အလွှာနဲ့ ဖမ်းတဲ့ အလွှာ နှစ်ခုလုံး ထားတာက defense in depth ပါ။

On screen:

- B2 step (1), cleared (P1 flow, vertical, left column, top to bottom with arrow-down): Top-up နှိပ် ↓ API: 200 OK (green) ↓ status field ဖတ်
- B2 step (2): ↓ အတည်ပြုချက် မပေါ် (red, fourth box in the column)
- B2 step (3): (green check beside the red box) | စည်း: ငွေဖြတ်ရင် ဘေလ်ဝင်တာ ပြရမယ် (green, right column, two lines)
- B2 step (4): ကြိုကာ: ကိုယ့် ပြောင်းလဲမှု အလိုလို ရပ် (blue, right column, two lines)
- B2 step (5): ဖမ်း: journey SLO burn alert (blue, under the step 4 label) | defense in depth (violet, under both)

## Scene 5 · Don't share fate

chapter: App နဲ့ အတူ မပျက်တဲ့ monitoring

> ⟪close board⟫ ⟪board B3 step 1⟫ သီတင်းကျွတ် ညမှာတော့ Top-up run နေတဲ့ cluster တစ်ခုလုံး ပျက်သွားပေမဲ့ page တစ်ခုမှ မဝင်ခဲ့ပါဘူး။ monitoring ကိုပါ အဲဒီ cluster ထဲမှာ run ထားလို့ alert တွေပါ အတူ ပျောက်သွားပြီး Facebook post တွေကို support က မစု မြင်မှ သိခဲ့ရပါတယ်။ ဒီလို monitoring က သူ စောင့်ကြည့်တဲ့ system နဲ့ အတူ ပျက်တာကို shared fate လို့ ခေါ်ပါတယ်။
> ⟪board B3 step 2⟫ ဒါကြောင့် monitoring ကို app မရှိတဲ့ zone B ဆီ ရွှေ့ပြီး production service တွေကို တတ်နိုင်သမျှ နည်းနည်းပဲ မှီအောင် ထားပါတယ်။ အခု zone A က app ပျက်ရင်တောင် zone B က page ပို့နိုင်ပါသေးတယ်။
> ⟪board B3 step 3⟫ cloud အပြင်ကနေ user လိုပဲ မိနစ်တိုင်း top-up တစ်ခု စမ်းဖြည့်ကြည့်တဲ့ prober လည်း ထည့်လိုက်လို့ အထဲမှာ အကုန် ပျက်ရင်တောင် alert ဆက်တက်ပါတယ်။
> ⟪board B3 step 4⟫ alert တွေက မြန်မြန် ရောက်တဲ့ နောက်ဆုံးရ data ကို သုံးပြီး၊ နောက်မှ မေးမယ့် မေးခွန်းတွေအတွက်တော့ နှေးပေမဲ့ ပြည့်စုံတဲ့ data ကို သိမ်းပါတယ်။ incident အတွင်း နောက်ဆုံးရ data ကို အရင် ပြရပါမယ်၊ တစ်စိတ်တစ်ပိုင်း မြင်ရတာတောင် ဘာမှ မမြင်ရတာထက် ကောင်းလို့ပါ။

On screen:

- B3 step (1), cleared (P6 lanes; top lane): cluster (one outline box) | app (red, inside it) | monitoring (red, inside it)
- B3 step (2) (bottom lane): app · zone A (red) | monitoring · zone B (green)
- B3 step (3): အပြင်က prober: alert ဆက်တက် (green, end of the bottom lane)
- B3 step (4) (two small labels under the bottom lane): alert: မြန်၊ နောက်ဆုံးရ (blue) | နောက်မှ မေး: နှေး၊ ပြည့်စုံ (violet)

## Scene 6 · Thirty services

chapter: Service 30 နဲ့ generated dashboard

> ⟪close board⟫ ⟪board B4 step 1⟫ Padauk မှာ service 30 လောက် ရှိလာတော့ dashboard ကို အဖွဲ့တိုင်း လက်နဲ့ ဆွဲရတာ မမီတော့ပါဘူး။ ဒါကြောင့် မသီရိက ဖုန်းကုမ္ပဏီတွေဆီ ချိတ်ပေးတဲ့ operator gateway client နဲ့ HTTP၊ database library တွေထဲကို standard metric တွေ ထည့်ပါတယ်။ အဲဒီ library တွေ သုံးတဲ့ service တိုင်းမှာ တူညီတဲ့ graph တွေ အလိုလို ထွက်လာတာကို generated dashboard လို့ ခေါ်ပါတယ်။
> ⟪board B4 step 2⟫ library ပိုင်ရှင်က alert တစ်ခု ရေးလိုက်ရင်လည်း သုံးတဲ့ service တိုင်းမှာ ပါသွားပြီး service တစ်ခုချင်းရဲ့ traffic နဲ့ ကိုက်အောင် သူ့ဘာသာ ချိန်ညှိပါတယ်။ user ဒုက္ခရောက်တာကို ပြတဲ့ alert တွေဘေးမှာ quota ပြည့်ခါနီးတာလို အကြောင်းရင်းကို ပြတဲ့ alert တွေလည်း ထားပါတယ်။
> ⟪board B4 step 3⟫ Top-up alert တက်ရင် script တစ်ခုက နောက်ဆုံး deploy၊ ဖုန်းကုမ္ပဏီတွေရဲ့ latency၊ database connection တွေကို အလိုလို စစ်ပြီး တွေ့တာကို incident chat channel ထဲ တင်ပေးလို့ on-call ကျနေတဲ့သူက စစ်ပြီးသား အချက်တွေကနေ စလို့ရပါတယ်။ deploy ပြီးချင်း error တွေ ရုတ်တရက် တက်လာရင်တော့ အလိုအလျောက် rollback လုပ်ပေးပါတယ်။

On screen:

- B4 step (1), cleared (P1 flow, three two-line boxes left to right): gateway client က / dashboard (blue)
- B4 step (2): → service အလိုက် / ကိုက်တဲ့ alert (orange)
- B4 step (3): → အလိုလို စစ် / + rollback (green)

## Scene 7 · Telemetry has a bill and a duty

chapter: Telemetry ရဲ့ bill နဲ့ တာဝန်

> ⟪close board⟫ ⟪page l08_p03⟫ လကုန်တော့ metric၊ log၊ trace လို telemetry ရဲ့ bill က 3 လအတွင်း 2 ဆ ဖြစ်နေလို့ CTO ကိုနေလင်းက အကြောင်းရင်း မေးပါတယ်။ ရှာကြည့်တော့ debug log တစ်ခုက request တစ်ခုလုံးကို user ရဲ့ NRC နံပါတ်နဲ့ အတူ ရေးနေတာ တွေ့ပါတယ်။ ဒါက bill ကိစ္စ သက်သက် မဟုတ်ဘဲ တာဝန်ကိစ္စပါ။
> ဒါကြောင့် log ရေးတဲ့ နေရာမှာတင် NRC နံပါတ်ကို ဖုံးပါတယ်။ lesson 4 က စည်းမျဉ်းလိုပဲ log ကိုလည်း ပြည်တွင်းမှာပဲ ထားရမယ် ဆိုပါစို့။ အသေးစိတ် data ကိုတော့ ရက် 30 ပြီးရင် ဖျက်ပါတယ်။
> ⟪page l08_p03b⟫ bill တက်တဲ့ နောက်အကြောင်း တစ်ခုက metric တစ်ခုမှာ user ID ကို label အဖြစ် ထည့်ထားတာပါ။ label တစ်ခုမှာ မတူတဲ့ တန်ဖိုး ဘယ်နှမျိုး ရှိလဲ ဆိုတာက cardinality ပါ။ တန်ဖိုး တစ်မျိုးစီက time series တစ်ခုစီ ဖြစ်လို့ user 12 သိန်းဆိုရင် series 12 သိန်း ဖြစ်ပြီး bill အဆမတန် တက်ပါတယ်။ ဒါကြောင့် user ID ကို ရှာရ ပိုကုန်ပေမဲ့ သိမ်းနိုင်တဲ့ log နဲ့ trace ထဲမှာပဲ ထားပါ။
> ⟪page l08_p03c⟫ field တိုင်းမှာလည်း ဘယ်လို data လဲ ဆိုတဲ့ အမှတ်အသား တပ်ပြီး ဘယ်ရောက်ရောက် ပါသွားအောင် ထားပါ။ ဥပမာ Operator တစ်ခုရဲ့ error rate က personal data မဟုတ်ပေမဲ့ ဖုန်းနံပါတ် ပါတဲ့ log က personal data ပါ။ နာမည် မပါတဲ့ မန္တလေး ဆိုင်ခွဲတွေရဲ့ ကိန်းဂဏန်းကလည်း supermarket chain တစ်ခုတည်းရဲ့ data မို့ ဘယ်သူ့ data လဲ သိနိုင်ပါတယ်။

On screen:

- l08_p03 (K2): Telemetry: bill နဲ့ တာဝန် | log ထဲက NRC နံပါတ်ကို ဖုံးပါ | log ကို ပြည်တွင်းမှာပဲ ထားရမယ် ဆိုပါစို့ | အသေးစိတ်ကို ရက် 30 ပြီးရင် ဖျက်ပါ
- l08_p03b (K7): metric label ထဲက user ID | series 12 သိန်း | user ID ကို log နဲ့ trace ထဲမှာပဲ ထားပါ
- l08_p03c (K2): field တိုင်းမှာ အမှတ်အသား တပ်ပါ | Operator error rate: personal data မဟုတ် | ဖုန်းနံပါတ် ပါတဲ့ log: personal data | ဆိုင်ခွဲ ကိန်းဂဏန်း: merchant တစ်ခုတည်း

## Scene 8 · Alert on evidence

chapter: အထောက်အထား ခိုင်လုံမှ page ပို့

> ⟪close page⟫ ⟪board B5 step 1⟫ နောက်ဆုံး ပြဿနာက ညဘက် page တွေပါ။ ဒီ လိမ္မော်ရောင် မျဉ်းက Top-up SLO ပေးထားတဲ့ fail ခွင့် 0.5 ရာခိုင်နှုန်းပါ။ alert အဟောင်းက Operator တစ်ခုရဲ့ error rate ဒီမျဉ်းကို ကျော်တာနဲ့ page ပို့ပါတယ်။ fail အရေအတွက်ကို ပုံသေ ထားတဲ့ စည်းကလည်း traffic နည်းတဲ့ Operator မှာ ပျက်နေရင်တောင် မတက်ဘဲ များတဲ့ Operator မှာ ကောင်းနေရင်တောင် တက်လို့ နှစ်ဘက်လုံး မှားပါတယ်။
> ⟪board B5 step 2⟫ မနက် 3 နာရီမှာ Operator C ဆီ top-up 40 ထဲက တစ်ခု fail တော့ 2.5 ရာခိုင်နှုန်း ဖြစ်လို့ page ဝင်လာပြီး မသီရိ အိပ်ရာက ထရပေမဲ့ တကယ်တော့ ဘာပြဿနာမှ မရှိခဲ့ပါဘူး။ နမူနာ နည်းလို့ တကယ့် fail နှုန်းက 0.5 ရာခိုင်နှုန်း အောက်ကနေ 13 ရာခိုင်နှုန်းလောက်အထိ ဖြစ်နိုင်ပြီး ဒီ ကျယ်တဲ့ အကွက်က မျဉ်းကို ဖြတ်နေလို့ အထောက်အထား မခိုင်လုံပါဘူး။
> ⟪board B5 step 3⟫ Operator A မှာတော့ 20000 ထဲက 240၊ 1.2 ရာခိုင်နှုန်းပဲ fail ဖြစ်ပေမဲ့ နမူနာ များတော့ အကွက်က ကျဉ်းပြီး တစ်ခုလုံး မျဉ်းအပေါ်မှာ ရှိလို့ page ပို့ရပါမယ်။ ဒီလို နမူနာ အရေအတွက်ပါ တွက်ပြီး ပြဿနာ ရှိတာ သေချာမှ page ပို့တာကို အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert လို့ ခေါ်ပါတယ်။
> ⟪board B5 step 4⟫ ပျမ်းမျှကလည်း လှည့်စားတတ်ပါတယ်။ ဥပမာ မိနစ် ပျမ်းမျှက 5 စက္ကန့်စာပဲ ရုတ်တရက် တက်တဲ့ error တွေကို ဖုံးထားနိုင်ပါတယ်။ monitoring ကောင်းလာစမှာလည်း failure တွေ ပိုများလာသလို ထင်ရပေမဲ့ အရင်က မမြင်ရတာတွေ ပေါ်လာတာပါ။

On screen:

- B5 step (1), cleared (P5 bars; underline axis): ခွင့်ပြု: 0.5% (thin orange threshold across the chart)
- B5 step (2): Operator C၊ မနက် 3 နာရီ: 40 ထဲက 1 (two-line label; short blue bar; a wide outline-only orange rectangle around its top, crossing the line) | page မပို့ (green)
- B5 step (3): Operator A: 20,000 ထဲက 240 (blue bar; a narrow outline-only orange rectangle, all above the line) | page ပို့ (red)
- B5 step (4): မိနစ် ပျမ်းမျှက 5 စက္ကန့်စာ ခုန်တက်တာကို ဖုံးနိုင် (small orange note under the axis, two lines)

## Scene 9 · This week

chapter: —

> ⟪close board⟫ ⟪page l08_p04⟫ ဒီအပတ်တော့ ကိုယ့် monitoring ကို ဒီလို စစ်ကြည့်ပါ။ success code ပြန်ပေးပေမဲ့ user ဘက်မှာ မအောင်မြင်တဲ့ နေရာ တစ်ခုကို ရှာကြည့်ပါ။ ကိုယ့် monitoring က app နဲ့ cluster တစ်ခုတည်း၊ zone တစ်ခုတည်းမှာ run နေလား စစ်ပါ။ ပြီးတော့ user ID လို တန်ဖိုး အရမ်းများတဲ့ metric label တစ်ခုကို ဖယ်ပါ။

On screen:

- l08_p04 (K2): ဒီအပတ် လုပ်စရာ | failure ကို ဖုံးနေတဲ့ success code ရှာပါ | monitoring ဘယ်မှာ run လဲ စစ်ပါ | cardinality မြင့်တဲ့ label တစ်ခု ဖယ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ notes ကို တစ်ကြောင်းချင်း ပြန်လှန်ကြည့်ရအောင်။ ⟪select observability⟫ observability က ကြိုမတွေးထားတဲ့ မေးခွန်းတွေကို ချိတ်ဆက်ထားတဲ့ data ကနေ ဖြေနိုင်တာပါ။ ⟪select golden signals⟫ golden signals က အရင်ဆုံး ကြည့်ရမယ့် signal လေးခုဖြစ်ပြီး၊ ⟪select trace⟫ trace က request တစ်ခုရဲ့ လမ်းကြောင်း တစ်ခုလုံးပါ။ ⟪select shared fate⟫ shared fate ဆိုတာ monitoring က app နဲ့ အတူ ပျက်တာပါ။
> ⟪select generated dashboard⟫ generated dashboard က shared library ကနေ အလိုလို ထွက်လာတဲ့ dashboard ဖြစ်ပြီး၊ ⟪select cardinality⟫ cardinality က label တစ်ခုမှာ မတူတဲ့ တန်ဖိုး ဘယ်နှမျိုး ရှိလဲ ဆိုတာပါ။ ⟪select အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert⟫ အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert ကတော့ နမူနာ အရေအတွက်ပါ တွက်ပြီး သေချာမှ page ပို့တာပါ။ ဒီ မေးခွန်းကို ဖြေကြည့်ပါဦး။ monitoring က app နဲ့ cluster တစ်ခုတည်းမှာ run နေရင် အဲဒီ cluster ပျက်တဲ့နေ့ ဘာဖြစ်မလဲ?
> ⟪pause 3s⟫ alert တွေပါ app နဲ့ အတူ ပျက်သွားလို့ user တွေ post တင်မှပဲ သိရပါမယ်။ Module 3 မှာတော့ မနက် 2 နာရီမှာ alert တက်လာပေမဲ့ လူ 60 ရှိတဲ့ Viber group ထဲ ရောက်သွားပြီး အဲဒီ group ကို လူတိုင်းက အသံပိတ်ထားကြပါတယ်။ ဘယ်သူ ဖြေမလဲ?

On screen:

- notes.md: # Monitoring ကနေ observability ဆီ | (blank line) | - observability — ကြိုမတွေးထားတဲ့ မေးခွန်းကို ချိတ်ဆက်ထားတဲ့ data ကနေ ဖြေ | - golden signals — latency · traffic · error · saturation | - trace — request တစ်ခု service တွေကို ဖြတ်သွားတဲ့ လမ်းကြောင်း | - shared fate — monitoring က app နဲ့ အတူ ပျက် | - generated dashboard — shared library ကနေ service တိုင်းအတွက် အလိုလို ထွက် | - cardinality — label တစ်ခုမှာ မတူတဲ့ တန်ဖိုး ဘယ်နှမျိုး | - အထောက်အထား ခိုင်လုံမှ တက်တဲ့ alert — နမူနာ အရေအတွက်ပါ တွက်ပြီး သေချာမှ page | (blank line) | မေးခွန်း: monitoring က app နဲ့ cluster တစ်ခုတည်းပေါ်မှာ run နေတယ်။ cluster ပျက်ရင် ဘာဖြစ်မလဲ?
