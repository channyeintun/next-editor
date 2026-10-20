# Lesson 24 · Overload နဲ့ emergency mode

slug: sre-24-overload-change-emergency · budget: 8400 characters (±5%)

## Scene 1 · Hook: Thingyan midnight, 20,000 a second

chapter: သင်္ကြန် ညသန်းခေါင်

> ⟪page l24_p01⟫ ဈေးနှုန်းစာရင်း သေးသွားလား စစ်တဲ့ check၊ zone တစ်ခုစီက cache နဲ့ notification queue တွေ ထည့်ပြီးတော့ ခြောက်ပတ် ပြင်ဆင်ခဲ့တဲ့ သင်္ကြန် ညသန်းခေါင် ရောက်လာပါပြီ။
> Operator B ရဲ့ နှစ်သစ် promo စတာနဲ့ တစ်စက္ကန့်ကို request ၃၀၀၀ အတွက် ဆောက်ထားတဲ့ top-up service ဆီ ၂၀၀၀၀ ဝင်လာပါတယ်။ lesson ၂၀ မှာ ကြိုငှားခဲ့တာက top-up အစစ်တွေအတွက်ပါ၊ ဒီ request အများစုကတော့ ထပ်ပို့နေတဲ့ retry တွေပါ။ မကြာခင် server တွေလည်း တစ်လုံးပြီး တစ်လုံး restart ဖြစ်လာပါတယ်။ ပြိုမကျဘဲ ဘယ်လို တည်ငြိမ်အောင် ထိန်းမလဲ?
> ⟪page l24_p01b⟫ အဲဒီ တစ်ညတည်းနဲ့ SLO က ခွင့်ပြုထားတဲ့ တစ်လစာ ပျက်ခွင့်၊ error budget ရဲ့ လေးပုံသုံးပုံကျော် ကုန်သွားပါတယ်။ ဒီလို ခံနိုင်တာထက် ပိုတဲ့ အလုပ် ရောက်လာတာကို overload လို့ ခေါ်ပါတယ်။ ဒီ lesson မှာ overload ကို ခံပုံ၊ ပြောင်းလဲမှုကို ဘေးကင်းအောင် လုပ်ပုံနဲ့ ကိုယ့် tool တွေပါ ပျက်တဲ့နေ့ကို ကြည့်ပါမယ်။

On screen:

- l24_p01 (K1): 24 | Overload နဲ့ emergency mode | သင်္ကြန် ညသန်းခေါင်: တစ်စက္ကန့် 20,000 | ဆောက်ထားတာ 3,000 အတွက် | retry ပေါ် retry ထပ်၊ server တွေ restart ဆက်ဖြစ် | ပြိုမကျဘဲ ဘယ်လို ထိန်းမလဲ? | (small loop badge, တည်ဆောက် lit)
- l24_p01b (K7): Top-up ရဲ့ တစ်လစာ error budget | 75% ကျော် | သင်္ကြန် တစ်ညတည်းနဲ့ ကုန်သွား

## Scene 2 · The cascade

chapter: Cascading failure

> ⟪close page⟫ ⟪board B1 step 1⟫ postmortem မှာ မသီရိက အဲဒီညကို ကွင်း တစ်ခုအဖြစ် ဆွဲပြပါတယ်။ ဝန် ပိုလာတော့ queue ရှည်လာပြီး request တွေ ကြာကြာ စောင့်ရပါတယ်။ app က စောင့်ပေးတဲ့ ကန့်သတ်ချိန်၊ timeout ကျော်သွားတော့ စောင့်တာ ရပ်လိုက်ပေမဲ့ server ကတော့ ဘယ်သူမှ မစောင့်တော့တဲ့ request တွေကို ဆက်လုပ်နေလို့ အလုပ်တွေ အလကား ဖြစ်ကုန်ပါတယ်။
> ⟪board B1 step 2⟫ timeout ဖြစ်တော့ app၊ Padauk API နဲ့ top-up router ဆိုတဲ့ layer သုံးခုလုံးက retry လုပ်ကြလို့ user တစ်ချက် နှိပ်တာက call အများကြီး ဖြစ်သွားပါတယ်။ health check ကို မဖြေနိုင်တဲ့ server တွေကို cloud platform က restart လုပ်ပစ်တော့ ကျန်တဲ့ server တွေပေါ် ဝန် ပိုကျပြီး ပြန်တက်လာတဲ့ server ကလည်း cache ဗလာနဲ့ နှေးလို့ ကွင်းက အစကို ပြန်ရောက်ပါတယ်။
> ⟪board B1 step 3⟫ ဒီလို တစ်ခု ပျက်တာက နောက်တစ်ခုပေါ် ဝန်ပိုကျပြီး ဆင့်ကဲ ပျက်သွားတာကို cascading failure လို့ ခေါ်ပါတယ်။ ကွင်းကို ဖြတ်ဖို့ ဝန်ကို လျှော့ရမယ်၊ retry တွေကို စောင့်ခိုင်းရမယ်၊ restart တွေကိုလည်း ခဏ ရပ်ရပါမယ်။

