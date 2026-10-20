# Lesson 25 · မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင်

slug: sre-25-platform-engineering · budget: 8400 characters (±5%)

## Scene 1 · Hook: a deploy went out during the freeze

chapter: Freeze အတွင်း ထွက်သွားတဲ့ deploy

> ⟪page l25_p01⟫ သင်္ကြန် ညနဲ့ login ပိတ်တဲ့ မနက်က သင်ခန်းစာတွေကြောင့် priority label၊ error budget နဲ့ ပြက္ခဒိန်ကို ကြည့်တဲ့ ပြောင်းလဲမှု စည်းကမ်းနဲ့ အရေးပေါ် အိတ်တွေက Padauk ရဲ့ ပုံမှန် ဖြစ်လာပါတယ်။
> ဒါပေမဲ့ နောက်တစ်နှစ်မှာ rollout တွေ ရပ်ထားရမယ့် သင်္ကြန် change freeze အတွင်း Top-up deploy တစ်ခု ထွက်သွားပြီး Wallet က သင်ခန်းစာ ယူပြီးသား outage မျိုး ထပ်ဖြစ်ပါတယ်။ wiki ပေါ်မှာပဲ ရှိတဲ့ freeze စည်းကမ်းက Wallet ရဲ့ script ထဲကိုပဲ ရောက်ခဲ့လို့ပါ။ မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင် ဘယ်လို လုပ်မလဲ?

On screen:

- l25_p01 (K1): 25 | မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင် | freeze အတွင်း deploy တစ်ခု ထွက်သွား | freeze စည်းကမ်းက wiki ပေါ်မှာပဲ | Wallet script က သိ · Top-up script က မသိ | မှန်တဲ့နည်းကို ဘယ်လို လွယ်စေမလဲ? | (small loop badge, တည်ဆောက် lit)

## Scene 2 · One rule, many scripts

chapter: စည်းကမ်း တစ်ခု၊ script အများကြီး

> ⟪close page⟫ ⟪board B1 step 1⟫ Wallet၊ Top-up နဲ့ Eats အဖွဲ့တွေမှာ ကိုယ်ပိုင် deploy script တစ်ခုစီ ရှိပါတယ်။ freeze စည်းကမ်း ထွက်လာတော့ Wallet က ပြက္ခဒိန် စစ်တဲ့ check ကို ကိုယ့် script ထဲ ထည့်ခဲ့ပေမဲ့ ကျန်တဲ့ နှစ်ဖွဲ့က wiki ကို ဖတ်ပြီး မှတ်ထားရုံပဲ ရှိလို့ Top-up က မေ့သွားတာပါ။
> ⟪board B1 step 2⟫ ပိတ်ရက်မှာ ရေးခဲ့တဲ့ rider service အသစ်ရဲ့ pipeline ကတော့ စည်းမျဉ်း တစ်ခုမှ မသိပါဘူး။ ကုမ္ပဏီ ကြီးလာလေ tool တွေ များလာလေ ဖြစ်ပြီး စာပေါ်က စည်းမျဉ်းက နောက်ကျမှ ရောက်သလို tool အသစ်တွေကလည်း သင်ခန်းစာ ဟောင်းတွေကို မသိပါဘူး။ ဒါကြောင့် outage အများစုက သင်ပြီးသား ပုံစံကိုပဲ ပြန်ထပ်တာပါ။
> ⟪board B1 step 3⟫ ဒီတော့ Padauk က deploy နဲ့ config ပြောင်းတာလို အန္တရာယ်ရှိတဲ့ ပြောင်းလဲမှု တစ်မျိုးစီအတွက် အဖွဲ့တိုင်း မဖြစ်မနေ သုံးရမယ့် shared platform တစ်ခုစီ ရွေးပါတယ်။ စည်းမျဉ်းက နေရာ တစ်ခုတည်းမှာ ရှိလို့ အဖွဲ့ အသစ်တွေလည်း ပထမနေ့ကတည်းက အလိုလို ရပါတယ်။ ပြောင်းရွှေ့ရတာ အလုပ်ပိုလို့ ဘယ်သူမှ မကြိုက်ပေမဲ့ ကိုနေလင်းက ကိုယ်တိုင် ထောက်ခံပြီး အကြောင်းရင်းကို ရှင်းပြပါတယ်။

