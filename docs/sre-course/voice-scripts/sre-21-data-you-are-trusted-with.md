# Lesson 21 · ယုံကြည်ပြီး အပ်ထားတဲ့ data

slug: sre-21-data-you-are-trusted-with · budget: 7600 characters (±5%)

## Scene 1 · Hook: "Please delete my account"

chapter: ကျွန်မ account ကို ဖျက်ပေးပါ

> ⟪page l21_p01⟫ Wallet က zone သုံးခုလုံးမှာ run နေပြီး အဖွဲ့တွေက server pool တစ်ခုကို မျှသုံးပါတယ်၊ load များရင် ဘာကို အရင် ပိတ်မလဲ ဆိုတဲ့ degradation profile လည်း ရေးထားပါတယ်။
> သင်္ကြန် ပြင်ဆင်နေတုန်း မန္တလေးက ဆရာမ တစ်ယောက်က ကျွန်မ account ကို ပိတ်ပြီး data တွေ အားလုံး ဖျက်ပေးပါလို့ မစုရဲ့ support အဖွဲ့ဆီ စာ ရေးလာပါတယ်။ ဆရာမရဲ့ data တွေက တကယ်တော့ ဘယ်နေရာတွေမှာ ရှိနေလဲ၊ တခြား ဘယ်သူ့ဆီမှာ မိတ္တူ ရှိနေသေးလဲ?

On screen:

- l21_p01 (K1): 21 | ယုံကြည်ပြီး အပ်ထားတဲ့ data | "ကျွန်မ account ကို ဖျက်ပေးပါ" | request တစ်ခု မစုရဲ့ အဖွဲ့ဆီ ရောက်လာ | ဘယ်သူ့ဆီ မိတ္တူ ရှိနေသေးလဲ? | သူ့ data တွေ ဘယ်မှာ ရှိလဲ? | (small loop badge, တည်ဆောက် lit)

## Scene 2 · Some things can't be retried

chapter: ပြန်စလို့ မရတဲ့ ပြဿနာ

> ⟪page l21_p02⟫ ဒီ မေးခွန်းက ဘာလို့ အရေးကြီးလဲ? outage မှာ user က ခဏ စောင့်ပြီး ပြန်ကြိုးစားလို့ ရပါတယ်၊ ပြင်လိုက်တာနဲ့ ပြဿနာလည်း ပြီးသွားပါတယ်။ data ပြဿနာကတော့ မတူပါဘူး။ ဥပမာ ဆရာမရဲ့ NRC ဓာတ်ပုံ ပေါက်သွားရင် ပြန်သိမ်းလို့ မရသလို မှားဖျက်မိတဲ့ data ကိုလည်း ကောင်းတဲ့ မိတ္တူ မရှိရင် ဘယ်တော့မှ ပြန်မရပါဘူး၊ မှားနေတဲ့ balance ကလည်း လိုက်ပြင်တဲ့အထိ မှားနေဆဲပါ။
> ⟪page l21_p02b⟫ outage မှာ စောင့်ပေးတဲ့ user တွေတောင် data ပြဿနာ ဖြစ်ရင်တော့ Padauk ကို ဆက်မယုံကြတော့ပါဘူး။ ဒါကြောင့် user တွေ ယုံကြည်ပြီး အပ်ထားတဲ့ data အတွက် tool မရွေးခင် business က ဘာလိုလဲ၊ ဥပဒေက ဘာတောင်းလဲ၊ ကျင့်ဝတ်အရ သင့်တော်လားလို့ အရင် မေးရပါတယ်။ ပြီးတော့ data မှန်ကန်မှု၊ integrity ကို speed နဲ့ cost အတွက် ဘယ်တော့မှ မလဲပါဘူး။

On screen:

- l21_p02 (K3 as a plain contrast, cells as left / right; the right column is the harder case, so it gets no teal "better" colour): Outage / Data ပြဿနာ | ပြန်ကြိုးစားလို့ ရ / ဘယ်တော့မှ ပြန်မရ | ပြင်ရင် ပြီး / မပြင်မချင်း မှားနေ | user စောင့် / user မယုံတော့
- l21_p02b (K2): ယုံကြည်ပြီး အပ်ထားတဲ့ data | outage ထက် ယုံကြည်မှုကို ပိုထိ | tool မရွေးခင်: business၊ ဥပဒေ၊ ကျင့်ဝတ် | integrity ကို speed၊ cost နဲ့ မလဲ

## Scene 3 · Where does she live?

chapter: သူ့ data တွေ ဘယ်မှာ ရှိလဲ

> ⟪close page⟫ ⟪board B1 step 1⟫ ဆရာမရဲ့ data တွေကို လိုက်ရှာကြည့်ရအောင်။ ပထမဆုံးက account နဲ့ ငွေလွှဲ မှတ်တမ်းတွေ ရှိတဲ့ database ပါ။ cache ထဲမှာ သူ့ profile ရှိပြီး wallet လက်ကျန်ငွေတွေ သိမ်းတဲ့ balance table ထဲမှာလည်း သူ့ လက်ကျန်ငွေ ပါနေပါတယ်။
> ⟪board B1 step 2⟫ analytics ထဲမှာ သူ့ ငွေလွှဲမှုတွေ၊ log ထဲမှာ သူ့ ဖုန်းနံပါတ် ပါပြီး backup တွေထဲမှာတော့ အားလုံး ရှိနေပါသေးတယ်။ ရက် ၃၀ အတွင်း နေရာတိုင်းက ဖျက်ရမယ်လို့ စည်းမျဉ်းက ဆိုတယ် ဆိုပါစို့။ ဆိုတော့ ဖျက်တာက command တစ်ကြောင်း မဟုတ်ဘဲ နေရာ တစ်ခုချင်းမှာ deadline ကိုယ်စီ ရှိတဲ့ pipeline ဖြစ်သွားပါတယ်၊ backup တွေကိုလည်း အဲဒီ deadline ထက် ကြာကြာ သိမ်းလို့ မရတော့ပါဘူး။
> ⟪board B1 step 3⟫ ဒါပေမဲ့ နေရာတိုင်းကို တစ်ပုံစံတည်း ကာကွယ်ဖို့ မလိုပါဘူး။ database ထဲက data က user ဆီက တိုက်ရိုက် ရလာတဲ့ original data မို့ ပျောက်ရင် ပြန်မရပါဘူး။ balance table ကတော့ database ကနေ ပြန်ဆောက်လို့ရတဲ့ derived data ပါ။ log ကိုတော့ lesson ၈ မှာ တွေ့ခဲ့သလို personal data ပါတယ်လို့ အမှတ်အသား တပ်ထားပါတယ်။
> ⟪close board⟫ ⟪page l21_p02c⟫ ပြန်ဆောက်တာ ကြာလွန်းရင်တော့ ကိစ္စ မတူတော့ပါဘူး။ balance table ကို အစကနေ ပြန်ဆောက်ရင် ၆ နာရီ ကြာပြီး အဲဒီ အတောအတွင်း လက်ကျန်ငွေ ပြလို့ မရတော့တဲ့အတွက် Padauk က အဲဒီ table ကို original data လိုပဲ ကာကွယ်ပါတယ်။

On screen:

- B1 step (1), cleared (P2 comb; targets in two columns of three): ဖျက်ပေးပါ request → (bus) → database | cache | balance table
- B1 step (2): analytics | log | backup (three more targets on the same bus, second column)
- B1 step (3): original (small green tag on database) | derived (small blue tag on balance table) | personal data (small orange tag on log)
- l21_p02c (K7): wallet လက်ကျန်ငွေ table | 6 နာရီ | ပြန်ဆောက်နေတုန်း လက်ကျန် မပြ၊ original လို ကာကွယ်

## Scene 4 · Soft, then hard

chapter: Soft delete နဲ့ hard delete

