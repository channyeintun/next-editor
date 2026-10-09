import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import LangText from "./LangText";

function renderTitle(text: string) {
  const { container } = render(
    <p>
      <LangText text={text} />
    </p>,
  );
  return container.querySelector("p")!;
}

describe("LangText", () => {
  it("renders an English-only title as plain text, with no lang span", () => {
    const title = renderTitle("Rust from zero: Ownership");

    expect(title).toHaveTextContent("Rust from zero: Ownership");
    expect(title.querySelector("[lang]")).toBeNull();
  });

  it("marks only the Burmese run of a mixed title as lang=my", () => {
    const title = renderTitle("Rust from zero: Data type တွေ");

    const burmese = title.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("တွေ");
    expect(title.textContent).toBe("Rust from zero: Data type တွေ");
  });

  it("keeps Burmese words separated by spaces in one run", () => {
    const title = renderTitle("Next Editor ကို မိတ်ဆက်ခြင်း");

    const burmese = title.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("ကို မိတ်ဆက်ခြင်း");
    expect(title.textContent).toBe("Next Editor ကို မိတ်ဆက်ခြင်း");
  });

  it("tags each Burmese run separately when English sits between them", () => {
    const title = renderTitle("Go: slice ကို for range နဲ့ လျှောက်ကြည့်တာ");

    const burmese = [...title.querySelectorAll('span[lang="my"]')].map((span) => span.textContent);
    expect(burmese).toEqual(["ကို", "နဲ့ လျှောက်ကြည့်တာ"]);
    expect(title.textContent).toBe("Go: slice ကို for range နဲ့ လျှောက်ကြည့်တာ");
  });
});
