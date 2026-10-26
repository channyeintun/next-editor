# Lesson 23 · Failure ကို ဘောင်ခတ်ထားတဲ့ design

slug: sre-23-containing-failure · budget: 8400 characters (±5%)

## Scene 1 · Hook: top-ups stop everywhere at 1 a.m.

chapter: တစ်ဝက်ပဲ ပါတဲ့ ဈေးနှုန်းစာရင်း

> ⟪page l23_p01⟫ Padauk က backup တွေကို အပတ်တိုင်း restore လုပ်ပြီး စစ်သလို data အများကြီး ဖျက်တာကိုလည်း လူ နှစ်ယောက် အတည်ပြုမှ လုပ်ပါတယ်။ ဒါပေမဲ့ တစ်ရက် ည ၁ နာရီမှာ top-up တွေ နေရာတိုင်း ရပ်သွားပါတယ်။ operator တွေရဲ့ plan ဈေးနှုန်းစာရင်းကို ညတိုင်း ထုတ်ပေးတဲ့ job က တစ်ဝက်ပဲ ပါတဲ့ စာရင်းကို ပို့လိုက်ပြီး server တိုင်းက ယုံလိုက်လို့ပါ။
> ⟪page l23_p01b⟫ job က ကြားမှာ ရပ်သွားလို့ စာရင်းထဲမှာ row တွေရဲ့ ၄၀ ရာခိုင်နှုန်းပဲ ပါခဲ့တာပါ။ ဆိုတော့ စာရင်းထဲ မပါတဲ့ plan တွေရဲ့ top-up မှန်သမျှ zone သုံးခုလုံးမှာ fail ကုန်ပါတယ်။ server တစ်လုံးမှ မကျဘဲ health check တွေလည်း အစိမ်းရောင်ပါ၊ မှားနေတာက data ပါ။
> ပြဿနာ မှန်သမျှကို ကြိုမမြင်နိုင်ပေမဲ့ ဘယ်အထိ ပျံ့မလဲ ဆိုတာကိုတော့ design နဲ့ ကန့်သတ်နိုင်ပါတယ်။ ကြိုမစီစဉ်ထားတဲ့ failure ကို ဘယ်လို ဘောင်ခတ်မလဲ?

On screen:

- l23_p01 (K1): 23 | Failure ကို ဘောင်ခတ်ထားတဲ့ design | ည 1 နာရီ၊ top-up တွေ နေရာတိုင်း ရပ် | ညတိုင်း job က ဈေးနှုန်းစာရင်း တစ်ဝက်ပဲ ပို့ | server တိုင်းက ယုံ၊ data က မှားနေတာ | failure ကို ဘယ်လို ဘောင်ခတ်မလဲ? | (small loop badge, တည်ဆောက် lit)
- l23_p01b (K7): ပို့လိုက်တဲ့ စာရင်း | 40% | row တွေ ဒီလောက်ပဲ၊ ကျန်တဲ့ plan တွေ fail

## Scene 2 · Reliable vs resilient

chapter: Reliable နဲ့ resilient

> ⟪close page⟫ ⟪board B1 step 1⟫ အပြာရောင် ဘောင်က Top-up ကို design လုပ်ပြီး စမ်းထားတဲ့ load အတိုင်းအတာပါ၊ ဘောင်ထဲက bar တွေကတော့ ပုံမှန် ညတွေပါ။ ဒီဘောင်ထဲမှာ lesson ၆ က Top-up ရဲ့ service level objective၊ SLO ပစ်မှတ်ကို ထိန်းနိုင်နေရင် reliable ဖြစ်တယ်လို့ ပြောပါတယ်။
> ⟪board B1 step 2⟫ ဈေးနှုန်းစာရင်း တစ်ဝက်ပဲ ရောက်တဲ့ ညကတော့ ဘောင်အပြင်ဘက်ပါ။ တချို့ system တွေက အနီရောင်လို ပြိုကျပြီး လူ လာပြင်တဲ့အထိ ရပ်နေပါတယ်။ တချို့ကတော့ အစိမ်းရောင်လို ခဏ ကျပေမဲ့ ပြဿနာ မပျံ့အောင် ဘောင်ခတ်ပြီး ပြန်တက်လာပါတယ်၊ ဥပမာ ကျန်တဲ့ plan တွေကို ဆက်ရောင်းနေနိုင်ပါတယ်။ ဒီလို design ဘောင် အပြင်က failure ကိုပါ ဘောင်ခတ်ပြီး ပြန်ကောင်းလာနိုင်တာကို resilience လို့ ခေါ်ပါတယ်။
> ⟪board B1 step 3⟫ incident တိုင်းကနေ ရတဲ့ သင်ခန်းစာတွေက ဒီဘောင်ကို တဖြည်းဖြည်း ချဲ့ပေးပါတယ်။ ဒါပေမဲ့ ပြင်ဆင်မှုတိုင်းက ဒီနေ့ ကုန်ကျပြီး failure တကယ် ဖြစ်မှ အကျိုးပြန်ပေးတာမို့ အားလုံးကို မကာကွယ်နိုင်ဘဲ ချိန်ဆပြီး ရွေးရပါတယ်။ ဘယ်လောက် resilient ဖြစ်ရင် လုံလောက်လဲ ဆိုတာကိုလည်း engineer တွေ မဟုတ်ဘဲ user တွေနဲ့ Padauk ကို ခေါ်သုံးတဲ့ system တွေက ဆုံးဖြတ်ပါတယ်။