> ⟪close page⟫ ⟪board B2 step 1⟫ ဖျက်တာကိုလည်း Padauk က နှစ်ဆင့် ခွဲလုပ်ပါတယ်။ ပထမဆင့် soft delete မှာတော့ data ကို app မှာ မပြတော့ပေမဲ့ ၁၄ ရက် ဆက်ထားပါတယ်။ ဆရာမ စိတ်ပြောင်းရင်ဖြစ်ဖြစ်၊ Padauk ဘက်က မှားဖျက်မိရင်ဖြစ်ဖြစ် ပြန်ယူလို့ရတဲ့ ဒီ ကာလကို undo window လို့ ခေါ်ပါတယ်။
> ⟪board B2 step 2⟫ ဒုတိယဆင့် hard delete ကတော့ deadline မတိုင်ခင် နေရာတိုင်းကနေ လုံးဝ ဖျက်ပစ်တာပါ။ pipeline က နေရာတိုင်းမှာ ဖျက်ပြီးပြီလား စစ်ပေးပြီး တစ်နေရာမှာ ကြာနေရင် alert တက်ပါတယ်။
> ⟪board B2 step 3⟫ တချို့ data ကိုတော့ သက်တမ်း ကုန်တာနဲ့ အလိုအလျောက် ဖျက်ပါတယ်၊ ဒီ သက်တမ်းကို time to live၊ TTL လို့ ခေါ်ပါတယ်။ TTL မှားရင် data တွေ သတိမထားမိခင် ပျောက်သွားနိုင်ပါတယ်။ ဒါကြောင့် Padauk ရဲ့ TTL က data ကို soft delete ထဲ အရင် ပို့လို့ မှားနေရင် ပြင်ချိန် ရပါတယ်၊ bug တစ်ခုက မှားဖျက်လာရင် TTL ဖျက်တာ အားလုံးကို တစ်ပြိုင်နက် ရပ်လို့ရတဲ့ ခလုတ်လည်း ရှိပါတယ်။

On screen:

- B2 step (1), cleared (P1 flow): soft delete / undo window: 14 ရက် (blue box, two lines)
- B2 step (2): hard delete / deadline (red box, with an arrow-right from soft delete, two lines)
- B2 step (3): TTL: soft delete အရင်၊ ပြင်လို့ရ / အားလုံး တစ်ပြိုင်နက် ရပ်ခလုတ် (orange note under the flow, two lines)

## Scene 5 · Know your data

chapter: ကိုယ့် data ကို သိပါ

> ⟪close board⟫ ⟪page l21_p03⟫ ဒါဆို data တစ်မျိုးချင်းကို ဘယ်လောက် ဂရုစိုက်မလဲ? original လား derived လား၊ ဘယ်လောက် တန်ဖိုးရှိလဲ၊ ပေါက်ကြားရင် ဘယ်လောက် ထိခိုက်မလဲလို့ မေးရပါတယ်။ NRC နံပါတ်၊ လိပ်စာ၊ မွေးနေ့လို data ကိုတော့ ခိုင်လုံတဲ့ အကြောင်းပြချက်နဲ့ review ရှိမှပဲ စုပါတယ်။ ဖုန်းနံပါတ်ကို hash လုပ်ထားရင်တောင် နံပါတ် တစ်ခုက hash တစ်ခုတည်းပဲ ထွက်လို့ record တွေကို ချိတ်ပြီး ဘယ်သူလဲ သိနိုင်နေသေးပါတယ်။
> ⟪page l21_p03b⟫ ဒီလို ခွဲလိုက်တဲ့ အမျိုးအစားကပဲ ဘယ်လောက် ကြာကြာ သိမ်းမလဲ၊ ဘယ်သူ ကြည့်ခွင့် ရှိလဲ၊ backup နဲ့ restore ကို ဘယ်လို လုပ်မလဲ ဆိုတာကို ဆုံးဖြတ်ပေးပါတယ်။ ဥပမာ ledger ကို backup ယူပေမဲ့ အဲဒီကနေ ပြန်ထုတ်လို့ရတဲ့ ပြေစာ PDF တွေကိုတော့ မယူပါဘူး။ Padauk က data တိုင်းရဲ့ အမျိုးအစားနဲ့ owner ကို data catalog တစ်ခုမှာ စာရင်းလုပ်ပါတယ်၊ နောက်တစ်ခါ ဖျက်ခိုင်းရင် လိုက်ရှာစရာ မလိုအောင်ပါ။