On screen:

- B1 step (1), cleared (P2 comb): freeze စည်းကမ်း (blue) → (bus) → Wallet script (green check) | Top-up script (red ✗) | Eats script (red ✗)
- B1 step (2): rider service / ပိတ်ရက်မှာ ရေးတဲ့ pipeline (fourth box under the bus, two lines) | ? (red, beside it)
- B1 step (3), cleared: shared deploy platform (blue) → (bus) → Wallet | Top-up | Eats | rider (each with a green check)

## Scene 3 · Your platform already exists

chapter: Platform က ရှိပြီးသားပါ

> ⟪close board⟫ ⟪page l25_p02⟫ deploy၊ run၊ monitoring နဲ့ data သိမ်းတာအတွက် မျှသုံးတဲ့ ဒီ အလွှာက platform ပါ။ tool တွေတင် မကဘဲ သုံးကြပုံ အလေ့အထတွေပါ ပါလို့ tool ဝယ်ရုံနဲ့ platform မရပါဘူး။ ကုမ္ပဏီတိုင်းမှာ platform ရှိပြီးသားပါ၊ design လုပ်ထားလား၊ မတော်တဆ ဖြစ်လာတာလား ဆိုတာပဲ ကွာပါတယ်။
> ⟪page l25_p02b⟫ Padauk ရဲ့ script တွေ၊ Viber group နဲ့ wiki ကလည်း အဖွဲ့ချင်း ကိုယ့်အတွက် ဆုံးဖြတ်ချက်တွေ စုလာရင်း မတော်တဆ ဖြစ်လာတဲ့ platform ပါပဲ။ ဒါကြောင့် ကိုနေလင်းက engineer တွေကို user အဖြစ် သဘောထားပြီး platform ကို product တစ်ခုလို ဆောက်ဖို့ မသီရိရဲ့ အဖွဲ့ကို တာဝန်ပေးပါတယ်၊ ဒါကို platform engineering လို့ ခေါ်ပါတယ်။

On screen:

- l25_p02 (K4): Platform က ရှိပြီးသားပါ | deploy · run · monitoring · သိမ်း + အလေ့အထ | design လုပ်ထားလား၊ မတော်တဆလား | ကိုယ့် engineer တွေအတွက် product
- l25_p02b (K2): ရည်ရွယ်ပြီး ဆောက်တဲ့ platform | script · Viber · wiki: မတော်တဆ platform | မသီရိ အဖွဲ့က platform ကိုပါ ယူ | user က ကိုယ့် engineer တွေ

## Scene 4 · From desire path to golden path

chapter: Desire path ကနေ golden path ဆီ

