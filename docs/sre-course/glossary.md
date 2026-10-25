# SRE course glossary (Burmese narration)

Status: proposal for Chan's review. Every lesson writer uses this file so a term
sounds the same in Lesson 1 and Lesson 32.

## 1. How writers use this file

- **Look up every technical term before you write it.** The tables in section 2
  say whether the term stays in English, how it should sound, and give a
  one-line explanation in spoken Burmese. You can reuse that line or reword it to
  fit the flow of the scene. Keep the meaning and the term the same.
- **Columns:**
  - **Keep EN?**
    - `EN`: say the English word. After the lesson that teaches it, no Burmese
      explanation is needed.
    - `EN + gloss`: English term, plus a short Burmese explanation the first time
      it comes up in each lesson.
    - `Full phrase`: say the whole English phrase, never the acronym. The acronym
      may still appear on a slide.
    - `MM`: say it in Burmese.
  - **Said as:** how the word should _sound_. `—` means "as written, nothing
    special".
    - This column is guidance for Chan and for the pronunciation list. It is
      **not** text to type. Write the term in its normal spelling. If the voice
      says it wrong, the fix goes into `BURMESE_RESPELLINGS` (section 4), never
      into the narration text.
  - **Burmese line:** a sentence you can reuse in narration, in the polite spoken
    register (`…ပါတယ်`, `…တာပါ`).
  - **First:** the lesson that first uses the term → the lesson that teaches it in
    depth, in the course order of 2026-10-17 (people-and-teams lessons come after the
    incident lessons). A few first-use points are approximate, so check the lesson
    spec in the curriculum.
    - When you use a term _before_ its teaching lesson, add the one-line
      explanation.
- **Our own words only.** This repo is public and the book's licence is
  NoDerivatives. Every explanation here is written fresh with our own examples
  (the fictional Padauk Pay app). None of it is the book's text. Do the same in
  narration. Credit the book in each scene's `sources`, never in the spoken
  text.
- **New terms:** if a lesson needs a term that is not here, add a row in the
  right table, in the same format, in the same commit as the lesson.

## 2. Terms by theme

### 2.1 Reliability basics, cloud and production

| English term                                                                             | Keep EN?                 | Said as                                                 | Burmese line                                                                                                                                                                             | First          |
| ---------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Site Reliability Engineering                                                             | EN                       | full phrase the first time in each lesson, then "S-R-E" | software engineering နည်းလမ်းတွေနဲ့ production system တွေကို စိတ်ချရအောင် ထိန်းပေးတဲ့ အလုပ်နယ်ပယ်ပါ။                                                                                                        | L01            |
| SRE (field, person, team)                                                                | EN                       | "S-R-E"; plural "SRE တွေ"                                | အလုပ်နယ်ပယ်ကိုရော၊ အဲဒီအလုပ်ကို လုပ်တဲ့ engineer ကိုရော၊ အဖွဲ့ကိုရော SRE လို့ပဲ ခေါ်ကြလို့ ဘယ်ဟာကို ဆိုလိုလဲ ရှင်းရှင်း ပြောပေးရပါမယ်။                                                                                               | L01 → L02      |
| reliability                                                                              | EN                       | —                                                       | system က user လိုအပ်တဲ့ အလုပ်ကို လိုအပ်သလောက် မှန်မှန်ကန်ကန်၊ အချိန်မီ လုပ်ပေးနိုင်တာပါ။ 100 ရာခိုင်နှုန်းကို မဆိုလိုဘဲ ဒီအသုံးအတွက် လုံလောက်တာကို ဆိုလိုပါတယ်။                                                                                 | L02            |
| down, slow, wrong                                                                        | MM                       | "ပျက်နေတာ၊ နှေးနေတာ၊ မှားနေတာ"                             | user ဘက်က ကြည့်ရင် ပြဿနာ သုံးမျိုး ရှိပါတယ်။ လုံးဝ သုံးမရတာ၊ သုံးလို့ရပေမဲ့ နှေးနေတာ၊ အဖြေ မှားနေတာ ဆိုတဲ့ သုံးမျိုးပါ။                                                                                                  | L02            |
| availability                                                                             | EN                       | —                                                       | user သုံးချင်တဲ့ အချိန်မှာ system က တကယ် သုံးလို့ရနေတဲ့ အချိုးပါ။                                                                                                                                          | L02            |
| uptime / downtime                                                                        | EN                       | "up time", "down time"                                  | system သုံးလို့ရနေတဲ့ အချိန်က uptime၊ သုံးမရဘဲ ရပ်နေတဲ့ အချိန်က downtime ပါ။                                                                                                                              | L03            |
| latency                                                                                  | EN                       | —                                                       | request တစ်ခု ပို့လိုက်ပြီး အဖြေ ပြန်ရတဲ့အထိ ကြာတဲ့ အချိန်ပါ။                                                                                                                                             | L02            |
| production                                                                               | EN                       | —                                                       | user တွေ တကယ် သုံးနေတဲ့၊ တကယ့် data နဲ့ run နေတဲ့ system ပါ။ စမ်းသပ်တဲ့ နေရာ မဟုတ်ပါဘူး။                                                                                                                    | L01            |
| service                                                                                  | EN                       | —                                                       | user ဒါမှမဟုတ် တခြား system တွေအတွက် အလုပ်တစ်ခုခု လုပ်ပေးတဲ့ software အစိတ်အပိုင်းပါ။                                                                                                                        | L02            |
| server                                                                                   | EN                       | —                                                       | service တွေ run နေတဲ့ စက်ပါ။                                                                                                                                                                 | L01            |
| user / customer                                                                          | EN                       | —                                                       | product ကို တကယ် သုံးတဲ့သူက user၊ ငွေပေးပြီး သုံးတဲ့ လူ ဒါမှမဟုတ် လုပ်ငန်းက customer ပါ။                                                                                                                      | L02            |
| feature                                                                                  | EN                       | —                                                       | product မှာ user သုံးလို့ရတဲ့ လုပ်ဆောင်ချက် တစ်ခုပါ။ reliability ကလည်း feature တစ်ခုပါပဲ၊ အရေးအကြီးဆုံး feature ဖြစ်လေ့ ရှိပါတယ်။                                                                                  | L02            |
| non-functional requirement                                                               | Full phrase              | never "N-F-R"                                           | feature က ဘာလုပ်လဲ မဟုတ်ဘဲ ဘယ်လောက် မြန်ရမလဲ၊ ဘယ်လောက် စိတ်ချရရမလဲ ဆိုတဲ့ လိုအပ်ချက်မျိုးပါ။                                                                                                                      | L02            |
| scalability                                                                              | EN                       | —                                                       | user နဲ့ traffic များလာတဲ့အခါ system က လိုက်ပြီး ကြီးထွားနိုင်တာပါ။                                                                                                                                   | L02            |
| efficiency                                                                               | EN                       | —                                                       | resource နဲ့ ငွေကို အလဟဿ မဖြစ်စေဘဲ အလုပ်ပြီးအောင် လုပ်နိုင်တာပါ။                                                                                                                                         | L02            |
| operations (ops)                                                                         | EN                       | "ops" as one word                                       | system ကို နေ့စဉ် run ထားပြီး ပြဿနာ တက်ရင် ဖြေရှင်းပေးတဲ့ အလုပ်ပါ။                                                                                                                                    | L02            |
| DevOps                                                                                   | EN                       | "dev-ops"                                               | developer နဲ့ operations ကြားက နံရံကို ဖျက်ပြီး code ရေးတာကနေ run တာအထိ အတူ တာဝန်ယူကြဖို့ အလေ့အကျင့်တွေပါ။ SRE က အဲဒီ အယူအဆနဲ့ လိုက်ဖက်ပါတယ်။                                                                         | L02            |
| enabler (not gatekeeper)                                                                 | EN + gloss               | —                                                       | SRE က product team ကို တားဆီးတဲ့ ဂိတ်စောင့် မဟုတ်ဘဲ မြန်မြန်နဲ့ ဘေးကင်းကင်း သွားနိုင်အောင် ကူညီပေးတဲ့သူ ဖြစ်ရပါမယ်။                                                                                                    | L02            |
| distributed system                                                                       | EN                       | —                                                       | စက်အများကြီးပေါ်မှာ ခွဲပြီး run နေပေမဲ့ user ဘက်က တစ်ခုတည်းလို မြင်ရတဲ့ system ပါ။                                                                                                                         | L01            |
| dependency                                                                               | EN                       | —                                                       | ကိုယ့် service အလုပ်လုပ်ဖို့ မှီခိုနေရတဲ့ တခြား service ဒါမှမဟုတ် system ပါ။ သူပျက်ရင် ကိုယ်ပါ ထိနိုင်ပါတယ်။                                                                                                            | L02            |
| technical debt                                                                           | EN                       | "tech debt" is fine                                     | အခု မြန်အောင် ဖြတ်လမ်းလိုက်ခဲ့လို့ နောင်မှာ ပြန်ပေးဆပ်ရမယ့် ပြင်ဆင်စရာ အလုပ်တွေပါ။ ကြာလေ အတိုးများလေ ပါ။                                                                                                           | L01            |
| risk                                                                                     | EN                       | —                                                       | ဖြစ်လာနိုင်တဲ့ ပြဿနာ တစ်ခုနဲ့ အဲဒါ ဖြစ်ခဲ့ရင် ဘယ်လောက် ထိခိုက်မလဲ ဆိုတာကို တွဲစဉ်းစားတာပါ။                                                                                                                            | L03            |
| feature velocity                                                                         | EN                       | —                                                       | feature အသစ်တွေကို user ဆီ ဘယ်လောက် မြန်မြန် ရောက်အောင် ထုတ်နိုင်လဲ ဆိုတဲ့ အရှိန်ပါ။                                                                                                                             | L01            |
| sublinear scaling                                                                        | EN + gloss               | "sub-linear"                                            | system ကြီးလာတိုင်း လူအင်အားကို အချိုးကျ မတိုးရဘဲ ပိုနည်းတဲ့ လူနဲ့ ထိန်းနိုင်တာပါ။                                                                                                                                 | L01            |
| sociotechnical system                                                                    | EN + gloss               | "socio-technical"                                       | software နဲ့ စက်တွေ တင်မကဘဲ အဲဒါတွေကို ဆောက်တဲ့၊ run တဲ့ လူတွေ၊ အဖွဲ့တွေ၊ လုပ်ငန်းစဉ်တွေ အားလုံး ပေါင်းထားတဲ့ system ပါ။                                                                                                | L02            |
| production health                                                                        | EN                       | —                                                       | production က ဘယ်လောက် ကျန်းမာလဲ ဆိုတာပါ။ ယဉ်ကျေးမှုကနေ design၊ monitoring၊ incident response အထိ အလွှာတိုင်းနဲ့ ဆိုင်ပါတယ်။                                                                                   | L02            |
| shift left                                                                               | EN + gloss               | —                                                       | ပြဿနာကို production ရောက်မှ မဖြေရှင်းဘဲ design နဲ့ development အဆင့်ကတည်းက စောစော ဖမ်းတာပါ။                                                                                                           | L02            |
| shift down                                                                               | EN + gloss               | —                                                       | reliability အလုပ်တွေကို developer တစ်ယောက်ချင်းဆီ မပုံဘဲ platform ထဲ ထည့်ပေးလိုက်လို့ အားလုံး အလိုလို ရသွားတာပါ။                                                                                                     | L01 → L25, L32 |
| reliability by default                                                                   | EN                       | —                                                       | developer က သီးသန့် မကြိုးစားရဘဲ platform ရဲ့ default တွေကြောင့် reliability အလိုလို ပါလာတာပါ။                                                                                                          | L01 → L25      |
| you build it, you run it                                                                 | Full phrase              | never the acronym                                       | ကိုယ်ရေးတဲ့ service ကို production မှာလည်း ကိုယ်တိုင် run ပြီး on-call ပါ ယူတဲ့ ပုံစံပါ။                                                                                                                       | L04            |
| cloud                                                                                    | EN                       | —                                                       | ကိုယ်ပိုင် စက် မဝယ်ဘဲ provider ဆီကနေ လိုသလောက် ငှားသုံးပြီး သုံးသလောက် ပေးရတဲ့ computing ပါ။                                                                                                                   | L04            |
| VM (virtual machine)                                                                     | EN                       | "V-M" or "virtual machine"                              | physical စက် တစ်လုံးကို software နဲ့ ခွဲပြီး သီးခြားစက်တွေလို သုံးနိုင်အောင် လုပ်ထားတာပါ။                                                                                                                        | L04            |
| container                                                                                | EN                       | —                                                       | app နဲ့ သူလိုအပ်တဲ့ အရာ အားလုံးကို ထုပ်ပိုးထားလို့ ဘယ်စက်ပေါ်မှာ run ပါစေ တစ်ပုံစံတည်း အလုပ်လုပ်ပါတယ်။                                                                                                                    | L04            |
| Kubernetes                                                                               | EN                       | "koo-ber-NET-eez"                                       | container တွေကို စက်အများကြီးပေါ်မှာ အလိုအလျောက် နေရာချ၊ run၊ ပျက်ရင် ပြန်စပေးတဲ့ platform ပါ။                                                                                                          | L02 → L04      |
| microservice                                                                             | EN                       | —                                                       | app ကြီး တစ်ခုကို သီးခြား deploy လုပ်လို့ရတဲ့ service သေးသေးလေးတွေအဖြစ် ခွဲထားတာပါ။                                                                                                                       | L04            |
| serverless                                                                               | EN                       | "server-less"                                           | server ကို ကိုယ်တိုင် မစီမံဘဲ code ကိုပဲ တင်ထားပြီး request ဝင်လာမှ run တဲ့ ပုံစံပါ။                                                                                                                            | L04            |
| managed service                                                                          | EN                       | —                                                       | ကိုယ်တိုင် မ run ဘဲ cloud provider က run ပေး၊ update လုပ်ပေးတဲ့ service ပါ၊ ဥပမာ managed database ပါ။                                                                                               | L04            |
| region / zone                                                                            | EN                       | —                                                       | region က မြို့ ဒါမှမဟုတ် နိုင်ငံ အလိုက် ခွဲထားတဲ့ datacenter အုပ်စုပါ။ zone က region တစ်ခုထဲမှာ သီးခြား လျှပ်စစ်နဲ့ network ရှိတဲ့ အပိုင်းပါ။                                                                                 | L04            |
| datacenter                                                                               | EN                       | —                                                       | server အများကြီးကို လျှပ်စစ်၊ အအေးပေးစနစ်၊ network တွေနဲ့ တကွ ထားတဲ့ အဆောက်အအုံပါ။                                                                                                                       | L04            |
| control plane / data plane                                                               | EN                       | —                                                       | data plane က user request တွေကို တကယ် handle လုပ်တဲ့ အပိုင်း၊ control plane က setting တွေ၊ ဘယ်ကို ပို့မလဲ ဆိုတာတွေကို ဆုံးဖြတ်ပေးတဲ့ အပိုင်းပါ။                                                                          | L04            |
| infrastructure as code                                                                   | Full phrase              | avoid "I-a-C"                                           | infrastructure ကို screen ပေါ်မှာ click နှိပ်ပြီး မဆောက်ဘဲ code နဲ့ ရေး၊ review လုပ်ပြီး version ထိန်းတာပါ။                                                                                               | L04            |
| desired state / reconcile                                                                | EN                       | —                                                       | ဖြစ်စေချင်တဲ့ အခြေအနေကို ရေးထားပြီး လက်ရှိ အခြေအနေက မတူရင် system က အလိုအလျောက် ပြန်ညှိပေးတာပါ။                                                                                                            | L04            |
| configuration drift                                                                      | EN                       | —                                                       | စက်တွေ ဒါမှမဟုတ် environment တွေကို လက်နဲ့ ပြင်ရင်းနဲ့ တဖြည်းဖြည်း မတူညီ ဖြစ်သွားတာပါ။                                                                                                                        | L04            |
| pets vs cattle                                                                           | EN + gloss               | —                                                       | စက်တစ်လုံးချင်းကို နာမည်ပေးပြီး လက်နဲ့ ပြုစုတာက pet၊ အားလုံး တူတူ ဖြစ်လို့ ပျက်ရင် အသစ်နဲ့ လဲလိုက်ရုံပဲ ဆိုတာက cattle ပါ။                                                                                                    | L04            |
| vendor lock-in                                                                           | EN                       | —                                                       | provider တစ်ခုတည်းရဲ့ ထူးခြားချက်တွေကို အရမ်း အားကိုးမိလို့ နောက်မှ ပြောင်းဖို့ ခက်သွားတာပါ။                                                                                                                      | L04            |
| Padauk reliability loop, "the Padauk loop" (Agree · Notice · Respond · Learn · Build in) | EN + gloss (stations MM) | "reliability loop"                                      | ပြဿနာ တစ်ခု ဖြစ်တိုင်း ပတ်ရတဲ့ စက်ဝိုင်းပါ။ ဘယ်လောက် စိတ်ချရရင် လုံလောက်လဲ သဘောတူတယ်၊ user ထိခိုက်နေတာကို သတိထားမိတယ်၊ တုံ့ပြန်တယ်၊ သင်ခန်းစာယူတယ်၊ ပြီးတော့ သင်ခန်းစာကို system ထဲ ထည့်တည်ဆောက်တယ်။ အလယ်မှာ လူတွေ ရှိပြီး culture က စက်ဝိုင်းကို လည်စေပါတယ်။ | L01 → L02      |
| agreed risk limit                                                                        | MM + "risk"              | —                                                       | shortcut တွေ၊ အမှားတွေကို ဘယ်အထိ ခံနိုင်လဲ ဆိုတာ ပြဿနာ မတက်ခင် ကြိုသဘောတူထားတဲ့ အကန့်အသတ်ပါ။ နောက်ပိုင်းမှာ ဒါကို SLO နဲ့ error budget လို့ ခေါ်ပါမယ်။                                                                         | L01 → L06      |
| real outage cost                                                                         | MM                       | —                                                       | outage ရဲ့ တကယ့် ကုန်ကျစရိတ်ပါ။ မိနစ်တွေတင် မဟုတ်ဘဲ user တွေ ထပ်ကြိုးစားရတဲ့ အချိန်၊ support အချိန်၊ refund အလုပ်၊ ဆိုင်တွေ ဆုံးရှုံးတဲ့ အရောင်း၊ နောက်ကျသွားတဲ့ feature တွေအထိ ပေါင်းတွက်ရပါတယ်။                                         | L03            |
| system decay                                                                             | MM                       | —                                                       | ဘယ်သူမှ ပြုပြင်ထိန်းသိမ်းမှု မလုပ်တော့ရင် system က ဖြည်းဖြည်းချင်း ဆွေးမြေ့လာပြီး နောက်ဆုံး ဘယ်သူမှ မထိရဲတော့တဲ့ အခြေအနေကို ရောက်တာပါ။                                                                                      | L03            |
| churn                                                                                    | EN + gloss               | —                                                       | user တွေ ဒါမှမဟုတ် ဆိုင်တွေက ကိုယ့် app ကို စွန့်ပြီး တခြား app ကို ပြောင်းသွားတာပါ။                                                                                                                           | L03            |
| gray failure                                                                             | EN + gloss               | —                                                       | server တွေ အားလုံး up လို့ ပြနေပေမဲ့ user တချို့အတွက် နှေးနေတာ၊ တစ်ဝက်တစ်ပျက် ပျက်နေတာမျိုးပါ။ ပျမ်းမျှ number တွေက မမြင်ရတတ်ပါဘူး။                                                                                 | L04            |
| workload-centric                                                                         | EN + gloss               | —                                                       | server တစ်လုံးချင်းကို ပြုစုတာထက် container၊ function လို workload တွေကို platform ပေါ်မှာ run ပြီး user ဘက်က ရလဒ်ကို ကြည့်တဲ့ ပုံစံပါ။                                                                              | L04            |
| reliable enough                                                                          | MM                       | —                                                       | ဒီအသုံးအတွက် လုံလောက်တဲ့ reliability ပါ။ ကြော်ငြာပုံ တစ်ပုံ ခဏ ပျက်တာ ရပေမဲ့ wallet balance တစ်မိနစ် မှားတာ မရပါဘူး။                                                                                             | L02 → L06      |
| user-side measurement                                                                    | MM                       | —                                                       | server ဘက်က number တွေထက် user တကယ် ခံစားရတာကို တိုင်းတာပါ။ ပြဿနာကို user မခံစားရခင် သတိထားမိဖို့ အခွင့်အရေး ပိုပေးပါတယ်။                                                                                         | L04 → L07      |

### 2.2 SLOs and error budgets