On screen:

- B1 step (1), cleared (P5 bars; a blue outline-only rectangle with short blue bars inside): design လုပ်ထားတဲ့ ဘောင် (blue, on the outline) | ပုံမှန် ညတွေ (under the bars)
- B1 step (2): စာရင်း တစ်ဝက် (one tall blue bar beyond the outline) | ပြိုကျ (red, a short red bar falling to the axis) | ကျပြီး ပြန်တက် (green, a green bar that dips and returns)
- B1 step (3): သင်ခန်းစာတိုင်း ဘောင် ကျယ်လာ (a wider blue outline around the first)

## Scene 3 · Padauk's risk picture

chapter: Padauk ရဲ့ risk ပုံ

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို ဘယ် failure အတွက် အရင် ပြင်ဆင်မလဲ? မသီရိနဲ့ ကိုဇော်က Padauk ရဲ့ risk တွေကို ဘယ်လောက် ခဏခဏ ဖြစ်လဲ၊ ဖြစ်ရင် ဘယ်လောက် ဆိုးလဲ ဆိုတဲ့ ဝင်ရိုး နှစ်ခုပေါ်မှာ နေရာချကြည့်ပါတယ်။ ညာဘက် ရောက်လေ ခဏခဏ ဖြစ်လေ၊ အပေါ် ရောက်လေ ဆိုးလေပါ။
> ⟪board B2 step 2⟫ ဈေးနှုန်းစာရင်း ပြတ်တာက ညတိုင်း ပို့နေလို့ ခဏခဏ ဖြစ်နိုင်ပြီး ဆိုးလည်း ဆိုးပါတယ်။ zone တစ်ခုလုံး ဆုံးရှုံးတာက ရှားပေမဲ့ ဖြစ်ရင် အရမ်း ဆိုးပါတယ်။ SMS provider နှစ်ခုက operator gateway တစ်ခုတည်းကို မျှသုံးနေတာကတော့ တစ်ခါတလေ ပြဿနာ ပေးပြီး အလယ်အလတ်လောက် ဆိုးပါတယ်။
> ⟪board B2 step 3⟫ ဖြစ်နိုင်ခြေကို ထိခိုက်မှုနဲ့ မြှောက်ပြီး အဆင့်စီရင် zone ဆုံးရှုံးတာလို ရှားတဲ့ ဘေးကြီးက ကိန်းဂဏန်း သေးသေးလေးပဲ ထွက်လို့ အလှည့် ဘယ်တော့မှ မရောက်ပါဘူး။ တစ်ခါ ဖြစ်ရုံနဲ့ ကုမ္ပဏီကိုပါ ထိနိုင်တဲ့ risk မှာ ဒီနည်း အလုပ်မဖြစ်လို့ ရှားပေမဲ့ ဆိုးတဲ့ risk ကိုလည်း plan တစ်ခု ပေးရပါတယ်။
> ⟪board B2 step 4⟫ ဒါကြောင့် စာရင်း ပြဿနာအတွက် ဈေးပေါပြီး အမြဲ ဖွင့်ထားတဲ့ check တွေ ထည့်ပါတယ်။ zone ဆုံးရှုံးတာအတွက်တော့ ဒီနေ့ ဖြစ်ရင် ဘာလုပ်မလဲ ဆိုတဲ့ plan ကို အခုပဲ ရေးပြီး အမြစ်ကနေ တစ်ဆင့်ချင်း ပြင်ပါတယ်။ SMS gateway ကိုတော့ အခုအတွက် လက်ခံပြီး ဘာကြောင့်လဲ၊ ဘယ်တော့ ပြန်ကြည့်မလဲ ရေးမှတ်ထားပါတယ်။ ပြင်ပုံကလည်း လက်နဲ့ ပြင်တာ၊ automation နဲ့ ပြင်တာ၊ architecture ပြောင်းပြီး အားနည်းချက်ကို ဖယ်ပစ်တာ ဆိုပြီး သုံးမျိုး ရှိပါတယ်။

