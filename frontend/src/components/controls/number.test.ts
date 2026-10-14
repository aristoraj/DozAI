// @vitest-environment jsdom
// Tests the custom number field with fake values. No server and no real data.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const html = (attrs = `min="1" max="5" step="1" value="3"`) => `<div class="field"><label for="n">Count</label><input id="n" type="number" ${attrs} /></div>`;

const input = () => document.getElementById("n") as HTMLInputElement;
const minus = () => document.querySelector('.cn-step[aria-label="Decrease"]') as HTMLButtonElement;
const plus = () => document.querySelector('.cn-step[aria-label="Increase"]') as HTMLButtonElement;
const flush = () => new Promise(r => setTimeout(r, 0)); // lets the MutationObserver run

beforeAll(async () => {
  const { initNumbers } = await import("./number.js");
  initNumbers();
});
beforeEach(async () => {
  document.body.innerHTML = "";
  await flush();
});

describe("custom number field", () => {
  it("adds minus and plus buttons around the real input, which keeps its value", async () => {
    document.body.innerHTML = html();
    await flush();
    expect(input().value).toBe("3");
    expect(document.querySelectorAll(".cn-step").length).toBe(2);
    expect(input().parentElement!.classList.contains("cn")).toBe(true);
  });

  it("plus and minus change the value and fire input and change, like typing would", async () => {
    document.body.innerHTML = html();
    await flush();
    const seen: string[] = [];
    input().addEventListener("input", () => seen.push(`input:${input().value}`));
    input().addEventListener("change", () => seen.push(`change:${input().value}`));
    plus().click();
    expect(input().value).toBe("4");
    minus().click();
    minus().click();
    expect(input().value).toBe("2");
    expect(seen).toEqual(["input:4", "change:4", "input:3", "change:3", "input:2", "change:2"]);
  });

  it("stops at the limits and greys out the button that can go no further", async () => {
    document.body.innerHTML = html(`min="1" max="2" step="1" value="1"`);
    await flush();
    expect(minus().disabled).toBe(true);
    expect(plus().disabled).toBe(false);
    plus().click();
    expect(input().value).toBe("2");
    expect(plus().disabled).toBe(true);
    expect(minus().disabled).toBe(false);
  });

  it("follows the step size, for example 0.5 dollars", async () => {
    document.body.innerHTML = html(`min="0" step="0.5" value="1"`);
    await flush();
    plus().click();
    expect(input().value).toBe("1.5");
  });

  it("starts from the minimum when the box is empty", async () => {
    document.body.innerHTML = html(`min="1" max="10" step="1" value=""`);
    await flush();
    plus().click();
    expect(Number(input().value)).toBeGreaterThanOrEqual(1);
    expect(input().value).not.toBe("");
  });

  it("a disabled field has disabled buttons that change nothing", async () => {
    document.body.innerHTML = html(`min="1" max="5" value="3" disabled`);
    await flush();
    expect(plus().disabled).toBe(true);
    expect(minus().disabled).toBe(true);
    plus().click();
    expect(input().value).toBe("3");
  });

  it("does not wrap the same field twice, and styles a field drawn later", async () => {
    document.body.innerHTML = `<div id="view"></div>`;
    await flush();
    document.getElementById("view")!.innerHTML = html();
    await flush();
    document.getElementById("view")!.append(document.createElement("span")); // another change, same field
    await flush();
    expect(document.querySelectorAll(".cn").length).toBe(1);
    expect(document.querySelectorAll(".cn-step").length).toBe(2);
  });
});
