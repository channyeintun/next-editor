# Lesson 18 · Test နဲ့ config

slug: sre-18-testing-and-config · budget: 7600 characters (±5%)

## Scene 1 · Hook: tests green, Operator A at zero

chapter: Test အစိမ်းနဲ့ traffic သုည

> ⟪page l18_p01⟫ toil ပစ်မှတ်ကို ၃၅ ရာခိုင်နှုန်း ထားလိုက်ပြီး promo tool က input အလွတ်ကို ငြင်းတတ်လာသလို failover bot ကလည်း action card အတိုင်း လုပ်နေပါပြီ။ ဒီတစ်ခါတော့ လစာထုတ်ရက် ညနေမှာ test တွေ အားလုံး အစိမ်းရောင် ဖြစ်နေပေမဲ့ Operator A ဆီ top-up တစ်ခုမှ မရောက်တော့ပါဘူး။ တစ်ယောက်က console ထဲမှာ routing ကို လက်နဲ့ ပြင်လိုက်လို့ပါ။
> ⟪page l18_p01b⟫ Top-up router က operator တစ်ခုစီဆီ traffic ဘယ်လောက်စီ ပို့မလဲကို config ထဲက weight တွေနဲ့ ဆုံးဖြတ်ပါတယ်။ အဲဒီညနေက Operator B နှေးနေလို့ engineer တစ်ယောက်က B ဆီ ပို့တာကို လျှော့ရင်း Operator A ရဲ့ weight ကိုပါ ၅၀ ကနေ သုည ဖြစ်အောင် မှားပြင်မိခဲ့တာပါ။ deploy လည်း မရှိ၊ code လည်း မပြောင်းခဲ့တော့ အကြောင်းရင်း ရှာတွေ့ဖို့ မိနစ် ၄၀ ကြာခဲ့ပါတယ်။
> test တွေက router ရဲ့ code ကို စစ်ခဲ့ပေမဲ့ config ကိုတော့ ဘယ်တော့မှ မကြည့်ခဲ့ပါဘူး။ ဒီတော့ test အစိမ်းရောင်က ဘာကို တကယ် သက်သေပြတာလဲ?

On screen:

- l18_p01 (K1): 18 | Test နဲ့ config | Test အစိမ်း၊ Operator A ဆီ traffic 0 | console ကနေ routing ကို တစ်ယောက် ပြင်ခဲ့ | weight က 0 ဖြစ်သွား | test တွေက ဘာကို မကြည့်ခဲ့လဲ? | (small loop badge, တည်ဆောက် lit)
- l18_p01b (K7): Operator A ရဲ့ weight | 50 → 0 | console ကနေ မှားပြင်၊ ရှာတာ 40 မိနစ်

## Scene 2 · What a test proves

chapter: Test က ဘာကို သက်သေပြလဲ

> ⟪page l18_p02⟫ postmortem မှာ မသီရိက ဒီ မေးခွန်းကို ပြန်မေးပါတယ်။ router ရဲ့ test တွေက weight ကို ၅၀၊ ၃၀၊ ၂၀ လို့ ပုံသေ ထည့်စမ်းထားလို့ pass ဖြစ်ခဲ့တာပါ။ ဆိုတော့ test pass ဖြစ်တာက ကိုယ် ကြိုတွေးထားတဲ့ case တွေ အလုပ်လုပ်နေသေးတယ် ဆိုတာလောက်ပဲ ပြောနိုင်ပြီး system ကောင်းနေတယ်လို့ သက်သေ မပြပါဘူး။ test fail ဖြစ်တာကတော့ တကယ့် ပြဿနာ ရှိနေတယ်ဆိုတာကို သေချာ ပြပါတယ်။
> ⟪page l18_p02b⟫ system တိုင်းက input ဒီပုံစံ လာမယ်၊ operator တွေ ဒီလောက် မြန်မယ်၊ weight တွေ သုည မဖြစ်ဘူး ဆိုတဲ့ ယူဆချက်တွေ ပေါ်မှာ ဆောက်ထားတာပါ။ outage အတော်များများကလည်း code ရေးတာ မှားလို့ချည်း မဟုတ်ဘဲ ဒီလို ယူဆချက် တစ်ခု မှားနေလို့ ဖြစ်တာပါ။ ဒါကြောင့် test ရဲ့ တကယ့် အလုပ်က ကိုယ့် ယူဆချက်တွေထဲက ဘယ်ဟာ မှားနေလဲ ဆိုတာကို user မတွေ့ခင် ရှာပေးတာပါ။