> ⟪close page⟫ ⟪board B2 step 1⟫ platform အဖွဲ့က ဘာကိုမှ မပိတ်ပင်ခင် engineer တွေ တကယ် ဘာသုံးနေလဲ အရင် ကြည့်ပါတယ်။ Viber group ထဲမှာ လူတိုင်း ကူးသုံးနေတဲ့ bash script တစ်ခု ရှိပြီး server တစ်လုံးမှာ အရင် deploy လုပ်ပြီး ငါးမိနစ် စောင့်ကြည့်တဲ့ ဉာဏ်ကောင်းတဲ့ နည်းလေး ပါပါတယ်။ လူတွေ တကယ် လျှောက်နေတဲ့ တရားဝင် မဟုတ်တဲ့ ဒီလမ်းကို desire path လို့ ခေါ်ပါတယ်။
> ⟪board B2 step 2⟫ အဲဒီ နည်းလေးကို template အသစ်ထဲ ထည့်ပြီး template က ဘယ်အဖွဲ့ ပိုင်လဲ ဆိုတာလို မေးခွန်း လေးခုပဲ မေးပါတယ်။ ထွက်လာတဲ့ service မှာ traffic နည်းနည်းကို version အသစ်ဆီ အရင်ပို့တဲ့ canary၊ အလိုအလျောက် rollback နဲ့ SLO dashboard ပါပြီးသားပါ။ လိုက်သွားရုံနဲ့ reliability ပါလာတဲ့ ဒီ standard လမ်းက golden path ပါ။
> ⟪board B2 step 3⟫ repository အသစ်ကနေ ပထမ deploy အထိ သုံးပတ် ကြာရာက တစ်ရက်ပဲ ကြာတော့ပါတယ်။ config က အဖွဲ့ရဲ့ repository ထဲမှာ ရှိလို့ incident ဖြစ်ရင် ဖွင့်ဖတ်လို့ရပြီး ထူးခြားတဲ့ လိုအပ်ချက်အတွက် ခွင့်ပြုချက်နဲ့ ထွက်လို့ရတဲ့ escape hatch လည်း ရှိပါတယ်။ ဒါကြောင့် အဖွဲ့တွေက အပြစ်ပေးမှာ ကြောက်လို့ မဟုတ်ဘဲ အလွယ်ဆုံးမို့ ကိုယ့်ဆန္ဒနဲ့ ပြောင်းလာကြပါတယ်။
> ⟪close board⟫ ⟪page l25_p02c⟫ platform က လိုအပ်ချက်တင် မကဘဲ ထိန်းပေးတဲ့ ဖြေရှင်းနည်း အနည်းငယ်ကိုပါ ပေးပြီး ရွေးစရာကို နည်း သုံးမျိုးနဲ့ ကန့်သတ်ပါတယ်။ အကြောင်းပြချက် မရှိရင် Postgres ကိုပဲ သုံးတာက strong default၊ Postgres ဒါမှမဟုတ် Postgres နဲ့ Redis cache ထဲက ရွေးတာက menu သေးသေးလေး ဖြစ်ပြီး SSH နဲ့ deploy လုပ်တာကိုတော့ ဖယ်လိုက်ပါတယ်။ ဒီတော့ အဖွဲ့တွေက dashboard tool ကို မငြင်းခုံတော့ဘဲ ဘယ် SLO က user နဲ့ ကိုက်လဲ ဆွေးနွေးလာကြပါတယ်။

On screen:

- B2 step (1), cleared (P1 flow): Viber မှာ မျှတဲ့ script (orange)
- B2 step (2): → template: မေးခွန်း 4 ခု (blue) → canary · auto-rollback · SLO dashboard ပါတဲ့ service (green)
- B2 step (3): escape hatch (small orange side box under the template) | 3 ပတ် → 1 ရက် (label under the flow)
- l25_p02c (K4): ရွေးစရာကို ကန့်သတ်ပုံ | strong default: Postgres | menu သေးသေး: Postgres · Postgres + Redis cache | ဖယ်ထုတ်: SSH နဲ့ deploy လုပ်တာ

## Scene 5 · When the template said no

chapter: Template က ငြင်းတဲ့နေ့

> ⟪page l25_p03⟫ ဒါပေမဲ့ တစ်နေ့မှာ Top-up developer တစ်ယောက်က မြန်မြန် ထုတ်ချင်လို့ canary အဆင့်ကို ဖြုတ်ပြီး rollback plan လည်း မရေးခဲ့ပါဘူး။ rollback plan မပါလို့ editor ထဲမှာတင် warning ပေါ်လာပြီး canary မပါလို့ merge လုပ်တော့ block ခံရပါတယ်။ incident မှာ အမြန် ပြင်ရရင်တော့ check တွေကို ကျော်ခွင့်ပေးတဲ့ break-glass လမ်း ရှိပေမဲ့ သုံးတိုင်း log ကျန်ပြီး နောက်နေ့ review လုပ်ရပါတယ်။
> ⟪page l25_p03b⟫ check တိုင်းက linter လိုပဲ ဘယ် စည်းမျဉ်းကို ချိုးမိလဲ ပြောပြီး ပြင်နည်းကိုပါ အကြံပေးပါတယ်။ check အများစုက warning ပဲ ပေးပြီး ခြွင်းချက် မရှိနိုင်တဲ့ စည်းမျဉ်းကျမှ block လုပ်ပါတယ်။ အကောင်းဆုံးကတော့ default အတိုင်း ထားရုံနဲ့ စည်းမျဉ်းနဲ့ ကိုက်ပြီးသား ဖြစ်နေတာပါ။
> ⟪page l25_p03c⟫ ရေးရခက်တဲ့ reliability code ကိုလည်း platform ထဲမှာ တစ်ခါတည်း ရေးထားပါတယ်။ gateway ခေါ်တဲ့ service တွေက retry code ကို ကိုယ်တိုင် မရေးဘဲ timeout၊ backoff with jitter၊ retry budget နဲ့ circuit breaker ပါတဲ့ shared gateway client ကို သုံးလို့ client ပြင်တိုင်း redeploy လုပ်ရုံနဲ့ အကုန် ရပါတယ်။ ဒါပေမဲ့ bug ပါရင်လည်း နေရာတိုင်း ရောက်မှာမို့ platform အဖွဲ့က ကိုယ့် ပြောင်းလဲမှုကို service တစ်ခု၊ zone တစ်ခုမှာ အရင် canary လုပ်ပါတယ်။

