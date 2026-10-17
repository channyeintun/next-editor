# Lesson 31 · ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE

slug: sre-31-sre-in-legacy-and-regulated · budget: 8400 characters (±5%)

## Scene 1 · Hook: wallets locked 70 minutes at midnight

chapter: ညသန်းခေါင်မှာ ပိတ်မိတဲ့ wallet

> ⟪page l31_p01⟫ ကိုမင်းက Parcel ရဲ့ ပထမဆုံး Site Reliability Engineer၊ SRE ဖြစ်ချိန်မှာ Padauk ကလည်း Bank X နဲ့ partner ဖြစ်လာလို့ ဘဏ်ရဲ့ စည်းမျဉ်းတွေ၊ ပြင်လို့မရတဲ့ vendor system တွေကြားမှာ အလုပ်လုပ်ရပါပြီ။ ဒီ အလုပ်ကို ဘဏ်မှာ system administrator လုပ်ခဲ့ဖူးတဲ့ ကိုဇော်က ဦးဆောင်ပါတယ်။
> တစ်ည ၁၂ နာရီမှာ job တစ်ခု မှားသွားလို့ wallet တွေ ပိတ်မိသွားပြီး user တွေ ငွေလွှဲလို့ မရတော့ပါဘူး။ ညဘက်အတွက် ငှားထားတဲ့ ပြင်ပ support desk က ချက်ချင်း မြင်ပေမဲ့ read-only access ပဲ ရှိလို့ ကြည့်ရုံပဲ ကြည့်နိုင်ပါတယ်။
> ⟪page l31_p01b⟫ desk က engineer တွေကို လိုက်ဖုန်းဆက်ရပါတယ်။ ပြင်နည်း သိတဲ့သူ ရောက်လာတော့လည်း compliance ခွင့်ပြုချက် မရမချင်း production data ကို မပြင်ရဘူးလို့ စည်းမျဉ်းက ဆိုတယ် ဆိုပါစို့။ ပြင်တာက ၅ မိနစ်ပဲ ကြာပေမဲ့ wallet တွေ မိနစ် ၇၀ ပိတ်မိနေခဲ့ပါတယ်။ ကျန်တဲ့ မိနစ် ၆၅ က ဘယ်ရောက်သွားလဲ?

On screen:

- l31_p01 (K1): 31 | ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE | ညသန်းခေါင်: wallet တွေ မိနစ် 70 ပိတ်မိ | ပြင်ပ desk က ကြည့်ရုံပဲ ကြည့်နိုင် | ခွင့်ပြုချက် တစ်နာရီကျော် · ပြင်တာ 5 မိနစ်ပဲ | မိနစ် 65 ဘယ်ရောက်သွားလဲ? | (small loop badge, the whole loop lit)
- l31_p01b (K6): ညသန်းခေါင်ရဲ့ မိနစ် 70 | 00:00 wallet ပိတ်မိ | 00:03 desk မြင် | 01:05 ခွင့်ပြုချက် ရ | 01:10 ပြင်ပြီး

## Scene 2 · Authority and access

chapter: မြင်ခွင့်နဲ့ လုပ်ခွင့်

