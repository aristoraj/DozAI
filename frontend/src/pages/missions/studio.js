// Create a mission: the brief, the draft, and the question review.
import { state } from "../../lib/state.js";
import { esc } from "../../lib/format.js";
import { employeeChoices } from "./add-modal.js";
import { $, modal, modalBackdrop } from "../../lib/dom.js";
import { closeModal } from "../../components/modal.js";
import { api, loadAll } from "../../lib/api.js";
import { resultsHtml } from "./index.js";
import { wordingHtml } from "./wording.js";
import { createQuestionEditor } from "../../components/question-editor.js";
import { render } from "../../shell.js";
import { toast } from "../../components/toast.js";

// ---- Mission Studio: write a mission as a plain brief, let the drafter structure it, read it, save it as a draft ---------------------------------------------
export function openStudioModal() {
  const s = { step: "brief", running: false, error: null, result: null, brief: { name: "", programme_name: "", goal: "", people: "", find_out: "", approach: "", start_from: state.defaultMission, employee: "", max_attempts: "", window_start_hour: "", window_end_hour: "" } };
  const read = () => {
    const b = s.brief, out = { name: b.name.trim(), programme_name: b.programme_name.trim(), goal: b.goal.trim(), people: b.people.trim(), find_out: b.find_out.trim() };
    if (b.approach.trim()) out.approach = b.approach.trim();
    if (b.start_from) out.start_from = b.start_from;
    if (b.employee) { const [id, ver] = b.employee.split("|"); out.employee_id = id; if (ver) out.employee_version = ver; }
    for (const k of ["max_attempts", "window_start_hour", "window_end_hour"]) if (String(b[k]).trim() !== "") out[k] = Number(b[k]);
    return out;
  };
  // ---- the form screen -------------------------------------------------------------------------------------------------------------
  const STUDIO_STEPS = ["Describe", "Draft", "Review", "Save"];
  const LIMITS = { name: [3, 100], programme_name: [1, 80], goal: [20, 1500], people: [10, 1000], find_out: [10, 3000], approach: [0, 1500] }; // the same limits the server checks
  const hourLabel = h => (h === 24 ? "12:00 am (end of day)" : `${Math.floor(h) % 12 || 12}:${h % 1 ? "30" : "00"} ${h < 12 ? "am" : "pm"}`);
  const hourSelect = (id, value, label) => `<select id="${id}" aria-label="${label}"><option value="">Usual</option>${Array.from({ length: 49 }, (_, i) => i / 2).map(h => `<option value="${h}" ${String(h) === String(value) ? "selected" : ""}>${hourLabel(h)}</option>`).join("")}</select>`;
  const autosize = el => { if (!el.offsetParent) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 260)}px`; }; // not while the dialog is hidden: it would measure as zero // grows as you type, so there are no big empty boxes

  /** Plain-words problems with the brief, found before anything is sent. The server checks the same limits again. */
  const briefProblems = b => {
    const out = [], len = k => String(b[k] ?? "").trim().length;
    if (len("name") < 3 || len("name") > 100) out.push("Give the mission a name (3 to 100 characters).");
    if (len("programme_name") < 1 || len("programme_name") > 80) out.push("Say what the programme is called (up to 80 characters).");
    if (len("goal") < 20) out.push("Say what the mission is trying to achieve, in at least 20 characters.");
    if (len("people") < 10) out.push("Say who the people are, in at least 10 characters.");
    if (len("find_out") < 10) out.push("Say what you need to find out about each person, in at least 10 characters.");
    for (const k of ["goal", "people", "find_out", "approach"]) if (len(k) > LIMITS[k][1]) out.push(`That text is too long: keep it under ${LIMITS[k][1]} characters.`);
    const att = String(b.max_attempts).trim();
    if (att !== "" && !(Number.isInteger(Number(att)) && Number(att) >= 1 && Number(att) <= 10)) out.push("Most contact attempts has to be a whole number from 1 to 10.");
    const ws = String(b.window_start_hour), we = String(b.window_end_hour);
    if (ws !== "" && we !== "" && Number(ws) >= Number(we)) out.push("Contact hours must end after they start.");
    return [...new Set(out)];
  };

  /** One line that says what the optional settings are, so they can stay folded away. */
  const settingsSummary = () => {
    const b = s.brief, picked = state.missions.find(m => m.version === b.start_from);
    const ws = String(b.window_start_hour), we = String(b.window_end_hour), att = String(b.max_attempts).trim();
    const hours = ws === "" && we === "" ? "usual contact hours" : `contact ${ws === "" ? "from the usual start" : "from " + hourLabel(Number(ws))} ${we === "" ? "to the usual end" : "to " + hourLabel(Number(we))}`;
    const who = b.employee ? ` · employee ${b.employee.split("|").join(" ")}` : "";
    return `${picked ? "Using " + picked.name : "Using the standard setup"}${who} · ${att ? att + " attempts at most" : "usual attempts"} · ${hours}`;
  };

  const field = (id, label, hint, rows, value, key) => {
    const [min, max] = LIMITS[key];
    return `<div class="field full"><div class="field-label"><label for="${id}">${label}</label><span class="field-count" id="${id}Count" data-min="${min}" data-max="${max}"></span></div><small class="field-hint">${hint}</small><textarea id="${id}" rows="${rows}" class="t-md">${esc(value)}</textarea></div>`;
  };

  const countLine = (id, value) => {
    const el = $(id + "Count"); if (!el) return;
    const n = value.trim().length, min = Number(el.dataset.min), max = Number(el.dataset.max);
    el.textContent = `${n} / ${max}`;
    el.classList.toggle("is-short", n > 0 && n < min);       // typed something, but not enough yet
    el.classList.toggle("is-long", n > max);
  };

  const drawBrief = () => {
    const b = s.brief, open = !!s.settingsOpen;
    modal.classList.add("modal-sticky");                      // only the middle scrolls, so Cancel and Draft are always in view
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">Create a mission</h2><p>Describe the mission in your own words. The drafter turns it into the questions and checklist the employee works from.</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      ${s.running ? '<div class="studio-progress" role="progressbar" aria-label="Drafting the mission"></div>' : ""}
      <div class="stepper" aria-label="Steps">${STUDIO_STEPS.map((n, i) => `<div class="stepper-item ${i === 0 ? "active" : ""}" ${i === 0 ? 'aria-current="step"' : ""}><span class="stepper-number">${i + 1}</span><span>${n}</span></div>`).join("")}</div>
      <div class="modal-body">
        <div class="studio-note"><span class="studio-note-icon" aria-hidden="true">i</span><p><strong>Describe the programme, not people.</strong> Do not write any person's name or phone number here. You read and approve the draft before anyone is contacted.</p></div>
        ${s.problems?.length ? `<div class="studio-problems" role="alert"><strong>${s.problems.length === 1 ? "One thing to fix" : "A few things to fix"}</strong><ul>${s.problems.map(p => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
        ${s.error ? `<div class="studio-problems" role="alert"><strong>The draft could not be started</strong><p>${esc(s.error)}</p></div>` : ""}
        <fieldset class="studio-fields" ${s.running ? "disabled" : ""}>
          <section class="form-section"><h3>About the mission</h3><div class="form-grid">
            <div class="field"><label for="sName">Mission name</label><input id="sName" value="${esc(b.name)}" placeholder="Six-month placement check" /></div>
            <div class="field"><label for="sProg">Programme name <span class="opt">(as participants see it)</span></label><input id="sProg" value="${esc(b.programme_name)}" placeholder="Project Udaan" /></div>
          </div></section>
          <section class="form-section"><h3>What it is for</h3><div class="form-grid">
            ${field("sGoal", "What is this mission trying to achieve?", "For example: find out whether people we placed in jobs are still working there six months on, and whether they want support.", 3, b.goal, "goal")}
            ${field("sPeople", "Who are the people?", "For example: young people who finished a three-month retail training with us last year, mostly on basic phones.", 2, b.people, "people")}
            ${field("sFind", "What must we find out about each person?", "One thing per line is clearest. Say when something only applies to some people, for example: &quot;the name of their employer, if they are working&quot;.", 5, b.find_out, "find_out")}
          </div></section>
          <section class="form-section"><h3>Tone and style <span class="opt">(optional)</span></h3><div class="form-grid">
            ${field("sApproach", "Tone, things to avoid, languages", "For example: be warm and brief; never promise jobs; do not ask about family.", 2, b.approach, "approach")}
          </div></section>
          <section class="form-section"><button type="button" class="settings-toggle" id="sToggle" aria-expanded="${open}"><span><strong>Settings</strong> <span class="opt">(optional)</span><small id="sSummary">${esc(settingsSummary())}</small></span><svg class="settings-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            ${open ? `<div class="form-grid settings-panel">
              <div class="field full"><label for="sFrom">Use the approved first message, contact rules and employee from</label><select id="sFrom">${state.missions.map(m => `<option value="${esc(m.version)}" ${m.version === b.start_from ? "selected" : ""}>${esc(m.name)} · ${esc(m.version)}</option>`).join("")}</select><small>The first WhatsApp message must be a template approved by WhatsApp, so it is copied rather than drafted.</small></div>
              <div class="field full"><label for="sEmp">Which employee does this mission</label><select id="sEmp"><option value="" ${!b.employee ? "selected" : ""}>The same as that mission</option>${employeeChoices(b.employee)}</select><small class="field-hint">Follow an employee to always use its newest version, or pin one exact version. Employees are set up under Claude engine.</small></div>
              <div class="field"><label for="sAtt">Most contact attempts per person</label><input id="sAtt" type="number" min="1" max="10" placeholder="Usual" value="${esc(b.max_attempts)}" /></div>
              <div class="field"><label for="sWs">Contact hours</label><div class="hours-row">${hourSelect("sWs", b.window_start_hour, "Contact hours, from")}<span>to</span>${hourSelect("sWe", b.window_end_hour, "Contact hours, until")}</div></div>
            </div>` : ""}</section>
        </fieldset>
      </div>
      <div class="modal-foot"><button class="button ghost" id="cancelS">Cancel</button><span class="foot-actions"><small class="foot-note">${s.running ? "Drafting can take a minute. Keep this window open." : "Takes about a minute. Nothing is saved until you approve it."}</small><button class="button primary" id="draftS" ${s.running ? "disabled" : ""}>${s.running ? "Drafting…" : "Draft the mission"}</button></span></div>`;
    $("closeModal").addEventListener("click", closeModal); $("cancelS").addEventListener("click", closeModal);
    const counted = { sGoal: "goal", sPeople: "people", sFind: "find_out", sApproach: "approach" };
    modal.querySelectorAll("textarea").forEach(autosize);
    for (const [id, k] of Object.entries(counted)) countLine(id, b[k]);
    const bind = (id, key) => $(id)?.addEventListener("input", e => { s.brief[key] = e.target.value; if (e.target.tagName === "TEXTAREA") autosize(e.target); if (counted[id]) countLine(id, e.target.value); if (id === "sAtt") $("sSummary").textContent = settingsSummary(); });
    [["sName", "name"], ["sProg", "programme_name"], ["sGoal", "goal"], ["sPeople", "people"], ["sFind", "find_out"], ["sApproach", "approach"], ["sAtt", "max_attempts"]].forEach(([id, k]) => bind(id, k));
    $("sFrom")?.addEventListener("change", e => { s.brief.start_from = e.target.value; $("sSummary").textContent = settingsSummary(); });
    $("sEmp")?.addEventListener("change", e => { s.brief.employee = e.target.value; $("sSummary").textContent = settingsSummary(); });
    [["sWs", "window_start_hour"], ["sWe", "window_end_hour"]].forEach(([id, k]) => $(id)?.addEventListener("change", e => { s.brief[k] = e.target.value; $("sSummary").textContent = settingsSummary(); }));
    $("sToggle").addEventListener("click", () => { s.settingsOpen = !s.settingsOpen; drawBrief(); });
    $("draftS").addEventListener("click", async () => {
      if (s.running) return;
      s.problems = briefProblems(s.brief); s.error = null;
      if (s.problems.length) { drawBrief(); modal.querySelector(".modal-body").scrollTop = 0; return; } // say what is missing before sending anything
      s.running = true; drawBrief(); // lock the button at once: drafting takes a while and a second click would start a second draft
      try { s.result = await api("/missions/draft", { method: "POST", body: read() }); s.editor = null; s.step = "review"; s.running = false; drawReview(); }
      catch (e) { s.running = false; s.error = e.message; drawBrief(); }
    });
  };
  const drawReview = () => {
    modal.classList.remove("modal-sticky");
    const r = s.result, d = r.definition;
    const need = d ? d.evidence_requirements.map(x => `<div class="check-item"><span class="check-mark">${x.required === false ? "○" : "●"}</span><span><strong>${esc(x.label)}</strong><small>${x.required === false ? "Optional" : "Required"}${x.when ? `, only if <code>${esc(x.when.key)}</code> is ${esc(x.when.in.join(" or "))}` : ""}${x.verify_against ? ", checked against the programme record" : ""}.${x.hint ? " " + esc(x.hint) : ""}</small></span></div>`).join("") : "";
    modal.innerHTML = `<div class="modal-head"><div><h2 id="modalTitle">${d ? "Review the questions" : "The draft could not be made"}</h2><p>${d ? `Drafted ${r.source === "claude" ? "by Claude" : "as a plain starting point (no model key is set)"}${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}. Nothing is saved yet. It will be saved as draft wording: nobody is contacted until a person signs it off.` : "Fix the brief or add detail, then try again."}</p></div><button class="close-button" id="closeModal" aria-label="Close">×</button></div>
      <div class="modal-body" style="max-height:60vh;overflow:auto">
        ${r.problems.length && !d ? `<div class="agent-callout" style="border-color:#b64b48"><small>Problems</small><h3>${esc(r.problems[0])}</h3>${r.problems.length > 1 ? `<p>${r.problems.slice(1, 6).map(esc).join("<br>")}</p>` : ""}</div>` : ""}
        ${r.notes.length ? `<div class="agent-callout"><small>Assumptions to check</small><p>${r.notes.map(esc).join("<br>")}</p></div>` : ""}
        ${d ? `<h3 class="t-md" style="margin:14px 0 4px">Goal</h3><p class="t-md" style="margin:0">${esc(d.objective)}</p>
          <h3 class="t-md" style="margin:14px 0 4px">Results it can end with</h3>${resultsHtml(d.outcomes, d.verdict_labels)}
          ${d.strategy ? `<h3 class="t-md" style="margin:14px 0 4px">Approach</h3><p class="t-sm" style="margin:0">Channels in order: ${d.strategy.channels.map(c => (c === "voice" ? "phone call" : "WhatsApp")).join(", then ")}. Follow up after about ${esc(d.strategy.follow_up_after_hours)} hours of silence.${d.agent_guidance ? " " + esc(d.agent_guidance) : ""}</p>` : ""}
          <h3 class="t-md" style="margin:18px 0 4px">Questions</h3>
          <p class="t-sm" style="margin:0 0 10px">Read each question as it will be asked on WhatsApp and on a phone call. Edit, remove or add anything you need. Nothing is saved until you save the mission.</p>
          <div id="qEditor"></div>
          <details class="q-more" style="margin-top:14px"><summary class="t-sm" style="cursor:pointer"><strong>What the employee will find out</strong> (${d.evidence_requirements.length})</summary><div class="check-list" style="margin-top:8px">${need}</div></details>
          ${wordingHtml(d.instrument)}` : ""}
      </div>
      <div class="modal-foot"><button class="button ghost" id="backS">← Edit the brief</button>${d ? `<button class="button primary" id="saveS" ${s.running ? "disabled" : ""}>${s.running ? "Saving…" : "Save as a draft mission"}</button>` : ""}</div>`;
    $("closeModal").addEventListener("click", closeModal);
    $("backS").addEventListener("click", () => { s.step = "brief"; drawBrief(); });
    // The save button follows the editor: not while a question is open for editing, and not while there are problems.
    const syncSave = () => {
      const b = $("saveS"), ed = s.editor; if (!b || !ed) return;
      const why = ed.isBusy() ? "Save or cancel the question you are editing first." : !ed.isChecked() ? "Checking the questions…" : ed.problems().length ? "Fix the problems listed above first." : "";
      b.disabled = s.running || !!why; b.title = why;
    };
    if (d) {
      s.editor ??= createQuestionEditor({ def: d, check: def => api("/missions/check", { method: "POST", body: def, silent: true }), onChange: syncSave });
      s.editor.mount($("qEditor"));
      if (!s.editor.isChecked()) s.editor.runCheck();
      syncSave();
    }
    $("saveS")?.addEventListener("click", async () => {
      if (s.running || !s.editor) return;
      const edited = s.editor.getDef();
      s.running = true; drawReview();
      try {
        const out = await api("/missions", { method: "POST", body: edited });
        closeModal(); state.missionShown = null; state.wording = null; state.wordingFor = null; state.qeditor = null; state.voiceFormFor = null; await loadAll();
        state.missionShown = await api("/mission?version=" + encodeURIComponent(out.mission.version)); render();
        toast("Saved as a draft mission. Review the questions on this page and sign off before contacting anyone.", "success");
      } catch (e) { s.running = false; s.error = e.message; toast(e.message, "warning"); drawReview(); }
    });
  };
  drawBrief(); modalBackdrop.hidden = false;
  modal.querySelectorAll("textarea").forEach(autosize); // now that it is visible, give the boxes their height
}
