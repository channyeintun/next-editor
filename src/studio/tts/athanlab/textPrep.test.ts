import { describe, expect, it } from "vite-plus/test";
import { ATHANLAB_TEXT_PREP_VERSION, prepareAthanLabText } from "./textPrep";

describe("prepareAthanLabText", () => {
  it("is version 1", () => {
    expect(ATHANLAB_TEXT_PREP_VERSION).toBe(1);
  });

  it("keeps a sentence or pause ending, and ends anything else with ။", () => {
    expect(prepareAthanLabText("ဒီသင်ခန်းစာကို ပြန်ချုပ်ရရင်၊")).toBe("ဒီသင်ခန်းစာကို ပြန်ချုပ်ရရင်၊");
    expect(prepareAthanLabText("ကုဒ်ကို run ကြည့်ရအောင် အခု")).toBe("ကုဒ်ကို run ကြည့်ရအောင် အခု။");
    expect(prepareAthanLabText("မင်္ဂလာပါ။")).toBe("မင်္ဂလာပါ။");
    expect(prepareAthanLabText("ဟုတ်လား?")).toBe("ဟုတ်လား?");
    expect(prepareAthanLabText("ကောင်းတယ်!")).toBe("ကောင်းတယ်!");
    expect(prepareAthanLabText("It compiles.")).toBe("It compiles.");
    expect(prepareAthanLabText("Rust")).toBe("Rust။");
  });

  it("drops quotation marks but keeps apostrophes inside words", () => {
    expect(prepareAthanLabText(`"mut" ဆိုတာ “ပြောင်းလို့ရတယ်” လို့ ‘အဓိပ္ပာယ်’ ရတယ်။`)).toBe(
      "mut ဆိုတာ ပြောင်းလို့ရတယ် လို့ အဓိပ္ပာယ် ရတယ်။",
    );
    expect(prepareAthanLabText("«this» „that”")).toBe("this that။");
    expect(prepareAthanLabText("Rust's borrow checker says 'no' — don't panic.")).toBe(
      "Rust's borrow checker says no — don't panic.",
    );
    expect(prepareAthanLabText("'quoted'")).toBe("quoted။");
    expect(prepareAthanLabText("Rust’s compiler says ’no’ — don’t panic.")).toBe(
      "Rust’s compiler says no — don’t panic.",
    );
  });

  it("drops a closing quote that a Burmese particle follows directly", () => {
    expect(prepareAthanLabText("‘mut’ကို သုံးရင်")).toBe("mutကို သုံးရင်။");
    expect(prepareAthanLabText("'mut'ကို သုံးရင်")).toBe("mutကို သုံးရင်။");
    expect(prepareAthanLabText("“Option”ဆိုတာ")).toBe("Optionဆိုတာ။");
  });

  it("drops brackets", () => {
    expect(prepareAthanLabText("println() ကို (macro) [ပါ] {နော်}")).toBe("println ကို macro ပါ နော်။");
  });

  it("turns an ellipsis into a pause", () => {
    expect(prepareAthanLabText("ဒါပေမဲ့… ခဏစောင့်")).toBe("ဒါပေမဲ့၊ ခဏစောင့်။");
    expect(prepareAthanLabText("ဒါပေမဲ့...ခဏစောင့်")).toBe("ဒါပေမဲ့၊ ခဏစောင့်။");
    expect(prepareAthanLabText("ဒါပေမဲ့.... ခဏစောင့်")).toBe("ဒါပေမဲ့၊ ခဏစောင့်။");
    expect(prepareAthanLabText("ပြန်ချုပ်ရရင်…")).toBe("ပြန်ချုပ်ရရင်၊");
  });

  it("collapses whitespace and trims", () => {
    expect(prepareAthanLabText("  ပထမ \n\t ဒုတိယ   ")).toBe("ပထမ ဒုတိယ။");
  });

  it("leaves nothing to speak as empty", () => {
    expect(prepareAthanLabText("")).toBe("");
    expect(prepareAthanLabText(` "" () `)).toBe("");
  });
});