On screen:

- l18_p02 (K2): Test က ဘာကို သက်သေပြလဲ | pass: ကြိုတွေးထားတဲ့ case တွေ ရသေး | fail: တကယ့် ပြဿနာ ရှိ | outage အတော်များများ: ယူဆချက် မှား တစ်ခု
- l18_p02b (K4): System ရဲ့ ယူဆချက်တွေ | input: ဒီပုံစံ လာမယ် | operator: ဒီလောက် မြန်မယ် | weight: 0 မဖြစ်ဘူး ✗

## Scene 3 · Test map

chapter: Test မြေပုံ

> ⟪close page⟫ ⟪board B1 step 1⟫ ဒါဆို test အမျိုးအစားတွေကို မြေပုံလို စီကြည့်ရအောင်။ unit test က function တစ်ခုချင်းကို စမ်းပြီး integration test ကတော့ router ကို operator gateway အစစ်အစား fake server နဲ့ ချိတ်စမ်းသလို အစိတ်အပိုင်းတွေ တွဲအလုပ်လုပ်တာကို စမ်းပါတယ်။
> ⟪board B1 step 2⟫ smoke test ကတော့ deploy ပြီးတာနဲ့ user တစ်ယောက် ရည်ရွယ်ချက် တစ်ခု ပြီးဖို့ ဖြတ်သွားရတဲ့ critical user journey တွေ ရသေးလား မြန်မြန် လျှောက်စစ်တာပါ၊ ဥပမာ ၁၀၀၀ ကျပ် top-up တစ်ခုကို အစအဆုံး ဖြည့်ကြည့်တာမျိုးပါ။
> ⟪board B1 step 3⟫ ညာဘက်မှာတော့ version အသစ်ကို traffic နည်းနည်းဆီ အရင် ပို့ပြီး အဟောင်းနဲ့ နှိုင်းယှဉ်တဲ့ canary နဲ့ ပျက်စီးမှုကို တမင် inject လုပ်တဲ့ fault test ရှိပါတယ်၊ ဒီနှစ်ခုက production ထဲမှာ စမ်းတာမို့ lesson ၁၉ အတွက် ချန်ထားပါမယ်။ ဆိုတော့ testing က release နဲ့ မပြီးပါဘူး။ release တိုင်း နည်းနည်းစီ နှေးလာတာမျိုးကိုလည်း test တစ်ခုခုက ပုံမှန် မတိုင်ရင် ဘယ်သူမှ သတိမထားမိပါဘူး။
> ⟪board B1 step 4⟫ ဘယ်ဘက်က test တွေကို repeatable test လို့ ခေါ်ပါတယ်။ ပြင်ပ system တွေကို မမှီလို့ ဘယ်နှခါ run run ရလဒ် တူပြီး fail ရင်လည်း အကြောင်းရင်း ရှာရ လွယ်တာမို့ test အများစုက ဒီလို ဖြစ်သင့်ပါတယ်။ ညာဘက်ကတော့ staging က မတုပနိုင်တဲ့ တကယ့် user၊ တကယ့် config နဲ့ တွေ့ရတဲ့ နောက်ဆုံး စစ်ဆေးချက်ပါ။
> ⟪board B1 step 5⟫ လူသိများတဲ့ test pyramid ကတော့ အလွှာ တစ်ခုစီမှာ test ဘယ်နှခု ရှိလဲ ပြပေမဲ့ ဘယ် test က user ကို တကယ် ကာကွယ်ပေးလဲ မပြပါဘူး။ ဒါကြောင့် test နည်းတဲ့ system ဟောင်းမှာ စမယ်ဆိုရင် payment လို ငွေနဲ့ ဆိုင်တဲ့ အပိုင်းကနေ စပြီး တခြားသူတွေ ခေါ်သုံးတဲ့ API၊ ကိုယ် ခေါ်သုံးတဲ့ API တွေကို ဆက်စစ်ပါ။

On screen:

- B1 step (1), cleared (P1 flow, English labels, left to right): unit → integration
- B1 step (2): → smoke
- B1 step (3): → canary → fault
- B1 step (4): repeatable (blue label over unit and integration) | real world: final check (orange label over canary and fault)
- B1 step (5): စမယ့်နေရာ: payment → တခြားသူ ခေါ်တဲ့ API → ကိုယ် ခေါ်တဲ့ API (orange text under the strip, two lines)

## Scene 4 · Two habits

chapter: အလေ့အထ နှစ်ခု

> ⟪close board⟫ ⟪page l18_p03⟫ test တွေ ကောင်းလာဖို့ အလေ့အထ နှစ်ခုနဲ့ စလို့ရပါတယ်။ ပထမက bug တစ်ခု တွေ့တိုင်း မပြင်ခင် အဲဒီ bug ကြောင့် fail ဖြစ်တဲ့ test ကို အရင် ရေးတာပါ။ ဥပမာ request တစ်ခုကို နှစ်ခါ ပို့ရင်တောင် ငွေ တစ်ခါပဲ ဖြတ်ရမယ် ဆိုတဲ့ test မျိုးပါ။ build နီနေရင်လည်း ချက်ချင်း ပြင်ပါ၊ ကြာကြာ နီနေရင် test တွေကို ဘယ်သူမှ မယုံတော့ပါဘူး။
> ⟪page l18_p03b⟫ ဒုတိယက alert တစ်ခုစီ စောင့်ကြည့်နေတဲ့ အခြေအနေကို test ထဲမှာ ပြန်ဖန်တီးတာပါ။ ဥပမာ Operator B နှေးရင် တက်တဲ့ alert အတွက် နှေးနေတဲ့ fake server နဲ့ စမ်းကြည့်တော့ router က ချက်ချင်း သုံးခါ retry လုပ်လို့ နှေးနေတဲ့ gateway ဆီ ဝန် သုံးဆ ရောက်နေတာ တွေ့ပါတယ်။ ဒီ အားနည်းချက်ကို user မတွေ့ခင် တွေ့သွားသလို alert တကယ် တက်တဲ့ညမှာလည်း on-call ကျသူက ဘာကို အရင် စစ်ရမလဲ သိနေပါပြီ။

On screen:

- l18_p03 (K2): အလေ့အထ နှစ်ခု | bug တိုင်း: fail တဲ့ test ကို အရင် | alert တိုင်း: အကြောင်းရင်းကို test လုပ် | build နီရင် ချက်ချင်း ပြင်
- l18_p03b (K6): alert ကနေ test | Operator B နှေး | fake server | retry 3 ခါ တွေ့ | on-call သိပြီးသား

## Scene 5 · Padauk's config questions

chapter: Config ကိုလည်း code လို

> ⟪page l18_p04⟫ ဒါပေမဲ့ ဒီ test တွေ အားလုံးက code ကိုပဲ စစ်ပါတယ်။ code အသစ်ကို feature flag နဲ့ တဖြည်းဖြည်း ဖွင့်လို့ရပေမဲ့ config ပြောင်းတာကတော့ server အားလုံးဆီ တစ်ပြိုင်နက် ရောက်သွားနိုင်လို့ code ပြောင်းသလောက်ပဲ အန္တရာယ် ရှိပါတယ်။ ဒါကြောင့် မသီရိက config ပြောင်းတိုင်း ဘယ်သူမဆို မြင်နိုင်လား၊ တစ်ဆင့်တည်းနဲ့ ပြန်ပြောင်းနိုင်လား၊ check တစ်ခုခု run ခဲ့လား ဆိုတဲ့ မေးခွန်း သုံးခု မေးပါတယ်။ console ကနေ ပြင်ခဲ့တဲ့ ညနေကတော့ ဒီ သုံးခုထဲက တစ်ခုမှ မရှိခဲ့ပါဘူး။
> ⟪page l18_p04b⟫ ပြင်ဖို့အတွက်တော့ config ကို code လို Git ထဲမှာ ထိန်းတဲ့ GitOps principle လေးခုကို လမ်းညွှန်အဖြစ် ယူပါတယ်။ လိုချင်တဲ့ အခြေအနေကို file ထဲမှာ ရေးထားမယ်၊ version တွေနဲ့ သိမ်းမယ်၊ system က အလိုအလျောက် ဆွဲယူမယ်၊ live ကို Git နဲ့ အမြဲ ကိုက်အောင် ညှိနေမယ် ဆိုတာတွေပါ။
> ⟪page l18_p04c⟫ ဝန်ဆောင်ခ config က lesson ၂ ကတည်းက Git ထဲ ရောက်နေပေမဲ့ routing config ကတော့ console ထဲမှာ ကျန်ခဲ့တာပါ။ အခု သူ့ကိုလည်း Git ထဲ ရွှေ့လိုက်တော့ ပြောင်းလဲမှုတိုင်းကို review လုပ်ရပြီး CI က build နဲ့ test ကို run ပေးပါတယ်၊ မှားရင်လည်း Git မှာ တစ်ဆင့်တည်းနဲ့ ပြန်ပြောင်းလို့ရပါတယ်။ config ကို ဖတ်လို့ မရရင်တောင် router က operator သုံးခုလုံးဆီ တန်းတူ ခွဲပို့တဲ့ safe default ကို သုံးပါတယ်။