| English term                  | Keep EN?               | Said as                                     | Burmese line                                                                                                             | First        |
| ----------------------------- | ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| SLI (service level indicator) | EN                     | "S-L-I"                                     | user ကြုံရတဲ့ အတွေ့အကြုံကို တိုင်းတဲ့ ကိန်းဂဏန်းပါ၊ ဥပမာ အောင်မြင်တဲ့ request ရာခိုင်နှုန်း ဒါမှမဟုတ် 300 millisecond အောက်မှာ ပြီးတဲ့ request ရာခိုင်နှုန်းပါ။    | L03 → L06–07 |
| SLO (service level objective) | EN                     | "S-L-O"                                     | SLI တစ်ခုအတွက် ဒီလောက်ဆို လုံလောက်ပြီလို့ သဘောတူ သတ်မှတ်ထားတဲ့ ပစ်မှတ်ပါ၊ ဥပမာ ရက် 30 အတွင်း request 99.9 ရာခိုင်နှုန်း အောင်မြင်ရမယ် ဆိုတာမျိုးပါ။              | L02 → L06–07 |
| SLA (service level agreement) | EN                     | "S-L-A"                                     | customer နဲ့ စာချုပ်ထဲမှာ ကတိပေးထားပြီး မပြည့်ရင် လျော်ကြေး ပေးရတဲ့ ကတိပါ။ အများအားဖြင့် SLO ထက် လျော့ထားပါတယ်။                              | L03          |
| error budget                  | EN                     | —                                           | SLO က ခွင့်ပြုထားတဲ့ ပျက်ခွင့်ပါ။ 99.9 ရာခိုင်နှုန်း ပစ်မှတ်ဆိုရင် ကျန်တဲ့ 0.1 ရာခိုင်နှုန်းက ပြောင်းလဲမှုတွေ၊ စမ်းသပ်မှုတွေအတွက် သုံးလို့ရတဲ့ budget ပါ။                  | L02 → L06–07 |
| error budget policy           | EN                     | —                                           | budget ကုန်ခါနီး ဒါမှမဟုတ် ကုန်သွားရင် အဖွဲ့က ဘာလုပ်မလဲ ဆိုတာ ကြိုသဘောတူ ရေးထားတဲ့ စည်းမျဉ်းပါ။                                                   | L05 → L06–07 |
| burn rate                     | EN                     | —                                           | error budget ကို ပုံမှန်နှုန်းထက် ဘယ်နှဆ မြန်မြန် သုံးနေလဲ ဆိုတဲ့ နှုန်းပါ။                                                                      | L06–07       |
| fast burn / slow burn         | EN                     | —                                           | နာရီပိုင်းအတွင်း budget ကုန်မယ့်နှုန်းနဲ့ သုံးနေတာက fast burn၊ ရက်တွေ ကြာမှ ကုန်မယ့်နှုန်းနဲ့ တဖြည်းဖြည်း သုံးနေတာက slow burn ပါ။                         | L06–07       |
| nines                         | EN term, Burmese count | "nine သုံးလုံး", "nine ငါးလုံး"                   | 99.9 ရာခိုင်နှုန်းကို nine သုံးလုံးလို့ ခေါ်ပါတယ်။ nine တစ်လုံး တိုးတိုင်း ပျက်ခွင့်က ဆယ်ပုံ တစ်ပုံ လျော့သွားပြီး ကုန်ကျစရိတ်က အများကြီး တက်ပါတယ်။                    | L03 → L06–07 |
| SLO window                    | EN                     | —                                           | SLO ကို တိုင်းတဲ့ ကာလပါ၊ ဥပမာ နောက်ဆုံး ရက် 30 ပါ။                                                                                  | L06–07       |
| threshold                     | EN                     | —                                           | ဒီတန်ဖိုးကို ကျော်ရင် ကောင်းတယ်၊ မကျော်ရင် မကောင်းဘူးလို့ ခွဲပေးတဲ့ မျဉ်းပါ။                                                                   | L06–07       |
| critical user journey         | Full phrase            | avoid "C-U-J"                               | user တစ်ယောက် ရည်ရွယ်ချက် တစ်ခု ပြီးမြောက်ဖို့ ဖြတ်သွားရတဲ့ အရေးကြီး အဆင့်တွေပါ၊ ဥပမာ အစားအသောက် ရွေး၊ မှာ၊ ငွေချေတဲ့အထိ လမ်းကြောင်းပါ။                | L05 → L06–07 |
| happy path                    | EN                     | —                                           | ဘာပြဿနာမှ မရှိရင် user သွားမယ့် ပုံမှန် လမ်းကြောင်းပါ။                                                                                | L06–07       |
| success rate / error rate     | EN                     | —                                           | request အားလုံးထဲက အောင်မြင်တဲ့ ရာခိုင်နှုန်းက success rate၊ မအောင်မြင်တဲ့ ရာခိုင်နှုန်းက error rate ပါ။                                        | L06–07       |
| percentile (p50, p95, p99)    | EN                     | "P fifty", "P ninety-five", "P ninety-nine" | request တွေကို ကြာချိန်အလိုက် စီလိုက်ရင် 99 ရာခိုင်နှုန်းက ဒီအချိန်ထက် မြန်တယ် ဆိုတာကို p99 လို့ ခေါ်ပါတယ်။                                                | L04 → L06–07 |
| tail latency                  | EN                     | —                                           | အနှေးဆုံး request အနည်းစုရဲ့ latency ပါ။ ပျမ်းမျှထဲမှာ ပျောက်နေပေမဲ့ user တွေ တကယ် ခံစားရပါတယ်။                                            | L04          |
| durability                    | EN                     | —                                           | သိမ်းထားတဲ့ data မပျောက်ဘဲ ဆက်ရှိနေမယ့် အလားအလာပါ။                                                                                  | L06–07       |
| freshness                     | EN                     | —                                           | data ဘယ်လောက် နောက်ဆုံးရ ဖြစ်လဲ၊ ပြောင်းပြီး ဘယ်လောက် ကြာမှ user မြင်ရလဲ ဆိုတာပါ။                                                        | L06–07       |
| correctness                   | EN                     | —                                           | system က ပြန်ပေးတဲ့ အဖြေ မှန်လား မမှန်လား ဆိုတာပါ။ မြန်ပေမဲ့ မှားနေရင် အသုံးမဝင်ပါဘူး။                                                     | L06–07       |
| throughput                    | EN                     | "through-put"                               | တစ်စက္ကန့်မှာ အလုပ် ဘယ်နှခု ပြီးအောင် လုပ်ပေးနိုင်လဲ ဆိုတဲ့ ပမာဏပါ။                                                                            | L06–07       |
| per-customer SLO              | EN                     | —                                           | customer အကြီး တစ်ယောက်ချင်းအတွက် သီးသန့် တိုင်းတဲ့ SLO ပါ။ စုစုပေါင်းမှာ ကောင်းနေပေမဲ့ customer တစ်ယောက်တည်း ဒုက္ခရောက်နေတာကို မြင်ရအောင်ပါ။           | L06–07       |
| implicit SLO                  | EN + gloss             | —                                           | ဘယ်သူမှ ကတိ မပေးထားပေမဲ့ user တွေက ဒီလိုပဲ အမြဲ ဖြစ်မှာပဲလို့ အားကိုးလာတဲ့ အပြုအမူပါ။                                                            | L06–07       |
| Hyrum's law                   | EN                     | "HIGH-rum's law"                            | user များလာရင် ကတိ မပေးထားတဲ့ အပြုအမူ အသေးလေးတွေကိုတောင် တစ်ယောက်ယောက်က အားကိုးလာမယ် ဆိုတဲ့ အတွေ့အကြုံ ဥပဒေသပါ။                                  | L06–07       |
| client-side SLO               | EN                     | —                                           | server ဘက်မှာ မဟုတ်ဘဲ user ရဲ့ phone ဒါမှမဟုတ် browser ဘက်ကနေ တိုင်းတဲ့ SLO ပါ။ server မမြင်ရတဲ့ network ပြဿနာတွေကိုပါ မြင်ရပါတယ်။               | L06–07       |
| bad minute                    | EN + gloss             | —                                           | အဲဒီ မိနစ်ထဲမှာ journey ရဲ့ အရေးကြီးတဲ့ အဆင့် တစ်ခုခု fail ဖြစ်ခဲ့ရင်၊ ဒါမှမဟုတ် error တွေ ပုံမှန်ထက် သိသိသာသာ များလာခဲ့ရင် အဲဒီ မိနစ်ကို bad minute လို့ ရေတွက်ပါတယ်။ | L07          |
| feature freeze                | EN                     | —                                           | error budget ကုန်သွားရင် feature အသစ် ထုတ်တာကို ခဏ ရပ်ပြီး reliability ပြင်တဲ့ အလုပ်ကို ဦးစားပေးတာပါ။                                      | L06–07       |
| Goodhart's law                | EN                     | "GOOD-hart's law"                           | ကိန်းဂဏန်း တစ်ခုကို ပစ်မှတ် လုပ်လိုက်တာနဲ့ လူတွေက ကိန်းဂဏန်းကိုပဲ လိုက်ပြင်ကြလို့ အဲဒီ ကိန်းဂဏန်းက တကယ့် အခြေအနေကို မပြတော့ဘူး ဆိုတာပါ။                               | L15          |

### 2.3 Observability and monitoring

| English term                                         | Keep EN?     | Said as                               | Burmese line                                                                                                                                    | First           |
| ---------------------------------------------------- | ------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| monitoring                                           | EN           | —                                     | ကြိုသိထားတဲ့ ကိန်းဂဏန်းတွေနဲ့ system ကျန်းမာရေးကို စောင့်ကြည့်ပြီး ပြဿနာ တက်ရင် သတိပေးတာပါ။                                                                           | L02 → L08       |
| observability                                        | EN           | —                                     | ကြိုမမျှော်လင့်ထားတဲ့ မေးခွန်းအသစ်တွေကိုပါ system ထုတ်ပေးတဲ့ data ကနေ ဖြေနိုင်တဲ့ စွမ်းရည်ပါ။ ဘာဖြစ်နေလဲ ဆိုတာအပြင် ဘာကြောင့်လဲ ဆိုတာကိုပါ ရှာနိုင်ပါတယ်။                                  | L02 → L08       |
| telemetry                                            | EN           | —                                     | system က သူ့အကြောင်း ထုတ်ပေးတဲ့ metric၊ log၊ trace လို data အားလုံးပါ။                                                                                     | L04 → L08       |
| metric                                               | EN           | —                                     | အချိန်နဲ့ အမျှ တိုင်းထားတဲ့ ကိန်းဂဏန်းပါ၊ ဥပမာ တစ်စက္ကန့်မှာ ဝင်လာတဲ့ request အရေအတွက်ပါ။                                                                              | L02 → L08       |
| log                                                  | EN           | —                                     | ဖြစ်ခဲ့တဲ့ event တစ်ခုချင်းကို အချိန်နဲ့ တကွ မှတ်ထားတဲ့ စာကြောင်းပါ။                                                                                                | L02 → L08       |
| structured logging                                   | EN           | —                                     | log ကို စာသား အလွတ် မရေးဘဲ field တွေ ခွဲရေးထားလို့ ရှာရ၊ စစ်ရ လွယ်တာပါ။                                                                                        | L08 → L30–31    |
| trace / span                                         | EN           | —                                     | request တစ်ခု service တွေကို ဖြတ်သွားတဲ့ လမ်းကြောင်း တစ်ခုလုံးက trace၊ အဲဒီထဲက service တစ်ခုက လုပ်တဲ့ အပိုင်းတစ်ခုချင်းက span ပါ။                                             | L04 → L08       |
| distributed tracing                                  | EN           | —                                     | service အများကြီးကို ဖြတ်သွားတဲ့ request ကို အစအဆုံး ခြေရာခံတာပါ၊ ဘယ်နေရာမှာ နှေးနေလဲ မြင်ရပါတယ်။                                                                 | L04 → L08       |
| trace ID                                             | EN           | "trace I-D"                           | request တစ်ခုရဲ့ log တွေနဲ့ span တွေကို ချိတ်ပေးတဲ့ ID ပါ။                                                                                                    | L08             |
| profiling                                            | EN           | —                                     | code ရဲ့ ဘယ်အပိုင်းက CPU နဲ့ memory ကို အများဆုံး သုံးနေလဲ တိုင်းတာပါ။                                                                                            | L08             |
| instrumentation                                      | EN           | verb: "instrument လုပ်"                 | code ထဲမှာ metric၊ log၊ trace ထုတ်ပေးအောင် ထည့်ရေးတာပါ။                                                                                                | L05 → L08       |
| dashboard                                            | EN           | —                                     | အရေးကြီး metric တွေကို graph တွေနဲ့ screen တစ်ခုတည်းမှာ စုပြထားတာပါ။                                                                                        | L02             |
| alert                                                | EN           | "alert တက်" (an alert fires)           | တစ်ခုခု မှားနေပြီ၊ လူ ကြည့်ဖို့ လိုပြီ ဆိုရင် system က အလိုအလျောက် သတိပေးတာပါ။                                                                                       | L02 → L08       |
| page / paging / pager                                | EN           | "page ဝင်လာ", "page ပို့"                 | ချက်ချင်း ကြည့်ရမယ့် alert ကို on-call ကျနေတဲ့သူရဲ့ phone ဆီ တိုက်ရိုက် ပို့ပြီး နှိုးတာပါ။ ညဘက်မှာတောင် ဝင်လာနိုင်ပါတယ်။                                                          | L02 → L09–10    |
| ticket                                               | EN           | —                                     | ချက်ချင်း မဟုတ်ဘဲ အလုပ်ချိန်ထဲမှာ ဖြေရှင်းလို့ရတဲ့ အလုပ် တစ်ခုပါ။                                                                                                     | L02             |
| actionable alert                                     | EN           | —                                     | alert ရလာရင် လူက တကယ် တစ်ခုခု လုပ်စရာ ရှိတဲ့ alert ပါ။ လုပ်စရာ မရှိရင် အဲဒါ noise ပါ။                                                                             | L08 → L17       |
| noise                                                | EN           | —                                     | လုပ်စရာ မရှိတဲ့ alert တွေပါ။ အရေးကြီးတဲ့ signal ကို ဖုံးသွားစေပါတယ်။                                                                                            | L17             |
| alert fatigue                                        | EN           | —                                     | အသုံးမဝင်တဲ့ alert တွေ များလွန်းလို့ လူတွေက alert ကို ဂရုမစိုက်တော့တဲ့ အခြေအနေပါ။                                                                                     | L08             |
| false positive / false negative                      | EN           | —                                     | ပြဿနာ မရှိဘဲ alert တက်လာတာက false positive၊ ပြဿနာ ရှိနေပေမဲ့ alert မတက်တာက false negative ပါ။                                                            | L09–10 → L17    |
| symptom-based alerting                               | EN           | —                                     | CPU များနေတာလို အကြောင်းရင်းကို မဟုတ်ဘဲ error များလာတာလို user ခံစားရတဲ့ လက္ခဏာကို alert လုပ်တာပါ။                                                                 | L08 → L30–31    |
| golden signals                                       | EN           | "four golden signals"                 | service တိုင်းမှာ အရင်ဆုံး ကြည့်သင့်တဲ့ latency၊ traffic၊ error နဲ့ saturation ဆိုတဲ့ signal လေးခုပါ။                                                               | L08             |
| traffic                                              | EN           | —                                     | system ဆီ ရောက်လာတဲ့ request ပမာဏပါ။                                                                                                                | L02             |
| saturation                                           | EN           | —                                     | CPU၊ memory လို resource တစ်ခု ဘယ်လောက် ပြည့်နေပြီလဲ ဆိုတာပါ။ ပြည့်ခါနီးရင် နှေးလာတတ်ပါတယ်။                                                                        | L08             |
| RED / USE                                            | EN           | "R-E-D", "U-S-E"                      | request ဘက်က rate၊ error၊ duration ကို ကြည့်တာက RED၊ resource ဘက်က utilization၊ saturation၊ error ကို ကြည့်တာက USE ပါ။                                    | L06–07 → L08    |
| cardinality / label                                  | EN           | —                                     | metric မှာ ထည့်ထားတဲ့ label တွေရဲ့ မတူတဲ့ တန်ဖိုး ဘယ်နှမျိုး ရှိလဲ ဆိုတာပါ။ user ID လို label ထည့်ရင် cardinality အရမ်း မြင့်ပြီး ကုန်ကျစရိတ် တက်ပါတယ်။                               | L04 → L08       |
| time series                                          | EN           | —                                     | အချိန်တစ်ခုချင်းမှာ တိုင်းထားတဲ့ တန်ဖိုးတွေကို အစဉ်လိုက် စီထားတာပါ။                                                                                                   | L04             |
| sampling                                             | EN           | —                                     | data အားလုံး မသိမ်းဘဲ တစ်စိတ်တစ်ပိုင်းကိုပဲ ရွေးသိမ်းတာပါ၊ ကုန်ကျစရိတ် သက်သာအောင်ပါ။                                                                                    | L08             |
| retention                                            | EN           | —                                     | telemetry ဒါမှမဟုတ် data ကို ဘယ်လောက် ကြာကြာ သိမ်းထားမလဲ ဆိုတာပါ။                                                                                           | L08 → L21–22    |
| prober / synthetic monitoring (synthetic test order) | EN           | —                                     | user လုပ်သလို request တွေကို အချိန်မှန် ပို့ပြီး service အလုပ်လုပ်လား အပြင်ဘက်ကနေ စစ်ပေးတဲ့ program ပါ။                                                                 | L02 → L08       |
| health check                                         | EN           | —                                     | service ဒါမှမဟုတ် server တစ်ခု ကောင်းနေသေးလား ပုံမှန် မေးကြည့်တဲ့ စစ်ဆေးမှုပါ။                                                                                   | L06–07 → L23–24 |
| baseline / anomaly                                   | EN           | —                                     | ပုံမှန် အခြေအနေ ဘယ်လိုလဲ ဆိုတာက baseline၊ အဲဒီကနေ ထူးထူးခြားခြား သွေဖည်နေတာက anomaly ပါ။                                                                        | L08             |
| OpenTelemetry                                        | EN           | "open telemetry"                      | telemetry ထုတ်ဖို့နဲ့ ပို့ဖို့ open standard ပါ။ vendor တစ်ခုတည်းနဲ့ မချည်နှောင်ထားရအောင် ကူညီပါတယ်။                                                                     | L04 → L08       |
| shared fate                                          | EN           | —                                     | monitoring system က သူ စောင့်ကြည့်နေတဲ့ system နဲ့ အတူတူ ပျက်သွားနိုင်တဲ့ အခြေအနေပါ။ ပျက်တဲ့ အချိန်မှာ ဘာမှ မမြင်ရတော့ပါဘူး။                                                | L08             |
| time to detect / mitigate / resolve                  | Full phrase  | avoid "T-T-D", "T-T-M", "T-T-R"       | ပြဿနာ စဖြစ်ပြီး သိရတဲ့အထိ၊ ထိခိုက်မှု ရပ်တဲ့အထိ၊ အပြီးတိုင် ဖြေရှင်းတဲ့အထိ ကြာချိန် သုံးခုပါ။                                                                                 | L08             |
| MTTR (also MTTD, MTTM)                               | EN           | "M-T-T-R"; full phrase the first time | incident အများကြီးရဲ့ ပျမ်းမျှ ဖြေရှင်းချိန်ပါ။ ပျမ်းမျှ တစ်ခုတည်းက လှည့်စားတတ်လို့ သတိထားပြီး သုံးရပါမယ်။                                                                | L28–29 → L30–31 |
| defense in depth                                     | EN           | —                                     | ကာကွယ်ရေး အလွှာ တစ်ခုတည်းကို အားမကိုးဘဲ အလွှာများစွာ ထားတာပါ၊ တစ်ခု လွတ်သွားရင် နောက်တစ်ခုက ဖမ်းနိုင်အောင်ပါ။                                                                | L08 → L11–12    |
| generated dashboard                                  | EN + gloss   | —                                     | shared library ထဲမှာ ထည့်ထားတဲ့ standard metric တွေကနေ service တိုင်းအတွက် အလိုအလျောက် ထွက်လာတဲ့ dashboard ပါ။ လက်နဲ့ တစ်ခုချင်း ဆွဲစရာ မလိုပါဘူး။                            | L08             |
| change supervision                                   | EN + gloss   | —                                     | user ဘက်က check တစ်ခု ကျသွားတာနဲ့ ကိုယ့် release၊ config push၊ feature ramp တွေကို အလိုအလျောက် ရပ်ပေးတာပါ။                                                       | L08 → L19       |
| evidence-based alert                                 | MM + "alert" | —                                     | error အရေအတွက် သက်သက်နဲ့ မဟုတ်ဘဲ နမူနာ ဘယ်လောက် ရှိလဲပါ ထည့်တွက်ပြီး တကယ် ပြဿနာ ဖြစ်နေတယ်လို့ သေချာမှ page လုပ်တဲ့ alert ပါ။ ညသန်းခေါင် request ၄၀ ထဲက တစ်ခု fail တာနဲ့ page မလုပ်ပါဘူး။ | L08             |

### 2.4 Incidents and on-call

