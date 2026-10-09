import { describe, expect, it } from "vite-plus/test";
import { isPlayerKeyTarget, isPressableTarget, isTypingTarget } from "./playerKeyTargets";

const within = (html: string, selector: string) => {
  document.body.innerHTML = html;
  return document.querySelector(selector);
};

describe("isPlayerKeyTarget", () => {
  it("takes keys on the page and on the player's buttons", () => {
    expect(isPlayerKeyTarget(document.body, "k")).toBe(true);
    expect(isPlayerKeyTarget(within("<button>Play</button>", "button"), "ArrowLeft")).toBe(true);
  });

  it("leaves Space on a button to the button", () => {
    expect(isPlayerKeyTarget(within("<button>Settings</button>", "button"), " ")).toBe(false);
  });

  it("never takes keys from places that are typed in or have keys of their own", () => {
    for (const [html, selector] of [
      ["<input>", "input"],
      ["<textarea></textarea>", "textarea"],
      ["<div class='monaco-editor'><div class='view-lines'></div></div>", ".view-lines"],
      ["<div class='xterm'><span></span></div>", "span"],
      ["<div class='excalidraw'><canvas></canvas></div>", "canvas"],
      ["<div contenteditable='true'><p></p></div>", "p"],
      ["<div role='dialog'><button>OK</button></div>", "button"],
      ["<div role='menu'><button>Item</button></div>", "button"],
      ["<div role='separator' tabindex='0'></div>", "div"],
    ]) {
      expect(isPlayerKeyTarget(within(html, selector), "k")).toBe(false);
    }
  });
});

describe("isTypingTarget", () => {
  it("is true for fields, editable content, the editor and the terminal", () => {
    for (const [html, selector] of [
      ["<input>", "input"],
      ["<div contenteditable='true'><p></p></div>", "p"],
      ["<div class='monaco-editor'><div class='view-lines'></div></div>", ".view-lines"],
      ["<div class='xterm'><span></span></div>", "span"],
    ]) {
      expect(isTypingTarget(within(html, selector))).toBe(true);
    }
  });

  it("is false for buttons, the page and non-elements", () => {
    expect(isTypingTarget(within("<button>Play</button>", "button"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("isPressableTarget", () => {
  it("is true for controls Space presses, and for what is inside them", () => {
    for (const [html, selector] of [
      ["<button>Play</button>", "button"],
      ["<div role='button' tabindex='0'><span></span></div>", "span"],
      ["<a href='#chapters'>Chapters</a>", "a"],
      ["<details><summary>More</summary></details>", "summary"],
      ["<div role='tablist'><div role='tab' tabindex='0'></div></div>", "[role='tab']"],
      ["<div role='menu'><div role='menuitem' tabindex='-1'></div></div>", "[role='menuitem']"],
    ]) {
      expect(isPressableTarget(within(html, selector))).toBe(true);
    }
  });

  it("is false for fields, sliders, the page and non-elements", () => {
    expect(isPressableTarget(within("<input>", "input"))).toBe(false);
    expect(isPressableTarget(within("<div role='slider' tabindex='0'></div>", "div"))).toBe(false);
    expect(isPressableTarget(within("<a>No link</a>", "a"))).toBe(false);
    expect(isPressableTarget(document.body)).toBe(false);
    expect(isPressableTarget(null)).toBe(false);
  });
});