On screen:

- B1 step (1), cleared (P3 ring, nodes clockwise on the track): ဝန် ပိုလာ → queue ရှည်လာ → timeout
- B1 step (2): client တွေ retry → restart၊ cache ဗလာ → (arrow back to ဝန် ပိုလာ)
- B1 step (3): (three red strikes across the ring, labelled) shed + degrade | backoff + jitter | restart ခဏရပ်

## Scene 3 · Hold steady, don't collapse

chapter: Goodput

> ⟪close board⟫ ⟪board B2 step 1⟫ ဒါဆို ဘာကို တိုင်းမလဲ? server handle လုပ်သမျှ request အားလုံးကို ရေတွက်တဲ့ throughput ကတော့ retry နဲ့ fail တွေပါ ပါနေလို့ လှည့်စားတတ်ပါတယ်။ ဒါကြောင့် ဖုန်းဘေလ် တကယ် ဝင်သွားတဲ့ top-up လို အသုံးဝင်တဲ့ အလုပ်ကိုပဲ ရေတွက်တဲ့ goodput ကို ကြည့်ပါတယ်။ ဒီ chart မှာ ဝင်လာတဲ့ ဝန်ကို capacity ရဲ့ ၁ ဆကနေ ၆ ဆအထိ တိုးကြည့်ပါမယ်။
> ⟪board B2 step 2⟫ အနီရောင် bar တွေက အဲဒီညက top-up service ပါ။ capacity ကျော်တာနဲ့ goodput ပြိုကျပြီး ၆ ဆမှာ သုညနီးပါး ဖြစ်သွားပါတယ်၊ server တွေက အလုပ် အပြည့် လုပ်နေပေမဲ့ အများစုက timeout ဖြစ်ပြီးသား request တွေနဲ့ retry တွေမို့ပါ။
> ⟪board B2 step 3⟫ Padauk လိုချင်တာက အစိမ်းရောင် bar တွေပါ။ ဝန် ဘယ်လောက်ပဲ တက်တက် goodput က capacity နားမှာ ညီညီ ရှိနေပြီး ပိုလာတဲ့ အပိုင်းကိုပဲ ငြင်းတာပါ။ အောင်မြင်တယ် ဆိုတာ တစ်ညလုံး ငွေပေးချေမှုတွေ ဆက်စီးနေပြီး ဝန် ကျသွားတာနဲ့ ဘယ်သူမှ ဘာမှ မနှိပ်ဘဲ system က သူ့ဘာသာ ပြန်ကောင်းလာတာပါ။

On screen:

- B2 step (1), cleared (P5 bars, underline axis): goodput (blue title) | ဝင်လာတဲ့ ဝန်: 1× · 2× · 4× · 6× (axis labels) | capacity (thin orange threshold)
- B2 step (2): (red bars that rise to the threshold, then fall away to almost nothing) ပြိုကျ (red label)
- B2 step (3): (green bars beside them that rise to the threshold and stay level) capacity နားမှာ ဆက်ပေး (green label)

## Scene 4 · Breaking the loop

chapter: ကွင်းကို ဖြတ်မယ်