| English term                            | Keep EN?                  | Said as                          | Burmese line                                                                                                                                                     | First        |
| --------------------------------------- | ------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| incident                                | EN                        | "incident ဖြစ်", "incident ကြေညာ" | user ဒါမှမဟုတ် business ကို ထိခိုက်နေလို့ ချက်ချင်း ညှိနှိုင်းပြီး ဖြေရှင်းဖို့ လိုတဲ့ ပြဿနာပါ။                                                                                                | L02 → L09–10 |
| outage                                  | EN                        | —                                | service တစ်ခုလုံး ဒါမှမဟုတ် အစိတ်အပိုင်း တစ်ခု သုံးမရ ဖြစ်သွားတာပါ။                                                                                                                | L01          |
| incident management / incident response | EN                        | —                                | incident ကို သိတာကနေ ထိန်းချုပ်၊ ဖြေရှင်းပြီး သင်ခန်းစာ ယူတဲ့အထိ စနစ်တကျ လုပ်တဲ့ နည်းလမ်းပါ။                                                                                            | L02 → L09–10 |
| on-call                                 | EN                        | "on-call ကျ", "on-call ယူ"        | သတ်မှတ်ထားတဲ့ အချိန်အတွင်း page ဝင်လာရင် ချက်ချင်း တုံ့ပြန်ဖို့ တာဝန်ယူထားတာပါ။                                                                                                        | L02 → L09–10 |
| rotation / shift                        | EN                        | —                                | on-call တာဝန်ကို အဖွဲ့ဝင်တွေ အလှည့်ကျ ယူတဲ့ အစီအစဉ်က rotation၊ တစ်ယောက်ရဲ့ တာဝန်ကာလ တစ်ခုက shift ပါ။                                                                                    | L09–10       |
| primary / secondary                     | EN                        | —                                | page ကို ပထမဆုံး ဖြေရမယ့်သူက primary၊ primary မဖြေနိုင်ရင် ဒါမှမဟုတ် အကူအညီ လိုရင် ဆက်ခေါ်ရမယ့်သူက secondary ပါ။                                                                         | L09–10       |
| follow-the-sun                          | EN                        | —                                | အချိန်ဇုန် မတူတဲ့ အဖွဲ့တွေက ကိုယ့်ရဲ့ နေ့ခင်းဘက်မှာပဲ on-call ယူပြီး တစ်ဖွဲ့ကနေ တစ်ဖွဲ့ကို လက်လွှဲတဲ့ ပုံစံပါ။ ညဘက် page မဝင်တော့ပါဘူး။                                                                         | L09–10       |
| escalation                              | EN                        | verb: "escalate လုပ်"              | ကိုယ့်ဘာသာ မဖြေရှင်းနိုင်ရင် ပိုသိတဲ့သူ ဒါမှမဟုတ် ဆုံးဖြတ်ပိုင်ခွင့် ရှိတဲ့သူကို ဆက်ခေါ်တာပါ။                                                                                                         | L09–10       |
| handoff                                 | EN                        | —                                | shift ပြောင်းတဲ့အခါ ဘာဖြစ်နေလဲ၊ ဘာကျန်နေလဲ ဆိုတာကို နောက်လူကို ရှင်းပြပြီး လွှဲပေးတာပါ။                                                                                               | L09–10       |
| acknowledge (ack)                       | EN                        | "ack လုပ်"                         | page ရလာရင် ကြည့်နေပါပြီလို့ system ထဲမှာ အသိပေးတာပါ၊ ဒါမှ secondary ဆီ ဆက်မသွားတော့ပါဘူး။                                                                                       | L09–10       |
| severity (SEV1, SEV2)                   | EN                        | "sev one", "sev two"             | incident ဘယ်လောက် ပြင်းထန်လဲ ဆိုတဲ့ အဆင့်ပါ၊ နံပါတ် ငယ်လေ ပြင်းလေ ပါ။                                                                                                           | L09–10       |
| declare an incident                     | MM verb                   | "incident ကြေညာ"                 | ပြဿနာကို incident အဖြစ် တရားဝင် ကြေညာပြီး role တွေ ခွဲ၊ လူ စုတာပါ။ သံသယ ရှိရင် ကြေညာလိုက်တာ ပိုကောင်းပါတယ်။                                                                           | L09–10       |
| incident commander                      | Full phrase               | avoid "I-C"                      | incident တစ်ခုလုံးကို ညှိနှိုင်းပြီး ဆုံးဖြတ်ချက်ချတဲ့သူပါ။ ရာထူး ဘယ်လောက်ပဲ ရှိရှိ incident အတွင်းမှာ incident commander က ဦးဆောင်ပါတယ်။ ကိုယ်တိုင် ပြင်တာထက် လူတိုင်း ဘာလုပ်ရမလဲ သိအောင် စီစဉ်ပေးတာက ပိုအရေးကြီးပါတယ်။ | L09 → L10    |
| communications lead                     | EN                        | —                                | stakeholder တွေနဲ့ customer တွေကို အခြေအနေ ပုံမှန် update ပေးတဲ့သူပါ။                                                                                                         | L09–10       |
| operations lead                         | EN                        | —                                | system ကို တကယ် ပြင်တဲ့ လုပ်ဆောင်ချက်တွေကို ဦးဆောင်တဲ့သူပါ။                                                                                                                       | L09–10       |
| scribe                                  | EN                        | —                                | incident အတွင်း ဘာတွေ ဖြစ်ခဲ့လဲ၊ ဘာဆုံးဖြတ်ခဲ့လဲ ဆိုတာ အချိန်နဲ့ တကွ မှတ်တမ်းတင်တဲ့သူပါ။                                                                                                    | L09–10       |
| incident response team                  | Full phrase first         | then "I-R-T"                     | incident ကြီးတွေ ဖြစ်ရင် ဝင်ညှိနှိုင်းဖို့ ကြိုဖွဲ့ထားတဲ့ အဖွဲ့ပါ။                                                                                                                       | L09–10       |
| triage                                  | EN                        | —                                | ပြဿနာ ဘယ်လောက် ပြင်းလဲ၊ ဘာကို အရင် လုပ်ရမလဲ ဆိုတာ မြန်မြန် ခွဲခြား ဆုံးဖြတ်တာပါ။                                                                                                    | L09–10       |
| mitigation                              | EN                        | verb: "mitigate လုပ်"              | အကြောင်းရင်း အပြည့်အစုံ မသိသေးခင်မှာပဲ user ထိခိုက်မှုကို အရင် ရပ်အောင် ဒါမှမဟုတ် လျှော့အောင် လုပ်တာပါ။                                                                                       | L02 → L09–10 |
| generic mitigation                      | EN                        | —                                | ပြဿနာ အမျိုးအစား မရွေး အလုပ်ဖြစ်အောင် ကြိုပြင်ထားတဲ့ လုပ်ဆောင်ချက်တွေပါ၊ ဥပမာ rollback၊ traffic လွှဲတာ၊ capacity တိုးတာ မျိုးပါ။                                                         | L11–12       |
| resolution                              | EN                        | —                                | ပြဿနာကို အပြီးတိုင် ဖြေရှင်းပြီး ပုံမှန် အခြေအနေ ပြန်ရောက်တာပါ။                                                                                                                 | L09–10       |
| root cause / contributing cause         | EN                        | —                                | ပြဿနာရဲ့ အခြေခံ အကြောင်းရင်းက root cause ပါ။ ဒါပေမဲ့ ရှုပ်ထွေးတဲ့ system မှာ အကြောင်းရင်း တစ်ခုတည်း မရှိဘဲ ပေါင်းပါဝင်တဲ့ အကြောင်းရင်း အများကြီး ရှိတတ်ပါတယ်။                                     | L02 → L11–12 |
| hypothesis                              | EN                        | —                                | ဘာကြောင့် ဖြစ်နေတာလဲ ဆိုတဲ့ ယူဆချက်ပါ၊ data နဲ့ စစ်ပြီး မှန်လား မှားလား ဆုံးဖြတ်ပါတယ်။                                                                                                | L09–10       |
| incident channel / war room             | EN                        | —                                | incident ဖြစ်နေစဉ် ဆောင်ရွက်သူတွေ စုပြီး ဆွေးနွေးတဲ့ chat channel ဒါမှမဟုတ် အခန်းပါ။                                                                                              | L09–10       |
| runbook / playbook                      | EN                        | "run book", "play book"          | alert တစ်ခု တက်လာရင် ဘာစစ်ရမလဲ၊ ဘာလုပ်ရမလဲ ဆိုတာ အဆင့်လိုက် ရေးထားတဲ့ လမ်းညွှန်ပါ။                                                                                                     | L04 → L09–10 |
| swarm                                   | EN                        | —                                | အဖွဲ့ဝင် အများကြီး တစ်ပြိုင်နက် ဝိုင်းပြီး ပြဿနာကို ဖြေရှင်းတာပါ။                                                                                                                  | L09–10       |
| bystander effect                        | EN + gloss                | —                                | လူများလေ တစ်ယောက်ယောက် လုပ်မှာပါလို့ ထင်ပြီး ဘယ်သူမှ မလုပ်ဖြစ်တဲ့ အခြေအနေပါ။                                                                                                         | L09–10       |
| confirmation bias                       | EN + gloss                | —                                | ကိုယ်ထင်ထားတာကို ထောက်ခံတဲ့ အချက်တွေကိုပဲ မြင်ပြီး ဆန့်ကျင်တဲ့ အချက်တွေကို လျစ်လျူရှုမိတာပါ။                                                                                                    | L09–10       |
| paging load                             | EN                        | —                                | on-call shift တစ်ခုမှာ page ဘယ်နှခု ဝင်လာလဲ ဆိုတဲ့ ဝန်ပါ။ များလွန်းရင် လူ မောပန်းပြီး အမှား များလာပါတယ်။                                                                              | L09–10       |
| game day / drill                        | EN                        | —                                | တကယ့် incident မဖြစ်ခင် ပျက်စီးမှုကို တမင် ဖန်တီးပြီး အဖွဲ့လိုက် လေ့ကျင့်တာပါ။                                                                                                          | L09–10       |
| Wheel of Misfortune                     | EN                        | —                                | အရင် incident တစ်ခုကို ပြန်ယူပြီး အဖွဲ့ဝင် တစ်ယောက်က on-call လို ဖြေရှင်းကြည့်တဲ့ လေ့ကျင့်ခန်း ကစားပွဲပါ။                                                                                    | L14          |
| shadowing / reverse shadowing           | EN                        | —                                | လူသစ်က အတွေ့အကြုံရှိသူ on-call ယူတာကို ဘေးကနေ လိုက်ကြည့်တာက shadowing၊ လူသစ်က ကိုယ်တိုင် ယူပြီး အတွေ့အကြုံရှိသူက ဘေးကနေ စောင့်ကြည့်ပေးတာက reverse shadowing ပါ။                                        | L14          |
| status page                             | EN                        | —                                | service အခြေအနေကို customer တွေ ကိုယ်တိုင် ဝင်ကြည့်လို့ရတဲ့ page ပါ။                                                                                                              | L11–12       |
| burnout                                 | EN                        | —                                | အလုပ်ဝန်နဲ့ ညဘက် page တွေကို ကြာကြာ ခံရလို့ ကိုယ်ရော စိတ်ပါ ပင်ပန်း ကုန်ခမ်းသွားတာပါ။                                                                                                    | L03          |
| OODA loop                               | EN, prefer the four words | "observe, orient, decide, act"   | ကြည့်၊ နားလည်၊ ဆုံးဖြတ်၊ လုပ်ဆောင်ပြီး ပြန်ကြည့်တဲ့ စက်ဝိုင်းပါ။                                                                                                                    | L09–10       |
| stakeholder                             | EN                        | —                                | ရလဒ်နဲ့ တိုက်ရိုက် သက်ဆိုင်ပြီး အခြေအနေ သိဖို့ လိုတဲ့သူတွေပါ၊ ဥပမာ product manager၊ support team၊ အုပ်ချုပ်သူ ပါ။                                                                             | L03          |
| response time (on-call)                 | EN + gloss                | —                                | page တက်ပြီး on-call က ဘယ်လောက် မြန်မြန် လက်တွေ့ စတုံ့ပြန်ရမလဲ ဆိုတာပါ။ ငါးမိနစ်ဆိုရင် laptop ကို နေရာတိုင်း ယူသွားရပြီး မိနစ် ၃၀ ဆိုရင် ပုံမှန် ဘဝ နေလို့ရပါတယ်။                                          | L09          |
| wait and watch                          | MM                        | —                                | fix ထည့်ပြီးတာနဲ့ ချက်ချင်း incident ပိတ်မပစ်ဘဲ တည်ငြိမ်ရဲ့လား ခဏ စောင့်ကြည့်တာပါ။                                                                                                   | L10          |

### 2.5 Learning from incidents, and safety

| English term                           | Keep EN?    | Said as                    | Burmese line                                                                                                                              | First           |
| -------------------------------------- | ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| postmortem                             | EN          | "post mortem"              | incident ပြီးရင် ဘာဖြစ်ခဲ့လဲ၊ ဘာကြောင့်လဲ၊ နောက် ထပ်မဖြစ်အောင် ဘာလုပ်မလဲ ဆိုတာ စာနဲ့ ရေးပြီး အဖွဲ့လိုက် သင်ယူတာပါ။                                                     | L02 → L11–12    |
| blameless                              | EN + gloss  | —                          | ပြဿနာ ဖြစ်ရင် ဘယ်သူ့ အပြစ်လဲလို့ လူကို မရှာဘဲ system နဲ့ လုပ်ငန်းစဉ်ထဲက အားနည်းချက်ကို ရှာတဲ့ ချဉ်းကပ်ပုံပါ။                                                               | L02 → L11–12    |
| psychological safety                   | EN + gloss  | —                          | အမှားကို ဝန်ခံတာ၊ မေးခွန်း မေးတာ၊ စိုးရိမ်ချက် ပြောတာတွေကြောင့် အပြစ်ပေးခံရမှာ မကြောက်ဘဲ ပြောရဲ၊ လုပ်ရဲတဲ့ အဖွဲ့ရဲ့ ယုံကြည်မှုပါ။                                             | L02 → L05       |
| action item                            | EN          | —                          | postmortem ကနေ ထွက်လာတဲ့ လုပ်ရမယ့် အလုပ်တွေပါ။ တစ်ခုချင်းမှာ owner နဲ့ ပြီးရမယ့် ရက် ရှိရပါမယ်။                                                                   | L05 → L11–12    |
| timeline                               | EN          | —                          | incident အတွင်း ဘာက ဘယ်အချိန် ဖြစ်ခဲ့လဲ ဆိုတာကို အစဉ်လိုက် စီထားတဲ့ မှတ်တမ်းပါ။                                                                                  | L11–12          |
| impact                                 | EN          | —                          | user ဘယ်နှယောက်၊ ဘယ်လောက် ကြာကြာ၊ ဘယ်လို ထိခိုက်ခဲ့လဲ ဆိုတာပါ။                                                                                             | L11–12          |
| near miss                              | EN          | —                          | user ကို မထိခိုက်ခဲ့ပေမဲ့ နည်းနည်းလေး ကံမကောင်းရင် incident ဖြစ်သွားနိုင်တဲ့ အဖြစ်ပါ။ အလကား ရတဲ့ သင်ခန်းစာပါ။                                                        | L05 → L11–12    |
| hindsight bias                         | EN + gloss  | —                          | အဖြေ သိပြီးမှ ပြန်ကြည့်တော့ သိသာပါတယ်လို့ ထင်မိတာပါ။ အဲဒီအချိန်က လူတွေမှာ အခု ကျွန်တော်တို့ သိတဲ့ အချက်အလက် မရှိခဲ့ပါဘူး။                                                       | L11–12          |
| outcome bias                           | EN + gloss  | —                          | ရလဒ် ဆိုးသွားလို့ ဆုံးဖြတ်ချက်ကိုပါ ဆိုးတယ်လို့ အကဲဖြတ်မိတာပါ။                                                                                                  | L09–10 → L11–12 |
| local rationality                      | EN + gloss  | —                          | အဲဒီအချိန်၊ အဲဒီ အချက်အလက်နဲ့ဆိုရင် လူတစ်ယောက် လုပ်ခဲ့တာက သူ့အတွက် အဓိပ္ပာယ် ရှိခဲ့တယ် ဆိုတဲ့ အမြင်ပါ။ ဘာကြောင့် အဲဒီလို လုပ်တာ အဓိပ္ပာယ် ရှိခဲ့လဲလို့ မေးရပါမယ်။                                  | L11–12          |
| just culture                           | EN + gloss  | —                          | အမှားလုပ်မိတဲ့ လူကို အပြစ် မပေးပေမဲ့ တာဝန်ယူမှုကိုတော့ ထိန်းထားတဲ့ ယဉ်ကျေးမှုပါ။                                                                                    | L11–12          |
| accountability                         | EN          | —                          | ဖြစ်ခဲ့တာကို ရှင်းပြပြီး ပြင်ဆင်ဖို့ တာဝန်ယူတာပါ၊ အပြစ်ပေးတာနဲ့ မတူပါဘူး။                                                                                     | L11–12          |
| Swiss cheese model                     | EN          | —                          | ကာကွယ်ရေး အလွှာတိုင်းမှာ အပေါက်လေးတွေ ရှိပြီး အပေါက်တွေ တစ်တန်းတည်း ကျသွားမှ incident ဖြစ်တယ် ဆိုတဲ့ ပုံစံပါ။                                                          | L11–12          |
| latent condition                       | EN          | —                          | ကြာကြာကတည်းက system ထဲမှာ ငြိမ်ငြိမ်လေး ရှိနေပြီး တခြား အချက်တစ်ခုနဲ့ ဆုံမှ ပြဿနာ ဖြစ်လာတဲ့ အားနည်းချက်ပါ။                                                       | L11–12          |
| complex system / emergent behavior     | EN          | —                          | အစိတ်အပိုင်း တစ်ခုချင်းကို ကြည့်ရုံနဲ့ ကြိုမမြင်နိုင်ဘဲ အားလုံး တွဲအလုပ်လုပ်မှ ပေါ်လာတဲ့ အပြုအမူပါ။                                                                            | L11–12 → L13    |
| systems thinking                       | EN          | —                          | အစိတ်အပိုင်း တစ်ခုချင်းထက် အားလုံး ဘယ်လို ဆက်စပ်ပြီး အပြန်အလှန် သက်ရောက်လဲ ဆိုတာကို ကြည့်တဲ့ စဉ်းစားပုံပါ။                                                                  | L09–10 → L13    |
| Safety-I / Safety-II                   | EN          | "Safety One", "Safety Two" | ပျက်တာတွေကို လျှော့ဖို့ပဲ အာရုံစိုက်တာက Safety-I၊ ပုံမှန်အားဖြင့် အဆင်ပြေနေတာ ဘာကြောင့်လဲ ဆိုတာကိုပါ နားလည်ပြီး အားဖြည့်တာက Safety-II ပါ။                                  | L11–12          |
| resilience                             | EN          | —                          | မမျှော်လင့်တဲ့ ပြဿနာ ကြုံရင်တောင် ဆက်အလုပ်လုပ်နိုင်ပြီး မြန်မြန် ပြန်ကောင်းလာနိုင်တဲ့ စွမ်းရည်ပါ။                                                                        | L11–12 → L23–24 |
| drift                                  | EN          | —                          | ပြဿနာ မဖြစ်သေးလို့ ဆိုပြီး လုပ်ငန်းစဉ်တွေ တဖြည်းဖြည်း လျော့ရဲလာပြီး အန္တရာယ် နယ်နိမိတ်ဆီ မသိမသာ ရွေ့သွားတာပါ။                                                         | L11–12          |
| STAMP                                  | EN          | "stamp" (one word)         | accident တွေကို အစိတ်အပိုင်း ပျက်လို့ထက် control မမှန်လို့ ဖြစ်တယ်လို့ ကြည့်တဲ့ safety model ပါ။                                                                     | L13             |
| STPA                                   | EN          | "S-T-P-A"                  | design အဆင့်မှာဖြစ်ဖြစ်၊ run နေတဲ့ system ပေါ်မှာဖြစ်ဖြစ် control structure ကို ဆွဲပြီး ဘယ်လို လုပ်ဆောင်ချက်တွေက loss ဖြစ်စေနိုင်လဲ ကြိုရှာတဲ့ နည်းလမ်းပါ။                    | L13             |
| CAST                                   | EN          | "cast" (one word)          | incident ဖြစ်ပြီးမှ control structure နဲ့ ပြန်ခွဲခြမ်းစိတ်ဖြာပြီး system ထဲက အကြောင်းရင်းတွေကို ရှာတဲ့ နည်းလမ်းပါ။                                               | L02 → L13       |
| loss / hazard                          | EN          | —                          | stakeholder တွေ လက်မခံနိုင်တဲ့ ဆုံးရှုံးမှုက loss၊ loss မဖြစ်သေးပေမဲ့ အဲဒီဆီ ဦးတည်နိုင်တဲ့ အန္တရာယ်ရှိတဲ့ အခြေအနေက hazard ပါ။                                              | L13             |
| control structure                      | EN          | —                          | ဘယ်သူ ဒါမှမဟုတ် ဘာက ဘယ်အရာကို ထိန်းလဲ၊ ဘယ်လို command ပို့ပြီး ဘယ်လို feedback ပြန်ရလဲ ဆိုတာ ဆွဲထားတဲ့ ပုံပါ။                                                            | L13             |
| controller / control action / feedback | EN          | —                          | ထိန်းတဲ့သူ ဒါမှမဟုတ် program က controller၊ သူ ပို့တဲ့ command က control action၊ ရလဒ်ကို ပြန်ပြောပြတဲ့ signal က feedback ပါ။                                   | L13             |
| unsafe control action                  | Full phrase | avoid "U-C-A"              | မှားတဲ့အချိန်မှာ ပို့တာ၊ မပို့သင့်ဘဲ ပို့တာ၊ ပို့သင့်ရဲ့နဲ့ မပို့တာ စတဲ့ အန္တရာယ်ရှိတဲ့ command ပါ။                                                                             | L13             |
| process model / mental model           | EN          | —                          | controller တစ်ခုက ထိန်းနေတဲ့ system အကြောင်း ယုံကြည်ထားတဲ့ ပုံပါ။ လက်တွေ့နဲ့ မကိုက်တော့ရင် မှားတဲ့ ဆုံးဖြတ်ချက် ထွက်လာပါတယ်။                                                | L09–10 → L13    |
| causal scenario                        | EN          | —                          | unsafe control action တစ်ခု ဘယ်လို ဖြစ်လာနိုင်လဲ ဆိုတာကို အဆင့်လိုက် ရှင်းပြတဲ့ ဇာတ်လမ်းပါ။                                                                        | L13             |
| cascading failure                      | EN          | —                          | အစိတ်အပိုင်း တစ်ခု ပျက်တာက နောက်တစ်ခုပေါ် ဝန်ပိုကျပြီး အဲဒါလည်း ပျက်၊ ဒီလို ဆင့်ကဲ ပျက်သွားတာပါ။                                                                     | L01 → L23–24    |
| retry storm                            | EN          | —                          | client တွေ အားလုံး တစ်ပြိုင်နက် ပြန်ကြိုးစားကြလို့ နာနေတဲ့ service ကို ပိုဒုက္ခ ပေးတာပါ။                                                                        | L11–12 → L25    |
| restorative accountability             | EN + gloss  | —                          | အမှားလုပ်မိတဲ့ သူကို အပြစ်ပေးမယ့်အစား ပြင်ဆင်ရေးမှာ ပါဝင်စေပြီး တာဝန်ယူစေတာပါ။ blameless ဆိုတာ ဘယ်သူမှ တာဝန်မရှိဘူးလို့ မဆိုလိုပါဘူး။                                         | L05 → L11       |
| control loop                           | EN + gloss  | —                          | controller တစ်ခုက action လုပ်၊ process ပြောင်း၊ feedback ပြန်ရ၊ ပြီးတော့ အဲဒီ feedback နဲ့ သူ့ယုံကြည်ချက်ကို ပြင်တဲ့ စက်ဝိုင်းပါ။ feedback မှားရင် ယုံကြည်ချက်လည်း မှားပါတယ်။ | L13             |