On screen:

- B2 step (1), cleared (P5 two-axis placement): ဘယ်လောက် ခဏခဏ (underline axis, label at its right end) | ဘယ်လောက် ဆိုး (thin vertical rectangle, label at its top)
- B2 step (2) (small labelled blue ellipses): စာရင်း ပြတ် (right and high) | zone ဆုံးရှုံး (left and very high) | SMS gateway မျှသုံး (middle)
- B2 step (3): ဖြစ်နိုင်ခြေ × ထိခိုက်မှု (orange, with a strike, beside "zone ဆုံးရှုံး")
- B2 step (4) (one decision beside each ellipse): ဈေးပေါ check၊ အမြဲ ဖွင့် (green) | plan အခု၊ တစ်ဆင့်ချင်း ပြင် (violet) | လက်ခံ၊ ရေးမှတ်ထား (orange)

## Scene 4 · Is it really independent?

chapter: တကယ် သီးခြား ဖြစ်ရဲ့လား

> ⟪close board⟫ ⟪board B3 step 1⟫ zone ဆုံးရှုံးရင် သုံးမယ့် plan ကို ရေးရင်း ကိုဇော်က lesson ၂၀ မှာ zone သုံးခုဆီ ဖြန့်ခဲ့တဲ့ Wallet ကို ပြန်စစ်ပါတယ်။ zone တစ်ခုစီက ပြဿနာ တစ်ခုတည်းကြောင့် အတူ ပျက်နိုင်တဲ့ အုပ်စု၊ failure domain ဖြစ်လို့ zone တစ်ခု ပျက်ရင် Wallet ရဲ့ သုံးပုံတစ်ပုံပဲ ထိမှာပါ၊ blast radius ကို ကျဉ်းအောင် ခွဲထားတာပါ။
> ⟪board B3 step 2⟫ ဒါပေမဲ့ request လမ်းကြောင်းကို လိုက်ကြည့်တော့ zone သုံးခုလုံးက login session တွေကို zone A ထဲက cache တစ်ခုတည်းကနေ ဖတ်နေတာ တွေ့ပါတယ်။ zone A ပျက်ရင် သုံးပုံတစ်ပုံ မဟုတ်ဘဲ Wallet တစ်ခုလုံး ရပ်မှာပါ။ ဒီလို တစ်ခုကို မျှသုံးလို့ အတူ ပျက်ကြတာကို lesson ၈ ကလိုပဲ shared fate လို့ ခေါ်ပါတယ်။
> ⟪board B3 step 3⟫ ဒီတော့ zone တစ်ခုစီမှာ ကိုယ်ပိုင် session cache ထားလိုက်ပါတယ်။ zone တွေ သီးခြားလို့ ထင်ရုံနဲ့ မလုံလောက်ပါဘူး၊ deployment တွေကို failure domain နဲ့ ကိုက်အောင် ထားပြီး zone တစ်ခု ဆုံးရှုံးရင် ဘာတွေ ပါသွားမလဲ ဂဏန်းနဲ့ တွက်ကြည့်ရပါမယ်။
> ⟪board B3 step 4⟫ domain တွေကိုလည်း ပိုကြီးအောင် မချဲ့ဘဲ domain အသစ် ထပ်တိုးရပါမယ်။ domain ကြီး တစ်ခု ပျက်ရင် သူ့ traffic အကုန် ကျန်တဲ့ domain တွေဆီ တစ်ပြိုင်နက် ပြေးလာပြီး သူတို့ကိုပါ လဲစေနိုင်လို့ပါ။ ပြန်ကောင်းလာတဲ့ domain ကိုလည်း traffic တစ်ခါတည်း ပြန်ဝင်ရင် ထပ်လဲနိုင်လို့ အဆင့်လိုက်ပဲ ပြန်လွှဲပါတယ်။
> ⟪board B3 step 5⟫ ဈေးနှုန်းစာရင်းလို အမှားက zone သုံးခုလုံးကို ထိသွားရင်ကော? zone တစ်ခုကို traffic ကနေ ခွဲထုတ်ပြီး ကောင်းမှန်းသိတဲ့ မိတ္တူကနေ ပြန်ပြင်ပါတယ်။ config၊ data နဲ့ binary တွေကို သီးသန့် ကာကွယ်ထားတဲ့ ဒီ မိတ္တူက ပြောင်းလဲမှု အသစ်တွေကို နောက်ဆုံးမှ လက်ခံပါတယ်။ ပြီးရင် အဲဒီ zone ကို ပြန်ချိတ်ပြီး ကျန်တဲ့ zone တွေမှာ တစ်ခုချင်း ထပ်လုပ်ပါတယ်။

