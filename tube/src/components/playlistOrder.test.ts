import { describe, expect, it } from "vite-plus/test";
import { moveItem, orderMembers, sortByTitle } from "./playlistOrder";

const lesson = (id: string, title = id) => ({ id, title });

describe("playlist order", () => {
  it("sorts titles the way a course numbers them", () => {
    const titles = ["CSS course 10: Sizing", "CSS course 2: Box model", "css course 1: Basics"];
    expect(sortByTitle(titles.map((title) => ({ title }))).map((item) => item.title)).toEqual([
      "css course 1: Basics",
      "CSS course 2: Box model",
      "CSS course 10: Sizing",
    ]);
  });

  it("moves an item to any position, clamped to the ends", () => {
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
  });

  it("keeps the panel's order, drops removed members and appends new ones", () => {
    const members = [lesson("a"), lesson("b"), lesson("new")];

    expect(orderMembers(members, null).map((item) => item.id)).toEqual(["a", "b", "new"]);
    expect(orderMembers(members, ["b", "gone", "a"]).map((item) => item.id)).toEqual([
      "b",
      "a",
      "new",
    ]);
  });
});