### 2.6 Automation and toil

| English term                                                   | Keep EN?    | Said as               | Burmese line                                                                                                                                                                                                                                      | First        |
| -------------------------------------------------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| toil                                                           | EN          | "toyl" (one syllable) | လက်နဲ့ လုပ်ရ၊ ထပ်ခါထပ်ခါ လုပ်ရ၊ automate လုပ်လို့ရပေမဲ့ ရေရှည် တန်ဖိုး မပေးတဲ့ ops အလုပ်ပါ။ service ကြီးလာတာနဲ့ အမျှ လိုက်များလာတတ်ပါတယ်။                                                                                                                                           | L01 → L17    |
| automation                                                     | EN          | verb: "automate လုပ်"   | လူက လက်နဲ့ လုပ်နေရတဲ့ အလုပ်ကို software က အစား လုပ်ပေးအောင် လုပ်တာပါ။ ပိုမြန်ရုံတင် မကဘဲ အမြဲ တစ်ပုံစံတည်း လုပ်ပေးလို့ အမှား နည်းပါတယ်။                                                                                                                                                 | L02 → L17    |
| tooling                                                        | EN          | —                     | engineer တွေ အလုပ်လုပ်ဖို့ သုံးတဲ့ tool တွေ စုစုပေါင်းပါ။                                                                                                                                                                                                         | L01 → L17    |
| script                                                         | EN          | —                     | command တွေကို စုရေးထားပြီး တစ်ခါတည်း run လို့ရတဲ့ program အသေးလေးပါ။                                                                                                                                                                                         | L02          |
| dry run                                                        | EN          | —                     | တကယ် မပြောင်းခင် ဘာတွေ ပြောင်းသွားမလဲ ဆိုတာကိုပဲ ပြပေးတဲ့ စမ်း run ပါ။                                                                                                                                                                                           | L17          |
| guardrail                                                      | EN          | —                     | လူ ဒါမှမဟုတ် automation က အန္တရာယ်ရှိတဲ့ နေရာကို မကျော်သွားအောင် ကြိုထားပေးတဲ့ ကန့်သတ်ချက်ပါ။                                                                                                                                                                            | L01 → L25    |
| rate limit                                                     | EN          | —                     | တစ်ချိန်တည်းမှာ ဘယ်လောက် များများ ဒါမှမဟုတ် ဘယ်လောက် မြန်မြန် လုပ်ခွင့်ရှိလဲ ကန့်သတ်ထားတာပါ။                                                                                                                                                                               | L03 → L17    |
| blast radius                                                   | EN          | —                     | တစ်ခုခု မှားသွားရင် ထိခိုက်မယ့် နယ်ပယ် ဘယ်လောက် ကျယ်လဲ ဆိုတာပါ။                                                                                                                                                                                                       | L02          |
| human in the loop                                              | EN          | —                     | automation ဒါမှမဟုတ် AI က အကြံပြုပေမဲ့ အရေးကြီး ဆုံးဖြတ်ချက်ကိုတော့ လူက အတည်ပြုရတဲ့ ပုံစံပါ။                                                                                                                                                                             | L09–10 → L17 |
| least privilege                                                | EN          | —                     | လူ ဒါမှမဟုတ် program တစ်ခုကို အလုပ်လုပ်ဖို့ တကယ် လိုတဲ့ permission လောက်ပဲ ပေးတာပါ။                                                                                                                                                                                     | L17 → L21–22 |
| audit log                                                      | EN          | —                     | ဘယ်သူက ဘယ်အချိန် ဘာလုပ်ခဲ့လဲ ဆိုတာကို ပြင်လို့ မရအောင် မှတ်ထားတဲ့ မှတ်တမ်းပါ။                                                                                                                                                                                               | L09–10 → L17 |
| automation surprise                                            | EN + gloss  | —                     | automation က လူ မမျှော်လင့်ထားတာကို လုပ်လိုက်လို့ လူက ဘာဖြစ်နေလဲ ချက်ချင်း နားမလည် ဖြစ်သွားတာပါ။                                                                                                                                                                         | L17          |
| deskilling / skill erosion                                     | EN + gloss  | —                     | automation က အမြဲ လုပ်ပေးနေလို့ လူတွေ လက်နဲ့ လုပ်တတ်တဲ့ ကျွမ်းကျင်မှု တဖြည်းဖြည်း ပျောက်သွားတာပါ။ automation ပျက်တဲ့နေ့မှာ ပြဿနာ ပေါ်ပါတယ်။                                                                                                                                       | L17 → L26    |
| cognitive load                                                 | EN + gloss  | —                     | တစ်ချိန်တည်းမှာ ခေါင်းထဲ ထည့်ထား၊ စဉ်းစားထားရတဲ့ ဝန်ပါ။                                                                                                                                                                                                        | L03 → L04    |
| self-healing / auto-remediation                                | EN          | —                     | ပြဿနာ တွေ့ရင် လူကို မစောင့်ဘဲ system က ကိုယ်တိုင် ပြင်ပေးတာပါ။                                                                                                                                                                                                    | L15 → L28–29 |
| circuit breaker                                                | EN          | —                     | dependency တစ်ခု ဆက်တိုက် ပျက်နေရင် ခဏ ခေါ်တာ ရပ်ထားပြီး သူ့ကို ပြန်ကောင်းခွင့် ပေးတဲ့ နည်းလမ်းပါ။                                                                                                                                                                        | L01 → L23–24 |
| cron job                                                       | EN          | "kron job"            | သတ်မှတ်ထားတဲ့ အချိန်တိုင်း အလိုအလျောက် run တဲ့ အလုပ်ပါ။                                                                                                                                                                                                            | L17          |
| single point of failure                                        | Full phrase | avoid "S-P-O-F"       | အဲဒါ တစ်ခုတည်း ပျက်ရင် တစ်ခုလုံး ရပ်သွားမယ့် အစိတ်အပိုင်း ဒါမှမဟုတ် လူ ပါ။                                                                                                                                                                                               | L14          |
| ROI                                                            | EN          | "R-O-I"               | အလုပ်တစ်ခုမှာ ထည့်ရတဲ့ အချိန်နဲ့ ငွေထက် ပြန်ရမယ့် အကျိုး ဘယ်လောက် များလဲ ဆိုတာပါ။                                                                                                                                                                                          | L03 → L17    |
| ironies of automation                                          | EN + gloss  | —                     | automation ကောင်းလာလေ လူတွေက ရှားရှားပါးပါး ခက်ခက်ခဲခဲ case တွေအတွက် ကျွမ်းကျင်မှု ဆုံးလေ ဖြစ်တတ်တာပါ။ automation ပျက်ချိန်မှာ လူက ဝင်ယူရတာ လက်နဲ့ အစကနေ လုပ်တာထက် ပိုခက်ပါတယ်။                                                                                                         | L17          |
| toil target                                                    | EN + gloss  | —                     | team ရဲ့ အချိန်ထဲက toil ကို ဘယ်လောက် ရာခိုင်နှုန်းအထိ လျှော့ချမလဲ ဆိုတဲ့ ပန်းတိုင်ပါ၊ Padauk မှာ ၃၅ ရာခိုင်နှုန်းပါ။                                                                                                                                                                | L17          |
| action card (suggests · asks first · acts, then tells · never) | EN + gloss  | —                     | automation ဒါမှမဟုတ် AI agent က လုပ်ခွင့်ရှိတဲ့ action တစ်ခုချင်းကို ရေးထားတဲ့ ကတ်ပါ။ action တစ်ခုစီအတွက် အကြံပဲ ပေးမလား၊ လူ approve လုပ်မှ လုပ်မလား၊ ကိုယ်တိုင် လုပ်ပြီးမှ ပြောမလား၊ လုံးဝ မလုပ်ရဘူးလား ဆိုတာနဲ့ undo လုပ်နည်း၊ ရပ်ရမယ့် အခြေအနေကို ရေးထားပါတယ်။ agent တစ်ခုလုံးကို မဟုတ်ဘဲ action တစ်ခုချင်းကို ဆုံးဖြတ်ပါတယ်။ | L17 → L28    |
| limit of removing toil                                         | MM          | —                     | toil ကို ဘယ်လောက်ပဲ မြန်မြန် ဖယ်ဖယ် အချိန်ပဲ ပြန်ရတာပါ။ ပိုကြီးတဲ့ အကျိုးက AI ကြောင့် တတ်နိုင်လာတဲ့ အလုပ်အသစ်တွေပါ။                                                                                                                                                               | L29          |

### 2.7 Testing and rollouts

| English term                              | Keep EN?    | Said as                            | Burmese line                                                                                                                             | First           |
| ----------------------------------------- | ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| deploy                                    | EN          | verb: "deploy လုပ်"                  | code အသစ်ကို server ပေါ် တင်ပြီး run တာပါ။                                                                                                     | L01             |
| release                                   | EN          | —                                  | user တွေ သုံးလို့ရအောင် version အသစ်ကို ထုတ်ပေးတာပါ။                                                                                                 | L02             |
| launch                                    | EN          | —                                  | product ဒါမှမဟုတ် feature အသစ်ကို user တွေဆီ ပထမဆုံး ထုတ်တာပါ။                                                                                       | L02 → L16       |
| rollout                                   | EN          | "roll out"                         | ပြောင်းလဲမှုကို production ထဲ ဖြန့်တာပါ။                                                                                                          | L01             |
| progressive rollout                       | EN          | —                                  | ပြောင်းလဲမှုကို အားလုံးဆီ တစ်ခါတည်း မပို့ဘဲ 1 ရာခိုင်နှုန်း၊ 10 ရာခိုင်နှုန်း၊ ပြီးမှ အားလုံးဆီ ဆိုပြီး အဆင့်လိုက် ဖြန့်တာပါ။ ပြဿနာ ရှိရင် user နည်းနည်းပဲ ထိပါတယ်။                        | L01 → L02       |
| rollback                                  | EN          | "roll back"; verb: "rollback လုပ်"   | ပြဿနာ ရှိတဲ့ ပြောင်းလဲမှုကို ဖယ်ပြီး အရင်က ကောင်းခဲ့တဲ့ version ကို ပြန်ပြောင်းတာပါ။                                                                           | L01             |
| roll forward / fix forward                | EN          | —                                  | နောက်ပြန် မဆုတ်ဘဲ ပြင်ပြီးသား version အသစ်ကို ဆက်တင်လိုက်တာပါ။                                                                                          | L01 → L26       |
| canary                                    | EN          | "ca-NAIR-ee"                       | version အသစ်ကို traffic အနည်းငယ်ဆီ အရင် ပို့ပြီး version ဟောင်းနဲ့ နှိုင်းယှဉ်ကြည့်ပါတယ်၊ ကောင်းမှ ဆက်ဖြန့်ပါတယ်။                                                     | L04 → L18–19    |
| canary analysis / baseline                | EN          | —                                  | canary နဲ့ version ဟောင်းကို metric အလိုက် နှိုင်းယှဉ်ပြီး ဆက်ဖြန့်မလား ရပ်မလား ဆုံးဖြတ်တာပါ။                                                                  | L18–19          |
| bake time                                 | EN          | —                                  | rollout အဆင့်တစ်ခုနဲ့ တစ်ခုကြားမှာ ပြဿနာ ပေါ်မလား စောင့်ကြည့်ရတဲ့ အချိန်ပါ။                                                                                | L18–19          |
| feature flag                              | EN          | —                                  | code ကို deploy လုပ်ပြီးသားမှာ feature တစ်ခုကို ပြန် deploy မလုပ်ဘဲ ဖွင့်လိုက် ပိတ်လိုက် လုပ်လို့ရတဲ့ ခလုတ်ပါ။                                                             | L02             |
| kill switch (stop button)                 | EN          | —                                  | ပြဿနာ ရှိရင် feature ဒါမှမဟုတ် AI agent ကို ချက်ချင်း ရပ်လိုက်လို့ရတဲ့ ခလုတ်ပါ။ agent ကို production ထဲ မထည့်ခင် အရင်ဆုံး တည်ဆောက်ရပါတယ်။                                 | L17 → L28       |
| CI/CD                                     | EN          | write "CI CD" (see 4.1); "C-I C-D" | code ပြောင်းတိုင်း အလိုအလျောက် build၊ test လုပ်ပြီး production အထိ ပို့ပေးတဲ့ လုပ်ငန်းစဉ်ပါ။                                                                 | L02             |
| pipeline                                  | EN          | —                                  | build၊ test၊ deploy အဆင့်တွေကို အစဉ်လိုက် အလိုအလျောက် ဖြတ်သွားစေတဲ့ လမ်းကြောင်းပါ။                                                                         | L02             |
| config / configuration                    | EN          | —                                  | code မပြောင်းဘဲ system ရဲ့ အပြုအမူကို ပြောင်းလို့ရတဲ့ setting တွေပါ။ config ပြောင်းတာလည်း code ပြောင်းသလောက် အန္တရာယ် ရှိပါတယ်။                                  | L01 → L18–19    |
| config as code / GitOps                   | EN          | "git-ops"                          | config ကို code လိုပဲ Git ထဲ သိမ်း၊ review လုပ်ပြီး Git ကနေ အလိုအလျောက် apply လုပ်တာပါ။                                                                  | L02 → L18–19    |
| code review / pull request                | EN          | PR: "P-R"                          | code ပြောင်းလဲမှုကို merge မလုပ်ခင် တခြားသူက ဖတ်ပြီး စစ်ပေးတာက code review၊ အဲဒီ review အတွက် တင်တဲ့ ပြောင်းလဲမှုက pull request ပါ။                              | L02             |
| unit / integration / end-to-end test      | EN          | —                                  | function တစ်ခုချင်းကို စမ်းတာက unit test၊ အစိတ်အပိုင်းတွေ တွဲအလုပ်လုပ်တာကို စမ်းတာက integration test၊ user လုပ်သလို အစအဆုံး စမ်းတာက end-to-end test ပါ။              | L18–19          |
| smoke test                                | EN          | —                                  | deploy ပြီးတာနဲ့ အခြေခံ အလုပ်တွေ လုပ်နိုင်သေးလား မြန်မြန် စစ်တာပါ။                                                                                      | L18–19          |
| regression                                | EN          | —                                  | အရင်က အလုပ်လုပ်နေတာ ပြောင်းလဲမှုကြောင့် ပျက်သွားတာ ဒါမှမဟုတ် ပိုဆိုးသွားတာပါ။                                                                                 | L18–19          |
| flaky test                                | EN          | —                                  | code မပြောင်းဘဲ တစ်ခါ pass တစ်ခါ fail ဖြစ်နေတဲ့ test ပါ၊ test တွေကို လူတွေ မယုံတော့အောင် လုပ်ပါတယ်။                                                         | L17 → L18–19    |
| hermetic test (repeatable test)           | EN + gloss  | "her-MET-ic"                       | အပြင် system တွေ မလိုဘဲ ကိုယ့်ဘာသာ သီးသန့် run လို့ရတဲ့ test ပါ။                                                                                          | L18–19          |
| mock / fake                               | EN          | "fake server", never server အတု     | test မှာ dependency အစစ်အစား သုံးတဲ့ ကိုယ်စားထိုး အစိတ်အပိုင်းပါ။                                                                                        | L18–19          |
| staging                                   | EN          | —                                  | production နဲ့ ဆင်တူအောင် လုပ်ထားပြီး production မရောက်ခင် စမ်းတဲ့ နေရာပါ။                                                                            | L18–19          |
| testing in production                     | Full phrase | avoid "TiP"                        | ဘယ်လောက် စမ်းစမ်း production မှာပဲ ပေါ်တဲ့ ပြဿနာ ရှိလို့ canary လို ထိန်းချုပ်ထားတဲ့ နည်းနဲ့ production မှာ စမ်းတာပါ။                                               | L18–19          |
| fault injection                           | EN          | verb: "inject လုပ်"                  | system ထဲကို ပျက်စီးမှုတွေ တမင် inject လုပ်ပြီး system က ဘယ်လို တုံ့ပြန်လဲ စမ်းတာပါ။                                                                          | L02 → L18–19    |
| chaos engineering                         | EN          | "KAY-os engineering"               | fault injection ကို စနစ်တကျ ပုံမှန် လုပ်ပြီး system ရဲ့ အားနည်းချက်တွေကို user မတွေ့ခင် ရှာတဲ့ အလေ့အကျင့်ပါ။                                                       | L02 → L18–19    |
| load test                                 | EN          | —                                  | traffic အများကြီးကို တမင် ပို့ပြီး system ဘယ်လောက်အထိ ခံနိုင်လဲ စမ်းတာပါ။                                                                                 | L02 → L20       |
| disaster recovery testing                 | EN          | —                                  | datacenter ဒါမှမဟုတ် region တစ်ခုလုံး ဆုံးရှုံးတာလို ကြီးမားတဲ့ ပြဿနာကို တမင် ဖန်တီးပြီး ပြန်ထူထောင်နိုင်လား စမ်းတာပါ။                                                 | L18–19 → L23–24 |
| fuzzing                                   | EN          | —                                  | ကျပန်း input တွေကို အလိုအလျောက် ထုတ်ပြီး program ပျက်သွားမလား စမ်းတာပါ။                                                                               | L18–19          |
| static analysis                           | EN          | —                                  | code ကို မ run ဘဲ ဖတ်ရုံနဲ့ အမှားတွေကို ရှာပေးတာပါ။                                                                                                   | L05 → L18–19    |
| formal methods / invariant                | EN          | —                                  | ဘယ်အခြေအနေမှာမဆို အမြဲ မှန်နေရမယ့် စည်းမျဉ်းက invariant ပါ၊ formal methods က အဲဒါ တကယ် မှန်လား သင်္ချာနည်းနဲ့ စစ်တာပါ။                                        | L18–19          |
| race condition                            | EN          | —                                  | အလုပ်နှစ်ခု တစ်ပြိုင်နက် run တဲ့အခါ ဘယ်ဟာ အရင် ပြီးလဲ ဆိုတဲ့ အစဉ်ပေါ် မူတည်ပြီး ရလဒ် မှားသွားတာပါ။                                                                   | L18–19          |
| fail open / fail closed                   | EN          | —                                  | တစ်ခုခု ပျက်ရင် ဆက်ခွင့်ပြုထားတာက fail open၊ ပိတ်ထားလိုက်တာက fail closed ပါ။ ဘယ်ဟာ ဘေးကင်းလဲ ဆိုတာ အခြေအနေပေါ် မူတည်ပါတယ်။                                       | L15 → L23–24    |
| safe default                              | EN          | —                                  | ဘာမှ မသတ်မှတ်ထားရင်တောင် ဘေးကင်းတဲ့ ဘက်ကို ရွေးပေးတဲ့ default ပါ။                                                                                       | L18–19          |
| break-glass                               | EN          | —                                  | အရေးပေါ်မှာ ပုံမှန် ကန့်သတ်ချက်တွေကို ကျော်လို့ရတဲ့ လမ်းပါ။ သုံးတိုင်း မှတ်တမ်း ကျန်ပြီး နောက်မှ ပြန်စစ်ပါတယ်။                                                              | L18–19 → L21–22 |
| timeout                                   | EN          | "time out"                         | အဖြေကို ဘယ်လောက်အထိ စောင့်မလဲ ဆိုတဲ့ ကန့်သတ်ချိန်ပါ၊ ကျော်သွားရင် စောင့်တာ ရပ်ပြီး ရှေ့ဆက်ပါတယ်။                                                                     | L18–19 → L23–24 |
| config check (syntax · meaning · dry run) | EN + gloss  | —                                  | config ပြောင်းလဲမှု တစ်ခုကို syntax မှန်လား၊ အဓိပ္ပာယ် မှန်လား (ဥပမာ weight တွေ ပေါင်း 100 ဖြစ်လား)၊ dry run နဲ့ ဘာဖြစ်မလဲ ဆိုတာ အဆင့်သုံးဆင့် စစ်တာပါ။                 | L18             |
| soft dependency                           | EN + gloss  | —                                  | မရှိရင်လည်း အဓိက အလုပ် ဆက်လုပ်နိုင်ရမယ့် dependency ပါ။ ဥပမာ loyalty points မရရင်တောင် checkout ဆက်ဖြစ်ရပါမယ်။                                               | L19             |
| fault experiment                          | EN + gloss  | —                                  | ပုံမှန်အခြေအနေ (steady state) ကို သတ်မှတ်၊ hypothesis ချ၊ fault တစ်ခု inject လုပ်ပြီး ရလဒ်ကို နှိုင်းယှဉ်တဲ့ production ထဲက စမ်းသပ်မှုပါ။ blast radius ကို ကန့်သတ်ထားရပါတယ်။ | L19             |