> ⟪close page⟫ ⟪board B1 step 1⟫ ၆၅ မိနစ်လုံး လုပ်ခွင့် ရှိတဲ့သူကို ရှာရင်း ကုန်သွားတာပါ။ incident ကို တုံ့ပြန်တဲ့သူမှာ မြင်ခွင့် ရှိရုံနဲ့ မလုံလောက်ပါဘူး၊ ပြင်ခွင့်ပါ ရှိရပါမယ်။ ဒါကြောင့် incident ကို ညှိပြီး ဆုံးဖြတ်တဲ့ incident commander က ဘယ် engineer ကိုမဆို နှိုးခွင့်နဲ့ အရေးပေါ် access ကို အတည်ပြုခွင့် ရှိတယ်လို့ CTO ကိုနေလင်းက စာနဲ့ ကြေညာပေးပါတယ်။
> ⟪board B1 step 2⟫ ဒါပေမဲ့ နှိုးလိုက်တဲ့ engineer မှာ access မရှိရင် ထပ်စောင့်ရမှာပါပဲ။ ဒါကြောင့် အရေးပေါ်မှာ ပုံမှန် ကန့်သတ်ချက်တွေကို ကျော်လို့ရတဲ့ break-glass လမ်းကို compliance အဖွဲ့နဲ့ ကြိုသဘောတူထားပါတယ်။
> ⟪board B1 step 3⟫ ဒီ လမ်းမှာ အကာအကွယ် သုံးခု ပါပါတယ်။ access က ၂ နာရီနဲ့ အလိုအလျောက် ပြန်ပိတ်တယ်၊ ဒုတိယ လူတစ်ယောက် အတည်ပြုမှ ပွင့်တယ်၊ ဘယ်သူ ဘာလုပ်ခဲ့လဲကို ပြင်လို့မရတဲ့ audit log ထဲ မှတ်ပါတယ်။ ပုံမှန်နေ့တွေမှာတော့ တကယ် လိုတဲ့ permission လောက်ပဲ ပေးတဲ့ least privilege နဲ့ သွားပြီး ဒီ စည်းတွေကို incident မှာသာ မဟုတ်ဘဲ production access အားလုံးမှာ သုံးပါတယ်။
> ⟪board B1 step 4⟫ desk ကတော့ read-only အတိုင်းပါပဲ။ ဒါပေမဲ့ postmortem မှာ desk က ကြည့်ပဲ ကြည့်နိုင်ခဲ့တယ်လို့ ပြောတော့ အဲဒီ စကားက incident commander ကို တိုက်ရိုက် page ပို့ခွင့် ပေးမယ့် action item ဖြစ်လာပြီး owner လည်း ရပါတယ်။ အဲဒါ လုပ်ဖို့ အချိန် ပေးတဲ့ ကိုနေလင်းလို ထောက်ခံပြီး ရင်းမြစ် ပေးတဲ့ ခေါင်းဆောင်ကို executive sponsor လို့ ခေါ်ပါတယ်။ နောက်လ drill မှာတော့ အစကနေ အဆုံး ၅ မိနစ်နဲ့ ပြီးသွားပါတယ်။
> ⟪board B1 step 5⟫ ငွေကြေး လုပ်ငန်းတွေကို စစ်တဲ့ regulator က ကြာကြာ ပျက်တဲ့ incident တိုင်းအတွက် report တောင်းတယ် ဆိုပါစို့။ Padauk က report သီးသန့် မရေးဘဲ ဒီ postmortem ကိုပဲ ပို့ပါတယ်။

On screen:

- B1 step (1), cleared (P1 flow, left to right): incident commander / စာနဲ့ လုပ်ပိုင်ခွင့် (blue, two lines)
- B1 step (2): → break-glass (arrow-right, then an orange box)
- B1 step (3): 2 နာရီနဲ့ ပိတ် | ဒုတိယ လူ အတည်ပြု | audit log (three small lock labels under break-glass)
- B1 step (4): ကြည့်ရုံပဲ ရတဲ့ desk (gray, bottom left) | 70 မိနစ် → 5 မိနစ် (green, bottom right)
- B1 step (5): postmortem = regulator အတွက် report (violet, along the bottom)

## Scene 3 · Complaint → business case

chapter: Complaint ကနေ business case ဆီ

> ⟪close board⟫ ⟪page l31_p02⟫ ကိုဇော်ရဲ့ နောက်ပြဿနာက Bill Pay နောက်ကွယ်က vendor billing system ပါ၊ ဝယ်ထားပေမဲ့ code ကို ပြင်လို့ မရပါဘူး။ မီတာခ ပေးရက် နီးတိုင်း ပျက်တတ်လို့ restart လုပ်တာ၊ settlement ဖိုင် ပြင်တာတွေကို လက်နဲ့ လုပ်ရပါတယ်။ ဒီလို ထပ်ခါထပ်ခါ လုပ်ရတဲ့ လက်အလုပ်၊ toil များလွန်းတယ်လို့ အဖွဲ့က ပြောခဲ့ပေမဲ့ ဘယ်သူမှ နားမထောင်ခဲ့ပါဘူး။
> ⟪page l31_p02b⟫ ကိုဇော်က အဲဒီ အလုပ် လုပ်တဲ့သူတွေနဲ့အတူ toil ကို နာရီနဲ့ incident အရေအတွက်နဲ့ တိုင်းတဲ့ toil audit လုပ်ပါတယ်။ တစ်လ ၄၅ နာရီ ကုန်ပြီး လက်နဲ့ ပြင်တဲ့ ဖိုင်တွေကြောင့် incident နှစ်ခု ဖြစ်ခဲ့တာ ထွက်လာပါတယ်။ automate လုပ်ရင် ဒီ နာရီတွေ product အလုပ်ဆီ ပြန်ရမယ် ဆိုတော့ complaint က business case ဖြစ်သွားပြီး ကိုနေလင်းက ချက်ချင်း ခွင့်ပြုပါတယ်။
> ⟪page l31_p02c⟫ ဒါပေမဲ့ ထပ်မဖြစ်အောင် ကြိုကာတဲ့ အလုပ်မှာ ခေါင်းဆောင်က အချိန် ပေးရုံ မကဘဲ အဖွဲ့ကလည်း action item တွေ လုပ်မယ်လို့ ကတိ ပေးရပါတယ်။ automation ကလည်း ဆောက်ပြီး မေ့ထားလို့ရတာ မဟုတ်လို့ script တိုင်းမှာ owner ထားပြီး script မှားတဲ့နေ့မှာလည်း ရေးတဲ့သူကို အပြစ်မရှာဘဲ blameless review လုပ်ပါတယ်။