On screen:

- l21_p03 (K4): ကိုယ့် data ကို သိပါ | original လား derived လား? | တန်ဖိုး ဘယ်လောက်၊ ပေါက်ရင် ဘယ်လောက် ထိခိုက်? | hash လုပ်ထားလည်း record ချိတ်လို့ရ
- l21_p03b (K5): အမျိုးအစားက ဆုံးဖြတ်တာ | ဘယ်လောက် ကြာကြာ သိမ်းမလဲ | ဘယ်သူ ကြည့်ခွင့် ရှိလဲ | backup ယူမလား | restore ဘယ်လို လုပ်မလဲ

## Scene 6 · The copy on the test server

chapter: Test server ပေါ်က မိတ္တူ

> ⟪page l21_p03c⟫ catalog ရေးနေရင်း မသီရိက စာရင်းထဲ မပါတဲ့ မိတ္တူ တစ်ခုကို တွေ့သွားပါတယ်။ developer တစ်ယောက်က bug တစ်ခု ရှာဖို့ တကယ့် wallet data တွေကို အဖွဲ့တိုင်း သုံးတဲ့ test server ပေါ် ကူးထားပြီး ဖျက်ဖို့ မေ့သွားခဲ့တာပါ၊ ဆရာမရဲ့ data လည်း ပါပါတယ်။ ဖျက်တဲ့ pipeline က ဒီ မိတ္တူကို မသိသလို test server ကို ဝင်လို့ရတဲ့ သူတိုင်း user တွေရဲ့ balance ကို မြင်နေရပါတယ်။ developer ကို အပြစ်တင်စရာ မဟုတ်ပါဘူး၊ test data မရှိလို့ အလွယ်ဆုံး လမ်းကို ရွေးခဲ့တာပါ။
> ⟪page l21_p04⟫ ဒါပေမဲ့ user တွေက ကိုယ့် data ကို ဘယ်သူ မြင်လဲ ဆိုတာကို အရမ်း ဂရုစိုက်ကြလို့ Padauk က လူရော service ရော တကယ် လိုတဲ့ permission လောက်ပဲ ပေးတဲ့ least privilege ကို စည်းမျဉ်းအဖြစ် ထားပါတယ်။ ဥပမာ support က ငွေလွှဲ အခြေအနေကို မြင်ရပေမဲ့ NRC ဓာတ်ပုံကို မမြင်ရပါဘူး။
> user data ကို တကယ် ကြည့်ဖို့ လိုလာရင်တော့ break-glass ဆိုတဲ့ အရေးပေါ် လမ်းနဲ့ account တစ်ခုတည်းကို တစ်နာရီလောက်ပဲ ဖွင့်ရပြီး ကြည့်တဲ့သူ ကိုယ်တိုင်တောင် ဖျက်လို့ မရတဲ့ မှတ်တမ်း ကျန်ပါတယ်။
> ⟪page l21_p04b⟫ test မှာ production data သုံးရင် engineer တွေမှာ permission အများကြီး ဆက်ရှိနေရပြီး script တစ်ခု မှားတာနဲ့ တကယ့် data ပျက်နိုင်ပါတယ်။ ဒါကြောင့် Padauk က တကယ့် user data မဟုတ်တဲ့ synthetic test data ကို သုံးပြီး test instance တွေကို ပုံမှန် ရှင်းပစ်ပါတယ်၊ sandbox အသစ်တွေကိုလည်း production နဲ့ မရောနိုင်တဲ့ နာမည် ပေးပါတယ်။