> ⟪close board⟫ ⟪page l24_p02⟫ Padauk က ကွင်းကို server ဘက်၊ client ဘက်နဲ့ partner တစ်ခုချင်းအလိုက် ဖြတ်ပါတယ်။ server ဘက်မှာ ဝန်ပိရင် request တချို့ကို တမင် ငြင်းပါတယ်၊ တစ်ဝက် လုပ်ပြီးမှ fail တာထက် တံခါးဝမှာတင် ငြင်းလိုက်ရင် resource ကို ကျန်တဲ့ request တွေအတွက် ချန်ထားနိုင်လို့ပါ။ ဒါကို load shedding လို့ ခေါ်ပါတယ်။
> ⟪page l24_p02b⟫ ဘာကို အရင် ငြင်းမလဲ ဆိုတာကို request တိုင်းမှာ တပ်ထားတဲ့ priority label က ဆုံးဖြတ်ပါတယ်။ top-up ငွေပေးချေမှုကို အမြဲ ဖြေပြီး status မေးတာ၊ promo banner တွေကိုတော့ ခဏနေမှ ပြန်ကြိုးစားပါလို့ ပြောပြီး ငြင်းပါတယ်။ lesson ၂၀ မှာ ကြိုရေးထားတဲ့ အစီအစဉ်အတိုင်း feature တချို့ ပိတ်ပြီး အဓိက အလုပ်ကို ဆက်ပေးတာကတော့ graceful degradation ပါ။
> ⟪page l24_p02c⟫ client တွေက ချက်ချင်း ပြန်ပြန်ပို့နေရင် shedding က အလကား ဖြစ်မှာမို့ client ဘက်ကလည်း ကူရပါတယ်။ retry ကို app တစ်နေရာတည်းမှာပဲ လုပ်ပြီး ပြန်ကြိုးစားတိုင်း စောင့်ချိန်ကို နှစ်ဆစီ တိုးပြီး ကျပန်း အချိန်နည်းနည်း ထည့်တဲ့ backoff with jitter ကို သုံးပါတယ်။ retry အရေအတွက်ကိုလည်း retry budget နဲ့ ကန့်သတ်ထားပြီး ခေါ်တာ အများစု fail နေရင် app က ကိုယ်တိုင် လျှော့ပို့ပြီး အရေးကြီးတဲ့ request ကိုပဲ ဆက်ပို့ပါတယ်။
> ⟪page l24_p02d⟫ တတိယက partner တစ်ခုချင်း သုံးခွင့်ရှိတဲ့ အများဆုံး ပမာဏ၊ quota ပါ။ အဲဒီည Operator B ရဲ့ promo က service တစ်ခုလုံးကို ပိတ်ဆို့လို့ Operator A နဲ့ C သုံးတဲ့ user တွေပါ ဒုက္ခရောက်ခဲ့ပါတယ်။ အခုတော့ operator တစ်ခုစီမှာ quota ရှိလို့ ကျော်တဲ့ request တွေက Operator B ဘက်မှာပဲ error ရပြီး A နဲ့ C က ဆက်သွားပါတယ်။

On screen:

- l24_p02 (K4): ကွင်းကို ဖြတ်ပါ | server: priority နဲ့ စောစော ငြင်း | client: retry လျှော့၊ backoff | partner: တစ်ခုချင်း quota
- l24_p02b (K2): Priority label | အမြဲ ဖြေ: top-up ငွေပေးချေမှု | ငြင်းလို့ရ: status မေးတာ၊ promo banner | ငြင်းရင်: "ခဏနေမှ ပြန်ကြိုးစားပါ"
- l24_p02c (K2): client ဘက်က ကူညီပုံ | retry: app မှာပဲ၊ backoff with jitter | retry budget နဲ့ ကန့်သတ် | fail များရင် ကိုယ်တိုင် လျှော့ပို့
- l24_p02d (K3, left gray / right teal; cells as left / right): quota မရှိ / operator တစ်ခုစီ quota | B promo က အားလုံးကို ပိတ်ဆို့ / ကျော်တာ B ဘက်ပဲ error | A နဲ့ C user တွေပါ ဒုက္ခ / A နဲ့ C ဆက်သွား

## Scene 5 · Change safely

chapter: ဘေးကင်းကင်း ပြောင်း