On screen:

- l31_p02 (K3, left gray / right teal; cells as left / right): Complaint / Business case | "toil များလွန်းတယ်" / တစ်လ 45 နာရီ၊ incident 2 ခု | လျစ်လျူရှု ခံရ / ခွင့်ပြုချက် ရ | automation က ထာဝရ / owner က ထိန်း
- l31_p02b (K7): toil audit | 45 နာရီ / လ | incident 2 ခု၊ ချက်ချင်း ခွင့်ပြုချက် ရ
- l31_p02c (K2): ခွင့်ပြုချက် ရပြီးနောက် | ခေါင်းဆောင်က အချိန်၊ အဖွဲ့က ကတိ | script တိုင်းမှာ owner | မှားရင် လူကို မဟုတ်၊ script ကို review

## Scene 4 · Wrap the vendor system

chapter: Vendor system ရှေ့က ကိုယ်ပိုင် အလွှာ

> ⟪close page⟫ ⟪board B2 step 1⟫ vendor system ရဲ့ အထဲကို မပြင်နိုင်ပေမဲ့ ပတ်ဝန်းကျင်ကိုတော့ Padauk ပိုင်ပါတယ်။ ဒါကြောင့် server၊ network နဲ့ setting တွေကို click နှိပ်ပြီး မပြင်ဘဲ code နဲ့ ရေးတဲ့ infrastructure as code နဲ့ စီမံပါတယ်။ ခဏခဏ ရပ်တတ်တဲ့ ချိတ်ဆက်မှုအတွက်လည်း restart script ရိုးရိုးလေး ရေးပါတယ်။
> ⟪board B2 step 2⟫ ပြီးတော့ vendor ရှေ့မှာ Padauk ကိုယ်ပိုင် gateway ထားလို့ request တိုင်း အဲဒီကို ဖြတ်ရပါတယ်။ gateway က vendor နှေးရင် timeout နဲ့ ဖြတ်တယ်၊ ပေးရက်မှာ များလာတဲ့ request တွေကို queue ထဲ စီတယ်၊ metric ထုတ်ပြီး config ပြောင်းတိုင်း check နဲ့ စစ်ပါတယ်။ ပြင်လို့မရတဲ့ system ရှေ့က ဒီလို ကိုယ်ပိုင် ကာကွယ်ရေး အလွှာကို anticorruption layer လို့ ခေါ်ပါတယ်။
> ⟪board B2 step 3⟫ alert ကိုလည်း vendor ရဲ့ အတွင်း ကိန်းဂဏန်းပေါ်မှာ မထားဘဲ user ဘေလ် ဆောင်တာ ဘယ်လောက် အောင်မြင်လဲ ဆိုတာပေါ်မှာ ထားပါတယ်၊ ဒီလို user ဘက်က alert က system ဟောင်း အသစ် မရွေး အလုပ်ဖြစ်ပါတယ်။ အောက်က system တွေ မတူပေမဲ့ သူတို့ကို စီမံတဲ့ code နဲ့ monitoring ကိုတော့ ပုံစံ တစ်ခုတည်း ထားပါတယ်။

On screen:

- B2 step (1), cleared: vendor billing / ပြင်လို့ မရ (gray locked box, two lines) | ပတ်ဝန်းကျင် အားလုံး code နဲ့ (larger orange outline around it) | restart script (small label beside the box)
- B2 step (2): users → Padauk gateway / timeout · queue · metric · config check (blue box, two lines) → (arrow into the locked box)
- B2 step (3): alert: user ဘေလ် ဆောင်တာ အောင်မြင်မှု % (green box under the gateway)

## Scene 5 · When you can't change it

chapter: —

> ⟪close board⟫ ⟪page l31_p03⟫ system ဟောင်း အသစ် ရောနေတဲ့ နေရာမှာ အားလုံးကို တစ်ပြိုင်နက် မပြင်ပါနဲ့၊ Padauk ကလည်း Bill Pay တစ်ခုကနေ စခဲ့တာပါ။ incident မှာလည်း အတွင်းကို နားမလည်ဘဲ ဘယ်မှာမဆို လုပ်လို့ရတဲ့ rollback၊ traffic လွှဲတဲ့ drain၊ အရန်ဆီ ပြောင်းတဲ့ failover ကို အရင် သုံးပါတယ်။ ပြင်လို့ မရတဲ့ system ဖြစ်ပေမဲ့ ပြန်ထူတာကိုတော့ drill နဲ့ လေ့ကျင့်ထားပါတယ်။
> ⟪page l31_p03b⟫ automate လုပ်မလား လူ လုပ်မလား ဆိုရင် Padauk က လူကို စောင့်ရတာက ပိုအန္တရာယ် များမှပဲ automate လုပ်ပါတယ်၊ ဥပမာ ချိတ်ဆက်မှု ရပ်ရင် restart script က ချက်ချင်း run ပါတယ်။ ဝန်ဆောင်ခ ဇယားကတော့ lesson ၂ က typo လို တစ်လုံး မှားရင် user တိုင်း ထိမှာမို့ script ကို မပေးဘဲ လူကပဲ ပြောင်းပါတယ်။

On screen:

- l31_p03 (K4): ပြင်လို့ မရရင် | system တစ်ခုကနေ စပါ | ဘယ်မှာမဆို: rollback၊ drain၊ failover | ပြန်ထူတာကို drill လုပ်ထားပါ
- l31_p03b (K2): စက်လား၊ လူလား? | စောင့်တာ ပိုဆိုးရင် automate | restart script: ချက်ချင်း | ဝန်ဆောင်ခ ဇယား: လူပဲ

## Scene 6 · One shared report

chapter: SLO report တစ်ခုတည်း

> ⟪close page⟫ ⟪board B3 step 1⟫ ကိုဇော်က SRE အလေ့အထတွေကို Bank X ဘက်အထိ ယူသွားချင်ပါတယ်။ ဒါပေမဲ့ incident တိုင်းမှာ vendor၊ Padauk နဲ့ ဘဏ်က ကိုယ့် monitoring ကိုယ် ပြပြီး ဘယ်သူ့ ကိန်းဂဏန်း မှန်လဲ ငြင်းနေကြပါတယ်။
> ⟪board B3 step 2⟫ ဘဏ်ကို tool အသစ် ပြောင်းဖို့ အမိန့် ပေးလို့ မရတော့ ကိုဇော်က ရှိပြီးသား သုံးခုလုံးကို ဖတ်တဲ့ SLO report တစ်ခုတည်းကို ဆောက်ပါတယ်၊ အားလုံး ကိန်းဂဏန်း တစ်စုတည်းကို ကြည့်လာတော့ ငြင်းတာ ရပ်သွားပါတယ်။ ဘဏ်လို ယုံကြည်မှု နည်းပြီး ကျွမ်းကျင်သူ ရှားတဲ့ နေရာမှာ lesson ၁၅ မှာလို SRE ကို အဖွဲ့တိုင်းထဲ ခွဲထည့်တာထက် ဗဟိုက အဖွဲ့ငယ်လေးက ပိုအလုပ်ဖြစ်တတ်ပါတယ်။
> ⟪board B3 step 3⟫ ဘဏ်နဲ့ vendor ပါတဲ့ postmortem တွေမှာတော့ blameless ဆိုတဲ့ စကားကို ဒိုင်းအဖြစ် သုံးပြီး action item ရှောင်လာကြပါတယ်။ ဒါကြောင့် ကိုဇော်က blameless ဆိုတာ လူကို အပြစ်မရှာတာပါ၊ action item တိုင်းမှာတော့ owner ရှိရမယ်လို့ ပြန်ရှင်းပြပါတယ်။

