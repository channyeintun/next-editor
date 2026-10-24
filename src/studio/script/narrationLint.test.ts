import { describe, expect, it } from "vite-plus/test";
import { VOXCPM2_MAX_TEXT_CHARS } from "../tts/voxcpm2Protocol";
import { LONG_DIALOG_CHARS, narrationIssues } from "./narrationLint";

/** One dialog per text, spoken exactly as written. */
function spoken(...texts: string[]) {
  return {
    dialogs: texts.map((text, index) => ({
      id: `scene.${index}`,
      sceneId: "scene",
      firstTokenIndex: 0,
      tokens: text.split(" "),
    })),
    speechTexts: texts,
  };
}

const severities = (locale: string, ...texts: string[]) =>
  narrationIssues(locale, spoken(...texts)).map((issue) => `${issue.dialogId} ${issue.severity}`);

describe("narrationIssues", () => {
  it("passes a clean dialog in either language", () => {
    expect(severities("en-US", "Two values come back at once.")).toEqual([]);
    expect(severities("my-MM", "ဒီ function က value နှစ်ခု ပြန်ပေးပါတယ်။")).toEqual([]);
  });

  it("fails a Burmese dialog VoxCPM2 would refuse, and warns on a long one", () => {
    const over = `${"က".repeat(VOXCPM2_MAX_TEXT_CHARS)}။`;
    const long = `${"က".repeat(LONG_DIALOG_CHARS)}။`;
    expect(severities("my", over, long)).toEqual(["scene.0 error", "scene.1 warning"]);
  });

  it("only warns on a long English dialog — VoxCPM2 never speaks one", () => {
    expect(severities("en-US", `${"a".repeat(VOXCPM2_MAX_TEXT_CHARS)}.`)).toEqual([
      "scene.0 warning",
    ]);
  });

  it("warns when a Burmese dialog stops mid-clause", () => {
    expect(severities("my-MM", "ပုံကို အခု", "ပုံကို အခု၊")).toEqual(["scene.0 warning"]);
    // English has no such rule: a mark may split a sentence anywhere.
    expect(severities("en-US", "and now the")).toEqual([]);
  });

  it("names the code-like characters a narrator would have to read", () => {
    const [issue] = narrationIssues("en-US", spoken("Call Math.max(n) inside the {braces}."));
    expect(issue.message).toContain('["Math.max(",")","{","}"]');
    expect(severities("en-US", "The data-testid attribute.")).toEqual(["scene.0 warning"]);
  });

  // VoxCPM2 said Saturday where the lesson meant "the dev server is starting".
  it("fails a Burmese verb run into its particle so it spells another word", () => {
    const [issue] = narrationIssues("my-MM", spoken("dev server ကို စနေပါပြီ။"));
    expect(issue).toMatchObject({ severity: "error" });
    expect(issue.message).toContain('write "စ နေ" with the space');
    expect(severities("my-MM", "card selector နဲ့ စနေလို့ ထပ်နေပါတယ်။")).toEqual(["scene.0 error"]);
    expect(severities("my-MM", "စာ စရိုက်တာနဲ့ ပျောက်သွားပါတယ်။")).toEqual(["scene.0 error"]);
    // The written-out verb, and the real Saturday, pass.
    expect(
      severities(
        "my-MM",
        "dev server ကို စ နေပါပြီ။",
        "စာ စ ရိုက်တာနဲ့ ပျောက်သွားပါတယ်။",
        "စနေနေ့က ပထမ ကြောင်းပါ။",
        "စနေ၊ တနင်္ဂနွေ ဖွင့်ပါတယ်။",
      ),
    ).toEqual([]);
  });
});