> ⟪page l24_p02e⟫ postmortem မှာ တွေ့တာ နောက်တစ်ခုက သင်္ကြန် မတိုင်ခင် နှစ်ရက်မှာ Padauk API ရဲ့ retry ကို တစ်ခါကနေ သုံးခါ တိုးလိုက်တဲ့ config ပြောင်းလဲမှုပါ။ code ပြောင်းလဲမှု နှစ်ခုနဲ့ ရောပြီး server အားလုံးဆီ တစ်ခါတည်း ပို့ခဲ့လို့ ညသန်းခေါင်မှာ ဘယ်ဟာကြောင့်လဲ မသေချာသလို ပြန်ဖြုတ်ဖို့လည်း deploy အသစ် လိုခဲ့ပါတယ်။
> ⟪page l24_p03⟫ production ပြဿနာ အများစုက ပြောင်းလဲမှုကနေ စတာပါ။ ဒါကြောင့် Padauk က code၊ config၊ data ဘာပဲ ပြောင်းပြောင်း lesson ၁၉ က canary လိုပဲ traffic နည်းနည်းဆီ အရင် ပို့ကြည့်ပြီး zone တစ်ခုချင်း တဖြည်းဖြည်း ဖြန့်ပါတယ်။ တစ်ကြိမ်မှာ ပြောင်းလဲမှု တစ်ခုပဲ ဖြန့်လို့ ပြဿနာ တက်ရင် ဘယ်ဟာကြောင့်လဲ ချက်ချင်း သိပါတယ်။
> ⟪page l24_p03b⟫ ပြောင်းလဲမှုတိုင်းကို ရပ်လို့လည်း ရရပါမယ်။ retry setting ကို feature flag ခလုတ် နောက်မှာ ထားခဲ့ရင် deploy မလုပ်ဘဲ စက္ကန့်ပိုင်းအတွင်း ပြန်ပိတ်နိုင်ခဲ့မှာပါ။ rollout ရပ်တဲ့ ခလုတ်ကလည်း နှိပ်လို့ ဘေးကင်းပြီး ပြန်ဆက်လို့ရမှ လူတွေ နှိပ်ရဲမှာပါ။

On screen:

- l24_p02e (K7): Padauk API ရဲ့ config ပြောင်းလဲမှု | retry 1 → 3 | သင်္ကြန် 2 ရက်အလို၊ server အားလုံး တစ်ခါတည်း
- l24_p03 (K4): ဘေးကင်းကင်း ပြောင်းပါ | code၊ config၊ data အားလုံး တဖြည်းဖြည်း | တစ်ကြိမ်မှာ ပြောင်းလဲမှု တစ်ခု | ပြောင်းလဲမှုတိုင်း ရပ်လို့ရ
- l24_p03b (K2): ရပ်လို့ရတဲ့ ပြောင်းလဲမှု | retry setting ကို feature flag နောက်မှာ | စက္ကန့်ပိုင်းအတွင်း ပြန်ပိတ် | ရပ်ခလုတ်: ဘေးကင်း၊ ပြန်ဆက်လို့ရ

## Scene 6 · Padauk's change rule

chapter: ပြောင်းလဲမှု စည်းကမ်း

> ⟪close page⟫ ⟪board B3 step 1⟫ ဒီ incident နောက်မှာ Padauk က ပြောင်းလဲမှုကို ဘယ်လောက် ဂရုစိုက်ရမလဲ ဆိုတာကို ပြက္ခဒိန်နဲ့ error budget နဲ့ ချိတ်လိုက်ပါတယ်။ အန္တရာယ် အများဆုံး ရက်တွေက လတိုင်း ၂၅ ရက်ကနေ ၁ ရက်အထိ လစာထုတ်တဲ့ အပတ်နဲ့ သင်္ကြန် မတိုင်ခင် သုံးရက်ပါ။
> ⟪board B3 step 2⟫ error budget ၂၅ ရာခိုင်နှုန်းအောက် ကျန်ရင် ဒါမှမဟုတ် အဲဒီ ရက်တွေထဲ ရောက်ရင် ပြောင်းလဲမှုတိုင်းမှာ rollback လုပ်မယ့်သူ နာမည်ကို ကြိုရေးပြီး reviewer နောက်တစ်ယောက် လိုပါတယ်။ ဒါက Padauk ရဲ့ ပြောင်းလဲမှု စည်းကမ်းပါ။ သင်္ကြန် ညက budget အများစု ကုန်သွားလို့ Top-up က လကုန်အထိ ဒီ စည်းကမ်းအောက်မှာ ရှိနေပါတယ်။
> ⟪board B3 step 3⟫ သင်္ကြန် အကြိုညမှာတော့ rollout အားလုံး ရပ်ပြီး အရေးပေါ် fix နဲ့ security fix ပဲ ခွင့်ပြုတဲ့ change freeze ပါ။ incident ကြီး ဖြစ်နေချိန်မှာလည်း မပျက်သေးတဲ့ service တွေနဲ့ ပြန်ကောင်းအောင် သုံးမယ့် tool တွေကို incident ပြီးတဲ့အထိ freeze အောက်မှာ ထားပါတယ်။

