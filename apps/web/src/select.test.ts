// @vitest-environment jsdom
// Tests the custom dropdown with fake options. No server and no real data.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const html = (options = `<option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option>`, attrs = "") =>
  `<div class="field"><label for="pick">Letter</label><select id="pick" ${attrs}>${options}</select></div>`;

const native = () => document.getElementById("pick") as HTMLSelectElement;
const trigger = () => document.querySelector(".cs-trigger") as HTMLButtonElement;
const list = () => document.querySelector(".cs-list");
const items = () => [...document.querySelectorAll(".cs-option")];
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const flush = () => new Promise(r => setTimeout(r, 0)); // lets the MutationObserver run

beforeAll(async () => {
  const { initSelects } = await import("./select.js");
  initSelects();
});
beforeEach(async () => {
  trigger()?.click(); // not needed when nothing is open, harmless otherwise
  document.body.innerHTML = "";
  await flush();
});

describe("custom dropdown", () => {
  it("replaces the native select with a button showing the chosen option, and keeps the select hidden inside", async () => {
    document.body.innerHTML = html();
    await flush();
    expect(trigger().textContent).toBe("Alpha");
    expect(trigger().getAttribute("aria-label")).toBe("Letter: Alpha");
    expect(native().classList.contains("cs-native")).toBe(true);
    expect(native().getAttribute("aria-hidden")).toBe("true");
    expect(list()).toBeNull(); // closed until clicked
  });

  it("opens on click, marks the chosen option, and picking one updates the select and fires change", async () => {
    document.body.innerHTML = html();
    await flush();
    const seen: string[] = [];
    native().addEventListener("change", () => seen.push(native().value));
    trigger().click();
    expect(items().map(i => i.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(items()[0]!.getAttribute("aria-selected")).toBe("true");
    (items()[2] as HTMLElement).click();
    expect(native().value).toBe("c");
    expect(seen).toEqual(["c"]);
    expect(trigger().textContent).toBe("Gamma");
    expect(list()).toBeNull(); // closes after choosing
  });

  it("does not fire change when the same option is picked again", async () => {
    document.body.innerHTML = html();
    await flush();
    let count = 0;
    native().addEventListener("change", () => count++);
    trigger().click();
    (items()[0] as HTMLElement).click();
    expect(count).toBe(0);
  });

  it("works from the keyboard: open, move, choose, and Escape closes only the list", async () => {
    document.body.innerHTML = html();
    await flush();
    key(trigger(), "ArrowDown");
    expect(list()).not.toBeNull();
    key(trigger(), "ArrowDown");
    expect(trigger().getAttribute("aria-activedescendant")).toBe(items()[1]!.id);
    key(trigger(), "Enter");
    expect(native().value).toBe("b");
    expect(list()).toBeNull();

    key(trigger(), "ArrowDown");
    let reachedPage = false;
    document.addEventListener("keydown", () => { reachedPage = true; }, { once: true });
    key(trigger(), "Escape");
    expect(list()).toBeNull();
    expect(reachedPage).toBe(false); // the dialog behind it would otherwise close too
  });

  it("jumps to an option by typing, and Home/End go to the ends", async () => {
    document.body.innerHTML = html();
    await flush();
    key(trigger(), "Enter");
    key(trigger(), "g");
    expect(items()[2]!.classList.contains("is-active")).toBe(true);
    key(trigger(), "Home");
    expect(items()[0]!.classList.contains("is-active")).toBe(true);
    key(trigger(), "End");
    expect(items()[2]!.classList.contains("is-active")).toBe(true);
  });

  it("skips disabled options", async () => {
    document.body.innerHTML = html(`<option value="a">Alpha</option><option value="b" disabled>Beta</option><option value="c">Gamma</option>`);
    await flush();
    key(trigger(), "Enter");
    key(trigger(), "ArrowDown");
    expect(items()[2]!.classList.contains("is-active")).toBe(true);
    (items()[1] as HTMLElement).click();
    expect(native().value).toBe("a"); // the disabled one cannot be chosen
  });

  it("an option can have shorter wording for the button and a quiet second line in the list", async () => {
    document.body.innerHTML = html(`<option value="a" data-short="Alpha" data-sub="First letter · 1 item">Alpha · first letter (1 item)</option><option value="b" data-short="Beta">Beta · plain</option>`);
    await flush();
    expect(trigger().textContent).toBe("Alpha");                    // the short wording, not the long one
    trigger().click();
    expect(document.querySelectorAll(".cs-opt small")).toHaveLength(1);
    expect(items()[0]!.querySelector("small")!.textContent).toBe("First letter · 1 item");
    expect(items()[1]!.textContent).toBe("Beta");                   // no second line unless one is given
    (items()[1] as HTMLElement).click();
    expect(native().value).toBe("b");
    expect(trigger().textContent).toBe("Beta");
    expect(trigger().getAttribute("aria-label")).toBe("Letter: Beta");
  });

  it("a disabled select gives a disabled button that does not open", async () => {
    document.body.innerHTML = html(undefined, "disabled");
    await flush();
    expect(trigger().disabled).toBe(true);
    trigger().click();
    expect(list()).toBeNull();
  });

  it("shows a friendly line when there is nothing to choose", async () => {
    document.body.innerHTML = html("");
    await flush();
    expect(trigger().textContent).toBe("");
    trigger().click();
    expect(list()!.textContent).toBe("Nothing to choose from");
  });

  it("styles a screen that is drawn later, and closes the list if its screen is redrawn", async () => {
    document.body.innerHTML = `<div id="view"></div>`;
    await flush();
    document.getElementById("view")!.innerHTML = html();
    await flush();
    expect(document.querySelectorAll(".cs-trigger").length).toBe(1);
    trigger().click();
    expect(list()).not.toBeNull();
    document.getElementById("view")!.innerHTML = html();
    await flush();
    expect(list()).toBeNull();
    expect(document.querySelectorAll(".cs-trigger").length).toBe(1);
  });

  it("follows the select when other code sets its value and fires change", async () => {
    document.body.innerHTML = html();
    await flush();
    native().value = "b";
    native().dispatchEvent(new Event("change", { bubbles: true }));
    expect(trigger().textContent).toBe("Beta");
  });

  it("closes when the user clicks elsewhere", async () => {
    document.body.innerHTML = html() + `<p id="elsewhere">x</p>`;
    await flush();
    trigger().click();
    document.getElementById("elsewhere")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(list()).toBeNull();
  });
});