On screen:

- l21_p03c (K2): ဘယ်စာရင်းမှာမှ မပါတဲ့ မိတ္တူ | debug ဖို့ တကယ့် wallet data ကူး | အဖွဲ့တိုင်း သုံးတဲ့ test server | ဖျက်တဲ့ pipeline က မသိ
- l21_p04 (K2): ဘယ်သူ မြင်ခွင့် ရှိလဲ | လူရော service ရော လိုသလောက်ပဲ | break-glass: ကျဉ်း၊ တို၊ မှတ်တမ်းကျန် | test ထဲမှာ production data မသုံး
- l21_p04b (K3, left gray / right teal; cells as left / right): အရင် / အခု | တကယ့် wallet data / synthetic test data | test server က ကြာကြာ ကျန် / ပုံမှန် ရှင်းပစ် | production နဲ့ ဆင်တဲ့ နာမည် / မရောနိုင်တဲ့ sandbox နာမည်

## Scene 7 · The nightly check

chapter: ညတိုင်း တိုက်စစ်တာ

> ⟪close page⟫ ⟪board B3 step 1⟫ account မပိတ်ခင် ဆရာမရဲ့ wallet ထဲက ငွေကို သူ့ bank ဆီ ပြန်လွှဲရပါမယ်၊ ဒါဆို အဲဒီ balance က မှန်ရဲ့လား? integrity ဆိုတာ ဒီ balance လို data က တကယ် ဖြစ်ခဲ့တဲ့ ငွေအဝင်အထွက်နဲ့ အမြဲ အတိအကျ ကိုက်နေတာပါ။ Padauk က wallet balance တွေကို cashback ledger နဲ့ ညတိုင်း တိုက်စစ်ပါတယ်၊ ဒီလို တိုက်စစ်ပြီး မကိုက်တာကို ပြင်တာကို reconciliation လို့ ခေါ်ပါတယ်။
> ⟪board B3 step 2⟫ မကိုက်တာ နှစ်မျိုး ရှိပါတယ်။ cashback ကို ledger ထဲ ချက်ချင်း ရေးပေမဲ့ balance ထဲကိုတော့ နာရီတိုင်း batch နဲ့ ထည့်တာမို့ batch တစ်ခု fail ရင် ညဘက် job က ဖြည့်ပေးပါတယ်၊ ဒါက design ထဲမှာ ကြိုသိထားတဲ့ ပုံမှန် reconciliation ပါ။ bug ကြောင့် မကိုက်တာကို ပြင်တာကတော့ repair ပါ၊ အဲဒါကို အသေးစိတ် မှတ်ပြီး log ထားရသလို ငွေ data မှာဆို ပထမဆုံး repair ကတည်းက alert တက်ရပါမယ်။
> ⟪board B3 step 3⟫ job တစ်ခုက မကိုက်တာကို တိတ်တိတ်လေး ပြင်ပေးနေရင်တော့ dashboard က အစိမ်းရောင် ပြနေပေမဲ့ bug ကိုတော့ ဖုံးထားမိပါတယ်။ မှားတဲ့ write ကို ဝင်ကတည်းက တားတာကလည်း အလွယ်ဆုံး ကာကွယ်နည်းပါ၊ balance သုညအောက် မရောက်ရဘူး ဆိုတဲ့ စည်းမျဉ်းကို database မှာ constraint အဖြစ် ထားရင် database ကိုယ်တိုင် ငြင်းပေးပါတယ်။
> ⟪close board⟫ ⟪page l21_p04c⟫ data အတွက် availability ဆိုတာမှာ မြန်တာလည်း ပါပါတယ်။ ledger က နည်းနည်း နှေးပါစေ၊ ဘယ်က ဖတ်ဖတ် မှန်နေတဲ့ consistency ကို အရင်လိုပြီး Eats menu ကတော့ speed ကို အရင်လိုပါတယ်။ user အတွက် timeout ဖြစ်နေတဲ့ menu က မရှိတဲ့ menu နဲ့ အတူတူမို့ data ရဲ့ SLO မှာ latency ကိုလည်း ထည့်ရပါမယ်။