On screen:

- B3 step (1), cleared (P2 comb; furniture title "Wallet"; zones stacked on the right): zone A: 33% | zone B: 33% | zone C: 33%
- B3 step (2): session cache (zone A) (orange box on the left, combing through a bus into all three zones) | zone A ပျက် = 100% ပျက် (red)
- B3 step (3): zone တိုင်းမှာ ကိုယ်ပိုင် cache (green)
- B3 step (4): domain မချဲ့၊ အရေအတွက် တိုး · traffic ကို အဆင့်လိုက် လွှဲ (orange text at the bottom, two lines)
- B3 step (5): ကောင်းမှန်းသိတဲ့ မိတ္တူ / zone တစ်ခုချင်း ခွဲ၊ ပြင်၊ ပြန်ချိတ် (green box, two lines)

## Scene 5 · Dependency arithmetic

chapter: Dependency တွေကို မြှောက်ကြည့်

> ⟪close board⟫ ⟪board B4 step 1⟫ Eats ရဲ့ product manager မနှင်းက checkout အတွက် rider တွေနဲ့ ဆိုင်တွေကို ၉၉.၉ ရာခိုင်နှုန်း ကတိပေးချင်ပါတယ်။ checkout က Wallet ကနေ ငွေဖြတ်ပြီးမှ SMS ပို့ဖို့ notification service ကို ခေါ်ပါတယ်။ ဒီလို request တစ်ခုက အစဉ်လိုက် ခေါ်ရတဲ့ dependency တွေကို serial dependency လို့ ခေါ်ပါတယ်။
> ⟪board B4 step 2⟫ Wallet က ၉၉.၉ ရာခိုင်နှုန်း၊ notification က ၉၉ ရာခိုင်နှုန်း ဆိုရင် နှစ်ခုလုံး အောင်မြင်မှ checkout အောင်မြင်တာမို့ availability တွေကို မြှောက်ရပြီး ၉၈.၉ ရာခိုင်နှုန်းလောက်ပဲ ရပါတယ်။ ဒါက နှစ်ခု သီးခြားစီ ပျက်တယ်လို့ ယူဆတာပါ၊ ဘယ်လိုပဲ ဖြစ်ဖြစ် notification ရဲ့ ၉၉ ကိုတော့ မကျော်နိုင်ပါဘူး။
> ⟪board B4 step 3⟫ ဒီ design နဲ့ ၉၉.၉ ကတိ မပေးနိုင်လို့ notification ကို queue ထဲ ထည့်လိုက်ပါတယ်။ checkout က SMS ပို့တဲ့အထိ မစောင့်တော့ဘဲ queue ထဲ ရောက်တာနဲ့ ပြီးသွားလို့ notification service ခဏ ပျက်နေလည်း checkout က ဆက်အလုပ်လုပ်ပါတယ်။
> ⟪board B4 step 4⟫ SMS ဘက်မှာတော့ ဒီ တွက်နည်းက အကောင်းဘက်ကနေ လှည့်စားနိုင်ပါတယ်။ provider နှစ်ခုက ၁ ရာခိုင်နှုန်းစီ ပျက်တယ် ဆိုပါစို့၊ သီးခြားစီ ပျက်ရင် နှစ်ခုလုံး တစ်ပြိုင်နက် ပျက်တာ ၁၀၀၀၀ ခါမှာ တစ်ခါပဲ ရှိလို့ ၉၉.၉၉ ရာခိုင်နှုန်း ရမှာပါ။ ဒါပေမဲ့ နှစ်ခုလုံးက operator gateway တစ်ခုတည်းကို ဖြတ်ရလို့ gateway ထက် ပိုမကောင်းနိုင်ပါဘူး၊ ဒါလည်း shared fate ပါပဲ။
> ⟪board B4 step 5⟫ ဒါကြောင့် error budget တွေကို ရိုးရိုး ပေါင်းမယ့်အစား request က dependency တွေကို တကယ် ဘယ်လို ခေါ်လဲ၊ ဘာကို မျှသုံးလဲ အရင် ဆွဲကြည့်ပြီးမှ တွက်ပါ။