On screen:

- l18_p04 (K4): Config ပြောင်းတိုင်း မေးခွန်း သုံးခု | ဘယ်သူမဆို မြင်နိုင်လား? | တစ်ဆင့်တည်းနဲ့ ပြန်ပြောင်းနိုင်လား? | check တစ်ခုခု run ခဲ့လား?
- l18_p04b (K5): GitOps principle 4 ခု | ရေးထား: လိုချင်တဲ့ အခြေအနေ | version: Git ထဲ သိမ်း | ဆွဲယူ: အလိုအလျောက် | ညှိ: live ကို Git နဲ့ ကိုက်
- l18_p04c (K2): Padauk ရဲ့ routing config | Git ထဲမှာ၊ review နဲ့ | CI က build နဲ့ test | safe default: သုံးခုလုံးဆီ တန်းတူ

## Scene 6 · Config checks

chapter: Config check သုံးဆင့်

> ⟪close page⟫ ⟪board B2 step 1⟫ တတိယ မေးခွန်းအတွက်တော့ routing config ပြောင်းတိုင်း rollout မတိုင်ခင် config check လို့ ခေါ်တဲ့ စစ်ဆေးမှု သုံးဆင့်ကို ဖြတ်ရပါတယ်။ syntax check က file ပုံစံ မှန်လား စစ်ပြီး ဒုတိယ အဆင့်က တန်ဖိုးတွေရဲ့ အဓိပ္ပာယ် မှန်လား စစ်ပါတယ်။ dry run ကတော့ config အသစ်ကို router copy တစ်ခုမှာ စမ်းတင်ပြီး operator တစ်ခုစီဆီ test top-up တစ်ခုစီ ပို့ကြည့်တာပါ။
> ⟪board B2 step 2⟫ Operator A ကို သုည ထားတဲ့ file ကလည်း syntax အရတော့ မှန်နေတာပါပဲ။ ဒါကြောင့် Padauk ရဲ့ အဓိပ္ပာယ် check တွေက weight တွေ ပေါင်းရင် ၁၀၀ ဖြစ်ရမယ်၊ မနက် ၆ နာရီကနေ ညသန်းခေါင်အထိ ဘယ် operator မှ သုည မဖြစ်ရဘူး၊ ဝန်ဆောင်ခ ၂၀ ရာခိုင်နှုန်းထက် ပိုတက်ရင် ဒုတိယ လူတစ်ယောက် approve လုပ်ရမယ် ဆိုတာတွေပါ။
> ⟪board B2 step 3⟫ incident အတွင်း review ကို စောင့်ချိန် မရှိရင်တော့ ပုံမှန် ကန့်သတ်ချက်တွေကို ကျော်တဲ့ break-glass လမ်း၊ emergency push ကို သုံးပါတယ်။ review ကို ကျော်ပေမဲ့ syntax check နဲ့ ဘယ်သူ ဘာ ပြောင်းခဲ့လဲ ဆိုတဲ့ log ကိုတော့ မကျော်ပါဘူး။
> ⟪board B2 step 4⟫ code ကို အရေးပေါ် push လုပ်ရင်လည်း ကျော်ခဲ့တဲ့ test တွေကို ချက်ချင်း ဆက် run ပါတယ်။ fail ရင် အဲဒီ push ကို ပျက်နေတယ်လို့ မှတ်ထားတော့ နောက် fix လုပ်မယ့်သူက အမှန်ကို သိပြီးမှ စနိုင်ပါတယ်။ break-glass ကို အပတ်တိုင်း သုံးနေရရင်တော့ အဲဒီ လမ်းမှာ မြန်တဲ့ test အစုလေး တစ်ခုကို အလိုအလျောက် run အောင် လုပ်ထားပါ။