### 2.8 Capacity

| English term                 | Keep EN?   | Said as                        | Burmese line                                                                                                                                              | First        |
| ---------------------------- | ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| capacity                     | EN         | —                              | system က ခံနိုင်တဲ့ အလုပ်ပမာဏနဲ့ အဲဒီအတွက် ရှိထားတဲ့ စက်၊ resource တွေပါ။                                                                                                     | L01          |
| capacity planning            | EN         | —                              | လာမယ့် demand ကို ခန့်မှန်းပြီး လိုမယ့် resource တွေကို အချိန်မီ ပြင်ဆင်ထားတာပါ။                                                                                               | L01 → L20    |
| demand / supply              | EN         | —                              | user တွေက လိုချင်တဲ့ အလုပ်ပမာဏက demand၊ အဲဒီအတွက် ပေးနိုင်တဲ့ resource က supply ပါ။                                                                                        | L20          |
| forecast                     | EN         | —                              | အရင် data ကနေ နောင်မှာ ဘယ်လောက် လိုမလဲ ခန့်မှန်းတာပါ။                                                                                                                 | L20          |
| organic / inorganic demand   | EN + gloss | —                              | user တွေ တဖြည်းဖြည်း များလာတာက organic၊ campaign ဒါမှမဟုတ် launch ကြောင့် ရုတ်တရက် တက်လာတာက inorganic ပါ။                                                             | L20          |
| peak / spike                 | EN         | —                              | တစ်နေ့ ဒါမှမဟုတ် တစ်နှစ်ထဲမှာ traffic အများဆုံး ဖြစ်တဲ့ အချိန်က peak၊ ရုတ်တရက် ခုန်တက်သွားတာက spike ပါ။                                                                           | L20          |
| headroom / buffer            | EN         | —                              | ပုံမှန် သုံးနေတာထက် ပိုထားတဲ့ အပို capacity ပါ၊ မမျှော်လင့်ဘဲ traffic တက်လာရင် ခံနိုင်အောင်ပါ။                                                                                     | L11–12 → L20 |
| N+1                          | EN         | write "N plus one" (see 4.1)   | လိုအပ်တဲ့ စက် N လုံးအပြင် တစ်လုံး ပိုထားတာပါ၊ တစ်လုံး ပျက်ရင်တောင် လုံလောက်အောင်ပါ။ လူအတွက်လည်း သုံးပါတယ်၊ on-call တာဝန်တစ်ခုချင်း၊ ကျွမ်းကျင်မှုတစ်ခုချင်းအတွက် အနည်းဆုံး လိုတာထက် လူတစ်ယောက် ပိုထားတာပါ။        | L14 → L20    |
| utilization                  | EN         | —                              | ရှိထားတဲ့ resource ထဲက တကယ် သုံးနေတဲ့ ရာခိုင်နှုန်းပါ။                                                                                                                    | L20          |
| provisioning / right-sizing  | EN         | —                              | resource ကို ပြင်ဆင်ပေးတာက provisioning၊ လိုတာထက် အရမ်း မပို၊ အရမ်း မလိုအောင် ညှိတာက right-sizing ပါ။                                                                     | L20          |
| autoscaling                  | EN         | "auto scaling"                 | load အလိုက် စက် အရေအတွက်ကို အလိုအလျောက် တိုးပေး၊ လျှော့ပေးတာပါ။                                                                                                          | L04 → L20    |
| lead time                    | EN         | —                              | resource မှာလိုက်တာကနေ တကယ် သုံးလို့ရတဲ့အထိ ကြာချိန်ပါ။                                                                                                                  | L20          |
| bottleneck                   | EN         | —                              | system တစ်ခုလုံးရဲ့ အမြန်နှုန်းကို ကန့်သတ်ထားတဲ့ အကျဉ်းဆုံး နေရာပါ။                                                                                                           | L20          |
| quota                        | EN         | —                              | တစ်ယောက်ချင်း ဒါမှမဟုတ် service တစ်ခုချင်း သုံးခွင့်ရှိတဲ့ resource အများဆုံး ပမာဏပါ။                                                                                         | L08 → L20    |
| load balancer                | EN         | —                              | ဝင်လာတဲ့ request တွေကို server တွေကြား ခွဲဝေပေးတာပါ၊ server တစ်လုံး ပျက်ရင် ကျန်တာတွေဆီ ပို့ပေးပါတယ်။                                                                          | L01          |
| load shedding                | EN         | —                              | ဝန် ပိုလာရင် system တစ်ခုလုံး မပြိုအောင် အရေးမကြီးတဲ့ request တချို့ကို တမင် ငြင်းလိုက်တာပါ။                                                                                      | L01 → L20    |
| throttling                   | EN         | —                              | client တစ်ခုခုကို ခွင့်ပြုထားတဲ့ နှုန်းထက် ကျော်မပို့နိုင်အောင် နှေးခိုင်းတာ ဒါမှမဟုတ် ငြင်းတာပါ။                                                                                        | L02 → L20    |
| criticality / sheddable      | EN         | —                              | request တစ်ခု ဘယ်လောက် အရေးကြီးလဲ ဆိုတာ tag တပ်ထားတာပါ။ ဝန် ပိုလာရင် အရင် ငြင်းလို့ရတာက sheddable request ပါ။                                                               | L20          |
| graceful degradation         | EN         | —                              | အစိတ်အပိုင်း တချို့ ပျက်ရင် ဒါမှမဟုတ် ဝန် ပိုရင် service တစ်ခုလုံး မရပ်ဘဲ အဓိက လုပ်ဆောင်ချက်တွေကို ဆက်ပေးထားတာပါ၊ ဥပမာ အကြံပြု menu မပြနိုင်ရင်တောင် order တင်လို့ ရနေတာ မျိုးပါ။                      | L02 → L23–24 |
| noisy neighbor               | EN         | —                              | resource မျှသုံးနေတဲ့ တခြား workload တစ်ခုက များများ သုံးလိုက်လို့ ကိုယ့်ဘက်က နှေးသွားတာပါ။                                                                                     | L20          |
| thundering herd              | EN         | —                              | client အများကြီး တစ်ပြိုင်နက် ဝင်လာလို့ service ကို ဖိသွားတာပါ၊ အထူးသဖြင့် service ပြန်တက်လာတဲ့ အချိန်မှာ ဖြစ်တတ်ပါတယ်။                                                              | L20 → L23–24 |
| retry                        | EN         | —                              | မအောင်မြင်တဲ့ request ကို ပြန်ပို့ကြည့်တာပါ။ မဆင်မခြင် လုပ်ရင် ပြဿနာကို ပိုဆိုးစေပါတယ်။                                                                                           | L01          |
| exponential backoff / jitter | EN         | —                              | ပြန်ကြိုးစားတိုင်း စောင့်ချိန်ကို နှစ်ဆစီ တိုးပြီး ကျပန်း အချိန်နည်းနည်း ထည့်တာပါ၊ client တွေ တစ်ပြိုင်နက် ပြန်မဝင်အောင်ပါ။                                                                 | L01 → L20    |
| cold start                   | EN         | —                              | စက် ဒါမှမဟုတ် service အသစ် စတက်ခါစမှာ cache မရှိသေးလို့ ပုံမှန်ထက် နှေးတာပါ။                                                                                                | L20 → L23–24 |
| multitenant                  | EN         | "multi-tenant"                 | customer အများကြီးက system တစ်ခုတည်းကို မျှသုံးတာပါ။                                                                                                               | L17 → L20    |
| FinOps                       | EN         | "fin-ops"                      | cloud ကုန်ကျစရိတ်ကို engineering နဲ့ finance အဖွဲ့ အတူတူ စီမံတဲ့ အလေ့အကျင့်ပါ။                                                                                                | L04 → L20    |
| CPU / GPU / accelerator      | EN         | "C-P-U", "G-P-U"               | GPU နဲ့ accelerator တွေက AI အလုပ်တွေကို မြန်မြန် တွက်ပေးတဲ့ စျေးကြီးတဲ့ chip တွေပါ။                                                                                         | L01 → L20    |
| requests per second          | EN         | prefer the phrase over "Q-P-S" | တစ်စက္ကန့်မှာ ဝင်လာတဲ့ request အရေအတွက်ပါ။                                                                                                                          | L20          |
| spot instance / on-demand    | EN         | —                              | စျေးပေါပေမဲ့ provider က အချိန်မရွေး ပြန်ယူနိုင်တဲ့ စက်က spot instance၊ စျေးပိုကြီးပေမဲ့ လိုတဲ့အချိန် ငှားလို့ရတာက on-demand ပါ။                                                       | L04 → L20    |
| plan of record               | EN + gloss | —                              | wish list နဲ့ မတူဘဲ တကယ် ငွေသုံးပြီး ဝယ်မယ်လို့ သဘောတူထားတဲ့ capacity အစီအစဉ်ပါ။                                                                                             | L20          |
| peak of sums / sum of peaks  | EN + gloss | —                              | team တစ်ခုစီရဲ့ peak တွေကို ပေါင်းတာ (sum of peaks) ထက် ပေါင်းထားတဲ့ traffic ရဲ့ peak (peak of sums) က များသောအားဖြင့် နည်းပါတယ်။ peak တွေ အချိန်မတူရင် shared pool က ငွေသက်သာပါတယ်။ | L20          |
| size the survivors           | MM         | —                              | zone တစ်ခု ပျက်သွားရင် ကျန်တဲ့ zone တွေမှာ load ကို ခံနိုင်လောက်တဲ့ နေရာ ကြိုထားရပါမယ်။                                                                                         | L20          |
| degradation profile          | EN + gloss | —                              | load ဘယ်လောက် ရောက်ရင် ဘာကို အရင် ပိတ်မလဲ၊ ဘာကို ဘယ်တော့မှ မပိတ်ဘူးလဲ (ဥပမာ payment) ဆိုတာ ကြိုရေးထားတဲ့ အစီအစဉ်ပါ။                                                                  | L20 → L24    |
| elasticity                   | EN + gloss | —                              | လိုတဲ့အချိန် capacity ကို မြန်မြန် တိုးလိုက် လျှော့လိုက် လုပ်နိုင်တာပါ။                                                                                                            | L04 → L20    |

### 2.9 Data

| English term                  | Keep EN?    | Said as                              | Burmese line                                                                                                                    | First           |
| ----------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| data integrity                | EN          | —                                    | data မှန်ကန်ပြီး ပြည့်စုံနေတာ၊ မပျက်စီး မပျောက်ဆုံးတာပါ။                                                                                     | L01 → L21–22    |
| backup                        | EN          | verb: "backup ယူ"                     | data ရဲ့ မိတ္တူကို သီးခြားနေရာမှာ သိမ်းထားတာပါ။                                                                                            | L01 → L21–22    |
| restore / restore test        | EN          | —                                    | backup ကနေ data ကို ပြန်ယူတာက restore ပါ။ restore ကို စမ်းမကြည့်ဖူးရင် backup ရှိတယ်လို့ စိတ်ချလို့ မရပါဘူး။                                           | L01 → L21–22    |
| snapshot                      | EN          | —                                    | အချိန် တစ်ခုမှာ data ရဲ့ အခြေအနေကို ဓာတ်ပုံရိုက်သလို မှတ်ထားတာပါ။                                                                                  | L21–22          |
| replication / replica         | EN          | —                                    | data ကို နေရာ အများကြီးမှာ မိတ္တူ ပွားပြီး ထိန်းထားတာက replication၊ အဲဒီ မိတ္တူ တစ်ခုချင်းက replica ပါ။                                            | L21–22          |
| replication lag               | EN          | —                                    | primary မှာ ပြောင်းလိုက်တာ replica ဆီ ရောက်ဖို့ ကြာချိန်ပါ။                                                                                 | L21–22          |
| primary / leader / follower   | EN          | —                                    | write တွေ လက်ခံတဲ့ အဓိက copy က primary ဒါမှမဟုတ် leader၊ သူ့ကို လိုက်ကူးတဲ့ copy တွေက follower ပါ။                                                  | L21–22          |
| failover                      | EN          | "fail over"                          | အဓိက component ပျက်ရင် အရန်ကို ပြောင်းသုံးတာပါ။                                                                                          | L02 → L21–22    |
| split brain                   | EN          | —                                    | node နှစ်ခုလုံးက ကိုယ့်ကိုယ်ကို primary လို့ ထင်ပြီး data ကို သီးခြားစီ ပြင်နေကြတဲ့ အန္တရာယ်ရှိတဲ့ အခြေအနေပါ။                                                   | L21–22          |
| RPO                           | EN          | "R-P-O"                              | ပြဿနာ ဖြစ်ရင် data ဘယ်လောက် ကြာချိန်စာအထိ ဆုံးရှုံးခံနိုင်လဲ ဆိုတာပါ။ disaster အတွက် နံပါတ်ပါ၊ နေ့စဉ် ကျန်းမာရေးကို SLO နဲ့ တိုင်းပါတယ်။                          | L22             |
| RTO                           | EN          | "R-T-O"                              | ပြဿနာ ဖြစ်ပြီး service ပြန်ကောင်းဖို့ ဘယ်လောက်အထိ ကြာခွင့်ရှိလဲ ဆိုတာပါ။ ပျက်ပြီးမှ စရေတွက်တဲ့ disaster နံပါတ်ပါ။                                          | L22             |
| point-in-time recovery        | Full phrase | avoid "P-I-T-R"                      | data ကို ပြဿနာ မဖြစ်ခင် အချိန် တစ်ခုခုရဲ့ အခြေအနေအတိုင်း ပြန်ယူနိုင်တာပါ။                                                                          | L21–22          |
| 3-2-1 rule                    | EN          | "three-two-one rule"                 | မိတ္တူ သုံးခု ထားမယ်၊ သိမ်းတဲ့ ပုံစံ နှစ်မျိုး သုံးမယ်၊ တစ်ခုကို တခြားနေရာမှာ ထားမယ် ဆိုတဲ့ backup စည်းမျဉ်းပါ။                                                  | L21–22          |
| checksum                      | EN          | —                                    | data ပြောင်းသွားလား၊ ပျက်သွားလား စစ်ဖို့ data ကနေ တွက်ထုတ်ထားတဲ့ ကိန်းဂဏန်း လက်မှတ်လေးပါ။                                                           | L21–22          |
| silent data corruption        | Full phrase | avoid "S-D-C"                        | error ဘာမှ မပြဘဲ data တိတ်တိတ်လေး ပျက်သွားတာပါ၊ ကြာမှ သိရတတ်ပါတယ်။                                                                          | L21–22          |
| soft delete / hard delete     | EN          | —                                    | ဖျက်လိုက်ပေမဲ့ ပြန်ယူလို့ရအောင် ခဏ သိမ်းထားတာက soft delete၊ လုံးဝ ဖျက်ပစ်တာက hard delete ပါ။                                                      | L21–22          |
| TTL (time to live)            | EN          | "T-T-L"                              | data ဒါမှမဟုတ် cache တစ်ခု ဘယ်လောက် ကြာရင် သက်တမ်း ကုန်ပြီး ဖျက်မလဲ ဆိုတဲ့ အချိန်ပါ။                                                                 | L18–19 → L21–22 |
| data retention                | EN          | —                                    | data ကို ဘယ်လောက် ကြာကြာ သိမ်းမလဲ၊ ဘယ်တော့ ဖျက်မလဲ ဆိုတဲ့ စည်းမျဉ်းပါ။                                                                           | L21–22          |
| personal data (PII)           | EN          | prefer "personal data"; else "P-I-I" | လူတစ်ယောက်ကို ခွဲခြားသိနိုင်တဲ့ data ပါ၊ ဥပမာ နာမည်၊ ဖုန်းနံပါတ်၊ NRC နံပါတ်ပါ။                                                                     | L06–07 → L21–22 |
| data residency                | EN + gloss  | —                                    | user data ကို သတ်မှတ်ထားတဲ့ နိုင်ငံ ဒါမှမဟုတ် region ထဲမှာပဲ ထားရမယ် ဆိုတဲ့ လိုအပ်ချက်ပါ။                                                                 | L04 → L21–22    |
| encryption key                | EN          | —                                    | data ကို encrypt လုပ်ပြီး ပြန်ဖွင့်ဖို့ သုံးတဲ့ သော့ပါ။ key ပျောက်ရင် data ပါ ပျောက်သလို ဖြစ်ပါတယ်။                                                     | L21–22 → L23–24 |
| original / derived data       | EN          | —                                    | user ဆီက တိုက်ရိုက် ရလာတဲ့ data က original၊ အဲဒီကနေ တွက်ထုတ်ထားလို့ ပြန်ထုတ်လို့ရတာက derived data ပါ။ original ကို ပိုအလေးထားပြီး ကာကွယ်ရပါမယ်။                 | L21–22          |
| reconciliation                | EN          | —                                    | system နှစ်ခုက data ကိုက်ညီလား နှိုင်းယှဉ်ပြီး မကိုက်တာကို ရှာ၊ ပြင်တာပါ၊ ဥပမာ wallet balance နဲ့ ledger ကို တိုက်စစ်တာပါ။                                   | L18–19 → L21–22 |
| idempotency / idempotency key | EN          | "eye-dem-POH-ten-see"                | တူညီတဲ့ request ကို ဘယ်နှခါ ပို့ပို့ ရလဒ်က တစ်ခါပဲ ဖြစ်တာပါ၊ ဥပမာ ငွေချေ ခလုတ်ကို နှစ်ခါ နှိပ်မိရင်တောင် ငွေ တစ်ခါပဲ ဖြတ်တာပါ။                                     | L05 → L13       |
| entrusted data                | MM          | —                                    | user တွေက ယုံကြည်ပြီး အပ်ထားတဲ့ data ပါ။ outage လို ပြန်စလို့ မရတဲ့အတွက် ပိုဂရုစိုက်ရပါတယ်။                                                              | L21             |
| reconciliation vs repair      | EN + gloss  | —                                    | data နှစ်ခုကို နေ့တိုင်း တိုက်စစ်တာ (reconciliation) က ပုံမှန် အလုပ်ပါ။ bug ကြောင့် ပြင်ရတာ (repair) ကိုတော့ log ထားပြီး ပထမဆုံး တစ်ခုမှာကတည်းက alert ပေးရပါမယ်။ | L21             |
| restore drill                 | EN + gloss  | —                                    | backup ကို အချိန်ဇယားနဲ့ တကယ် restore လုပ်ကြည့်ပြီး ကြာချိန်နဲ့ data မှန်လား စစ်တာပါ။                                                              | L22             |
| known-good copy               | MM          | —                                    | config၊ data၊ binary တွေရဲ့ ကာကွယ်ထားတဲ့ ကောင်းမှန်းသိတဲ့ မိတ္တူပါ။ ပြောင်းလဲမှုတွေကို နောက်ဆုံးမှ လက်ခံပါတယ်။                                                | L23             |

### 2.10 Resilience