On screen:

- B4 step (1), cleared (P1 flow): Eats checkout → Wallet 99.9% → notification 99%
- B4 step (2): ≈ 98.9% (violet box at the end of the flow) | သီးခြားစီ ပျက်ရင် / ဘယ်လိုပဲ 99% ကို မကျော် (small violet text under it, two lines)
- B4 step (3): ကတိ 99.9%? (orange, with a strike) | notification ကို queue (green, under "notification 99%")
- B4 step (4) (P2 fan-in below the flow): SMS provider 1 | SMS provider 2 | operator gateway: သူ့ထက် မကောင်း (red, the two providers combing into it)
- B4 step (5): (red circle around "operator gateway", no new label)

## Scene 6 · Eats checkout's dependency card

chapter: Dependency card

> ⟪close board⟫ ⟪page l23_p02⟫ Eats အဖွဲ့က ဒါတွေကို dependency card တစ်ခုထဲ ချရေးပါတယ်။ မရှိမဖြစ် လိုတာက Wallet ဖြစ်ပြီး notification ကိုတော့ queue ကနေ ပို့ပါတယ်။ loyalty နဲ့ ဟင်းပွဲ ဓာတ်ပုံ service တွေမှာတော့ test ထဲ failure ကို inject လုပ်ကြည့်ပြီး checkout ဆက် အောင်မြင်မှ optional လို့ ရေးပါတယ်၊ မအောင်မြင်ရင် မရှိမဖြစ်ထဲ ထည့်ပါတယ်။
> ⟪page l23_p02b⟫ ကိုယ့်ကို မှီခိုနေတဲ့သူတွေကို ပေးရမယ့် ကတိလည်း card ပေါ်မှာ ပါပါတယ်။ checkout က Wallet ရဲ့ ၉၉.၉ ကို မကျော်နိုင်လို့ မနှင်းက rider တွေနဲ့ ဆိုင်တွေကို ၉၉.၅ ရာခိုင်နှုန်းပဲ ကတိပေးပါတယ်။ ပြဿနာကြီး ဖြစ်တဲ့နေ့ ဘယ်သူ့အတွက် အရင် ပြန်ဖွင့်ပေးမလဲ ဆိုတာလည်း ဒီ ကတိတွေနဲ့ ဆုံးဖြတ်ပါတယ်။
> ⟪page l23_p02c⟫ အရင်က SMS gateway ပျက်တုန်းက notification အဖွဲ့ရော Top-up အဖွဲ့ရော တစ်ဖက်အဖွဲ့က ပိုင်တယ်လို့ ထင်နေခဲ့ပါတယ်။ ဒါကြောင့် အခု မျှသုံးတဲ့ dependency တိုင်းမှာ owner တစ်ယောက်ကို နာမည်နဲ့ ရေးပြီး owner မရှိတဲ့ ကွက်လပ်တွေကို ခေါင်းဆောင်တွေက လိုက်ရှာပါတယ်။ SMS gateway ကို ပြန်ကြည့်တဲ့နေ့ ရောက်တော့ gateway ကို မဖြတ်တဲ့ ကိုယ်ပိုင် လမ်းကြောင်းနဲ့ provider တစ်ခုကို fallback ထည့်ပါတယ်၊ ဈေးပိုကြီးပေမဲ့ gateway နဲ့ အတူ မပျက်ပါဘူး။

On screen:

- l23_p02 (K4): Eats checkout ရဲ့ dependency card | လိုအပ်: Wallet · notification ကို queue | optional: loyalty၊ ဓာတ်ပုံ (စမ်းပြီး) | ကတိ: rider နဲ့ ဆိုင်တွေကို 99.5%
- l23_p02b (K4, the same cards as l23_p02, the third card highlighted yellow)
- l23_p02c (K3, left gray / right teal; cells as left / right): အရင် / အခု | owner: တစ်ဖက်အဖွဲ့လို့ ထင် / owner: နာမည် တစ်ယောက် | ကွက်လပ်: ဘယ်သူမှ မရှာ / ခေါင်းဆောင်တွေ ရှာ | SMS fallback: gateway တစ်ခုတည်း / ကိုယ်ပိုင် လမ်းကြောင်း

## Scene 7 · Bad input

chapter: Bad input

> ⟪close page⟫ ⟪board B5 step 1⟫ ည ၁ နာရီက ဈေးနှုန်းစာရင်းဆီ ပြန်သွားရအောင်။ ပုံမှန်နဲ့ မတူတဲ့ ဒါမှမဟုတ် မှားနေတဲ့ input၊ bad input က attacker ဆီကပဲ မဟုတ်ဘဲ ကိုယ့် job ဒါမှမဟုတ် dependency ကနေလည်း လာနိုင်ပါတယ်။ စာရင်းက တစ်ဝက်မှာ ပြတ်နေတာ၊ အလွတ် ဖြစ်နေတာ၊ ဟောင်းနေတာ ဖြစ်နိုင်ပါတယ်။ ဒီတော့ server တွေ မယုံခင် မနေ့ကထက် အများကြီး သေးနေလား၊ တစ်နာရီထက် ဟောင်းနေလား စစ်ပါတယ်။
> ⟪board B5 step 2⟫ check မအောင်ရင် စာရင်းအသစ်ကို ငြင်းပြီး alert တက်ပါတယ်၊ server တွေကတော့ နောက်ဆုံး ကောင်းခဲ့တဲ့ version ကို ဆက်သုံးပါတယ်။ သံသယ ဖြစ်ရင် မနေ့က စာရင်းနဲ့ ဆက် run နေတာက အန္တရာယ် အနည်းဆုံးပါ။
> ⟪board B5 step 3⟫ check ကို အောင်သွားရင်တောင် server တိုင်းဆီ တစ်ခါတည်း မပို့ပါဘူး။ server တိုင်း မျှသုံးတဲ့ data က နေရာတိုင်းကို တစ်ပြိုင်နက် ရောက်သွားလို့ အန္တရာယ် အများဆုံး ပြောင်းလဲမှုပါ၊ ဒါကြောင့် code လိုပဲ zone တစ်ခုချင်း rollout လုပ်ရပါတယ်။
> ⟪board B5 step 4⟫ data ဖတ်တဲ့ service တိုင်းကလည်း data မှားနေရင်၊ အလွတ် ဖြစ်နေရင် ဘာလုပ်မလဲ ကြိုဆုံးဖြတ်ထားရပါမယ်။ fraud blocklist အလွတ်ကို ယုံရင် ဘာမှ မတားတော့လို့ အကုန် ဖြတ်သွားပါတယ်၊ ဒါက fail open ပါ။ merchant စာရင်း အလွတ်ကို ယုံရင်တော့ ဆိုင်တိုင်းရဲ့ ငွေချေမှု ပိတ်ကုန်မှာမို့ fail closed ပါ၊ ဘယ်ဟာ ဘေးကင်းလဲ ဆိုတာ data အလိုက် ကွာပါတယ်။

On screen:

- B5 step (1), cleared (P1 flow): ဈေးနှုန်းစာရင်း job → မနေ့ကထက် သေး? / တစ်နာရီထက် ဟောင်း? (orange box, two lines)
- B5 step (2): → ငြင်း၊ alert (red) | နောက်ဆုံး ကောင်းခဲ့တဲ့ version (green, under the red box)
- B5 step (3): → server တွေ / zone တစ်ခုချင်း (box, two lines)
- B5 step (4): fraud blocklist အလွတ်: fail open | merchant စာရင်း အလွတ်: fail closed (orange text at the bottom, two lines)

## Scene 8 · This week

chapter: —

