import { describe, expect, it } from "vite-plus/test";
import {
  courseGroupOf,
  groupLessons,
  matchThumbnail,
  orderWorkflowLessons,
} from "./workflowLessons";

describe("workflow lessons", () => {
  it("groups numbered courses by prefix and the rest by their first word", () => {
    expect(courseGroupOf("css-course-01-basics")).toBe("css-course");
    expect(courseGroupOf("react-crash-course-13-react-19-3-recap")).toBe("react-crash-course");
    expect(courseGroupOf("sre-12-how-complex-systems-fail")).toBe("sre");
    expect(courseGroupOf("rust-borrow")).toBe("rust");
    expect(groupLessons(["rust-match", "css-course-02-box-model", "rust-borrow"])).toEqual([
      { name: "css-course", slugs: ["css-course-02-box-model"] },
      { name: "rust", slugs: ["rust-borrow", "rust-match"] },
    ]);
  });

  it("matches each course's exported thumbnail names", () => {
    const css = ["01-basics.png", "02-box-model.png", "12-functions.png"];
    expect(matchThumbnail("css-course-01-basics", css)).toBe("01-basics.png");
    expect(matchThumbnail("css-course-12-functions", css)).toBe("12-functions.png");
    expect(matchThumbnail("react-crash-course-02-props-lists", ["02-props-lists.png"])).toBe(
      "02-props-lists.png",
    );
    expect(matchThumbnail("rust-variables", ["01-rust-hello.png", "02-rust-variables.png"])).toBe(
      "02-rust-variables.png",
    );
    expect(matchThumbnail("css-course-03-selectors", css)).toBeNull();
  });

  it("prefers a numbered match, and refuses to guess between two equal ones", () => {
    // "basics" alone would also end the slug; the numbered name wins.
    expect(matchThumbnail("css-course-01-basics", ["basics.png", "01-basics.png"])).toBe(
      "01-basics.png",
    );
    expect(matchThumbnail("rust-hello", ["01-rust-hello.png", "07-rust-hello.jpg"])).toBeNull();
  });

  it("orders lessons course by course, by slug number or else thumbnail number", () => {
    const ordered = orderWorkflowLessons([
      { slug: "rust-variables", thumbnail: "02-rust-variables.png" },
      { slug: "css-course-10-sizing-units", thumbnail: null },
      { slug: "rust-hello", thumbnail: "01-rust-hello.png" },
      { slug: "css-course-02-box-model", thumbnail: null },
      { slug: "rust-borrow", thumbnail: null },
    ]);
    expect(ordered.map((lesson) => lesson.slug)).toEqual([
      "css-course-02-box-model",
      "css-course-10-sizing-units",
      "rust-hello",
      "rust-variables",
      "rust-borrow",
    ]);
  });
});