On screen:

- B3 step (1), cleared (P8 timeline, underline axis = one month): လစာထုတ် အပတ် (25–1) | သင်္ကြန် 3 ရက်အလို (blue tick labels, above and below the axis)
- B3 step (2): budget 25% အောက်၊ လစာထုတ် အပတ်၊ 3 ရက်အလို: / rollback လုပ်မယ့်သူ + reviewer နောက်တစ်ယောက် (orange, two lines, above the axis)
- B3 step (3): သင်္ကြန် အကြိုည: rollout ရပ် / အရေးပေါ် fix နဲ့ security fix ပဲ (red, two lines, below the axis)

## Scene 7 · Your undo toolbox

chapter: Undo လုပ်နည်း

> ⟪close board⟫ ⟪page l24_p04⟫ အဲဒီညက Padauk ကို ပြန်ထိန်းခဲ့တာက promo banner ပိတ်ပြီး degrade လုပ်တာနဲ့ capacity တိုးတာပါ။ ဒါတွေက အကြောင်းရင်း မသိခင် သုံးလို့ရတဲ့ lesson ၁၀ က generic mitigation တွေပါ။ traffic လွှဲတဲ့ drain၊ rollback နဲ့ ဒုက္ခပေးနေတဲ့ caller ကို block လုပ်တာလည်း ပါပါတယ်။ version အသစ်က data ပုံစံကို ပြောင်းပြီးသွားရင်တော့ rollback လုပ်လို့ မရတော့လို့ ပြင်ပြီးသား version ကို ရှေ့ဆက်တင်တဲ့ roll forward ကို ကြိုပြင်ထားရပါမယ်။
> ⟪page l24_p04b⟫ fix တွေကလည်း ပြောင်းလဲမှုတွေမို့ ကြိုစမ်းထားပြီး တဖြည်းဖြည်း သုံးရပါတယ်။ restart ကိုတော့ ဝန်ပိချိန်မှာ သတိထားရပါမယ်၊ capacity နဲ့ data ပြည့်နေတဲ့ cache ကို လွှင့်ပစ်လို့ပါ။ ဒါကြောင့် ဝန်ပိရင် အလိုအလျောက် restart ကို ခဏ ရပ်ပြီး အသုံးဝင်တဲ့ အလုပ် လုံးဝ မလုပ်နိုင်တော့တဲ့ server ကိုပဲ restart လုပ်ပါတယ်။

On screen:

- l24_p04 (K2): Undo လုပ်နည်း စာရင်း | drain · rollback · capacity တိုး | degrade · ဒုက္ခပေးတဲ့ caller ကို block | data ပြောင်းပြီးပြီလား? roll forward
- l24_p04b (K2): Fix တွေကလည်း ပြောင်းလဲမှု | ကြိုစမ်း၊ တဖြည်းဖြည်း သုံး | ဝန်ပိရင် အလိုအလျောက် restart ခဏရပ် | အလုပ် လုံးဝ မလုပ်တဲ့ server ကိုပဲ restart

## Scene 8 · When our usual tools are down too

chapter: ကိုယ့် tool တွေပါ ပျက်တဲ့အခါ

