// The question editor: read the questions of a mission the way both channels will use them, and edit, remove or add them,
// without touching JSON. Used when a mission is first drafted and again just before sign-off.
//
// Two parts. First the changes to a mission definition, written as plain functions that return a new definition (so they can be
// tested on their own). Then the screen, which draws one card per question and calls those functions.
// Nothing here changes the shape of the mission: a question stays a question, and each one still has its own "what to find out" entry.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = x => JSON.parse(JSON.stringify(x));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Wording compared without capitals, punctuation or extra spaces. Hindi vowel signs are kept. */
export const normaliseWording = s => String(s ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

/** A short name made of letters, digits and underscores, for an answer key or a choice value. */
export function slug(text, max = 30) {
  const words = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return words.slice(0, 5).join("_").slice(0, max).replace(/_+$/, "");
}

/** A category (the "module" of a question) as one tidy key: "Same Job" and "same_job" are one category. Same rule as the server. */
export const categoryKey = name => String(name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
/** The category as people read it: "same_job" is "Same job". */
export const categoryTitle = key => String(key).replace(/[_-]+/g, " ").replace(/^\w/, c => c.toUpperCase());
/** The categories of a mission in the order they first appear. */
export const categoriesOf = def => [...new Set(def.instrument.questions.map(q => q.module))];

const optionsOf = q => (q.type === "yesno" ? [{ key: "1", label: "Yes", value: "yes" }, { key: "2", label: "No", value: "no" }] : q.options || []);

/** The question that follows `q` when nothing special applies: its "otherwise" rule, else the next one in the list. null = the end. */
export function defaultNext(ins, q) {
  const rule = (q.next || []).find(r => !r.when);
  if (rule) return rule.goto;
  const at = ins.questions.findIndex(x => x.id === q.id);
  return ins.questions[at + 1]?.id ?? null;
}

/** Every road through the questionnaire: the question ids asked, and the answers that decided the road. Null when there are too many. */
function roads(ins) {
  const out = []; const first = ins.questions[0];
  if (!first) return out;
  let capped = false;
  const byId = id => ins.questions.find(x => x.id === id);
  const walk = (q, asked, decided) => {
    if (capped) return;
    for (const v of q.type === "text" ? ["(text)"] : optionsOf(q).map(o => o.value)) {
      const rule = (q.next || []).find(r => !r.when || r.when.equals === v);
      const nextId = rule ? rule.goto : defaultNext(ins, q);
      const here = [...asked, q.id], dec = (q.next || []).some(r => r.when) ? [...decided, [q.id, v]] : decided;
      const next = nextId ? byId(nextId) : null;
      if (!next || here.includes(next.id)) { out.push({ ids: here, decided: dec }); if (out.length > 500) { capped = true; return; } }
      else walk(next, here, dec);
    }
  };
  walk(first, [], []);
  return capped ? null : out;
}

/** "Asked of everyone", or "Only if <earlier question> is <answer>": what a person reading the list needs to know about when it is asked. */
export function whenText(def, q) {
  const all = roads(def.instrument);
  if (!all) return "";
  const mine = all.filter(r => r.ids.includes(q.id));
  if (!mine.length) return "Not reached by any answer. Check the order of the questions";
  if (mine.length === all.length) return "Asked of everyone";
  const common = mine[0].decided.filter(([id, v]) => mine.every(r => r.decided.some(([i2, v2]) => i2 === id && v2 === v)));
  if (!common.length) return "Asked only on some answers";
  const [srcId, value] = common[0];
  const src = def.instrument.questions.find(x => x.id === srcId);
  const need = (def.evidence_requirements || []).find(r => r.key === src.evidence_key);
  const answer = optionsOf(src).find(o => o.value === value)?.label ?? value;
  return `Only if ${(need?.label ?? clip(src.text, 40)).toLowerCase()} is “${answer}”`;
}

/**
 * Another question that says the same thing and could be asked of the same person. The same wording on two different branches
 * ("where do you work" for people who stayed and for people who moved) is fine. A question being added goes at the end, so it is
 * asked of everyone. (The server checks again before anything is saved.)
 */
export function findRepeat(def, text, exceptId) {
  const t = normaliseWording(text);
  if (!t) return null;
  const all = exceptId ? roads(def.instrument) : null;
  const together = other => !all || all.some(r => r.ids.includes(exceptId) && r.ids.includes(other.id));
  const i = def.instrument.questions.findIndex(q => q.id !== exceptId && normaliseWording(q.text) === t && together(q));
  return i < 0 ? null : { number: i + 1, question: def.instrument.questions[i] };
}

const unique = (base, taken) => { let v = base, n = 2; while (taken.has(v)) v = `${base.slice(0, 36)}_${n++}`; return v; };

/** Validate the pieces a person can type, and say what is wrong in plain words. */
function checkFields(def, f, exceptId) {
  const text = (f.text || "").trim();
  if (text.length < 3) return "Write the question.";
  if (text.length > 900) return "The question is too long. Keep it under 900 characters.";
  const dup = findRepeat(def, text, exceptId);
  if (dup) return `This is the same as question ${dup.number}. Each question should be asked once.`;
  if (f.labels) {
    const labels = f.labels.map(l => l.trim());
    if (labels.some(l => !l)) return "Every answer choice needs some words.";
    if (labels.some(l => l.length > 120)) return "An answer choice is too long. Keep each under 120 characters.";
    if (new Set(labels.map(normaliseWording)).size !== labels.length) return "Two answer choices say the same thing.";
  }
  return null;
}

/**
 * Change a question: what is read on WhatsApp, the wording of its answer choices, its category, and whether it is required.
 * The phone wording is read only. It is never taken from the edit. If the written wording changes and the phone wording was following it
 * automatically, the wording the phone has now (`patch.phone`) is written into the question's own phone wording first, so the phone sounds the same.
 */
export function updateQuestion(def, id, patch) {
  const q0 = def.instrument.questions.find(q => q.id === id);
  if (!q0) return { error: "That question is no longer there." };
  const error = checkFields(def, { text: patch.text, labels: q0.type === "choice" ? patch.labels : undefined }, id);
  if (error) return { error };
  const next = clone(def); const q = next.instrument.questions.find(x => x.id === id);
  q.text = patch.text.trim();
  if (q.type === "choice" && patch.labels) q.options = q.options.map((o, n) => ({ ...o, label: patch.labels[n].trim() })); // the saved values never change
  const reworded = q.text !== q0.text || (q.type === "choice" && q.options.some((o, n) => o.label !== q0.options[n].label));
  if (reworded && !q0.spoken && patch.phone) q.spoken = patch.phone;
  if (patch.category !== undefined) { const key = categoryKey(patch.category); if (!key) return { error: "Give the category a name." }; q.module = key; }
  const need = (next.evidence_requirements || []).find(r => r.key === q.evidence_key);
  if (need && patch.required !== undefined) need.required = !!patch.required;
  return { def: next };
}

/** Remove a question and everything that only existed for it. A question that other things depend on is not removed: it says what depends on it. */
export function removeQuestion(def, id) {
  const ins = def.instrument, q = ins.questions.find(x => x.id === id);
  if (!q) return { blocked: "That question is no longer there." };
  if (ins.questions.length < 2) return { blocked: "A mission needs at least one question." };
  const needs = def.evidence_requirements || [];
  const dependents = needs.filter(r => r.key !== q.evidence_key && (r.when?.key === q.evidence_key || r.verify_when?.key === q.evidence_key));
  if (dependents.length) return { blocked: `Other questions depend on the answer to this one (${dependents.map(r => r.label).join(", ")}). Remove those first, or edit this question instead.` };
  const next = clone(def);
  const after = defaultNext(next.instrument, q); // where the interview goes if this question is skipped
  const before = next.instrument.questions;
  const list = before.filter(x => x.id !== id);
  // A question with no rule of its own simply goes to whatever is next in the list. Taking one out of the list must not change where those go.
  for (const o of list) {
    const was = before[before.findIndex(x => x.id === o.id) + 1]?.id ?? null, now = list[list.findIndex(x => x.id === o.id) + 1]?.id ?? null;
    if (!(o.next || []).some(r => !r.when) && was === id && now !== after) o.next = [...(o.next || []), { goto: after }];
  }
  next.instrument.questions = list;
  for (const o of list) for (const r of o.next || []) if (r.goto === id) r.goto = after;
  if (!next.instrument.questions.some(x => x.evidence_key === q.evidence_key)) next.evidence_requirements = (next.evidence_requirements || []).filter(r => r.key !== q.evidence_key);
  return { def: next };
}

/** Add a question at the end of the interview. It gets its own short key, its own "what to find out" entry, and is asked of everyone. */
export function addQuestion(def, spec) {
  const labels = spec.type === "choice" ? (spec.options || []).map(l => l.trim()).filter(Boolean) : undefined;
  if (spec.type === "choice" && (labels.length < 2 || labels.length > 10)) return { error: "Give between 2 and 10 answer choices, one per line." };
  const error = checkFields(def, { text: spec.text, labels });
  if (error) return { error };
  const category = spec.category === undefined ? (def.instrument.questions.at(-1)?.module || "general") : categoryKey(spec.category);
  if (!category) return { error: "Give the category a name." };
  const next = clone(def); const ins = next.instrument;
  const keys = new Set(ins.questions.map(q => q.evidence_key)), ids = new Set(ins.questions.map(q => q.id));
  const text = spec.text.trim();
  const key = unique(slug(text) || "question", keys);
  const id = unique(`q_${key}`.slice(0, 40), ids);
  const q = { id, module: category, type: spec.type, text, evidence_key: key }; // the phone wording is made automatically and is not written by hand
  if (spec.type === "choice") {
    const taken = new Set();
    q.options = labels.map((label, n) => { const value = unique(slug(label, 40) || `option_${n + 1}`, taken); taken.add(value); return { key: String(n + 1), label, value }; });
  }
  // Every road that used to end now ends with the new question.
  for (const o of ins.questions) for (const r of o.next || []) if (r.goto === null) r.goto = id;
  ins.questions.push(q);
  const label = clip(text.replace(/[?\s]+$/, ""), 80);
  next.evidence_requirements = [...(next.evidence_requirements || []), { key, label: label.charAt(0).toUpperCase() + label.slice(1), required: spec.required !== false, min_confidence: 0.6 }];
  return { def: next, id };
}

// ---- the screen ---------------------------------------------------------------------------------------------------------------------

const TYPE_LABEL = { text: "Free text answer", choice: "Choose one", yesno: "Yes or no" };

function autosize(el) { if (!el || !el.offsetParent) return; el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; }

/**
 * One editor per mission being reviewed. `check(def)` asks the server what is wrong with the questions as they now stand and what the voice
 * agent would say; `onChange` is told when the problems, the busy state or the changed state moves, so the page can enable or disable its
 * Save or Sign off button.
 */
export function createQuestionEditor({ def, check, canEdit = true, onChange }) {
  const original = JSON.stringify(def.instrument.questions) + JSON.stringify(def.evidence_requirements || []);
  const S = { def: clone(def), editing: null, ed: null, edError: null, confirm: null, blocked: null, adding: false, form: null, formError: null, phone: {}, problems: [], checked: false, checkFailed: false, root: null, seq: 0 };
  const api = {};

  const changed = () => JSON.stringify(S.def.instrument.questions) + JSON.stringify(S.def.evidence_requirements || []) !== original;
  const busy = () => !!S.editing || S.adding;
  const notify = () => onChange?.({ changed: changed(), busy: busy(), problems: S.problems, checked: S.checked });

  async function runCheck() {
    const mine = ++S.seq;
    try {
      const r = await check(S.def);
      if (mine !== S.seq) return;
      S.problems = r.problems || []; S.phone = Object.fromEntries((r.phone || []).map(p => [p.id, p.spoken])); S.checked = true; S.checkFailed = false;
    } catch (e) { if (mine !== S.seq) return; S.checkFailed = true; S.problems = [`Could not check the questions just now: ${e.message}`]; }
    render(); notify();
  }

  const applyNew = next => { S.def = next; S.editing = null; S.adding = false; S.confirm = null; S.blocked = null; S.edError = null; S.formError = null; render(); notify(); runCheck(); };

  const opts = q => (q.type === "text" ? "" : `<ul class="q-opts">${optionsOf(q).map((o, n) => `<li><span>${n + 1}</span>${esc(o.label)}</li>`).join("")}</ul>`);

  function card(q, n) {
    const need = (S.def.evidence_requirements || []).find(r => r.key === q.evidence_key);
    const required = need ? need.required !== false : true;
    const head = `<header class="q-head"><span class="q-num">${n + 1}</span>
      <div class="q-meta"><strong>${esc(whenText(S.def, q))}</strong><small title="Saved as ${esc(q.evidence_key)}">${esc(TYPE_LABEL[q.type])} · ${required ? "Must be answered" : "Optional"}</small></div>`;
    if (S.editing === q.id) return `<article class="q-card editing" data-q="${esc(q.id)}">${head}</header>${editForm(q)}</article>`;
    const actions = !canEdit ? "" : S.confirm === q.id
      ? `<div class="q-actions"><span class="q-sure">Remove this question?</span><button class="button ghost small" data-q-keep>Keep it</button><button class="button danger small" data-q-remove-yes>Yes, remove</button></div>`
      : `<div class="q-actions"><button class="button ghost small" data-q-edit>Edit</button><button class="button ghost small danger-text" data-q-remove>Remove</button></div>`;
    const spoken = S.phone[q.id];
    return `<article class="q-card" data-q="${esc(q.id)}">${head}${actions}</header>
      ${S.blocked?.id === q.id ? `<p class="q-warn" role="alert">${esc(S.blocked.text)}</p>` : ""}
      <div class="q-channels">
        <section class="q-channel"><h4><span class="q-dot wa"></span>WhatsApp</h4><p>${esc(q.text)}</p>${opts(q)}</section>
        <section class="q-channel"><h4><span class="q-dot ph"></span>Phone call<em>read only</em></h4><p>${spoken ? esc(spoken) : `<span class="muted">Worked out from the written question when the call is placed.</span>`}</p></section>
      </div></article>`;
  }

  /** A dropdown of the existing categories, and a box for a new one when "A new category" is chosen. */
  function categoryField(prefix, value, fresh) {
    const cats = categoriesOf(S.def), adding = value === "__new";
    return `<div class="field"><label for="${prefix}Category">Category</label><select id="${prefix}Category" data-${prefix}="category">${cats.map(c => `<option value="${esc(c)}" ${c === value ? "selected" : ""}>${esc(categoryTitle(c))}</option>`).join("")}<option value="__new" ${adding ? "selected" : ""}>A new category…</option></select></div>
      ${adding ? `<div class="field"><label for="${prefix}NewCategory">Name of the new category</label><input id="${prefix}NewCategory" data-${prefix}="newCategory" maxlength="40" value="${esc(fresh)}" placeholder="For example: income" autocomplete="off"></div>` : ""}`;
  }

  function editForm(q) {
    const e = S.ed;
    return `<div class="q-form">
      <div class="field full"><label for="qeText">What people read on WhatsApp</label><textarea id="qeText" rows="3" maxlength="900" data-qe="text">${esc(e.text)}</textarea></div>
      <div class="field full"><span class="q-legend">What the voice agent says on a call <small>Read only. It stays as it is when you change the WhatsApp wording.</small></span><p class="q-fixed">${esc(S.phone[q.id] || "Worked out from the written question when the call is placed.")}</p></div>
      ${categoryField("qe", e.category, e.newCategory)}
      ${q.type === "choice" ? `<div class="field full"><span class="q-legend">Answer choices <small>You can reword them. What is saved for each one stays the same.</small></span>${e.labels.map((l, n) => `<input type="text" class="q-opt-input" aria-label="Answer choice ${n + 1}" maxlength="120" value="${esc(l)}" data-qe-label="${n}">`).join("")}</div>` : ""}
      <label class="q-check"><input type="checkbox" data-qe="required" ${e.required ? "checked" : ""}><span>This question must be answered</span></label>
      <p class="q-warn" id="qeWarn" role="alert" ${S.edError ? "" : "hidden"}>${esc(S.edError || "")}</p>
      <div class="q-form-actions"><button class="button ghost small" data-q-cancel>Cancel</button><button class="button primary small" data-q-save>Save question</button></div></div>`;
  }

  function addForm() {
    const f = S.form;
    return `<div class="q-card editing q-add"><header class="q-head"><span class="q-num">+</span><div class="q-meta"><strong>Add a question</strong><small>It is asked at the end, of everyone. Both WhatsApp and phone calls will use it.</small></div></header>
      <div class="q-form">
        <div class="field full"><label for="qaText">The question</label><textarea id="qaText" rows="3" maxlength="900" data-qa="text" placeholder="For example: What is your monthly income?">${esc(f.text)}</textarea></div>
        <div class="field"><label for="qaType">How do people answer?</label><select id="qaType" data-qa="type"><option value="text" ${f.type === "text" ? "selected" : ""}>Free text answer</option><option value="choice" ${f.type === "choice" ? "selected" : ""}>Choose one</option><option value="yesno" ${f.type === "yesno" ? "selected" : ""}>Yes or no</option></select></div>
        ${f.type === "choice" ? `<div class="field full"><label for="qaOpts">Answer choices</label><textarea id="qaOpts" rows="4" data-qa="options" placeholder="One answer per line">${esc(f.options)}</textarea><small>One per line, between 2 and 10.</small></div>` : ""}
        ${categoryField("qa", f.category, f.newCategory)}
        <p class="q-fixed-note">The phone wording is made automatically from the written question and cannot be changed.</p>
        <label class="q-check"><input type="checkbox" data-qa="required" ${f.required ? "checked" : ""}><span>This question must be answered</span></label>
        <p class="q-warn" id="qaWarn" role="alert" ${S.formError ? "" : "hidden"}>${esc(S.formError || "")}</p>
        <div class="q-form-actions"><button class="button ghost small" data-q-add-cancel>Cancel</button><button class="button primary small" data-q-add-save>Add this question</button></div></div></div>`;
  }

  /** The cards under their category headings. A question keeps its number (its place in the order), which is what the checks refer to. */
  function groupedCards() {
    const groups = [];
    S.def.instrument.questions.forEach((q, n) => { let g = groups.find(x => x.key === q.module); if (!g) { g = { key: q.module, items: [] }; groups.push(g); } g.items.push([q, n]); });
    return groups.map(g => `<section class="q-group" aria-label="${esc(categoryTitle(g.key))}"><h3 class="q-group-title">${esc(categoryTitle(g.key))}<span>${g.items.length}</span></h3><div class="q-list">${g.items.map(([q, n]) => card(q, n)).join("")}</div></section>`).join("");
  }

  function render() {
    const root = S.root; if (!root) return;
    const problems = S.problems.length ? `<div class="q-problems" role="alert"><strong>${S.checkFailed ? "Not checked" : "Fix this before you continue"}</strong><ul>${S.problems.slice(0, 6).map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>`
      : S.checked ? `<p class="q-ok">✓ No problems found. WhatsApp and phone calls ask the same things.</p>` : "";
    root.innerHTML = `<div class="q-editor">${problems}${groupedCards()}
      ${canEdit ? (S.adding ? addForm() : `<button class="button ghost q-add-button" data-q-add ${S.editing ? "disabled" : ""}>+ Add a question</button>`) : ""}</div>`;
    root.querySelectorAll("textarea").forEach(autosize);
  }

  function onClick(e) {
    const t = e.target.closest("button"); if (!t || !S.root.contains(t)) return;
    const id = t.closest("[data-q]")?.dataset.q, q = id && S.def.instrument.questions.find(x => x.id === id);
    if (t.hasAttribute("data-q-edit") && q) {
      const need = (S.def.evidence_requirements || []).find(r => r.key === q.evidence_key);
      S.editing = id; S.adding = false; S.confirm = null; S.blocked = null; S.edError = null;
      S.ed = { text: q.text, labels: q.type === "choice" ? q.options.map(o => o.label) : [], required: need ? need.required !== false : true, category: q.module, newCategory: "" };
      render(); notify(); S.root.querySelector("#qeText")?.focus();
    } else if (t.hasAttribute("data-q-cancel")) { S.editing = null; S.edError = null; render(); notify();
    } else if (t.hasAttribute("data-q-save")) {
      const e = S.ed, cur = S.def.instrument.questions.find(x => x.id === S.editing);
      const r = updateQuestion(S.def, S.editing, { text: e.text, labels: e.labels, required: e.required, category: e.category === "__new" ? e.newCategory : e.category, phone: S.phone[cur.id] });
      if (r.error) { S.edError = r.error; const w = S.root.querySelector("#qeWarn"); if (w) { w.textContent = r.error; w.hidden = false; } return; }
      applyNew(r.def);
    } else if (t.hasAttribute("data-q-remove")) { S.confirm = id; S.blocked = null; render();
    } else if (t.hasAttribute("data-q-keep")) { S.confirm = null; render();
    } else if (t.hasAttribute("data-q-remove-yes")) {
      const r = removeQuestion(S.def, id);
      if (r.blocked) { S.confirm = null; S.blocked = { id, text: r.blocked }; render(); return; }
      applyNew(r.def);
    } else if (t.hasAttribute("data-q-add")) { S.adding = true; S.editing = null; S.form = { text: "", type: "text", options: "", required: true, category: S.def.instrument.questions.at(-1)?.module || "general", newCategory: "" }; S.formError = null; render(); notify(); S.root.querySelector("#qaText")?.focus();
    } else if (t.hasAttribute("data-q-add-cancel")) { S.adding = false; S.formError = null; render(); notify();
    } else if (t.hasAttribute("data-q-add-save")) {
      const f = S.form;
      const r = addQuestion(S.def, { text: f.text, type: f.type, options: f.options.split(/\r?\n/), required: f.required, category: f.category === "__new" ? f.newCategory : f.category });
      if (r.error) { S.formError = r.error; const w = S.root.querySelector("#qaWarn"); if (w) { w.textContent = r.error; w.hidden = false; } return; }
      applyNew(r.def);
    }
  }

  function onInput(e) {
    const el = e.target; if (!S.root.contains(el)) return;
    if (el.tagName === "TEXTAREA") autosize(el);
    const qe = el.dataset.qe, qa = el.dataset.qa;
    if (S.editing && (qe || el.dataset.qeLabel !== undefined)) {
      if (el.dataset.qeLabel !== undefined) S.ed.labels[Number(el.dataset.qeLabel)] = el.value;
      else S.ed[qe] = qe === "required" ? el.checked : el.value;
      if (qe === "text") warnRepeat(el.value, S.editing, "#qeWarn");
      if (qe === "category") render();
    } else if (S.adding && qa) {
      S.form[qa] = qa === "required" ? el.checked : el.value;
      if (qa === "text") warnRepeat(el.value, null, "#qaWarn");
      if (qa === "type" || qa === "category") render(); // the answer choices box appears only for "Choose one", and the name box only for a new category
    }
  }
  // While typing, say at once when the question repeats another. Saving checks again.
  function warnRepeat(text, exceptId, sel) {
    const w = S.root.querySelector(sel); if (!w) return;
    const d = findRepeat(S.def, text, exceptId);
    w.textContent = d ? `This is the same as question ${d.number}. Each question should be asked once.` : ""; w.hidden = !d;
  }

  Object.assign(api, {
    /** Draw into `root`. Safe to call again after the page around it was redrawn. */
    mount(root) { S.root = root; if (!root._qBound) { root.addEventListener("click", onClick); root.addEventListener("input", onInput); root.addEventListener("change", onInput); root._qBound = true; } render(); },
    runCheck,
    getDef: () => clone(S.def),
    isChanged: changed,
    isBusy: busy,
    problems: () => S.problems,
    isChecked: () => S.checked,
  });
  return api;
}