On screen:

- l25_p03 (K2): Top-up က စည်းမျဉ်း ချိုးတဲ့နေ့ | editor warning: rollback plan မပါ | merge block: canary အဆင့် မပါ | break-glass: log ကျန်၊ review လုပ်
- l25_p03b (K2): လမ်းပြတဲ့ check | စည်းမျဉ်းနဲ့ ပြင်နည်း ပြ | အများစု warning၊ block က ရှား | အကောင်းဆုံး: default က ကိုက်ပြီးသား
- l25_p03c (K2): Shared gateway client | timeout · backoff + jitter | retry budget · circuit breaker | ကိုယ့်ပြောင်းလဲမှုကို canary: service 1 · zone 1

## Scene 6 · Shift down

chapter: Shift left နဲ့ shift down

> ⟪close page⟫ ⟪board B3 step 1⟫ အရင်က Padauk က reliability ကို design အဆင့်ကတည်းက စောစော စဉ်းစားဖို့ အဖွဲ့တိုင်းကို တောင်းခဲ့ပါတယ်၊ ဒါကို shift left လို့ ခေါ်ပါတယ်။ ဒါပေမဲ့ ဒါတစ်ခုတည်းဆိုရင် အဖွဲ့တိုင်းက retry၊ rollout၊ SLO အကုန် ကျွမ်းကျင်ရမယ်၊ မဟုတ်ရင် Site Reliability Engineering၊ SRE အဖွဲ့ဆီမှာ တန်းစီ စောင့်ရပါမယ်။ engineer ၆၀ လောက်ကို SRE လေး ငါး ယောက်နဲ့ လိုက်မမီပါဘူး။
> ⟪board B3 step 2⟫ shift down ကတော့ အဲဒီ အလုပ်တွေကို shared gateway client လိုပဲ ကျွမ်းကျင်သူတွေက platform ထဲမှာ တစ်ခါ ဆောက်ပေးလို့ အဖွဲ့တိုင်းက အဲဒီပေါ်မှာ ရပ်ရုံပါပဲ။ ကိုယ်ပိုင် SRE မရှိတဲ့ service သေးသေးတွေတောင် reliability အခြေခံကို အလိုလို ရလာပါတယ်။
> ⟪board B3 step 3⟫ ဒါဆို shift left ကို ရပ်ရမလား ဆိုတော့ မဟုတ်ပါဘူး။ စောစော စဉ်းစားတာကို ဆက်လုပ်ပြီး အဲဒီ အလုပ်ကို platform မှာ မျှသုံးတာမို့ နှစ်ခုလုံး တွဲသုံးရပါတယ်။

On screen:

- B3 step (1), cleared (P6 lanes, top lane): Wallet | Top-up | Eats (three team boxes, each with a red label: retry · rollout · SLO) → SRE (one queue box)
- B3 step (2) (bottom lane): Wallet | Top-up | Eats (the same teams, standing on a wide green slab) | platform: retry · rollout · SLO (the slab's label)
- B3 step (3): နှစ်ခုလုံး: စောစော + မျှသုံး (violet label between the lanes)

## Scene 7 · Right-sized control

chapter: လိုသလောက် တင်းကျပ်မှု

> ⟪close board⟫ ⟪page l25_p04⟫ platform က service တိုင်းကို တစ်ပုံစံတည်း မစစ်ပါဘူး။ hackathon app တွေက Playground မှာ ကြိုက်တဲ့အချိန် deploy လုပ်နိုင်ပေမဲ့ customer data ကို မထိရပါဘူး။ Eats ရဲ့ menu service လိုဟာတွေက Light မှာ warning ပဲ ရပြီး service အများစုက Standard မှာ canary နဲ့ SLO check ကို ဖြတ်ရပါတယ်။ ledger နဲ့ ငွေ ရွှေ့တဲ့ system တွေကတော့ Strict မှာ လူ နှစ်ယောက် review လုပ်မှ ပြောင်းရပါတယ်။
> ⟪page l25_p04b⟫ စစ်ဆေးမှုကို အမှားရဲ့ ထိခိုက်မှုနဲ့ ကိုက်အောင် ချိန်ညှိတာကို လိုသလောက် တင်းကျပ်မှုလို့ ခေါ်ပါမယ်။ ဒါက တက်ရမယ့် လှေကား မဟုတ်ပါဘူး။ hackathon ကို Strict နဲ့ ထိန်းရင် စမ်းသပ်မှု ရပ်သွားပြီး ledger ကို Playground မှာ ထားရင် အန္တရာယ် ကြီးပါတယ်။ ဒါကြောင့် ကုမ္ပဏီ တစ်ခုထဲမှာ လေးဆင့်လုံး တစ်ပြိုင်နက် ရှိနေတာ ပုံမှန်ပါ။

On screen:

- l25_p04 (K6): လိုသလောက် တင်းကျပ်မှု | Playground | Light | Standard | Strict
- l25_p04b (K2): လှေကား မဟုတ်ပါ | hackathon ကို Strict: စမ်းသပ်မှု ရပ် | ledger ကို Playground: အန္တရာယ် | ကုမ္ပဏီ တစ်ခုမှာ လေးဆင့်လုံး

## Scene 8 · Exceptions are normal

chapter: Exception တွေက ပုံမှန်ပါ

> ⟪page l25_p05⟫ platform ဘယ်လောက်ပဲ ကောင်းကောင်း မထည့်ထားမိတဲ့ လိုအပ်ချက်တွေ ရှိတတ်ပါတယ်။ ဥပမာ fraud အဖွဲ့က ငွေလွှဲတိုင်းကို စစ်ဖို့ GPU ပေါ်က Python model server လိုပါတယ်။ ဒါကြောင့် platform ကနေ ခွဲထွက်ခွင့်၊ exception တွေကို ထိခိုက်မှုအလိုက် ခွဲပါတယ်။
> memory limit တိုးတာလို သေးတဲ့ ကိစ္စက ticket မတင်ဘဲ ကိုယ်တိုင် လုပ်လို့ရတဲ့ self-service ဖြစ်ပြီး log ကျန်ပါတယ်။ runtime အသစ်လို ကြီးတဲ့ ကိစ္စကိုတော့ ပျက်ရင် ညဘက် ထပြင်ရမယ့် မသီရိနဲ့ ကုန်ကျစရိတ် ပေးရမယ့် ကိုနေလင်းက review လုပ်ပါတယ်။
> ⟪page l25_p05b⟫ exception မပေးဘဲ အတင်း သုံးခိုင်းရင် လူတွေက မမြင်ရတဲ့ နေရာမှာ workaround တွေ ဆောက်ကုန်ပါတယ်။ ရွေးစရာ များလွန်းတာက tech debt တစ်မျိုး ဖြစ်သလို တင်းကျပ်လွန်းတာကလည်း debt နောက်တစ်မျိုးပါ။ ဒါကြောင့် exception တိုင်းကို owner နဲ့အတူ စာရင်း တစ်ခုတည်းမှာ ထားပါတယ်၊ အဖွဲ့ သုံးဖွဲ့က model server မျိုး တောင်းထားတာ မြင်ရတော့ platform အဖွဲ့က အဲဒါကို နောက် golden path အဖြစ် ဆောက်ပေးပါတယ်။

On screen:

- l25_p05 (K2): Exception တွေက ပုံမှန်ပါ | memory limit: self-service၊ log ကျန် | runtime အသစ်: ပျက်ရင် တာဝန်ယူမယ့်သူ review | 3 ဖွဲ့ တောင်းရင်: နောက် golden path
- l25_p05b (K3, left gray / right teal; cells as left / right): အတင်း ခိုင်းရင် / စာရင်းထဲ ထည့်ရင် | မမြင်ရတဲ့ workaround / owner နဲ့ မြင်သာ | ဘာမှ မသင်ရ / platform က သင်ယူ

## Scene 9 · A new rule for old systems

chapter: System ဟောင်းတွေအတွက် စည်းမျဉ်း အသစ်

> ⟪close page⟫ ⟪board B4 step 1⟫ lesson ၂၂ က restore drill ၇ နာရီ ကြာခဲ့လို့ Padauk က ငွေ database တိုင်းမှာ ရက် ၉၀ အတွင်း အောင်မြင်တဲ့ restore test ရှိရမယ် ဆိုတဲ့ စည်းမျဉ်းကို owner မသီရိ၊ အကြောင်းပြချက်နဲ့ နှစ်စဉ် ပြန်သုံးသပ်မယ့် ရက်နဲ့အတူ ရေးပါတယ်။ service အသစ်တွေကတော့ restore test မပါရင် merge လုပ်လို့ မရပါဘူး။
> ⟪board B4 step 2⟫ service ဟောင်း ၃၅ ခုကိုတော့ ချက်ချင်း block မလုပ်ဘဲ owner နဲ့ ကုန်ဆုံးရက် ပါတဲ့ ယာယီ ခွင့်ပြုချက်၊ exemption ကို ပေးပါတယ်။ ကုန်ဆုံးရက်က risk ပေါ် မူတည်ပြီး ledger က သတ်မှတ်ရက်အထိ၊ merchant service တွေက နောက် အပြောင်းအလဲကြီးအထိ ရပါတယ်။ ပိတ်တော့မယ့် SMS gateway ဟောင်းကိုတော့ ခေါင်းဆောင်တွေက risk ကို လက်ခံကြောင်း သုံးလ တစ်ခါ ပြန်လက်မှတ်ထိုးပါတယ်။
> ⟪board B4 step 3⟫ ညတိုင်း run တဲ့ check က အဖွဲ့ scorecard တွေနဲ့ exception စာရင်းကို update လုပ်ပြီး ပြင်စရာကို ticket၊ အသင့်ရေးထားတဲ့ pull request ဒါမှမဟုတ် ဘေးကင်းရင် အလိုအလျောက် ပြင်တာနဲ့ ဖြေရှင်းပါတယ်။ ခေါင်းဆောင် report မှာ ငွေ database ခြောက်ခုကို restore တစ်ခါမှ မစမ်းဖူးတာ မြင်ရတော့ ကိုနေလင်းက restore sprint ကို ခွင့်ပြုပါတယ်၊ ခေါင်းဆောင်တွေက ကုန်ကျစရိတ်ထက် မသိရတဲ့ risk ကို ပိုကြောက်လို့ပါ။

On screen:

- B4 step (1), cleared (P6, two lanes): service အသစ် → restore test မပါရင် block (red)
- B4 step (2) (second lane): service ဟောင်း 35 ခု → ရက်စွဲအထိ exemption (orange)
- B4 step (3): scorecard + exception စာရင်း (green box under both lanes, an `arrow-down` from each lane) | ငွေ database 6 ခု: restore မစမ်းဖူး → restore sprint (violet, beside the scorecard, lands as the narration names it)

## Scene 10 · This week

chapter: —

> ⟪close board⟫ ⟪page l25_p06⟫ ကိုယ့်ကုမ္ပဏီရဲ့ မတော်တဆ platform ကို ဒီအပတ် ဒီလို စပြင်ကြည့်ပါ။ လူတိုင်း ကူးသုံးနေတဲ့ script ကို ရှာပြီး ဘာကြောင့် သုံးကြလဲ မေးကြည့်ပါ။ wiki ပေါ်မှာပဲ ရှိတဲ့ စည်းမျဉ်း တစ်ခုကို pipeline ထဲက check တစ်ခု ဖြစ်အောင် ပြောင်းပါ။ ပြီးတော့ ကိုယ့် exception တွေကို စာရင်း တစ်ခုတည်းမှာ စုရေးပါ။

On screen:

- l25_p06 (K2): ဒီအပတ် လုပ်စရာ | လူတိုင်း ကူးသုံးတဲ့ script ကို ရှာပါ | wiki စည်းမျဉ်း တစ်ခုကို check လုပ်ပါ | exception တွေကို တစ်နေရာတည်း စုပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ Module ၅ ရဲ့ နောက်ဆုံး notes ပါ။ ⟪select golden path⟫ golden path က လိုက်သွားရုံနဲ့ reliability ပါလာတဲ့ standard လမ်းပါ၊ ⟪select escape hatch⟫ escape hatch က default နဲ့ မကိုက်ရင် ခွင့်ပြုချက်နဲ့ ထွက်တဲ့ လမ်းပါ။ ⟪select break-glass⟫ break-glass က အရေးပေါ်မှာ check ကို ကျော်ပေမဲ့ log ကျန်ပြီး နောက်မှ review လုပ်ရတဲ့ လမ်းပါ။
> ⟪select shift down⟫ shift down က reliability အလုပ်ကို platform ထဲမှာ တစ်ခါတည်း ဆောက်ပေးတာ ဖြစ်ပြီး၊ ⟪select လိုသလောက် တင်းကျပ်မှု⟫ လိုသလောက် တင်းကျပ်မှုက စစ်ဆေးမှုကို အမှားရဲ့ ထိခိုက်မှုနဲ့ ကိုက်အောင် ချိန်ညှိတာပါ။ ⟪select exemption⟫ exemption ကတော့ owner၊ အကြောင်းပြချက်နဲ့ ကုန်ဆုံးရက် ပါတဲ့ ယာယီ ခွင့်ပြုချက်ပါ။ ⟪select မေးခွန်း⟫ စည်းမျဉ်း တစ်ခုက wiki ပေါ်မှာပဲ ရှိနေတယ် ဆိုရင် အဲဒါကို golden path ထဲ ထည့်ဆောက်ဖို့ နည်း တစ်ခု ပြောကြည့်ပါ။
> ⟪pause 3s⟫ စည်းမျဉ်းနဲ့ ကိုက်ပြီးသား default တစ်ခု၊ template ထဲက check တစ်ခု ဒါမှမဟုတ် merge ကို block လုပ်တာ ဘယ်ဟာမဆို ရပါတယ်။ Module ၆ ရောက်တော့ coding agent တွေ ပါလာပြီး merge တွေက တစ်ရက်ကို ၁၅ ကနေ ၁၂၀ အထိ ခုန်တက်သွားပါတယ်။ SRE အလုပ်မှာ ဘာတွေ ပြောင်းသွားမလဲ?

On screen:

- notes.md: # မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင် | (blank line) | - golden path — လိုက်သွားရုံနဲ့ reliability ပါလာတဲ့ standard လမ်း | - escape hatch — default နဲ့ မကိုက်ရင် ခွင့်ပြုချက်နဲ့ ထွက်တဲ့ လမ်း | - break-glass — အရေးပေါ်မှာ ကျော်၊ log ကျန်၊ နောက်မှ review | - shift down — ကျွမ်းကျင်သူက platform ထဲမှာ တစ်ခါ ဆောက်၊ အားလုံး ရ | - လိုသလောက် တင်းကျပ်မှု — အမှားရဲ့ ထိခိုက်မှုနဲ့ ကိုက်တဲ့ စစ်ဆေးမှု: Playground · Light · Standard · Strict | - exemption — owner၊ အကြောင်းပြချက်၊ ကုန်ဆုံးရက် ပါတဲ့ ယာယီ ခွင့်ပြုချက် | (blank line) | မေးခွန်း: wiki ပေါ်မှာပဲ ရှိတဲ့ စည်းမျဉ်းကို golden path ထဲ ထည့်ဆောက်ဖို့ နည်း တစ်ခု ပြောပါ။