> ⟪close page⟫ ⟪board B4 step 1⟫ သင်္ကြန် ပြီးလို့ ဆယ်ရက်လောက်အကြာ လစာထုတ်ရက် မနက်မှာ on-call ကျနေတဲ့ ကိုမင်းက Wallet နှေးနေတာကို ကြည့်ဖို့ console ကို ဝင်ပေမဲ့ login မရပါဘူး။ login တစ်ခါနဲ့ tool အားလုံး ဝင်ရအောင် လုပ်ပေးတဲ့ single sign-on ပျက်နေလို့ console၊ team chat နဲ့ runbook wiki အားလုံး ပိတ်သွားပါတယ်။
> ⟪board B4 step 2⟫ on-call ကျသူတွေ မီးပျက်ရင် power bank၊ လိုင်းကျရင် ဆင်းကတ် အပို ဆောင်ထားသလိုပဲ အဲဒီနေ့ နောက်မှာ Padauk က အရေးပေါ် အိတ် တစ်ခု ပြင်ပါတယ်။ အိတ်ထဲမှာ ပုံမှန် ကန့်သတ်ချက်ကို ကျော်ပြီး ဝင်လို့ရတဲ့ break-glass key၊ နံပါတ် တစ်ခု ခေါ်ရုံနဲ့ အားလုံး ဆုံလို့ရတဲ့ phone bridge နဲ့ ဖုန်းထဲ သိမ်းထားတဲ့ offline runbook တွေ ပါပါတယ်။
> ⟪board B4 step 3⟫ break-glass key သုံးရင်တောင် လူ နှစ်ယောက် အတည်ပြုရပါတယ်၊ အရေးပေါ်လမ်းက ပိုလွယ်နေရင် တစ်ယောက်ယောက်က ပုံမှန်လမ်းကို တမင် ဖျက်ပြီး ကျော်သွားနိုင်လို့ပါ။ fallback တွေကိုလည်း ပုံမှန်လမ်းနဲ့ သုံးရတာ တူအောင် လုပ်ထားရပါမယ်၊ offline runbook က wiki နဲ့ အဆင့်တွေ အတူတူ ဖြစ်သလိုပါ။
> ⟪board B4 step 4⟫ နောက်လမှာ single sign-on ကို တမင် ပိတ်တဲ့ game day လုပ်တော့ break-glass key ရှိတာ ကိုဇော် တစ်ယောက်တည်း ဖြစ်ပြီး လေယာဉ်ပေါ်မှာမို့ ဆက်သွယ်မရပါဘူး။ အတူ ပျက်နိုင်တဲ့ failure domain ဆိုတာ လူတွေမှာလည်း ရှိလို့ မန္တလေးမှာ key ရှိတဲ့ ဒုတိယ လူ တစ်ယောက် ထားလိုက်ပါတယ်။
> ⟪close board⟫ ⟪page l24_p04c⟫ tool တွေ ပျက်တဲ့နေ့မှာတော့ မေးခွန်း သုံးခုကို အစဉ်လိုက် မေးပါ။ ပုံမှန်လမ်း ရသေးလား၊ မရရင် fallback ရှိလား၊ အဲဒါလည်း မရှိရင်တော့ အတွေ့အကြုံ အများဆုံး နှစ်ယောက်ကို ခေါ်ပါ။ fallback တွေ အမြဲ သုံးလို့ရနေအောင် ခေါင်းဆောင်တွေက ထိန်းထားရပြီး ခဏခဏ သေးသေးလေး လေ့ကျင့်တာကလည်း ကျွမ်းကျင်မှုကို ကြာကြာ ခံစေပါတယ်။

On screen:

- B4 step (1), cleared (P2 comb): single sign-on ပျက် (red) → (bus) → console | chat | runbook wiki (red)
- B4 step (2): break-glass key | phone bridge | offline runbook (green, one under each red box)
- B4 step (3): (orange circle around break-glass key, no new label)
- B4 step (4): game day: key ရှိသူ 1 ယောက်၊ ဆက်သွယ်မရ (orange) → မန္တလေးမှာ ဒုတိယ key ရှိသူ (green)
- l24_p04c (K6): tool တွေ ပျက်ရင် မေးမယ့် အစဉ် | ပုံမှန်လမ်း ရလား? | fallback ရှိလား? | အတွေ့အကြုံ အများဆုံး 2 ယောက် | (caption) ခဏခဏ သေးသေးလေး လေ့ကျင့်

## Scene 9 · This week

chapter: —

> ⟪page l24_p05⟫ ကိုယ့် system ထဲမှာ layer နှစ်ခုက retry ထပ်လုပ်နေတဲ့ client တွေကို ဒီအပတ် ရှာကြည့်ပါ။ နောက်လာမယ့် peak ရက်တွေကို ပြက္ခဒိန်ပေါ် မှတ်ပြီး အဲဒီ ရက်တွေမှာ ပြောင်းလဲမှုကို ဘယ်လောက် တင်းကျပ်မလဲ ချရေးပါ။ ပြီးတော့ chat မရှိရင် ဘယ်လို စကားပြောမလဲလို့ အဖွဲ့ကို မေးကြည့်ပါ။

On screen:

- l24_p05 (K2): ဒီအပတ် လုပ်စရာ | layer 2 ခုမှာ retry လုပ်နေတာ ရှာပါ | နောက် peak ရဲ့ စည်းကမ်း မှတ်ပါ | chat မရှိရင် ဘယ်လို ပြောမလဲ မေးပါ

## Recap · notes.md

> ⟪close page⟫ ⟪notes⟫ cascading failure ကနေ စပါမယ်။ ⟪select cascading failure⟫ cascading failure က တစ်ခု ပျက်တော့ နောက်တစ်ခုပေါ် ဝန်ပိုကျပြီး ဆင့်ကဲ ပျက်သွားတာ ဖြစ်ပြီး၊ ⟪select goodput⟫ goodput က retry နဲ့ fail တွေကို ဖယ်ပြီး user အတွက် တကယ် အောင်မြင်တဲ့ အလုပ်ပါ။ ⟪select load shedding⟫ load shedding က ဝန်ပိရင် အရေးမကြီးတဲ့ request ကို တံခါးဝမှာတင် ငြင်းတာပါ။
> ⟪select backoff with jitter⟫ backoff with jitter က retry တိုင်း စောင့်ချိန် တိုးပြီး ကျပန်း အချိန် ထည့်တာ ဖြစ်ပြီး၊ ⟪select ပြောင်းလဲမှု စည်းကမ်း⟫ ပြောင်းလဲမှု စည်းကမ်းက budget နည်းချိန်၊ peak နီးချိန်နဲ့ incident ကြီးချိန်မှာ ပြောင်းလဲမှုကို ပိုတင်းတင်း စစ်တာပါ။ ⟪select အရေးပေါ် အိတ်⟫ အရေးပေါ် အိတ်ကတော့ ကိုယ့် tool တွေ ပျက်တဲ့နေ့အတွက် ကြိုပြင်ထားတဲ့ fallback တွေပါ။
> ⟪select မေးခွန်း⟫ သင်္ကြန် ညက retry တွေကို ပြန်တွေးကြည့်ပါ။ layer သုံးခုက call တစ်ခုကို တစ်ခုစီ သုံးခါအထိ ကြိုးစားရင် user တစ်ချက် နှိပ်တာက အောက်ဆုံးမှာ call ဘယ်နှခုအထိ ဖြစ်နိုင်လဲ?
> ⟪pause 3s⟫ သုံး သုံးလီ ကိုး၊ ကိုး သုံးလီ ၂၇ ခုပါ၊ ဒါကြောင့် retry ကို layer တစ်ခုတည်းမှာပဲ ထားရတာပါ။ နောက်တစ်နှစ် သင်္ကြန် change freeze အလယ်မှာ Top-up deploy တစ်ခု ထွက်သွားပါတယ်၊ freeze စည်းကမ်းက wiki စာမျက်နှာ တစ်ခုပေါ်မှာပဲ ရှိနေခဲ့လို့ပါ။ မှန်တဲ့နည်းကို လွယ်တဲ့နည်း ဖြစ်အောင် ဘယ်လို လုပ်မလဲ?

On screen:

- notes.md: # Overload နဲ့ emergency mode | (blank line) | - cascading failure — တစ်ခု ပျက်တာက နောက်တစ်ခုပေါ် ဝန်ပိုကျပြီး ကွင်းလို ဆင့်ကဲ ပျက် | - goodput — retry နဲ့ fail ဖယ်ပြီး user အတွက် တကယ် အောင်မြင်တဲ့ အလုပ် | - load shedding — ဝန်ပိရင် အရေးမကြီးတဲ့ request ကို တံခါးဝမှာ ငြင်း | - backoff with jitter — retry တိုင်း စောင့်ချိန် တိုး၊ ကျပန်း အချိန် ထည့် | - ပြောင်းလဲမှု စည်းကမ်း — budget နည်း၊ peak နီး၊ incident ကြီးရင် ပြောင်းလဲမှုကို ပိုတင်းတင်း စစ် | - အရေးပေါ် အိတ် — break-glass key · phone bridge · offline runbook | (blank line) | မေးခွန်း: layer 3 ခု၊ တစ်ခုစီ 3 ခါအထိ ကြိုးစား။ user တစ်ချက် နှိပ်ရင် အောက်ဆုံးမှာ call ဘယ်နှခုအထိ?