| English term               | Keep EN?   | Said as                     | Burmese line                                                                                                                             | First        |
| -------------------------- | ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| failure domain             | EN         | —                           | ပြဿနာ တစ်ခုတည်းကြောင့် အတူတူ ပျက်သွားနိုင်တဲ့ အစိတ်အပိုင်း အုပ်စုပါ၊ ဥပမာ zone တစ်ခု၊ rack တစ်ခု ပါ။                                                               | L01 → L23–24 |
| redundancy                 | EN         | —                           | တစ်ခု ပျက်ရင် အစားထိုးနိုင်အောင် အပို ထပ်ထားတာပါ။ အပိုတွေက failure domain မတူမှ အသုံးဝင်ပါတယ်။                                                                 | L03 → L23–24 |
| fallback                   | EN         | —                           | အဓိက လမ်း မရရင် သုံးဖို့ ကြိုပြင်ထားတဲ့ အရန်လမ်းပါ။ ပုံမှန် စမ်းမထားရင် လိုတဲ့နေ့မှာ အလုပ်မလုပ်တတ်ပါဘူး။                                                                  | L01 → L23–24 |
| cell / shard               | EN         | —                           | user ဒါမှမဟုတ် data ကို သီးခြား အုပ်စုလေးတွေ ခွဲထားတာပါ၊ တစ်ခု ပျက်ရင် တစ်ပိုင်းပဲ ထိအောင်ပါ။                                                                   | L23–24       |
| overload                   | EN         | —                           | system ဆီ ခံနိုင်တာထက် ပိုတဲ့ အလုပ် ရောက်လာတာပါ။                                                                                                      | L20 → L23–24 |
| retry budget               | EN         | —                           | retry ကို ဘယ်လောက်အထိပဲ ခွင့်ပြုမလဲ ဆိုတဲ့ ကန့်သတ်ချက်ပါ၊ retry storm မဖြစ်အောင်ပါ။                                                                           | L23–24 → L25 |
| goodput                    | EN         | "good put"                  | throughput ထဲမှာ user အတွက် တကယ် အသုံးဝင်ပြီး အောင်မြင်တဲ့ အလုပ် ပမာဏပါ။                                                                                | L23–24 → L27 |
| query of death             | EN         | —                           | ပို့လိုက်တိုင်း server ကို crash ဖြစ်စေတဲ့ request မျိုးပါ။ retry လုပ်ရင် server တွေ တစ်လုံးပြီး တစ်လုံး ပျက်ကုန်နိုင်ပါတယ်။                                               | L23–24       |
| change freeze              | EN         | —                           | အန္တရာယ်များတဲ့ ကာလမှာ production ပြောင်းလဲမှုတွေကို ခဏ ရပ်ထားတာပါ။                                                                                   | L16 → L23–24 |
| risk register (risk sheet) | EN         | —                           | ဖြစ်နိုင်တဲ့ risk တွေ၊ ဘယ်လောက် ဖြစ်နိုင်လဲ၊ ဖြစ်ရင် ဘယ်လောက် ထိခိုက်မလဲ ဆိုတာကို စာရင်း လုပ်ထားတာပါ။ Padauk မှာ postmortem နဲ့ near miss တွေကနေ Thiri ရေးတဲ့ risk sheet ပါ။ | L01 → L32    |
| tabletop exercise          | EN         | —                           | တကယ် မပျက်စေဘဲ စားပွဲဝိုင်းမှာ ထိုင်ပြီး ဒါဖြစ်ရင် ဘာလုပ်မလဲလို့ အဆင့်လိုက် ဆွေးနွေး လေ့ကျင့်တာပါ။                                                                      | L23–24       |
| disaster recovery          | EN         | "D-R" after the full phrase | datacenter ဒါမှမဟုတ် region တစ်ခုလုံး ဆုံးရှုံးတာလို ကြီးမားတဲ့ ပြဿနာကနေ ပြန်ထူထောင်နိုင်ဖို့ ပြင်ဆင်ထားတာပါ။                                                        | L04 → L23–24 |
| drain                      | EN         | verb: "drain လုပ်"            | cluster ဒါမှမဟုတ် server တစ်ခုဆီ traffic မပို့တော့ဘဲ တခြားနေရာကို လွှဲလိုက်တာပါ။                                                                            | L09–10       |
| traffic shift              | EN         | —                           | traffic ကို နေရာ တစ်ခုကနေ တစ်ခုကို လွှဲပြောင်းတာပါ။                                                                                                  | L09–10       |
| emergency stop             | EN         | —                           | automation ဒါမှမဟုတ် rollout တစ်ခုကို ချက်ချင်း ရပ်ပစ်နိုင်တဲ့ ခလုတ်ပါ။                                                                                    | L23–24       |
| serial dependency          | EN + gloss | —                           | request တစ်ခုက အစဉ်လိုက် ခေါ်ရတဲ့ dependency တွေပါ။ availability တွေ မြှောက်ရလို့ တစ်ခုချင်းထက် နိမ့်သွားပါတယ်။                                                   | L23          |
| bad input                  | EN + gloss | —                           | ပုံမှန်နဲ့ မတူတဲ့ ဒါမှမဟုတ် မှားနေတဲ့ input ပါ၊ ဥပမာ တစ်ဝက်ပဲ ရေးထားတဲ့ price list။ server တိုင်းက ယုံလိုက်ရင် နေရာတိုင်း ပျက်နိုင်ပါတယ်။                                     | L23          |
| adaptive throttling        | EN + gloss | —                           | မကြာခင်က ခေါ်တာ အများစု fail ဖြစ်နေရင် client က request အသစ်တွေကို ကိုယ်တိုင် လျှော့ပို့ပြီး အရေးကြီးတာတွေပဲ ထားတာပါ။                                            | L24          |
| change rule                | MM         | —                           | error budget နည်းနေချိန်၊ payday ရက်သတ္တပတ်၊ Thingyan မတိုင်ခင်နဲ့ incident ကြီး ဖြစ်နေချိန်မှာ ပြောင်းလဲမှုတိုင်းကို ပိုတင်းကျပ်စွာ စစ်တဲ့ Padauk ရဲ့ စည်းကမ်းပါ။             | L24          |
| emergency kit              | MM         | —                           | login၊ chat၊ wiki လို ကိုယ့် tool တွေပါ ပျက်သွားချိန်အတွက် ကြိုပြင်ထားတဲ့ break-glass key၊ phone bridge၊ offline runbook တွေပါ။                             | L24          |

### 2.11 Platforms

| English term                           | Keep EN?   | Said as     | Burmese line                                                                                                   | First     |
| -------------------------------------- | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| platform                               | EN         | —           | developer တွေ ကိုယ်တိုင် service တွေ ဆောက်၊ run နိုင်အောင် ဘုံ tool တွေနဲ့ လမ်းကြောင်းတွေကို ပေါင်းပေးထားတဲ့ အခြေခံ အလွှာပါ။                | L01 → L25 |
| platform engineering                   | EN         | —           | အဲဒီ platform ကို developer တွေကို user အဖြစ် သဘောထားပြီး product တစ်ခုလို ဆောက်၊ ထိန်းတဲ့ အလုပ်ပါ။                                | L01 → L25 |
| internal developer platform            | EN         | —           | ကုမ္ပဏီ အတွင်းက developer တွေ သုံးဖို့ ဆောက်ထားတဲ့ platform ပါ။                                                              | L04 → L25 |
| golden path / paved road               | EN         | —           | platform က အကောင်းဆုံး ထောက်ပံ့ထားတဲ့ standard လမ်းပါ။ အဲဒီလမ်းအတိုင်း သွားရင် reliability အများစု အလိုလို ပါလာပါတယ်။                 | L01 → L25 |
| escape hatch                           | EN         | —           | golden path နဲ့ မကိုက်တဲ့ အထူး လိုအပ်ချက် ရှိရင် ခွင့်ပြုချက်နဲ့ ထွက်လို့ရတဲ့ လမ်းပါ။                                                        | L25       |
| desire path                            | EN + gloss | —           | developer တွေ တကယ်တမ်း သွားနေကြတဲ့ လမ်းပါ၊ platform က ဘယ်ကို ပြင်ရမလဲ ဆိုတာကို ပြနေပါတယ်။                                       | L25       |
| self-service                           | EN         | —           | ticket တင်ပြီး တခြားအဖွဲ့ကို မစောင့်ဘဲ developer ကိုယ်တိုင် လုပ်လို့ရတာပါ။                                                          | L04 → L25 |
| default / strong default               | EN         | —           | ဘာမှ မပြင်ရင် ရမယ့် setting ပါ။ default ကောင်းရင် လူအများစုက ပြင်စရာ မလိုပါဘူး။                                             | L25       |
| policy as code                         | EN         | —           | စည်းမျဉ်းတွေကို စာရွက်ပေါ်မှာ မထားဘဲ code နဲ့ ရေးပြီး အလိုအလျောက် စစ်ခိုင်းတာပါ။                                                   | L04 → L25 |
| scorecard                              | EN         | —           | service တစ်ခုချင်းက best practice တွေကို ဘယ်လောက် လိုက်နာထားလဲ အမှတ်ပေး ပြတဲ့ စာရင်းပါ။                                         | L15 → L25 |
| template                               | EN         | —           | service အသစ် စဆောက်ရင် ကောင်းတဲ့ setting တွေ ပါပြီးသား ပုံစံပါ။                                                           | L04 → L25 |
| abstraction                            | EN         | —           | အသေးစိတ် ရှုပ်ထွေးမှုတွေကို ဖုံးပြီး ရိုးရှင်းတဲ့ interface ပဲ ပြပေးတာပါ။                                                           | L25       |
| client library / application framework | EN         | —           | service တိုင်း ကိုယ်တိုင် မရေးရအောင် retry၊ timeout လို ဘုံ အလုပ်တွေကို ထည့်ပေးထားတဲ့ code ပါ။                                        | L25       |
| migration                              | EN         | —           | system ဟောင်းကနေ အသစ်ကို ပြောင်းရွှေ့တာပါ။                                                                             | L25       |
| large-scale change                     | EN         | —           | codebase တစ်ခုလုံး ဒါမှမဟုတ် service အများကြီးကို တစ်ပြိုင်နက် ပြောင်းရတဲ့ အလုပ်ပါ။                                                | L25       |
| monorepo                               | EN         | "mono-repo" | ကုမ္ပဏီရဲ့ code အားလုံး ဒါမှမဟုတ် အများစုကို repository တစ်ခုတည်းမှာ ထားတာပါ။                                                   | L04 → L25 |
| service catalog                        | EN         | —           | service တိုင်းရဲ့ owner၊ အရေးပါမှု၊ dependency တွေကို စာရင်းလုပ်ထားတဲ့ နေရာပါ။                                                | L32       |
| exemption (with expiry)                | EN + gloss | —           | platform rule ကို ယာယီ မလိုက်နာခွင့် ပေးထားတာပါ။ ပိုင်ရှင်၊ အကြောင်းပြချက်၊ ကုန်ဆုံးရက် ပါပြီး exception စာရင်းတစ်ခုထဲမှာ အားလုံး ထားရပါတယ်။ | L25       |
| right-sized control                    | MM         | —           | အမှား ဖြစ်ရင် ဘယ်လောက် ထိခိုက်မလဲ ဆိုတာနဲ့ ကိုက်ညီအောင် စစ်ဆေးမှုရဲ့ တင်းကျပ်မှုကို ချိန်ညှိတာပါ (Playground၊ Light၊ Standard၊ Strict)။          | L25       |

### 2.12 Organization, culture and careers

| English term                                 | Keep EN?    | Said as                                            | Burmese line                                                                                                                                                                                             | First        |
| -------------------------------------------- | ----------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| culture                                      | MM          | "ယဉ်ကျေးမှု"                                          | အဖွဲ့ထဲက လူတွေ ဘယ်လို စဉ်းစား၊ ဘယ်လို ပြုမူ၊ ဘာကို တန်ဖိုးထားလဲ ဆိုတာပါ။                                                                                                                                                        | L02 → L05    |
| pathological / bureaucratic / generative     | EN + gloss  | —                                                  | အာဏာနဲ့ အပြစ်ရှာတာကို ဦးစားပေးတာက pathological၊ စည်းမျဉ်းနဲ့ ဌာန နယ်နိမိတ်ကို ဦးစားပေးတာက bureaucratic၊ ရလဒ်နဲ့ သတင်း ပွင့်ပွင့်လင်းလင်း စီးဆင်းတာကို ဦးစားပေးတာက generative ယဉ်ကျေးမှုပါ။                                                  | L05          |
| DORA                                         | EN          | "Dora" (one word)                                  | software delivery နဲ့ operations ဘယ်လောက် ကောင်းလဲ တိုင်းတဲ့ နှစ်စဉ် သုတေသနနဲ့ အဲဒီက metric တွေပါ။                                                                                                                           | L03 → L05    |
| engagement model                             | EN          | —                                                  | SRE အဖွဲ့က product team တွေနဲ့ ဘယ်လို ပုံစံနဲ့ တွဲလုပ်မလဲ ဆိုတဲ့ သဘောတူညီချက်ပါ။                                                                                                                                                   | L01 → L16    |
| centralized / decentralized / hybrid         | EN          | —                                                  | SRE အားလုံး အဖွဲ့ တစ်ခုတည်းမှာ ရှိတာက centralized၊ product team တွေထဲ ခွဲထားတာက decentralized၊ နှစ်မျိုး ရောထားတာက hybrid ပါ။                                                                                               | L15          |
| embedded SRE                                 | EN          | —                                                  | SRE တစ်ယောက်က product team ထဲမှာ ဝင်ပြီး နေ့စဉ် အတူ လုပ်တာပါ။                                                                                                                                                       | L15 → L16    |
| consulting / office hours                    | EN          | —                                                  | product team တွေ လိုတဲ့အခါ SRE ဆီ လာမေးလို့ရတဲ့ အကြံပေး ပုံစံပါ။                                                                                                                                                        | L16          |
| production readiness review                  | Full phrase | "P-R-R" only on slides                             | service အသစ်ကို launch မလုပ်ခင် monitoring၊ on-call၊ capacity စတာတွေ အသင့် ဖြစ်ပြီလား စစ်တဲ့ review ပါ။                                                                                                                | L16          |
| design review / launch review                | EN          | —                                                  | design အဆင့်မှာ ဒါမှမဟုတ် launch မလုပ်ခင် reliability ဘက်က စစ်ပေးတဲ့ review ပါ။                                                                                                                                       | L16          |
| handback                                     | EN          | —                                                  | on-call တာဝန်ကို product team ဆီ ပြန်လွှဲပေးတာပါ။ အများအားဖြင့် ကြိုစီစဉ်ထားတဲ့ handback ပါ၊ service တည်ငြိမ်သွားပြီး engagement ပြီးချိန်မှာ ရက်စွဲ၊ runbook၊ training နဲ့အတူ ပြန်ပေးတာပါ။ service က SLO ကို ထပ်ခါထပ်ခါ မမီရင်လည်း ပြန်လွှဲတတ်ပါတယ်။ | L03 → L16    |
| Conway's law                                 | EN          | "CON-way's law"                                    | အဖွဲ့အစည်း ဆက်သွယ်ပုံအတိုင်း system ရဲ့ ဖွဲ့စည်းပုံ ထွက်လာတတ်တယ် ဆိုတဲ့ ဥပဒေသပါ။                                                                                                                                                     | L15          |
| charter                                      | EN          | —                                                  | အဖွဲ့ရဲ့ ရည်ရွယ်ချက်၊ တာဝန် နယ်ပယ်၊ မလုပ်မယ့် အရာတွေနဲ့ ရက်စွဲပါတဲ့ တိုင်းတာလို့ရတဲ့ အောင်မြင်မှု စံတွေကို ရေးထားတဲ့ စာတမ်းပါ။                                                                                                                      | L15          |
| OKR / KPI                                    | EN          | "O-K-R", "K-P-I"                                   | အဖွဲ့ရဲ့ ရည်မှန်းချက်နဲ့ တိုင်းမယ့် ရလဒ်တွေက OKR၊ အဓိက တိုင်းတဲ့ ကိန်းဂဏန်းက KPI ပါ။                                                                                                                                                | L02 → L15    |
| headcount                                    | EN          | —                                                  | အဖွဲ့မှာ ခန့်ခွင့်ရှိတဲ့ လူ အရေအတွက်ပါ။                                                                                                                                                                                  | L01 → L16    |
| tech lead / manager / individual contributor | EN          | never "I-C" here (clashes with incident commander) | နည်းပညာဘက် ဦးဆောင်သူက tech lead၊ လူတွေကို စီမံသူက manager၊ လူ မစီမံဘဲ ကိုယ်တိုင် engineering လုပ်သူက individual contributor ပါ။                                                                                                  | L14          |
| onboarding                                   | EN          | —                                                  | လူသစ်ကို အဖွဲ့နဲ့ system တွေ နားလည်ပြီး အလုပ်လုပ်နိုင်အောင် လမ်းပြတာပါ။                                                                                                                                                       | L05 → L14    |
| mentor / buddy                               | EN          | —                                                  | လူသစ်ကို ရေရှည် လမ်းညွှန်ပေးသူက mentor၊ နေ့စဉ် မေးစရာ ရှိရင် မေးလို့ရတဲ့ အဖော်က buddy ပါ။                                                                                                                                      | L14          |
| T-shaped                                     | EN + gloss  | "T shaped"                                         | နယ်ပယ် တစ်ခုမှာ နက်နက်နဲနဲ ကျွမ်းကျင်ပြီး တခြား နယ်ပယ်တွေကိုလည်း ကျယ်ကျယ်ပြန့်ပြန့် သိတဲ့ ကျွမ်းကျင်မှု ပုံစံပါ။                                                                                                                             | L14          |
| non-abstract large system design             | Full phrase | never the acronym                                  | system ကြီး တစ်ခုကို ပုံကြမ်း ဆွဲရုံ မဟုတ်ဘဲ စက် ဘယ်နှလုံး၊ network ဘယ်လောက် လိုမလဲ ဆိုတာကို တကယ့် ကိန်းဂဏန်းနဲ့ တွက်ပြတဲ့ လေ့ကျင့်ခန်းပါ။                                                                                                           | L14          |
| career ladder                                | EN          | —                                                  | အဆင့်တစ်ခုချင်းမှာ ဘာတွေ လုပ်တတ်ရမလဲ ရေးထားတဲ့ ရာထူး တိုးတက်မှု လမ်းကြောင်းပါ။                                                                                                                                                | L14          |
| silo / knowledge silo                        | EN          | —                                                  | အချက်အလက် ဒါမှမဟုတ် အသိပညာက အဖွဲ့ တစ်ဖွဲ့ ဒါမှမဟုတ် လူ တစ်ယောက်ဆီမှာပဲ ပိတ်မိနေတာပါ။                                                                                                                                              | L05 → L14    |
| bus factor                                   | EN          | —                                                  | ဘယ်နှယောက် ထွက်သွားရင် အဖွဲ့ ဆက်မလုပ်နိုင်တော့ဘူး ဆိုတဲ့ အရေအတွက်ပါ။ တစ်ယောက်ပဲ ဆိုရင် အန္တရာယ် များပါတယ်။                                                                                                                                | L30–31       |
| heroics (hero antipattern)                   | EN          | —                                                  | လူ တစ်ယောက်ချင်းရဲ့ ညဘက် အချိန်ပို ကြိုးစားမှုကို အားကိုးပြီး system ကို ရပ်တည်အောင် ထားရတာပါ။ ရေရှည် မခံပါဘူး။                                                                                                                       | L05          |
| maturity model                               | EN          | —                                                  | အဖွဲ့ ဒါမှမဟုတ် အလေ့အကျင့် တစ်ခု ဘယ်အဆင့် ရောက်နေလဲ၊ နောက် ဘာလုပ်ရမလဲ ဆိုတာ အဆင့်လိုက် ခွဲပြထားတာပါ။                                                                                                                                  | L05 → L28–29 |
| legacy                                       | EN          | —                                                  | အရင်ကတည်းက ရှိနေပြီး ပြင်ရ၊ ပြောင်းရ ခက်ပေမဲ့ business အတွက် အရေးကြီးနေဆဲ system ပါ။                                                                                                                                   | L15 → L30–31 |
| vendor / third-party                         | EN          | —                                                  | ကိုယ်တိုင် မဆောက်ဘဲ ပြင်ပ ကုမ္ပဏီဆီက ဝယ်သုံး ဒါမှမဟုတ် ငှားသုံးတဲ့ software ဒါမှမဟုတ် service ပါ။                                                                                                                                   | L04 → L30–31 |
| compliance / regulator                       | EN          | —                                                  | ဥပဒေနဲ့ စည်းမျဉ်းတွေကို လိုက်နာကြောင်း သက်သေပြနိုင်တာက compliance၊ အဲဒါကို စစ်တဲ့ အစိုးရ ဒါမှမဟုတ် အဖွဲ့က regulator ပါ။                                                                                                               | L04 → L30–31 |
| two-person rule                              | EN          | —                                                  | အန္တရာယ်ရှိတဲ့ ပြောင်းလဲမှုကို လူ နှစ်ယောက် အတည်ပြုမှ လုပ်လို့ရတဲ့ စည်းမျဉ်းပါ။                                                                                                                                                      | L30–31       |
| weaponized blamelessness                     | EN + gloss  | name it once, then explain                         | blameless ဆိုတဲ့ စကားကို တာဝန်ယူမှုကနေ ရှောင်ဖို့ ဒါမှမဟုတ် ပြဿနာကို ဖုံးဖို့ အလွဲသုံးတာပါ။                                                                                                                                           | L30–31       |
| NOC                                          | EN          | "nock"; "network operations center" the first time | screen တွေ ရှေ့မှာ ထိုင်ပြီး system တွေကို အချိန်ပြည့် စောင့်ကြည့်တဲ့ အဖွဲ့ ဒါမှမဟုတ် အခန်းပါ။                                                                                                                                       | L30–31       |
| feedback loop                                | EN          | —                                                  | လုပ်လိုက်တဲ့ အရာရဲ့ ရလဒ်ကို ပြန်သိရပြီး နောက်တစ်ခါ ပိုကောင်းအောင် ပြင်နိုင်တဲ့ စက်ဝိုင်းပါ။ မြန်လေ သင်ယူနိုင်လေ ပါ။                                                                                                                           | L15          |
| starter project                              | EN + gloss  | —                                                  | အသစ်ဝင်လာသူ ပထမဆုံး ယူလုပ်တဲ့ project ပါ၊ Padauk မှာ Ko Min ရဲ့ operator dashboard လိုမျိုးပါ။                                                                                                                            | L14          |
| planned work vs interruptions                | MM          | —                                                  | ကြာရှည် တန်ဖိုးရှိတဲ့ project အလုပ်နဲ့ page၊ ticket၊ review လို ကြားဖြတ်ဝင်လာတဲ့ အလုပ်ကို ခွဲကြည့်တာပါ။ ကြားဖြတ်အလုပ်ကို အချိန်ရဲ့ တစ်ဝက်အောက်မှာ ထားပါတယ်။                                                                                       | L14          |
| limits on ops work (a ceiling, not a target) | MM          | —                                                  | ops အလုပ်က လူတစ်ယောက်ရဲ့ အချိန် တစ်ဝက်ထက် မကျော်ရ၊ on-call က လေးပုံတစ်ပုံထက် မကျော်ရ ဆိုတဲ့ အမြင့်ဆုံး ကန့်သတ်ချက်ပါ။ ပန်းတိုင် မဟုတ်ပါဘူး၊ ကောင်းတဲ့ team တွေက အများကြီး အောက်မှာ ရှိပါတယ်။                                                              | L03 → L15    |
| shadow SRE                                   | EN + gloss  | —                                                  | တရားဝင် SRE အကူအညီ နှေးလို့ team တစ်ခုက ကိုယ်ပိုင် ops လူ၊ ကိုယ်ပိုင် tool တွေကို တိတ်တိတ်လေး ထားလုပ်တဲ့ ညှိနှိုင်းမှုမရှိတဲ့ reliability အလုပ်ပါ။                                                                                                      | L15          |
| outcome (in an engagement)                   | MM          | —                                                  | SRE နဲ့ product team တို့ အတူ ရယူမယ့် ရလဒ်ပါ၊ ဥပမာ pending မှာ ပိတ်မိနေတဲ့ ငွေပေးချေမှု မရှိရ။ pager ကိုင်ပေးတာထက် ရလဒ်ကို ဦးစားပေးပါတယ်။                                                                                             | L16          |
| shared on-call                               | MM          | —                                                  | SRE နဲ့ developer တွေ on-call ကို ခွဲယူတာပါ၊ ဥပမာ app page တွေ developer ဆီ၊ shared database page တွေ SRE ဆီ။                                                                                                        | L16          |
| always-on basics                             | MM          | —                                                  | effort ဘာမှ မချထားတဲ့ team တွေပါ အမြဲ ရနိုင်တဲ့ SRE အကူအညီတွေပါ၊ postmortem review၊ office hours၊ incident ကြီးမှာ ကူညီတာမျိုးပါ။                                                                                           | L16          |
| brownfield / greenfield                      | EN + gloss  | —                                                  | brownfield က ရှိပြီးသား system ပေါ်မှာ စတင်တာ၊ greenfield က အသစ် design ကစပြီး reliability ကို ထည့်တည်ဆောက်တာပါ။                                                                                                       | L06 → L16    |
| nonfunctional requirement                    | Full phrase | —                                                  | ဘာလုပ်လဲ မဟုတ်ဘဲ ဘယ်လောက် ကောင်းကောင်း လုပ်လဲ ဆိုတဲ့ လိုအပ်ချက်တွေပါ၊ မြန်နှုန်း၊ စိတ်ချရမှု၊ လုံခြုံရေး စသဖြင့်ပါ။                                                                                                                          | L16          |
| executive sponsor                            | EN + gloss  | —                                                  | SRE ပြောင်းလဲမှုကို ထောက်ခံပြီး အချိန်နဲ့ ရင်းမြစ် ပေးတဲ့ အထက်ပိုင်း ခေါင်းဆောင်ပါ၊ Padauk မှာ Ko Nay Lin ပါ။                                                                                                                    | L05 → L31    |
| ordered priority list                        | MM          | —                                                  | လုပ်မယ့် အလုပ်တွေကို အစီအစဉ်တကျ စီပြီး လူတိုင်း မြင်အောင် ထားတဲ့ စာရင်းပါ။ အသစ်တစ်ခု ဝင်ရင် တစ်ခု ထွက်ရပါတယ်။                                                                                                                            | L30          |
| repeat fire                                  | MM          | —                                                  | ထပ်ခါထပ်ခါ ပြန်ပြန်ဖြစ်နေတဲ့ outage ပါ၊ ပထမဆုံး SRE က အရင်ဆုံး ငြိမ်းရမယ့် မီးပါ။                                                                                                                                         | L30          |
| toil audit                                   | EN + gloss  | —                                                  | toil ဘယ်လောက် ရှိလဲ အလုပ်လုပ်တဲ့ သူတွေနဲ့ အတူ နာရီ၊ incident အရေအတွက်နဲ့ တိုင်းကြည့်တာပါ။ complaint ကို business case ဖြစ်အောင် ပြောင်းပေးပါတယ်။                                                                                         | L17 → L31    |
| anticorruption layer                         | EN + gloss  | —                                                  | ပြင်လို့မရတဲ့ အဟောင်း system ဒါမှမဟုတ် vendor system ရှေ့မှာ ကိုယ်ပိုင် gateway တစ်ခု ထားပြီး timeout၊ queue၊ metric၊ check တွေနဲ့ ကာကွယ်တဲ့ အလွှာပါ။                                                                                   | L31          |
| one SLO report                               | MM + "SLO"  | —                                                  | monitoring system အမျိုးမျိုးကနေ ဖတ်ပြီး service အားလုံးရဲ့ SLO ကို တစ်နေရာတည်းမှာ ပြတဲ့ report ပါ။ အသင်းအဖွဲ့ တစ်ခုချင်းကို အတင်း မပြောင်းခိုင်းဘဲ SRE ကို ဖြန့်တဲ့ နည်းပါ။                                                                    | L31          |
| generalist (SRE)                             | EN + gloss  | —                                                  | နယ်ပယ် တစ်ခုတည်းမှာ နက်တာထက် system အများကြီးကို principle တွေနဲ့ ကြည့်ပြီး agent တွေကို လမ်းညွှန်နိုင်တဲ့ SRE ပါ။                                                                                                                    | L32          |

