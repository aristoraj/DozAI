// @vitest-environment jsdom
// The shared loading behaviour: which button is held, when the spinner and the top bar appear, and that everything is put back.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BAR_AFTER_MS, HINT_AFTER_MS, IDLE_MS, createBusy, loadingLine, loadingState, spinnerHtml } from "./busy.js";

let doc: Document;
const press = (el: Element) => (el as HTMLElement).click();
const bar = () => doc.querySelector(".top-progress") as HTMLElement;
const hint = () => doc.querySelector(".top-progress-hint") as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = `<button class="button" id="save" data-busy-label="Saving…">Save</button><button class="button" id="plain">Go</button><button class="nav-item" id="nav">Menu</button><button class="button" id="quiet" data-no-busy>Quiet</button>`;
});
afterEach(() => { vi.useRealTimers(); });

describe("a button that starts work", () => {
  it("is guarded at once, shows its working label, and is put back when the work is done", () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    press(save);
    const end = busy.begin();
    expect(save.disabled).toBe(true);                       // cannot be pressed again
    expect(save.classList.contains("is-busy")).toBe(true);
    expect(save.getAttribute("aria-busy")).toBe("true");
    expect(save.textContent).toBe("Saving…");
    end();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(false);
    expect(save.classList.contains("is-busy")).toBe(false);
    expect(save.hasAttribute("aria-busy")).toBe(false);
    expect(save.textContent).toBe("Save");                    // the original wording is back
  });

  it("is put back when the work fails too: the end is the same either way", async () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    const work = async () => { const end = busy.begin(); try { await Promise.reject(new Error("server said no")); } finally { end(); } };
    press(save);
    await expect(work()).rejects.toThrow("server said no");
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(false);
    expect(save.textContent).toBe("Save");
  });

  it("without a working label it keeps its words and only shows the spinner", () => {
    const busy = createBusy(doc), plain = doc.getElementById("plain") as HTMLButtonElement;
    press(plain); const end = busy.begin();
    expect(plain.textContent).toBe("Go");
    expect(plain.classList.contains("is-busy")).toBe(true);
    end(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(plain.classList.contains("is-busy")).toBe(false);
  });

  it("work that follows work (save, then reload) keeps the button held until all of it is done", () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    press(save);
    const first = busy.begin(); first();
    vi.advanceTimersByTime(IDLE_MS - 50);                   // the reload starts straight away
    const second = busy.begin();
    vi.advanceTimersByTime(IDLE_MS * 3);
    expect(save.disabled).toBe(true);                       // still held
    second(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(false);
  });

  it("two requests from one press hold it once and release it when both are done", () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    press(save);
    const a = busy.begin(), b = busy.begin();
    expect(busy.heldCount()).toBe(1);
    a(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(true);
    b(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(false);
  });

  it("ending twice does no harm", () => {
    const busy = createBusy(doc);
    press(doc.getElementById("save")!);
    const end = busy.begin(); end(); end();
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(busy.pending()).toBe(0);
  });

  it("a button that was already disabled stays disabled", () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    save.disabled = true; (save as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));   // a disabled button gets no real click, so say it was pressed
    const end = busy.begin(); end(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(save.disabled).toBe(true);
  });

  it("if the page was redrawn meanwhile, the new button is left alone", () => {
    const busy = createBusy(doc), save = doc.getElementById("save") as HTMLButtonElement;
    press(save); const end = busy.begin();
    const fresh = doc.createElement("button"); fresh.className = "button"; fresh.id = "save"; fresh.textContent = "Save";
    save.replaceWith(fresh);
    end(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(fresh.disabled).toBe(false);
    expect(fresh.classList.contains("is-busy")).toBe(false);
  });
});

describe("what is not held", () => {
  it("menu items and other things that are not buttons of the app", () => {
    const busy = createBusy(doc);
    press(doc.getElementById("nav")!); const end = busy.begin();
    expect(busy.heldCount()).toBe(0);
    end(); vi.advanceTimersByTime(IDLE_MS + 1);
  });

  it("a button that opts out", () => {
    const busy = createBusy(doc);
    press(doc.getElementById("quiet")!); busy.begin();
    expect(busy.heldCount()).toBe(0);
  });

  it("work that has nothing to do with the last press (a press a while ago)", () => {
    const busy = createBusy(doc);
    press(doc.getElementById("save")!);
    vi.advanceTimersByTime(1000);
    busy.begin();
    expect(busy.heldCount()).toBe(0);
  });

  it("silent work: nothing is held, no bar, nothing counted", () => {
    const busy = createBusy(doc);
    press(doc.getElementById("save")!);
    const end = busy.begin({ silent: true });
    vi.advanceTimersByTime(BAR_AFTER_MS + 1000);
    expect(busy.heldCount()).toBe(0);
    expect(busy.pending()).toBe(0);
    expect(bar().hidden).toBe(true);
    end();
  });
});

describe("the bar along the top", () => {
  it("does not appear for quick work", () => {
    const busy = createBusy(doc);
    const end = busy.begin();
    vi.advanceTimersByTime(BAR_AFTER_MS - 50);
    expect(bar().hidden).toBe(true);
    end(); vi.advanceTimersByTime(IDLE_MS + 1);
    vi.advanceTimersByTime(BAR_AFTER_MS * 2);
    expect(bar().hidden).toBe(true);                       // and the timer that would have shown it is gone
  });

  it("appears for slow work, says it is still working when it is very slow, and goes away when the work is done", () => {
    const busy = createBusy(doc);
    const end = busy.begin();
    vi.advanceTimersByTime(BAR_AFTER_MS + 10);
    expect(bar().hidden).toBe(false);
    expect(hint().hidden).toBe(true);
    vi.advanceTimersByTime(HINT_AFTER_MS);
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toContain("Still working");
    end(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(bar().hidden).toBe(true);
    expect(hint().hidden).toBe(true);
  });

  it("stays up through a chain of requests instead of flickering between them", () => {
    const busy = createBusy(doc);
    busy.begin()();                                        // first request ends at once
    vi.advanceTimersByTime(BAR_AFTER_MS + 10);
    const second = busy.begin();
    vi.advanceTimersByTime(BAR_AFTER_MS + 10);
    expect(bar().hidden).toBe(false);
    second(); vi.advanceTimersByTime(IDLE_MS + 1);
    expect(bar().hidden).toBe(true);
  });

  it("can be read by a screen reader: a progress bar with a name, and a polite note", () => {
    createBusy(doc);
    expect(bar().getAttribute("role")).toBe("progressbar");
    expect(bar().getAttribute("aria-label")).toBe("Working");
    expect(hint().getAttribute("aria-live")).toBe("polite");
  });
});

describe("loading markup for areas that wait for data", () => {
  it("is one spinner everywhere, hidden from screen readers, with the words readable", () => {
    expect(spinnerHtml()).toContain('class="spinner"');
    expect(spinnerHtml()).toContain('aria-hidden="true"');
    expect(loadingLine("Opening the questions…")).toContain("Opening the questions…");
    expect(loadingLine()).toContain("Loading…");
    expect(loadingLine()).toContain('role="status"');
    const s = loadingState("Loading phone calls…", "Reading the calls.");
    expect(s).toContain("empty-state");
    expect(s).toContain("Loading phone calls…");
    expect(s).toContain("spinner");
  });
  it("escapes what it is given", () => {
    expect(loadingLine("<b>x</b>")).not.toContain("<b>");
    expect(loadingState("<i>t</i>", "<u>x</u>")).not.toMatch(/<i>|<u>/);
  });
});