> ⟪close board⟫ ⟪page l23_p03⟫ failure တစ်ခု ဘယ်အထိ ပျံ့နိုင်လဲ သိအောင် ဒီအပတ် စလုပ်စရာ သုံးခုပါ။ ကိုယ့် zone တွေ တကယ်တော့ database၊ cache၊ gateway လို ဘာတွေကို မျှသုံးနေလဲ စာရင်း လုပ်ကြည့်ပါ။ အရေးအကြီးဆုံး journey ရဲ့ dependency တွေကို ဆွဲပြီး availability တွေကို မြှောက်ကြည့်ပါ။ ပြီးတော့ ညတိုင်း ဝင်လာတဲ့ data တစ်ခုမှာ မနေ့ကထက် သေးလွန်းနေလား စစ်တဲ့ check တစ်ခု ထည့်ပါ။

On screen:

- l23_p03 (K2): ဒီအပတ် လုပ်စရာ | zone တွေ တကယ် မျှသုံးတာကို စာရင်းလုပ်ပါ | journey ရဲ့ dependency တွေကို မြှောက်ပါ | "သေးလွန်းလား?" check ထည့်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ ဘောင်ခတ်နည်းတွေကို ပြန်ခေါ်ကြည့်ပါမယ်။ ⟪select resilience⟫ resilience က design ဘောင် အပြင်က failure ကိုပါ ဘောင်ခတ်ပြီး ပြန်ကောင်းလာနိုင်တာပါ။ ⟪select failure domain⟫ failure domain က အတူ ပျက်နိုင်တဲ့ အုပ်စု ဖြစ်ပြီး၊ ⟪select blast radius⟫ blast radius က မှားရင် ထိခိုက်မယ့် နယ်ပယ်ပါ။
> ⟪select serial dependency⟫ serial dependency တွေမှာ availability တွေကို မြှောက်ရလို့ စုစုပေါင်းက အားအနည်းဆုံး တစ်ခုထက်တောင် နိမ့်ပါတယ်။ ⟪select shared fate⟫ shared fate က တစ်ခုတည်းကို မျှသုံးလို့ အတူ ပျက်တာ ဖြစ်ပြီး၊ ⟪select fail open / fail closed⟫ fail open နဲ့ fail closed က data မှားရင် ဆက်ခွင့်ပြုမလား ပိတ်မလား ကြိုရွေးထားတာပါ။
> ⟪select မေးခွန်း⟫ journey တစ်ခုက သီးခြားစီ ပျက်တဲ့ service နှစ်ခုကို အစဉ်လိုက် ခေါ်ပြီး တစ်ခုက ၉၉.၉၊ နောက်တစ်ခုက ၉၉.၅ ရာခိုင်နှုန်း ဆိုရင် journey က အကောင်းဆုံး ဘယ်လောက် ရနိုင်လဲ?
> ⟪pause 3s⟫ ၉၉.၄ ရာခိုင်နှုန်းလောက်ပါ၊ မြှောက်ရလို့ ၉၉.၅ ထက်တောင် နိမ့်ပါတယ်။ ခြောက်ပတ် ပြင်ဆင်ခဲ့တဲ့ သင်္ကြန် ညသန်းခေါင် ရောက်တော့ တစ်စက္ကန့်ကို request ၃၀၀၀ အတွက် ဆောက်ထားတဲ့ top-up service ဆီ ၂၀၀၀၀ ရောက်လာပြီး server တွေ restart ဖြစ်လာပါတယ်။ ပြိုမကျဘဲ ဘယ်လို တည်ငြိမ်အောင် ထိန်းမလဲ?

On screen:

- notes.md: # Failure ကို ဘောင်ခတ်ထားတဲ့ design | (blank line) | - resilience — design ဘောင် အပြင်က failure ကိုပါ ဘောင်ခတ်ပြီး ပြန်ကောင်းလာ | - failure domain — ပြဿနာ တစ်ခုတည်းကြောင့် အတူ ပျက်နိုင်တဲ့ အုပ်စု | - blast radius — မှားရင် ထိခိုက်မယ့် နယ်ပယ် | - serial dependency — အစဉ်လိုက် ခေါ်ရလို့ availability တွေ မြှောက်ရ | - shared fate — တစ်ခုတည်းကို မျှသုံးလို့ အတူ ပျက် | - fail open / fail closed — data မှားရင် ဆက်ခွင့်ပြုမလား၊ ပိတ်မလား | (blank line) | မေးခွန်း: journey က သီးခြား service 2 ခုကို အစဉ်လိုက် ခေါ်တယ်၊ 99.9% နဲ့ 99.5%။ အကောင်းဆုံး ဘယ်လောက် ရနိုင်လဲ?