### 2.13 AI

| English term                          | Keep EN?          | Said as                                          | Burmese line                                                                                                                                    | First           |
| ------------------------------------- | ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| AI                                    | EN                | "A-I"                                            | လူလို စဉ်းစား၊ ဆုံးဖြတ်ရတဲ့ အလုပ်မျိုးကို software က လုပ်ပေးနိုင်တဲ့ နည်းပညာပါ။                                                                                        | L01             |
| LLM                                   | EN                | "L-L-M"                                          | စာသား အများကြီးနဲ့ train ထားလို့ စာသားကို နားလည်ပြီး ပြန်ရေးပေးနိုင်တဲ့ AI model ပါ။                                                                            | L09–10 → L26    |
| model / training / inference          | EN                | —                                                | model ကို data နဲ့ သင်ပေးတာက training၊ train ပြီးသား model ကို request တစ်ခုချင်းအတွက် run ပြီး အဖြေ ထုတ်တာက inference ပါ။                                      | L27             |
| serving                               | EN                | —                                                | train ပြီးသား model ကို user request တွေအတွက် production မှာ run ထားပေးတာပါ။                                                                           | L27             |
| prompt                                | EN                | —                                                | model ကို ပေးတဲ့ ညွှန်ကြားချက်နဲ့ မေးခွန်းပါ။                                                                                                               | L26             |
| token / context window                | EN                | —                                                | model က စာသားကို ခွဲဖတ်တဲ့ အပိုင်းလေးတွေက token၊ တစ်ကြိမ်မှာ model ဖတ်နိုင်တဲ့ token အများဆုံး ပမာဏက context window ပါ။                                                | L26 → L27       |
| hallucination                         | EN                | "ha-loo-si-NAY-shun"                             | model က မမှန်တဲ့ အရာကို အမှန်လို ယုံကြည်စိတ်ချစွာ ပြောလိုက်တာပါ။                                                                                                   | L26             |
| agent / AI agent                      | EN                | —                                                | ရည်မှန်းချက် တစ်ခု ပေးလိုက်ရင် tool တွေ ခေါ်သုံးပြီး အဆင့်တွေကို ကိုယ်တိုင် ဆက်တိုက် လုပ်ဆောင်တဲ့ AI ပါ။                                                                           | L01 → L26       |
| agentic                               | EN                | "a-JEN-tic"                                      | AI agent တွေက အဆင့်တွေကို ကိုယ်တိုင် ဆုံးဖြတ်ပြီး လုပ်ဆောင်တဲ့ ပုံစံကို ပြောတာပါ။                                                                                         | L18–19 → L26    |
| coding agent                          | EN                | —                                                | code ကို ကိုယ်တိုင် ရေး၊ ပြင်၊ test လုပ်ပေးတဲ့ AI agent ပါ။                                                                                                  | L26             |
| tool call                             | EN                | —                                                | AI က အပြင် tool တစ်ခုကို ခေါ်သုံးတာပါ၊ ဥပမာ log ရှာတာ၊ dashboard ဖတ်တာ မျိုးပါ။                                                                             | L27             |
| MCP                                   | EN                | "M-C-P"; "Model Context Protocol" the first time | AI agent တွေက tool တွေ၊ data တွေနဲ့ ချိတ်ဆက်ဖို့ standard protocol ပါ။                                                                                     | L27 → L28–29    |
| RAG                                   | EN                | "rag" (one word)                                 | အဖြေ မထုတ်ခင် သက်ဆိုင်တဲ့ စာရွက်စာတမ်းတွေကို အရင် ရှာပြီး model ကို ထည့်ပေးတဲ့ နည်းလမ်းပါ။                                                                                | L28–29 → L30–31 |
| eval / golden set (golden dataset)    | EN                | "ee-VAL"                                         | အဖြေ မှန်ကို ကြိုသိထားတဲ့ မေးခွန်း စုစည်းမှုနဲ့ AI ရဲ့ အဖြေ ကောင်းမကောင်း စနစ်တကျ စစ်တာက eval ပါ။                                                                      | L18–19 → L27    |
| LLM-as-a-judge                        | EN                | "L-L-M as a judge"                               | AI တစ်ခုရဲ့ အဖြေကို တခြား LLM တစ်ခုက အမှတ်ပေး စစ်ဆေးတာပါ။                                                                                                  | L18–19 → L28–29 |
| prompt injection                      | EN                | —                                                | model ဖတ်မယ့် data ထဲမှာ ညွှန်ကြားချက်တွေ ဝှက်ထည့်ပြီး model ကို မလုပ်သင့်တာ လုပ်ခိုင်းတဲ့ တိုက်ခိုက်မှုပါ။                                                                         | L18–19 → L27    |
| data drift / model drift              | EN                | —                                                | အချိန် ကြာလာတာနဲ့ အမျှ လက်တွေ့ data က model ကို train ခဲ့တဲ့ data နဲ့ ကွာလာလို့ အဖြေ အရည်အသွေး ကျလာတာပါ။                                                              | L04 → L27       |
| fine-tuning                           | EN                | —                                                | train ပြီးသား model ကို ကိုယ့်အလုပ်နဲ့ ဆိုင်တဲ့ data နဲ့ ထပ်သင်ပေးတာပါ။                                                                                             | L27             |
| time to first token                   | Full phrase       | never "T-T-F-T"                                  | prompt ပို့ပြီး ပထမဆုံး စာလုံး ပြန်ထွက်လာတဲ့အထိ ကြာချိန်ပါ၊ AI service ရဲ့ latency SLI အဖြစ် သုံးလေ့ ရှိပါတယ်။                                                           | L27             |
| checkpoint                            | EN                | —                                                | training ကြာလို့ ကြားထဲမှာ အခြေအနေကို သိမ်းထားတာပါ၊ ပျက်ရင် အစကနေ မစဘဲ ဆက်လုပ်လို့ ရပါတယ်။                                                                         | L27             |
| safety filter                         | EN                | —                                                | model ရဲ့ input နဲ့ output ထဲက အန္တရာယ်ရှိတဲ့ အကြောင်းအရာကို စစ်ထုတ်ပေးတာပါ။                                                                                     | L27             |
| sandbox                               | EN                | —                                                | program ဒါမှမဟုတ် agent ကို တခြား system တွေ မထိနိုင်အောင် ပိတ်ထားတဲ့ နေရာထဲမှာ run တာပါ။                                                                        | L04 → L27       |
| supply chain                          | EN                | —                                                | ကိုယ်သုံးတဲ့ model၊ library၊ data တွေ ဘယ်ကလာလဲ ဆိုတဲ့ ကွင်းဆက်ပါ၊ တစ်နေရာ ညစ်ညမ်းရင် အကုန် ထိနိုင်ပါတယ်။                                                                    | L08 → L27       |
| deterministic / probabilistic         | EN + gloss        | —                                                | input တူရင် ရလဒ် အမြဲ တူတာက deterministic၊ input တူပေမဲ့ ရလဒ် ကွဲနိုင်တာက probabilistic ပါ။ AI က probabilistic ဖြစ်လို့ စစ်ပုံ မတူပါဘူး။                               | L28–29          |
| progressive authorization             | EN + gloss        | —                                                | AI ကို ယုံကြည်မှု တိုးလာတာနဲ့ အမျှ လုပ်ခွင့်ကို တစ်ဆင့်ချင်း တိုးပေးတာပါ။                                                                                                | L28–29          |
| human over the loop                   | EN                | —                                                | AI က ကိုယ်တိုင် လုပ်ပေမဲ့ လူက စောင့်ကြည့်ပြီး လိုရင် ဝင်ရပ်လို့ရတဲ့ ပုံစံပါ။                                                                                                 | L28–29          |
| spec-driven development               | EN                | —                                                | code မရေးခင် လိုချင်တဲ့ အပြုအမူကို spec အဖြစ် အရင် ရှင်းရှင်း ရေးပြီး AI ကို အဲဒီ spec အတိုင်း လုပ်ခိုင်းတာပါ။                                                               | L26             |
| coherence drift                       | EN + gloss        | say "strategic incoherence" once only            | AI က အပိုင်းလိုက် မြန်မြန် ရေးပေးလို့ system တစ်ခုလုံးရဲ့ design က တဖြည်းဖြည်း မညီညွတ် ဖြစ်လာတာပါ။                                                                     | L26             |
| AI SRE                                | EN                | "A-I S-R-E"                                      | AI ကို အဓိက tool အဖြစ် သုံးပြီး production ကို ထိန်းတဲ့ SRE အလုပ် ပုံစံပါ။                                                                                        | L26             |
| Jevons paradox                        | EN                | "JEV-unz paradox"                                | တစ်ခုခု ပိုထိရောက်၊ ပိုစျေးပေါလာရင် လူတွေက ပိုသုံးလာလို့ စုစုပေါင်း သုံးစွဲမှုက ပိုများလာတတ်တာပါ။                                                                              | L06–07 → L28–29 |
| leading / trailing indicator          | EN                | —                                                | ပြဿနာ မဖြစ်ခင် ကြိုပြတဲ့ အချက်က leading indicator၊ outage အရေအတွက်လို ဖြစ်ပြီးမှ တိုင်းလို့ရတဲ့ အချက်က trailing indicator ပါ။                                          | L32             |
| confidence line                       | MM                | —                                                | AI အကြံပြုချက်တွေကို ပြမယ့် အနိမ့်ဆုံး ယုံကြည်မှု အဆင့်ပါ။ အဲဒီအောက်ဆိုရင် ဘာမှ မပြလို့ ခန့်မှန်းချက် အားနည်းတာက on-call ကို လမ်းမလွဲစေပါဘူး။                                             | L29             |
| reopen rate                           | EN + gloss        | —                                                | agent ဖြေရှင်းပြီးသား ticket တွေ ပြန်ဖွင့်ရတဲ့ နှုန်းပါ။ agent ကို တိုင်းတဲ့ အဓိက number ပါ။                                                                         | L29             |
| fleet scan                            | EN + gloss        | —                                                | incident တစ်ခုမှာ တွေ့တဲ့ အားနည်းချက်ကို codebase တိုင်းမှာ ရှာတာပါ၊ ဥပမာ idempotency key မပါတဲ့ payment call တွေ။                                                 | L29             |
| complaint grouping                    | MM                | —                                                | user ရေးတဲ့ complaint တွေကို version၊ operator၊ နေရာ အလိုက် AI နဲ့ အုပ်စုဖွဲ့ပြီး အုပ်စု အရွယ်အစားနဲ့ ပြဿနာ ဘယ်လောက် ကြီးလဲ ကြည့်တာပါ။                                        | L29             |
| production wall                       | MM + "production" | —                                                | AI နဲ့ code ရေးတာ မြန်လာပေမဲ့ production ထဲ ဘေးကင်းကင်း ထည့်ရတဲ့ အဆင့်က မလွယ်လာတာကို ပြတဲ့ နံရံပုံပါ။                                                                   | L26             |
| change record                         | EN + gloss        | —                                                | agent ဒါမှမဟုတ် လူ တစ်ယောက်ယောက် ပြောင်းလဲမှု လုပ်တိုင်း task၊ အကြောင်းပြချက်နဲ့ run ခဲ့တဲ့ test တွေကို မှတ်ထားတာပါ။ incident ဖြစ်ရင် ဘာကြောင့်လဲ ပြန်ကြည့်လို့ရပါတယ်။                   | L26             |
| degraded answer                       | EN + gloss        | —                                                | error မဟုတ်ပေမဲ့ အားနည်းတဲ့၊ ဒါမှမဟုတ် ဈေးသက်သာတဲ့ model ကနေ ပေးလိုက်တဲ့ အဖြေပါ။ HTTP က 200 ပြပေမဲ့ SLO ထဲမှာ degraded အဖြစ် ရေတွက်ရပါတယ်။                                | L27             |
| two error budgets (service and agent) | EN + gloss        | —                                                | service ရဲ့ error budget နဲ့ AI agent ကိုယ်ပိုင် safety budget ကို သီးခြား ထားတာပါ။ service budget ကုန်ရင် agent က အကြံပဲ ပေးပြီး safety budget ကုန်ရင် agent ရပ်ပါတယ်။ | L28             |
| undoable action                       | MM                | —                                                | undo လုပ်နည်း သိပြီးသား၊ အလိုအလျောက် ပြန်ဖျက်လို့ရတဲ့ action အသေးလေးပါ။ undo မသိရင် agent မလုပ်ရပါဘူး။                                                              | L28             |

### 2.14 Running-example words (Padauk Pay)

These belong to our fictional Yangon super-app. If the curriculum renames the
app, update this table.

| English term               | Keep EN?     | Said as                                     | Burmese line                                                                                        | First        |
| -------------------------- | ------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ |
| Padauk Pay                 | product name | "ပိတောက် Pay" (see 4.2)                       | ရန်ကုန်နဲ့ မန္တလေးမှာ wallet၊ top-up နဲ့ အစားအသောက် မှာတဲ့ service တွေ ပေးတဲ့ ကျွန်တော်တို့ရဲ့ စိတ်ကူးယဉ် app ပါ။               | L01          |
| Padauk Eats                | product name | "ပိတောက် Eats"                                | Padauk Pay ထဲက အစားအသောက် မှာပြီး rider နဲ့ ပို့ပေးတဲ့ service ပါ။                                             | L01          |
| wallet                     | EN           | —                                           | ဖုန်းထဲမှာ ငွေထည့်ထားပြီး ပေးချေလို့ရတဲ့ အကောင့်ပါ။                                                                | L01          |
| top-up                     | EN           | "top up"                                    | wallet ဒါမှမဟုတ် ဖုန်းထဲကို ငွေ ဖြည့်တာပါ။                                                                     | L01          |
| merchant                   | EN           | —                                           | Padauk Pay နဲ့ ငွေလက်ခံတဲ့ ဆိုင်ပါ။                                                                           | L01          |
| rider                      | EN           | —                                           | အစားအသောက် ပို့ပေးတဲ့သူပါ။                                                                                 | L01          |
| voucher / cashback         | EN           | —                                           | လျှော့စျေး ကူပွန်က voucher၊ ဝယ်ပြီးရင် ပြန်ရတဲ့ ငွေက cashback ပါ။                                               | L17          |
| refund                     | EN           | —                                           | ပေးပြီးသား ငွေကို customer ဆီ ပြန်အမ်းတာပါ။                                                                | L13          |
| ledger                     | EN           | —                                           | ငွေဝင် ငွေထွက် တစ်ခုချင်းကို မပြင်ရ မဖျက်ရ အစဉ်လိုက် မှတ်ထားတဲ့ စာရင်းပါ။                                                | L13 → L21–22 |
| settlement                 | EN           | —                                           | ရောင်းရတဲ့ ငွေကို merchant ဆီ စုပြီး လွှဲပေးတာပါ။                                                               | L13          |
| QR                         | EN           | "Q-R"                                       | ဖုန်းနဲ့ scan ဖတ်ပြီး ငွေချေတဲ့ ကုဒ်ပါ။                                                                        | L32          |
| Thingyan, Yangon, Mandalay | MM           | write သင်္ကြန်၊ ရန်ကုန်၊ မန္တလေး in Burmese script | traffic peak ဥပမာ ပေးရင် သင်္ကြန်လို ပွဲတော် ရက်တွေကို သုံးလို့ရပါတယ်။                                                 | L20          |
| Ops Buddy                  | product name | —                                           | Padauk ရဲ့ internal AI operations agent ပါ။ read-only နဲ့ စပြီး action card အတိုင်း လုပ်ခွင့် တဖြည်းဖြည်း ရလာပါတယ်။ | L28          |
| Padauk Parcel              | product name | "ပိတောက် Parcel"                              | Padauk ဝယ်လိုက်တဲ့ မန္တလေးက delivery startup အသေးလေးပါ၊ Ko Min က ပထမဆုံး SRE ပါ။                             | L30          |