On screen:

- B3 step (1), cleared (P2 comb, fan-in; three boxes stacked on the left, each with an arrow-right into the bus): vendor monitoring | Padauk metric | ဘဏ် ချိတ်ဆက်မှု check
- B3 step (2): (arrow-right out of the bus) | SLO report တစ်ခုတည်း (violet box on the right)
- B3 step (3): blameless ≠ owner မရှိ (orange label at the bottom)

## Scene 7 · Monsoon night

chapter: မိုးရာသီ ရေကြီးတဲ့ည

> ⟪close board⟫ ⟪page l31_p04⟫ incident မှာ လေ့ကျင့်ထားတဲ့ စွမ်းရည်က software နဲ့ မဆိုင်တဲ့ အကျပ်အတည်းမှာလည်း အသုံးဝင်ပါတယ်။ မိုးရာသီ ညတစ်ညမှာ ရန်ကုန် မြို့နယ် တချို့ ရေကြီးလို့ rider တွေ ပိတ်မိပြီး ဆိုင်တချို့ internet ပြတ်သွားတော့ Padauk က incident ကြေညာပါတယ်။ rider တိုင်းကို လုံခြုံလား ဖုန်းဆက်မေးတယ်၊ ဆိုင်တွေကို cash on delivery ပြောင်းပေးတယ်၊ status page တစ်ခုတည်းမှာ လူတိုင်းအတွက် update တင်ပါတယ်။
> ⟪page l31_p04b⟫ အဲဒီညက ပုံစံက မီးသတ်နဲ့ ကယ်ဆယ်ရေး အဖွဲ့တွေ သုံးတဲ့ Incident Command System ကနေ ယူထားတာပါ၊ incident commander က ညှိပေးရုံပဲ လုပ်ပြီး rider အဖွဲ့၊ ဆိုင်ဘက် အဖွဲ့နဲ့ support က ကိုယ့်နယ်ပယ်မှာ ကိုယ်တိုင် လုပ်ကြတာပါ။ Padauk က လူတိုင်း call တစ်ခုထဲ ဝင်ဖို့ ကြီးလွန်းပြီး အချိန်ပြည့် အရေးပေါ် အဖွဲ့ ထားဖို့ သေးလွန်းလို့ ဒီပုံစံနဲ့ ကိုက်ပါတယ်။

On screen:

- l31_p04 (K2): မိုးရာသီ ရေကြီးတဲ့ည | rider လုံခြုံရေး ဖုန်းစာရင်း | ဆိုင်တွေ cash on delivery ပြောင်း | လူတိုင်းအတွက် status page တစ်ခု
- l31_p04b (K6): ဘယ်အရွယ်မှာ ဘယ်လို ဦးဆောင်မလဲ | သေး: call တစ်ခုတည်း | Padauk: ညှိသူ တစ်ယောက် | အရမ်းကြီး: သီးသန့် အဖွဲ့

## Scene 8 · One problem, three lenses

chapter: ပြဿနာ တစ်ခု၊ ရှုထောင့် သုံးခု