On screen:

- B3 step (1), cleared (P6 lanes): ညတိုင်း: balance = cashback ledger? (blue box, top)
- B3 step (2): reconciliation: design ထဲက နေ့စဉ် အလုပ် (top lane, green) | bug repair: အသေးစိတ် သိမ်း၊ log / ပထမ တစ်ခုမှာ alert (bottom lane, orange, two lines)
- B3 step (3): တိတ်တိတ် ပြင်ရင် bug ကို ဖုံးမိ (red, under the lanes) | constraint: မှားတဲ့ write ကို ငြင်း (green, beside it)
- l21_p04c (K4): availability မှာ speed လည်း ပါ | ledger: consistency အရင် | Eats menu: speed အရင် | timeout = data မရှိ

## Scene 8 · Suppose the rule says…

chapter: စည်းမျဉ်းက ဒီလို ဆိုတယ် ဆိုပါစို့

> ⟪page l21_p05⟫ data နဲ့ ဘာလုပ်ခွင့် ရှိလဲ ဆိုတာကိုလည်း စည်းမျဉ်းတွေက ကန့်သတ်ပါတယ်။ lesson ၄ ကလိုပဲ NRC နံပါတ် ပါတဲ့ data ကို ပြည်တွင်းမှာပဲ ထားရမယ် ဆိုပါစို့။ ဒီ data residency စည်းမျဉ်းက disaster မှာလည်း မပြောင်းလို့ region တစ်ခုလုံး ပျက်ရင်တောင် ဒီ data ကို ပြည်ပ ရွှေ့ပြီး ကယ်လို့ မရတာကို playbook ထဲမှာ ကြိုရေးထားရပါတယ်။
> ⟪page l21_p05b⟫ data ကို စုခဲ့တဲ့ အကြောင်းအတွက်ပဲ သုံးရမယ် ဆိုတဲ့ စည်းမျဉ်းလည်း ရှိနိုင်ပါတယ်။ ဥပမာ Eats က wallet ငွေသုံးပုံကို ကြည့်ပြီး ကြော်ငြာ ပို့ချင်ရင် ငွေလွှဲဖို့ စုခဲ့တဲ့ data မို့ user ကို အရင် မေးရပါမယ်။ တကယ့် စည်းမျဉ်းကိုတော့ ကိုယ့်ဘာသာ မှန်းမယူဘဲ ရှေ့နေနဲ့ အတူ ရှာပါ။ ဥပဒေက အနည်းဆုံး အဆင့်ပဲ ဖြစ်ပြီး ကျင့်ဝတ်က အဲဒီထက် မြင့်လို့ user တွေ သိရင် သဘောကျပါ့မလားလို့လည်း မေးကြည့်ပါ။

On screen:

- l21_p05 (K2): စည်းမျဉ်းက ဒီလို ဆိုတယ် ဆိုပါစို့ | ဒီ data က ပြည်တွင်းမှာပဲ | စုခဲ့တဲ့ အကြောင်းအတွက်ပဲ သုံး | user တွေ သဘောကျပါ့မလား?
- l21_p05b (K2): Eats က ကြော်ငြာ ပို့ချင်တယ် | ငွေလွှဲဖို့ စုခဲ့တဲ့ data | user ကို အရင် မေးပါ | ဥပဒေက အနည်းဆုံး အဆင့်ပဲ

## Scene 9 · This week

chapter: —