## 3. Rules

### 3.1 Keep developer vocabulary in English

- Developer vocabulary stays in English, in Latin script: incident, on-call,
  postmortem, rollout, rollback, deploy, latency, traffic, server, dashboard,
  alert, paging, SLO, error budget, toil, screen, memory, component, state and
  the like.
- **Never invent literary Burmese for them**, and never write them in Burmese
  script (no ဆာဗာ, ဒက်ရှ်ဘုတ်). Chan's standing rule from the earlier courses
  still applies:
  - screen, not မျက်နှာပြင်
  - tree, not သစ်ပင်
  - memory, not မှတ်ဉာဏ်
  - "handle လုပ်", never ကိုင်ပေး
  - "fake server", never server အတု
  - "inject လုပ်", never ထိုးထည့်
- **Everyday words stay Burmese:** ပြဿနာ, အမှား, ပျက်, နှေး, ကြာချိန်,
  ရာခိုင်နှုန်း, ပစ်မှတ်, အဖွဲ့, တာဝန်, ဆုံးဖြတ်ချက်, ကုန်ကျစရိတ်, မှတ်တမ်း, စာရင်း,
  ခလုတ်, ခေါင်းစဉ်, စာပိုဒ်, ယဉ်ကျေးမှု. The adverb အလိုအလျောက် is fine, as in
  "အလိုအလျောက် rollback လုပ်ပေးတယ်". Only the noun "automation" stays English.
- **Gloss once, then use the English term.** A `EN + gloss` term gets one short
  Burmese explanation the first time it comes up in each lesson. After that, use
  only the English word. Don't switch between the English term and a Burmese
  paraphrase for the same idea in one lesson.
- **Acronyms:**
  - Say the full English phrase the first time in each lesson, then the acronym
    ("Site Reliability Engineering … SRE").
  - A term marked `Full phrase` is never said as its acronym.
  - Always write the plural in Burmese: "SLO တွေ", "SRE တွေ", "incident တွေ".
    Never use an English plural (SLOs, SREs, incidents). The pronunciation list
    matches whole words, so `SLOs` would slip past a fix made for `SLO`.

### 3.2 How to write English inside Burmese

- **Put a space between the English term and the Burmese particle that follows
  it:** "SLO ကို", "rollback လုပ်", "alert တက်". This is the house style of the
  shipped CSS and Rust courses.
  - It also keeps the pronunciation fix working (section 4.1). Never join the
    two with a hyphen (`SLO-ကို`).
- **Write terms in lowercase,** except acronyms and proper nouns. The
  pronunciation list is case-sensitive, so one lowercase spelling is easier to
  fix.
- **English verbs get a Burmese helper verb.** Use these pairings across the
  course:

| Meaning     | Say           | Meaning                    | Say                    |
| ----------- | ------------- | -------------------------- | ---------------------- |
| deploy      | deploy လုပ်     | an alert fires             | alert တက်               |
| roll back   | rollback လုပ်   | a page arrives             | page ဝင်လာ              |
| roll out    | rollout လုပ်    | page someone               | page ပို့                 |
| automate    | automate လုပ်   | be on call                 | on-call ကျ / on-call ယူ |
| mitigate    | mitigate လုပ်   | declare an incident        | incident ကြေညာ         |
| escalate    | escalate လုပ်   | write a postmortem         | postmortem ရေး         |
| drain       | drain လုပ်      | spend / exhaust the budget | error budget သုံး / ကုန်   |
| handle      | handle လုပ်     | shift traffic              | traffic လွှဲ              |
| inject      | inject လုပ်     | add capacity               | capacity တိုး            |
| acknowledge | ack လုပ်        | take a backup              | backup ယူ               |
| instrument  | instrument လုပ် | restore                    | restore လုပ်             |
| review      | review လုပ်     | fail over                  | failover လုပ်            |

### 3.3 Register

- Use the polite spoken register throughout (`…ပါတယ်`, `…ပါမယ်`, `…တာပါ`, `…လား`).
- Write complete, connected, explanatory sentences with natural connectors
  (ဆိုတော့၊ ဒါကြောင့်၊ ဥပမာအားဖြင့်၊ ဒါပေမဲ့). Never write chains of short
  fragments. Chan has rejected that style.
- Never read code, YAML or formulas aloud. The slide shows them, and the
  narration explains the idea.

### 3.4 Numbers and symbols

- **Numbers in narration are Burmese digits with no thousands separator**
  (Chan, 2026-10-18, after the pronunciation probe): "၃၀၀၀", "၁၀၀၀၀",
  "၉၉.၉", never "3,000" or "၃,၀၀၀". The decimal point stays. Small counts may
  stay Burmese words ("သုံးခု"). Screen text (deck pages, board labels,
  notes.md) keeps Latin digits. `~/Documents/sre-course/work/burmese-digits.py`
  converts the spoken lines of a voice script or lesson YAML and leaves
  markers alone.
- **Percentages:** Burmese digits plus the Burmese word: "၉၉.၉ ရာခိုင်နှုန်း".
  Never `%`.
- **Nines:** "nine သုံးလုံး" (99.9), "nine ငါးလုံး" (99.999). Say the
  percentage too the first time.
- **Units:** write "millisecond" and "second" in full. Never `ms` or `s`.
- **Few numbers per scene.** Round them where the exact value doesn't matter.
  Keep exact numbers on the slide.
- **24/7:** say it in Burmese: "တစ်နေ့ ၂၄ နာရီ၊ ရက်တိုင်း".

### 3.5 Names

- No "Google" in the course or lesson titles.
- No company-internal product or program names from the book in narration.
  Describe what the thing does instead.
- People's names (Conway, Hyrum, Goodhart, Jevons, Leveson) only where the law
  or method is named after them. Say each one at most once or twice per lesson.

### 3.6 Words and forms to avoid

Written-register grammar (never in narration):

| Avoid                             | Use instead                        |
| --------------------------------- | ---------------------------------- |
| သည် / ပါသည်                         | တယ် / ပါတယ်                          |
| ၏                                 | ရဲ့                                  |
| ၌ / တွင်                            | မှာ                                 |
| ၍ / သဖြင့်                          | ပြီး / လို့                            |
| သော                               | တဲ့                                  |
| များ (plural)                     | တွေ                                 |
| ထို / ၎င်း                           | အဲဒီ / အဲဒါ                           |
| ဤ                                 | ဒီ                                  |
| မည်                                | မယ်                                 |
| နှင့်                                | နဲ့                                  |
| သို့သော်                              | ဒါပေမဲ့                              |
| ထို့ကြောင့်                            | ဒါကြောင့်                            |
| အကယ်၍ … လျှင်                        | တကယ်လို့ … ရင်                          |
| heavy `-ခြင်း` nouns (စောင့်ကြည့်ခြင်း) | a verb phrase, or the English term |

Invented or literary Burmese for developer terms:

| Avoid                                             | Use instead                                               |
| ------------------------------------------------- | --------------------------------------------------------- |
| ဖြစ်ရပ် / အရေးပေါ် အခြေအနေ (for incident)            | incident                                                  |
| ပြတ်တောက်မှု (for outage)                             | outage                                                    |
| သတိပေးချက် (for alert)                              | alert ("alert တက်")                                        |
| စောင့်ကြည့်ခြင်း (for monitoring)                      | monitoring                                                |
| ကြည့်ရှုနိုင်စွမ်း (for observability)                     | observability                                             |
| ဂျူတီ / တာဝန်စောင့် (for on-call)                      | on-call ("on-call ကျ")                                    |
| သေဆုံးပြီးနောက် စစ်ဆေးခြင်း (for postmortem)            | postmortem                                                |
| အပြစ်မတင်သော (for blameless)                        | blameless + one gloss                                     |
| နောက်ပြန်ဆုတ်ခြင်း / ပြန်လည်ရုပ်သိမ်းခြင်း (for rollback)     | rollback                                                  |
| ဖြန့်ချိခြင်း (for rollout / release)                 | rollout / release                                         |
| ဖြန့်ကျက်ခြင်း / တပ်ဆင်ခြင်း (for deploy)                | deploy လုပ်                                                 |
| အမှားဘတ်ဂျက် (for error budget)                      | error budget                                              |
| ဝန်ဆောင်မှုအဆင့် ရည်မှန်းချက် (for SLO)                     | SLO                                                       |
| နှောင့်နှေးချိန် / ကြန့်ကြာချိန် (for latency)              | latency                                                   |
| အသွားအလာ (for traffic)                             | traffic                                                   |
| ငြီးငွေ့ဖွယ် ထပ်တလဲလဲ အလုပ် (as the name for toil)          | toil + one gloss                                          |
| ယုံကြည်စိတ်ချရမှု (as the name for reliability)          | reliability ("စိတ်ချရတဲ့ system" is fine as everyday wording) |
| ရရှိနိုင်မှု (for availability)                          | availability                                              |
| ဆာဗာ / ဒက်ရှ်ဘုတ် / ဒေတာဘေ့စ် (Burmese-script spellings) | server / dashboard / database                             |
| server အတု / ဆာဗာအတု                                | fake server                                               |
| ကိုင်ပေး / ကိုင်တွယ် (for handle)                         | handle လုပ်                                                 |
| ထိုးထည့် (for inject)                                 | inject လုပ်                                                 |
| မျက်နှာပြင် / သစ်ပင် / မှတ်ဉာဏ်                           | screen / tree / memory                                    |

Book phrasings never used in narration or on slides (they are the book's coined names or
distinctive wording; teach the idea in our own words):

| Avoid                                                            | Say instead                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| force multiplier                                                 | describe it: "တခြားသူတွေ ပိုလုပ်နိုင်အောင် ကူညီပေးတဲ့သူ"                         |
| staff engineer (as the SRE role)                                 | "system တစ်ခုလုံးကို မြင်နေတဲ့သူ"                                           |
| blame-aware, blame awareness                                     | local rationality, just culture, restorative accountability       |
| autonomy levels, Level 0 to 4, L0–L4                             | the action card and its modes                                     |
| trust pillars                                                    | tell Ops Buddy's story: dry run, track record, pauses in a freeze |
| RWO, Restore Window Objective                                    | "backup တွေ ဘယ်လောက် နောက်ကျော်အထိ ရှိလဲ"                                  |
| crumple zone                                                     | degradation profile                                               |
| four layers of data needs                                        | "integrity ကို speed နဲ့ cost အတွက် ဘယ်တော့မှ မလဲပါဘူး"                      |
| N × K problem                                                    | tell the freeze-rule story (one rule, many scripts)               |
| VOIS                                                             | Padauk's three config questions                                   |
| inversion of authority                                           | "ရာထူး ဘယ်လောက်ပဲ ရှိရှိ incident commander က ဦးဆောင်ပါတယ်"                 |
| generations of engagement (1 / 2 / 3)                            | "အရင်က လုပ်ပုံတွေက သင်ပေးခဲ့တာ"                                            |
| the reliability building, floors, hierarchy of production health | the Padauk reliability loop                                       |

Acronyms never spoken (say the phrase instead; the acronym may sit on a slide):

| Acronym                               | Say                                                               |
| ------------------------------------- | ----------------------------------------------------------------- |
| CUJ                                   | critical user journey                                             |
| SDLC                                  | software development lifecycle                                    |
| NFR / FR                              | non-functional requirement / functional requirement               |
| PIR                                   | postmortem                                                        |
| IC                                    | incident commander (or individual contributor; never the letters) |
| IRM                                   | incident management platform                                      |
| SDO                                   | software delivery and operations performance                      |
| SWE                                   | software engineer                                                 |
| TTD / TTM / TTR                       | time to detect / mitigate / resolve                               |
| TTFT                                  | time to first token                                               |
| HBM                                   | GPU memory                                                        |
| EWMA                                  | describe it: "အလုပ်အနည်းဆုံး server ကို ရွေးတဲ့ နည်း"                        |
| SPOF                                  | single point of failure                                           |
| TiP                                   | testing in production                                             |
| SDC                                   | silent data corruption                                            |
| PITR                                  | point-in-time recovery                                            |
| UCA                                   | unsafe control action                                             |
| NALSD                                 | non-abstract large system design                                  |
| IaC                                   | infrastructure as code                                            |
| OTel                                  | OpenTelemetry                                                     |
| DoS                                   | denial of service                                                 |
| YBIYRI                                | you build it, you run it                                          |
| DiRT and other internal program names | disaster recovery testing / a description                         |

## 4. Pronunciation risks and proposed respellings

Status: **proposals only.** Nothing here has been added to
`src/studio/script/lexicon.ts`. Chan confirms each entry by ear first.

### 4.1 How the Burmese pronunciation list works

- `BURMESE_RESPELLINGS` in `src/studio/script/lexicon.ts` changes the speech
  text only. Captions keep the written word, and only the dialogs that contain
  the term are synthesized again.
- It currently holds:
  - Vite/vite → "veet"
  - DOM → "Dom"
  - className → "class name"
  - App/app → "Up"/"up"
- **Matching rules:**
  - The narration is split on spaces into tokens.
  - An entry matches a token's whole core: its letters, digits, `.`, `_` and
    `-`.
  - Leading and trailing punctuation, including attached Burmese text, is kept
    around the replacement. A trailing full stop is handled too.
  - Matching is case-sensitive, so `Rollback` and `rollback` need separate
    entries.
- **What this means for writers:**
  - **Plurals miss.** `SLOs` is a different token from `SLO`. This is one more
    reason for "SLO တွေ".
  - **Tokens with `/` or `+` can never be fixed** because the core can't contain
    them. Write these differently instead:
    - `CI/CD` → "CI CD"
    - `A/B test` → "A B test"
    - `N+1` → "N plus one"
    - `24/7` → the Burmese phrase in 3.4
    - Never `p_slo`-style symbols
  - **A hyphen joins the token,** so `SLO-ကို` would not match. Use a space.
- **Evidence so far:**
  - Shipped Burmese lessons say CSS, HTML, JSX, UI, ID, RGB and HSL without
    complaint. So all-caps initialisms that are meant to be spelled out
    letter by letter are usually fine.
  - Three kinds of word went wrong:
    - an all-caps acronym meant as a word: DOM came out as the Burmese
      syllable ဒွမ်
    - a short capitalised word: App was spelled A-P-P
    - a run-together compound: className
  - The candidates below follow those three patterns.

### 4.2 Candidates for `BURMESE_RESPELLINGS`

**Decided by ear (Chan, 2026-10-18, pronunciation probe):** canary, rollout,
rollback and Padauk keep their written form ("ရေးနေကျ", the probe's first
take sounded more natural), so they get **no** entry; the proposals for them
below are withdrawn. Terms Chan did not comment on stay as written too, until
a real render sounds wrong.

**Priority A: likely wrong. Test before the first SRE lesson is rendered.**

| Written token(s)       | Should sound like               | Why at risk                                         | Proposed entries                                                                            |
| ---------------------- | ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| CAST                   | the word "cast"                 | all-caps word, like DOM                             | `CAST: "cast"`                                                                              |
| STAMP                  | the word "stamp"                | all-caps word                                       | `STAMP: "stamp"`                                                                            |
| DORA                   | "Dora"                          | all-caps word                                       | `DORA: "Dora"`                                                                              |
| RAG                    | the word "rag"                  | all-caps word                                       | `RAG: "rag"`                                                                                |
| NOC                    | "nock"                          | all-caps word                                       | `NOC: "nock"`                                                                               |
| toil                   | "toyl"                          | spelling invites "to-il"                            | `toil: "toyl"`                                                                              |
| postmortem             | "post mortem"                   | run-together compound, like className               | `postmortem: "post mortem"`                                                                 |
| rollout, rollback      | "roll out", "roll back"         | run-together compounds; used in almost every lesson | `rollout: "roll out"`, `rollback: "roll back"`                                              |
| SaaS                   | "sass"                          | mixed-case short word, like App                     | `SaaS: "sass"`                                                                              |
| DevOps, GitOps, FinOps | "dev ops", "git ops", "fin ops" | mixed-case compounds                                | `DevOps: "dev ops"`, `GitOps: "git ops"`, `FinOps: "fin ops"`                               |
| Kubernetes             | "koo-ber-net-eez"               | long foreign spelling                               | `Kubernetes: "koober netties"`, or Chan's own spoken form                                   |
| OpenTelemetry          | "open telemetry"                | run-together brand name                             | `OpenTelemetry: "open telemetry"`                                                           |
| Padauk                 | ပိတောက်                           | Burmese word in Latin letters, read as English      | `Padauk: "ပိတောက်"` (a Burmese-script spoken form; the slides and captions keep "Padauk Pay") |
| p50, p90, p95, p99     | "P fifty" … "P ninety-nine"     | letter plus digits                                  | `p99: "P ninety-nine"` etc. Chan to confirm: English numbers or "P ကိုးဆယ့်ကိုး"                  |
| SEV1, SEV2             | "sev one", "sev two"            | letters plus digit                                  | `SEV1: "sev one"`, `SEV2: "sev two"`                                                        |

**Priority B: plausible. Add only if a render sounds wrong.**

| Written token(s)                             | Should sound like                                        | Proposed entries                                                       |
| -------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| runbook, playbook                            | "run book", "play book"                                  | `runbook: "run book"`, `playbook: "play book"`                         |
| failover                                     | "fail over"                                              | `failover: "fail over"`                                                |
| goodput, throughput                          | "good put", "through put"                                | `goodput: "good put"`, `throughput: "through put"`                     |
| backoff, timeout                             | "back off", "time out"                                   | `backoff: "back off"`, `timeout: "time out"`                           |
| autoscaling, multitenant, monorepo, codebase | "auto scaling", "multi tenant", "mono repo", "code base" | one entry each                                                         |
| on-call                                      | "on call"                                                | `on-call: "on call"`                                                   |
| top-up, Top-up                               | "top up"                                                 | `top-up: "top up"`, `Top-up: "top up"`                                 |
| canary                                       | "ka-nair-ee"                                             | `canary: "ka nairy"`                                                   |
| chaos                                        | "kay-os"                                                 | `chaos: "kay os"`                                                      |
| cache                                        | "cash"                                                   | `cache: "cash"`                                                        |
| queue                                        | "kyoo"                                                   | `queue: "Q"`                                                           |
| idempotent, idempotency                      | "eye-dem-POH-tent", "eye-dem-POH-ten-see"                | `idempotent: "eye dem poh tent"`, `idempotency: "eye dem poh ten see"` |
| agentic                                      | "a-JEN-tic"                                              | `agentic: "a jen tic"`                                                 |
| eval, evals                                  | "ee-VAL", "ee-VALS"                                      | `eval: "ee val"`, `evals: "ee vals"`                                   |
| hallucination                                | "ha-loo-si-NAY-shun"                                     | `hallucination: "ha loo si nay shun"`                                  |
| hermetic                                     | "her-MET-ic"                                             | `hermetic: "her met ic"`                                               |
| cron                                         | "kron"                                                   | `cron: "kron"`                                                         |
| YAML, JSON                                   | "yamel", "jay-son"                                       | `YAML: "yamel"`, `JSON: "jay son"`                                     |
| A2A, B2B, B2C                                | "A to A", "B to B", "B to C"                             | one entry each                                                         |
| 3-2-1                                        | "three two one"                                          | `3-2-1: "three two one"`                                               |
| Hyrum's (token `Hyrum's`)                    | "High-rum's"                                             | `Hyrum's: "High rum's"`                                                |
| Goodhart's                                   | "Good-hart's"                                            | `Goodhart's: "Good hart's"`                                            |
| Jevons                                       | "Jev-unz"                                                | `Jevons: "Jev unz"`                                                    |
| Leveson, Rasmussen, Westrum                  | "Lev-eh-son", "Ras-mus-sen", "Wes-trum"                  | one entry each, only if a lesson names them                            |

**Priority C: spelled-out initialisms. Fine by precedent. Watch only.**

- **The core set:** SLO, SLI, SLA, SRE, API, CPU, GPU, AI, LLM, MCP, RPO, RTO,
  TTL, MTTR, OKR, KPI, ROI, STPA, VM, DR, QR, NRC.
  - Initialisms ending in a vowel (SRE, SLO, SLA, ROI) could be read as words.
  - If that happens, add a spaced form: `SRE: "S R E"`, `SLO: "S L O"`,
    `SLA: "S L A"`, `ROI: "R O I"`.
- **Avoid entirely:** Cynefin, sycophancy, fungibility, decompensation,
  geopatriation. Explain the idea in Burmese instead of naming the word.

### 4.3 Suggested check

- **Before the first SRE lesson renders, run one probe:** one short throwaway
  Burmese dialog that uses every Priority A term once, synthesized with Chan's
  Burmese voice.
- **Add only what Chan hears wrong.** Put those entries into
  `BURMESE_RESPELLINGS` in a single commit, each with a one-line comment
  explaining it, as the existing entries do.
- **Fix later mispronunciations the same way.** Add the token to the list.
  Never respell it inside the narration text.