> ⟪close page⟫ ⟪board B4 step 1⟫ အပတ် အနည်းငယ် ကြာတော့ vendor system နှေးလို့ alert တက်ပါတယ်။ ကိုဇော် ဝင်ကြည့်တော့ disk ပြည့်နေပြီး vendor က customer တွေရဲ့ NRC နံပါတ်တွေကို log ထဲ ရေးထည့်နေတာ တွေ့ပါတယ်။ ဒါကို ရှုထောင့် သုံးခုကနေ ကြည့်ရအောင်။
> ⟪board B4 step 2⟫ reliability ဘက်က log တွေ ကြီးလာလို့ storage ဘေလ် တက်ပြီး disk ပြည့်ရင် system ရပ်နိုင်တဲ့ ပြဿနာပါ။ security ဘက်ကတော့ log ရသွားတဲ့ ဘယ်သူမဆို NRC နံပါတ်တွေကို ယူသွားနိုင်တဲ့ ပြဿနာပါ။
> ⟪board B4 step 3⟫ privacy ဘက်ကတော့ အထောက်အထား စစ်ဖို့ပဲ ပေးခဲ့တဲ့ data ကို log ထဲ သိမ်းထားတဲ့ ပြဿနာပါ။ ဘာက ပျက်နိုင်လဲ ကြိုရှာတဲ့ အလေ့အထက သုံးခုလုံး တူပေမဲ့ ရန်က မတူပါဘူး။ reliability ရဲ့ ရန်က ပမာဏပါ၊ ငွေလွှဲ သန်းချီ ရှိရင် ရှားတဲ့ အမှားတောင် နေ့တိုင်း ကြုံရလို့ပါ။ security ရဲ့ ရန်က NRC ကို ခိုးချင်တဲ့သူ၊ privacy ရဲ့ ရန်ကတော့ ပေးခဲ့တဲ့ ရည်ရွယ်ချက်ထက် ကျော်သုံးတာပါ။
> ⟪board B4 step 4⟫ ပြင်နည်းကတော့ တစ်ခုတည်းပါ၊ gateway က vendor မလိုတဲ့ NRC နံပါတ်ကို ဖြုတ်ပစ်ပြီး log ဟောင်းတွေကို ရှင်းလိုက်တော့ ရှုထောင့် သုံးခုလုံး တစ်ပြိုင်နက် ကောင်းသွားပါတယ်။
> ⟪board B4 step 5⟫ library တစ်ခုမှာ လုံခြုံရေး အားနည်းချက်၊ vulnerability ပေါ်တော့လည်း Padauk က incident တစ်ခုတည်းအဖြစ် run ပါတယ်။ အဖွဲ့တိုင်းအတွက် ပြီးတယ် ဆိုတာ upgrade လုပ်ပြီးတာ ဒါမှမဟုတ် စာနဲ့ ရေးထားတဲ့ exception ရှိတာ ဖြစ်ပြီး အခြေအနေကို တစ်နေရာတည်းမှာ မှတ်ပါတယ်၊ ပြီးပြီလို့ ပြောရုံနဲ့ မရဘဲ သက်သေ ပြရပါတယ်။

On screen:

- B4 step (1), cleared (P2 comb, fan-out): vendor log ထဲက NRC နံပါတ် (box on the left) → (a vertical bus)
- B4 step (2): reliability: log ဘေလ်၊ / disk ပြည့် (box, two lines) | security: ပေါက်ကြားနိုင် (box) (both fed from the bus)
- B4 step (3): privacy: ရည်ရွယ်ချက်ထက် / ကျော်သုံး (box, two lines, fed from the bus)
- B4 step (4): gateway က NRC ဖြုတ် (green label under the three boxes)
- B4 step (5): vulnerability: ပြီးတဲ့ စံ တစ်ခု + သက်သေ (orange label along the bottom)

## Scene 9 · What SRE means here

chapter: ဒီမှာ SRE ဆိုတာ

> ⟪close board⟫ ⟪page l31_p04c⟫ Padauk က SRE ကို tool တစ်ခုလို ဝယ်ခဲ့တာ မဟုတ်ပါဘူး။ ကိုယ့် အရွယ်အစား၊ budget နဲ့ regulator ကို ကိုက်တဲ့ အလေ့အထတွေကို ရွေးပြီး ပြင်သုံးခဲ့တာမို့ SRE က စည်းမျဉ်း စာရင်း မဟုတ်ဘဲ တွေးပုံ တစ်ခုပါ။
> Parcel မှာ SRE က ကိုမင်း တစ်ယောက်တည်း၊ Padauk မှာ platform အဖွဲ့ ဖြစ်သလို ကိုယ့်ဆီမှာ on-call rotation ဒါမှမဟုတ် ပိုအားကောင်းတဲ့ DevOps အဖွဲ့ ဖြစ်နိုင်ပါတယ်။ ဒါပေမဲ့ အချိန်နဲ့ manager ရဲ့ ထောက်ခံမှု မရှိရင် ဘယ်ပုံစံမှ အလုပ်မဖြစ်ပါဘူး။
> ⟪page l31_p05⟫ ကုမ္ပဏီ အဟောင်းမှာလည်း ဒီအပတ် စလို့ရတာ သုံးခုပါ။ ညဘက် incident မှာ အရေးပေါ် access ကို ဘယ်သူ အတည်ပြုမလဲ စာနဲ့ ရေးထားပါ။ အဖွဲ့နဲ့ တစ်နာရီ ထိုင်ပြီး toil audit သေးသေးလေး လုပ်ကြည့်ပါ။ ပြီးတော့ ကိုယ့်ဆီမှာ SRE ဆိုတာ ဘာလဲ စာပိုဒ် တစ်ပိုဒ် ရေးကြည့်ပါ။