On screen:

- B2 step (1), cleared (P6 lanes; top lane, P1 flow): syntax → အဓိပ္ပာယ် → dry run → rollout (green)
- B2 step (2) (one three-line text block under အဓိပ္ပာယ်): weight ပေါင်း = 100 / 06:00–24:00 မှာ 0 မရ / ဝန်ဆောင်ခ +20% → ဒုတိယ approve
- B2 step (3) (bottom lane): emergency push (red) → review ကျော် / syntax check + log ကျန် (orange, two lines)
- B2 step (4): ကျော်ခဲ့တဲ့ test တွေ ချက်ချင်း run (small orange text under the bottom lane)

## Scene 7 · Drift

chapter: Git နဲ့ live မတူတော့ရင်

> ⟪close board⟫ ⟪board B3 step 1⟫ တစ်လအကြာ လစာထုတ်ရက် ညမှာ Operator B နှေးလာပြန်ပါတယ်။ on-call ကျနေသူက emergency push နဲ့ live မှာ Operator A ရဲ့ weight ကို ၅၀ ကနေ ၇၀ ကို တင်လိုက်တော့ top-up တွေ ပြန်ကောင်းလာပေမဲ့ Git ထဲကိုတော့ ဘယ်သူမှ ပြန်မထည့်ခဲ့ပါဘူး။ ဒီလို live မှာ run နေတာနဲ့ Git ထဲမှာ ရေးထားတာ မတူတော့တာကို configuration drift လို့ ခေါ်ပါတယ်။
> ⟪board B3 step 2⟫ နောက်တစ်ပတ် Git ကနေ ပုံမှန် deploy လုပ်တော့ weight က ၅၀ ကို တိတ်တိတ်လေး ပြန်ရောက်ပြီး ညက fix ပျောက်သွားပါတယ်။ ဒါဆို ၅၀ နဲ့ ၇၀ ဘယ်ဟာ မှန်လဲ? drift ဖြစ်ပြီးရင် ဘယ်သူမှ သေချာ မသိတော့ပါဘူး။
> ⟪board B3 step 3⟫ drift ကို ဖြေရှင်းနည်း လေးဆင့် ရှိပါတယ်။ အဖွဲ့ သေးရင် config ကို code နဲ့ တွဲပြီး deploy လုပ်လို့ရပေမဲ့ config ကို သီးသန့် မြန်မြန် ပြောင်းနိုင်တာ ဆုံးသွားပါတယ်။ နောက်တစ်ဆင့်က CI ထဲမှာ live နဲ့ Git ကွာနေလား ရှာတာပါ။
> ⟪board B3 step 4⟫ တတိယက ကွာတာ တွေ့တိုင်း alert ပို့တာပါ။ ဒါပေမဲ့ drift alert တွေ ခဏခဏ တက်နေရင် လူတွေ ဂရုမစိုက်တော့တတ်လို့ ယုံလို့ရအောင် ထိန်းထားရပါမယ်။ နောက်ဆုံးကတော့ tool တစ်ခုက live ကို Git အတိုင်း အမြဲ အလိုအလျောက် ပြန်ညှိပေးတာပါ။
> ⟪board B3 step 5⟫ ဒါပေမဲ့ အဲဒီ tool က မှားတဲ့ commit တစ်ခုကိုလည်း နေရာတိုင်း ချက်ချင်း ပို့မှာမို့ merge မလုပ်ခင် check တွေ ခိုင်မာမှ သုံးပါ။ Padauk ရဲ့ ပထမ အဖြေကတော့ ညတိုင်း live config ကို Git နဲ့ ယှဉ်ပြီး ကွာတာကို မနက် team chat ထဲ တင်ပေးတဲ့ diff လေး တစ်ခုပါ။

On screen:

- B3 step (1), cleared: Git: weight 50 (blue box) | live: weight 70 (လက်နဲ့ ပြင်) (orange box)
- B3 step (2): နောက် deploy က fix ကို ပြန်ဖျက် (red, under both boxes)
- B3 step (3), cleared (P1 flow, left to right, two-line boxes): code နဲ့ တွဲ / (အဖွဲ့ သေး) → CI မှာ / ရှာ
- B3 step (4): → alert / (ယုံရအောင်) → Git ကနေ / auto-sync
- B3 step (5): merge မလုပ်ခင် / check ခိုင်မှ (orange note under the last box, two lines) | Padauk: ညတိုင်း diff (green label under CI မှာ ရှာ)

## Scene 8 · This week

chapter: —

> ⟪close board⟫ ⟪page l18_p05⟫ review မပါဘဲ ပြောင်းလို့ရနေတဲ့ config တစ်ခုကို ဒီအပတ် console တွေထဲမှာ ရှာပါ။ နောက်ဆုံး ပြင်ခဲ့တဲ့ bug ကို test တစ်ခု ဖြစ်အောင် ရေးပါ။ ပြီးတော့ live config တစ်ခုကို Git ထဲက version နဲ့ တစ်ခါ ယှဉ်ကြည့်ပါ။

On screen:

- l18_p05 (K2): ဒီအပတ် လုပ်စရာ | review မပါဘဲ ပြောင်းတဲ့ config ရှာပါ | နောက်ဆုံး bug ကို test လုပ်ပါ | live config ကို Git နဲ့ ယှဉ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ weight သုည ဖြစ်ခဲ့တဲ့ ညနေကနေ ဒီ လေးခုကို ယူသွားပါ။ ⟪select repeatable test⟫ repeatable test က ပြင်ပ system တွေကို မမှီလို့ ဘယ်နှခါ run run ရလဒ် တူတဲ့ test ပါ။ ⟪select smoke test⟫ smoke test က deploy ပြီးတာနဲ့ အဓိက journey တွေ ရသေးလား မြန်မြန် စစ်တာပါ။
> ⟪select config check⟫ config check က rollout မတိုင်ခင် syntax၊ အဓိပ္ပာယ်၊ dry run ဆိုပြီး သုံးဆင့် စစ်တာ ဖြစ်ပြီး၊ ⟪select configuration drift⟫ configuration drift ကတော့ live မှာ run နေတာနဲ့ Git ထဲမှာ ရှိတာ မတူတော့တာပါ။
> ⟪select မေးခွန်း⟫ ကိုယ့် system ထဲမှာ သုည လို့ ပြောင်းလိုက်ရုံနဲ့ service တစ်ခုလုံး ရပ်သွားနိုင်တဲ့ config တန်ဖိုး တစ်ခုကို စဉ်းစားကြည့်ပါ။
> ⟪pause 3s⟫ ဥပမာ worker အရေအတွက်၊ rate limit ဒါမှမဟုတ် Padauk လို traffic weight ဖြစ်နိုင်ပါတယ်။ တွေ့ရင် သုည မဖြစ်ရဘူး ဆိုတဲ့ အဓိပ္ပာယ် check တစ်ခု ထည့်လိုက်ပါ။ ညတိုင်း diff စတဲ့ အပတ်မှာပဲ ဝန်ဆောင်ခ တွက်ပေးတဲ့ pricing service ရဲ့ canary က pass ဖြစ်ပေမဲ့ Bill Pay မှာ timeout တွေ စဖြစ်လာပါတယ်။ ဘယ်သူ့ဘက်ကို ကြည့်နေခဲ့တာလဲ?

On screen:

- notes.md: # Test နဲ့ config | (blank line) | - repeatable test — ပြင်ပ system မမှီ၊ ဘယ်နှခါ run run ရလဒ် တူ | - smoke test — deploy ပြီးတာနဲ့ အဓိက journey တွေကို မြန်မြန် စစ် | - config check — syntax · အဓိပ္ပာယ် · dry run၊ rollout မတိုင်ခင် | - configuration drift — live နဲ့ Git ထဲက config မတူတော့တာ | (blank line) | မေးခွန်း: 0 လို့ ပြောင်းရုံနဲ့ service တစ်ခုလုံး ရပ်သွားနိုင်တဲ့ config တန်ဖိုး တစ်ခုကို ပြောပါ။