> ⟪page l21_p06⟫ ကိုယ့် user တွေ အပ်ထားတဲ့ data အတွက် ဒီအပတ် လုပ်နိုင်တာ သုံးခုပါ။ test server၊ laptop၊ spreadsheet လို production အပြင် ရောက်နေတဲ့ production data ကို ရှာကြည့်ပါ။ user တစ်ယောက်ရဲ့ data ဘယ်နေရာတွေမှာ ရှိလဲ ချရေးကြည့်ပါ။ ပြီးတော့ အမြဲ ဖွင့်ထားတဲ့ admin access တစ်ခုကို ပိတ်ပြီး လိုမှ break-glass နဲ့ ယူခိုင်းပါ။

On screen:

- l21_p06 (K2): ဒီအပတ် လုပ်စရာ | production အပြင်က production data ရှာပါ | user တစ်ယောက်ရဲ့ data နေရာ ရေးပါ | အမြဲဖွင့် admin access တစ်ခု ပိတ်ပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ ဆရာမရဲ့ စာ တစ်စောင်က data အကြောင်း အများကြီး သင်ပေးခဲ့ပါတယ်။ ⟪select ယုံကြည်ပြီး အပ်ထားတဲ့ data⟫ ယုံကြည်ပြီး အပ်ထားတဲ့ data က ပျက်ရင် outage လို ပြန်စလို့ မရလို့ tool မရွေးခင် business၊ ဥပဒေ၊ ကျင့်ဝတ် မေးခွန်းတွေကို အရင် မေးရပါတယ်။ ⟪select soft delete⟫ soft delete က ပြန်ယူလို့ရအောင် ခဏ ထားတာ၊ hard delete က deadline မတိုင်ခင် လုံးဝ ဖျက်ပစ်တာပါ။
> ⟪select original / derived⟫ original data ကို ပြန်ထုတ်လို့ မရပေမဲ့ derived data ကို ပြန်ဆောက်လို့ ရပါတယ်။ ⟪select least privilege⟫ least privilege က တကယ် လိုတဲ့ permission လောက်ပဲ ပေးတာပါ။ ⟪select reconciliation⟫ reconciliation က ပုံမှန် တိုက်စစ်တာ ဖြစ်ပြီး bug ကြောင့် ပြင်ရတဲ့ repair မှာတော့ log ထားပြီး alert တက်ရပါမယ်။ ⟪select မေးခွန်း⟫ derived data ဖြစ်တဲ့ balance table တစ်ခုကို ပြန်ဆောက်ရင် ၆ နာရီ ကြာတယ် ဆိုပါစို့၊ backup ယူထားမလား၊ မယူဘဲ ထားမလား?
> ⟪pause 3s⟫ ယူထားသင့်ပါတယ်၊ ပြန်ဆောက်နေတဲ့ ၆ နာရီလုံး product ကို သုံးလို့ မရလို့ပါ။ လကုန် စာရင်းပိတ်တော့ cashback bug တစ်ခုက Padauk ရဲ့ အဟောင်းဆုံး backup ထက်တောင် စောပြီး စခဲ့တာ တွေ့ရပါတယ်။ နောက်ပြန် ဘယ်အထိ သွားလို့ ရမလဲ?

On screen:

- notes.md: # ယုံကြည်ပြီး အပ်ထားတဲ့ data | (blank line) | - ယုံကြည်ပြီး အပ်ထားတဲ့ data — ပြန်စလို့ မရ၊ tool မရွေးခင် business၊ ဥပဒေ၊ ကျင့်ဝတ် | - soft delete / hard delete — undo window အတွင်း ပြန်ယူလို့ရ / deadline မတိုင်ခင် လုံးဝ ဖျက် | - original / derived — ပြန်ထုတ်လို့ မရ / ပြန်ဆောက်လို့ရ၊ ကြာရင် original လို ကာကွယ် | - least privilege — လူရော service ရော လိုတဲ့ permission လောက်ပဲ | - reconciliation — design ထဲက ပုံမှန် တိုက်စစ်၊ bug repair ကို log ထားပြီး alert | (blank line) | မေးခွန်း: derived balance table ကို ပြန်ဆောက်ရင် 6 နာရီ ကြာတယ်။ backup ယူမလား?
