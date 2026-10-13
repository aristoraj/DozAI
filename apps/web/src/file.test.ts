// @vitest-environment jsdom
// Tests the custom file picker with fake files. No server and no real data.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const html = (attrs = "") => `<div class="field"><label for="f">CSV file</label><input type="file" id="f" accept=".csv" ${attrs} /></div>`;
const input = () => document.getElementById("f") as HTMLInputElement;
const button = () => document.querySelector(".cf button") as HTMLButtonElement;
const label = () => document.querySelector(".cf-name") as HTMLElement;
const flush = () => new Promise(r => setTimeout(r, 0)); // lets the MutationObserver run

/** jsdom cannot pick a real file, so give the input a fake list of files. */
const choose = (names: string[]) => {
  Object.defineProperty(input(), "files", { configurable: true, value: names.map(n => ({ name: n })) });
  input().dispatchEvent(new Event("change", { bubbles: true }));
};

beforeAll(async () => {
  const { initFiles } = await import("./file.js");
  initFiles();
});
beforeEach(async () => {
  document.body.innerHTML = "";
  await flush();
});

describe("custom file picker", () => {
  it("replaces the browser's picker with a button and a file name, keeping the real input hidden inside", async () => {
    document.body.innerHTML = html();
    await flush();
    expect(button().textContent).toBe("Choose a file");
    expect(label().textContent).toBe("No file chosen");
    expect(input().classList.contains("cf-native")).toBe(true);
    expect(input().getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(".cf")).toHaveLength(1);
  });

  it("the button opens the real file dialog", async () => {
    document.body.innerHTML = html();
    await flush();
    let opened = 0;
    input().addEventListener("click", () => opened++);
    button().click();
    expect(opened).toBe(1);
  });

  it("shows the chosen file's name, and goes back when nothing is chosen", async () => {
    document.body.innerHTML = html();
    await flush();
    const seen: string[] = [];
    input().addEventListener("change", () => seen.push(input().files![0]?.name ?? "none")); // the app's own listener still works
    choose(["participants-batch-7.csv"]);
    expect(label().textContent).toBe("participants-batch-7.csv");
    expect(label().classList.contains("has-file")).toBe(true);
    choose([]);
    expect(label().textContent).toBe("No file chosen");
    expect(label().classList.contains("has-file")).toBe(false);
    expect(seen).toEqual(["participants-batch-7.csv", "none"]);
  });

  it("a disabled file field gives a disabled button", async () => {
    document.body.innerHTML = html("disabled");
    await flush();
    expect(button().disabled).toBe(true);
  });

  it("a click on the field's label lands on the visible button", async () => {
    document.body.innerHTML = html();
    await flush();
    input().focus();
    expect(document.activeElement).toBe(button());
  });

  it("styles a field drawn later, and never wraps the same field twice", async () => {
    document.body.innerHTML = `<div id="view"></div>`;
    await flush();
    document.getElementById("view")!.innerHTML = html();
    await flush();
    document.getElementById("view")!.append(document.createElement("span")); // another change, same field
    await flush();
    expect(document.querySelectorAll(".cf")).toHaveLength(1);
    expect(document.querySelectorAll(".cf button")).toHaveLength(1);
  });
});