On screen:

- l31_p04c (K4): ဒီမှာ SRE ဆိုတာ | ဝယ်လိုက်တဲ့ tool မဟုတ် | ကိုယ်နဲ့ ကိုက်တဲ့ အလေ့အထ | အချိန်နဲ့ manager ထောက်ခံမှု
- l31_p05 (K2): ဒီအပတ် လုပ်စရာ | အရေးပေါ် access ကို ဘယ်သူ အတည်ပြုလဲ ရေးပါ | တစ်နာရီ toil audit လုပ်ပါ | "ဒီမှာ SRE ဆိုတာ" ကို ရေးပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ ဘဏ်ဘက်ကို ကိုဇော် ယူသွားခဲ့တဲ့ အလေ့အထတွေပါ။ ⟪select break-glass⟫ break-glass က အရေးပေါ်မှာ ပုံမှန် ကန့်သတ်ချက်ကို ကျော်လို့ရအောင် ကြိုသဘောတူထားတဲ့ လမ်းပါ။ ⟪select toil audit⟫ toil audit က complaint ကို နာရီနဲ့ incident ပါတဲ့ business case ဖြစ်အောင် ပြောင်းပေးပါတယ်။ ⟪select anticorruption layer⟫ anticorruption layer က ပြင်လို့မရတဲ့ system ရှေ့က ကိုယ်ပိုင် gateway ပါ။
> ⟪select executive sponsor⟫ executive sponsor က အချိန်နဲ့ ရင်းမြစ် ပေးပြီး ထောက်ခံတဲ့ ခေါင်းဆောင် ဖြစ်ပြီး၊ ⟪select SLO report တစ်ခုတည်း⟫ SLO report တစ်ခုတည်းက ရှိပြီးသား tool တွေကို ဖတ်ပြီး ကိန်းဂဏန်း တစ်စုတည်း ပြပေးပါတယ်။
> ⟪select မေးခွန်း⟫ ကိုယ့် ပြင်ပ support desk က incident အတွင်း ကြည့်ရုံပဲ ကြည့်နိုင်တယ် ဆိုရင် အရေးပေါ် access ကို ဘေးကင်းအောင် ဘယ် အကာအကွယ် နှစ်ခု ထည့်မလဲ?
> ⟪pause 3s⟫ အချိန် ကန့်သတ်ချက်၊ ဒုတိယ လူရဲ့ အတည်ပြုချက်နဲ့ audit log ထဲက နှစ်ခု ဆိုရင် မှန်ပါတယ်။ နောက်ဆုံး lesson ကတော့ Padauk ရဲ့ နှစ်ကုန် review ပါ၊ သုံးလစာ uptime ကိန်းဂဏန်းတွေက ရှေ့မှာ ဘာလာမလဲ ဘာမှ မပြောခဲ့ပါဘူး။ ဒါဆို ဘာက ကြိုပြောနိုင်မလဲ?

On screen:

- notes.md: # ကုမ္ပဏီကြီး အဟောင်းတွေထဲက SRE | (blank line) | - break-glass — အရေးပေါ်မှာ ကန့်သတ်ချက်ကို ကျော်ဖို့ ကြိုသဘောတူထားတဲ့ လမ်း | - toil audit — complaint ကို နာရီနဲ့ incident ပါတဲ့ business case ဖြစ်အောင် | - anticorruption layer — ပြင်လို့ မရတဲ့ system ရှေ့က ကိုယ်ပိုင် gateway | - executive sponsor — အချိန်နဲ့ ရင်းမြစ် ပေးပြီး ထောက်ခံတဲ့ ခေါင်းဆောင် | - SLO report တစ်ခုတည်း — ရှိပြီးသား tool တွေကို ဖတ်ပြီး ကိန်းဂဏန်း တစ်စုတည်း | (blank line) | မေးခွန်း: ပြင်ပ desk က incident မှာ ကြည့်ရုံပဲ ရတယ်။ အရေးပေါ် access ကို ဘေးကင်းအောင် လုပ်တဲ့ အကာအကွယ် နှစ်ခုက ဘာလဲ?
