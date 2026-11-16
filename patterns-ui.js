/*
 * patterns-ui.js - Vibe Rounds "Patterns" tab (chunk 6: list, create and edit form).
 * Loaded by index.html with <script src="/patterns-ui.js"></script>; served by a route in server.js.
 * It fills the panel #tab11. No dependencies. It talks only to /api/patterns (patterns.js).
 * Chunk 7: banner with the active cohort, Run button per pattern, run view (three chips, counts, reasons, matches with a link to the patient explorer).
 * Chunk 8: Review panel under the form (status steps, certainty control, history). The server decides who may review; the panel only shows
 * the buttons to a reviewer.
 * Chunk 9: "Create from a case": enter a patient id from the active cohort, get an abstracted summary (age band, codes, day offsets) and a draft that opens in the form.
 * Chunk 10: "Create from a few cases": paste or enter several patient ids of the active cohort, get aggregates (shared codes, counts, gaps) and a draft in the form.
 * Chunk 11: Export (downloads reviewed and active patterns as one JSON file) and Import (choose a file; every pattern arrives as a draft at hypothesis).
 * Chunk 12b: "Draft from a description": type a pattern in plain English, the server (pattern-ai.js) asks the model for a draft that must pass the checker;
 * the draft opens in the form, marked AI-drafted and unreviewed, and is not saved until you save it.
 * Chunk 12d: "Explain in plain words" in the run view (fixed label sentences from the server first, then the model's text, labelled unreviewed) and a
 * checkbox in the case box to let the external model word the plain statement (off by default; the server refuses it unless the setting is on).
 */
(function () {
  'use strict';
  const PANEL = 'tab11';
  const CERT_FREE = ['hypothesis', 'contested'];            // above these needs a reviewer (Review panel)
  const CERT_ALL = ['hypothesis', 'contested', 'supported', 'established'];
  const BASIS = ['expert', 'guideline', 'literature', 'observed_in_data', 'model_suggested'];
  const CLAIM = ['descriptive', 'association', 'causal'];
  const KINDS = [['library', 'Library (written by a person)'], ['one_case', 'From one case'], ['few_cases', 'From a few cases']];
  const EXAMPLE = {
    valuesets: { condition: { domain: 'dx', codes: ['44054006'], mode: 'descendants' }, drug: { domain: 'rx', codes: ['A10BA02'], mode: 'exact' } },
    events: [{ as: 'dx', valueset: 'condition', pick: 'first' }, { as: 'rx', valueset: 'drug', pick: 'first_on_or_after:dx' }],
    when: [{ rel: 'within_days', a: 'rx.date', of: 'dx.date', range: [0, 90] }],
  };

  const S = { list: [], editing: null, loaded: null, readOnly: false, busy: false, history: [], review: null, dirty: false, draftSource: null };
  const DOM_LABEL = { dx: 'diagnosis', rx: 'medication', pr: 'procedure', en: 'encounter class', im: 'immunization', ob: 'observation' };
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const opts = (list, cur, off) => list.map((v) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + (off && off.includes(v) ? ' disabled' : '') + '>' + esc(v.replace(/_/g, ' ')) + (off && off.includes(v) ? ' (needs review)' : '') + '</option>').join('');

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch (e) { /* not JSON */ }
    return { ok: r.ok, status: r.status, json: json || {} };
  }
  const say = (id, kind, html) => { const el = $(id); if (el) el.innerHTML = html ? '<div class="status-output ' + kind + '">' + html + '</div>' : ''; };
  const day = (v) => (v ? String(v).slice(0, 10) : '');

  function shell() {
    const p = $(PANEL); if (!p || p.dataset.ready) return false;
    p.dataset.ready = '1';
    p.innerHTML =
      '<div class="page-head"><h2>Patterns</h2></div>' +
      '<p>A pattern is a clinical sequence written down so it can be checked against data: for example a diagnosis, then a drug within 90 days. Each pattern says how sure we are of it. New patterns start as drafts.</p>' +
      '<div id="patBanner" class="an-card" role="status" aria-live="polite">Checking the active cohort…</div>' +
      '<div class="an-card" id="patList"><div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">' +
      '<h3 style="margin:0">Patterns</h3><span>' +
      '<button type="button" class="download-btn" id="patNew" style="margin-top:0">New pattern</button> ' +
      '<button type="button" class="download-btn" id="patCase" style="margin-top:0" aria-expanded="false" aria-controls="patCaseBox">Create from a case</button> ' +
      '<button type="button" class="download-btn" id="patCases" style="margin-top:0" aria-expanded="false" aria-controls="patCasesBox">Create from a few cases</button> ' +
      '<button type="button" class="download-btn" id="patAi" style="margin-top:0" aria-expanded="false" aria-controls="patAiBox">Draft from a description</button> ' +
      '<button type="button" class="download-btn" id="patAsst" style="margin-top:0" aria-expanded="false" aria-controls="patAsstBox">Pattern assistant</button> ' +
      '<button type="button" class="download-btn" id="patExport" style="margin-top:0">Export reviewed patterns</button> ' +
      '<button type="button" class="download-btn" id="patImport" style="margin-top:0">Import from a file</button><input type="file" id="patImportFile" accept="application/json,.json" hidden aria-label="Pattern file to import"> ' +
      '<button type="button" class="download-btn" id="patSeed" style="margin-top:0">Add the three example patterns</button> ' +
      '<button type="button" class="download-btn" id="patReload" style="margin-top:0">Reload</button></span></div>' +
      '<div id="patListStatus" role="status" aria-live="polite" style="min-height:20px;margin-top:8px"></div>' +
      '<div style="overflow-x:auto"><div id="patTable"></div></div></div>' +
      '<section class="an-card" id="patRun" aria-labelledby="patRunTitle" hidden></section>' +
      '<section class="an-card" id="patCaseBox" aria-labelledby="patCaseTitle" hidden>' +
      '<h3 id="patCaseTitle" style="margin:0 0 4px" tabindex="-1">Create from a case</h3>' +
      '<div class="an-muted">Enter the id of one patient in the active cohort (as shown in the Patient explorer). The server removes names, ids, birth date, address, calendar dates and free text, keeps the codes and the days between them, and drafts a pattern from that sequence. Nothing is saved until you save the draft.</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:8px"><label>Patient id<br><input type="text" id="patCaseId" maxlength="64" autocomplete="off" style="min-width:240px"></label>' +
      '<button type="button" class="download-btn" id="patCaseGo" style="margin:0">Draft from this case</button> <button type="button" class="download-btn" id="patCaseClose" style="margin:0">Close</button></div>' +
      '<label style="display:block;margin-top:8px"><input type="checkbox" id="patCaseWord"> Let the external model word the plain statement. Only the age band, the codes and the day numbers are sent: no ids, dates or text. It is refused for a rare sequence and unless your administrator has switched it on. Leave it unticked to word the statement by code only.</label>' +
      '<div id="patCaseStatus" role="status" aria-live="polite" style="margin-top:10px"></div><div id="patCaseOut"></div></section>' +
      '<section class="an-card" id="patCasesBox" aria-labelledby="patCasesTitle" hidden>' +
      '<h3 id="patCasesTitle" style="margin:0 0 4px" tabindex="-1">Create from a few cases</h3>' +
      '<div class="an-muted">Enter the ids of patients in the active cohort, separated by commas, spaces or new lines. Only codes that most of them share, their usual order and the longest gap are used. A group smaller than the minimum cell is not summarized. No patient data and no model are involved. Nothing is saved until you save the draft.</div>' +
      '<label style="display:block;margin-top:8px">Patient ids<br><textarea id="patCasesIds" rows="3" spellcheck="false" style="width:100%"></textarea></label>' +
      '<div style="margin-top:8px"><button type="button" class="download-btn" id="patCasesGo" style="margin:0">Draft from these cases</button> <button type="button" class="download-btn" id="patCasesClose" style="margin:0">Close</button></div>' +
      '<div id="patCasesStatus" role="status" aria-live="polite" style="margin-top:10px"></div><div id="patCasesOut"></div></section>' +
      '<section class="an-card" id="patAiBox" aria-labelledby="patAiTitle" hidden>' +
      '<h3 id="patAiTitle" style="margin:0 0 4px" tabindex="-1">Draft from a description</h3>' +
      '<div class="an-muted">Describe the pattern in plain English, for example: a viral illness, then an antibiotic within 3 days, no further record of the illness in the next month. The text you type is sent to the external model you set under AI settings: do not type patient names, ids or dates. No patient data is sent. The model can only pick conditions and drugs that occur in the active cohort; the server checks the draft before you see it. A model draft is a guess, not a source. Nothing is saved until you save the draft.</div>' +
      '<label style="display:block;margin-top:8px">Description<br><textarea id="patAiText" rows="3" maxlength="1000" style="width:100%"></textarea></label>' +
      '<div style="margin-top:8px"><button type="button" class="download-btn" id="patAiGo" style="margin:0">Draft with AI</button> <button type="button" class="download-btn" id="patAiClose" style="margin:0">Close</button></div>' +
      '<div id="patAiStatus" role="status" aria-live="polite" style="margin-top:10px"></div><div id="patAiOut"></div></section>' +
      '<section class="an-card" id="patAsstBox" aria-labelledby="patAsstTitle" hidden>' +
      '<h3 id="patAsstTitle" style="margin:0 0 4px" tabindex="-1">Pattern assistant</h3>' +
      '<div class="an-muted">Step 1: pick one of the most common diagnoses in the active cohort. Step 2: the model suggests a few patterns worth looking at for it, in plain English. Step 3: choose one to open it as a draft in the form, then save and run it. The model sees the diagnosis name and the names of conditions and drugs in the cohort, never counts or patient data.</div>' +
      '<label style="display:block;margin-top:8px">Find a diagnosis<br><input type="search" id="patAsstFind" autocomplete="off" style="width:100%" aria-controls="patAsstList"></label>' +
      '<div id="patAsstList" style="margin-top:8px;max-height:240px;overflow:auto" role="list"></div>' +
      '<div style="margin-top:8px"><button type="button" class="download-btn" id="patAsstClose" style="margin:0">Close</button></div>' +
      '<div id="patAsstStatus" role="status" aria-live="polite" style="margin-top:10px"></div><div id="patAsstOut"></div></section>' +
      '<form class="an-card" id="patForm" novalidate aria-labelledby="patFormTitle" hidden>' +
      '<h3 id="patFormTitle" style="margin:0 0 8px">New pattern</h3>' +
      '<div id="patFormNote" class="an-muted" style="margin-bottom:8px"></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">' +
      '<label>Id (lowercase letters, digits, underscores)<br><input type="text" id="patId" maxlength="64" autocomplete="off" style="width:100%" aria-describedby="patIdHelp"></label>' +
      '<label>Where it came from<br><select id="patKind" style="width:100%"></select></label>' +
      '<label>Certainty<br><select id="patCert" style="width:100%"></select></label>' +
      '<label>Basis<br><select id="patBasis" style="width:100%"></select></label>' +
      '<label>Claim<br><select id="patClaim" style="width:100%"></select></label>' +
      '<label>Tags (comma separated, optional)<br><input type="text" id="patTags" autocomplete="off" style="width:100%"></label></div>' +
      '<div id="patIdHelp" class="an-muted" style="margin:4px 0 8px">Certainty above hypothesis is set by a reviewer in the Review panel below, after the pattern has been reviewed. "Contested" needs a note.</div>' +
      '<label>Plain-English statement<br><textarea id="patPlain" rows="2" style="width:100%"></textarea></label>' +
      '<label style="display:block;margin-top:8px">Source note, or why it is contested (optional except for contested)<br><textarea id="patNote" rows="2" style="width:100%"></textarea></label>' +
      '<label style="display:block;margin-top:8px">Pattern logic (JSON with valuesets, events and when) <button type="button" class="download-btn" id="patExample" style="margin:0 0 0 6px">Insert example</button><br>' +
      '<textarea id="patLogic" rows="12" spellcheck="false" style="width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px"></textarea></label>' +
      '<label id="patChangeWrap" style="display:block;margin-top:8px" hidden>What changed (optional, saved in history)<br><input type="text" id="patChange" maxlength="500" style="width:100%"></label>' +
      '<div style="margin-top:10px"><button type="submit" class="download-btn" id="patSave" style="margin-top:0">Save draft</button> ' +
      '<button type="button" class="download-btn" id="patCancel" style="margin-top:0">Close</button></div>' +
      '<div id="patFormStatus" role="status" aria-live="polite" style="margin-top:10px"></div></form>' +
      '<section class="an-card" id="patReview" aria-labelledby="patReviewTitle" hidden></section>';
    $('patKind').innerHTML = KINDS.map((k) => '<option value="' + k[0] + '">' + esc(k[1]) + '</option>').join('');
    $('patNew').onclick = () => openForm(null);
    $('patReload').onclick = () => { loadBanner().then(loadList); };
    $('patSeed').onclick = seed;
    $('patCase').onclick = toggleCase;
    $('patCaseClose').onclick = () => closeCase(true);
    $('patCaseGo').onclick = draftCase;
    $('patExport').onclick = exportPatterns;
    $('patImport').onclick = () => $('patImportFile').click();
    $('patImportFile').addEventListener('change', importPatterns);
    $('patCases').onclick = toggleCases;
    $('patCasesClose').onclick = () => closeCases(true);
    $('patCasesGo').onclick = draftCases;
    $('patAi').onclick = toggleAi;
    $('patAiClose').onclick = () => closeAi(true);
    $('patAiGo').onclick = draftAi;
    $('patAsst').onclick = toggleAsst;
    $('patAsstClose').onclick = () => closeAsst(true);
    $('patAsstFind').addEventListener('input', drawAsstList);
    $('patAsstList').addEventListener('click', (e) => { const b = e.target.closest('button[data-code]'); if (b) pickDx(b.getAttribute('data-code')); });
    $('patAsstOut').addEventListener('click', (e) => { const b = e.target.closest('button[data-sg]'); if (b) useSuggestion(Number(b.getAttribute('data-sg'))); });
    $('patCaseId').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); draftCase(); } });
    $('patCancel').onclick = closeForm;
    $('patExample').onclick = () => { if (!S.readOnly) $('patLogic').value = JSON.stringify(EXAMPLE, null, 2); };
    $('patForm').addEventListener('submit', (e) => { e.preventDefault(); save(); });
    $('patForm').addEventListener('input', () => { S.dirty = true; });
    $('patReview').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-to]'); if (b) { reviewStatus(b.getAttribute('data-to')); return; }
      if (e.target.closest('#patCertApply')) reviewCertainty();
    });
    $('patTable').addEventListener('click', (e) => {
      const o = e.target.closest('button[data-open]'); if (o) { openForm(o.getAttribute('data-open')); return; }
      const d = e.target.closest('button[data-del]'); if (d) { deletePattern(d.getAttribute('data-del')); return; }
      const r = e.target.closest('button[data-run]'); if (r) runPattern(r.getAttribute('data-run'));
    });
    $('patRun').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-patient]'); if (b) openPatient(b.getAttribute('data-patient'));
      if (e.target.closest('#patRunAgain') && S.runId) runPattern(S.runId);
      if (e.target.closest('#patRunExplain')) explainRun();
      if (e.target.closest('#patRunClose')) { $('patRun').hidden = true; S.runId = null; S.lastRun = null; }
    });
    return true;
  }

  function drawList() {
    if (!S.list.length) { $('patTable').innerHTML = '<p class="an-muted">No patterns yet. Use "New pattern" or "Add the three example patterns".</p>'; return; }
    $('patTable').innerHTML = '<table class="an-table" style="width:100%"><caption class="an-muted" style="text-align:left;caption-side:top">' + S.list.length + ' pattern' + (S.list.length === 1 ? '' : 's') + '</caption>' +
      '<thead><tr><th scope="col">Id</th><th scope="col">Statement</th><th scope="col">Status</th><th scope="col">Certainty</th><th scope="col">Claim</th><th scope="col">Version</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead><tbody>' +
      S.list.map((p) => '<tr><td style="text-align:left"><button type="button" class="download-btn" style="margin:0" data-open="' + esc(p.id) + '" aria-label="Open pattern ' + esc(p.id) + '">' + esc(p.id) + '</button></td>' +
        '<td style="text-align:left;white-space:normal;min-width:220px">' + esc(p.plain) + '</td><td style="text-align:left">' + esc(p.status) + '</td><td style="text-align:left">' + esc(p.certainty) + '</td>' +
        '<td style="text-align:left">' + esc(p.claim) + '</td><td>' + esc(p.version) + '</td><td style="text-align:left">' + esc(day(p.updated_at)) + '</td><td><button type=\"button\" class=\"download-btn\" style=\"margin:0\" data-run=\"' + esc(p.id) + '\"' + (S.cohort ? '' : ' disabled title=\"Needs an active cohort\"') + ' aria-label=\"Run pattern ' + esc(p.id) + '\">Run</button> <button type=\"button\" class=\"download-btn\" style=\"margin:0\" data-del=\"' + esc(p.id) + '\"' + (p.status === 'draft' || p.status === 'retired' ? '' : ' disabled title=\"Retire it first (Review panel)\"') + ' aria-label=\"Delete pattern ' + esc(p.id) + '\">Delete</button></td></tr>').join('') + '</tbody></table>';
  }

  // Delete a draft or a retired pattern. The server asks for a reason and the version we saw; history and saved runs go with it.
  async function deletePattern(id) {
    if (S.busy) return;
    const p = S.list.find((x) => x.id === id); if (!p) return;
    const note = window.prompt('Delete pattern "' + id + '" for good? Its history and saved runs are deleted with it (the audit log keeps a record).\n\nType the reason (at least 3 characters):');
    if (note === null) return;
    if (note.trim().length < 3) { say('patListStatus', 'error', 'A reason is needed to delete a pattern. Nothing was deleted.'); return; }
    S.busy = true; say('patListStatus', 'info', 'Deleting…');
    try {
      const r = await api('POST', '/api/patterns/' + encodeURIComponent(id) + '/delete', { note: note.trim(), version: p.version });
      if (!r.ok) { say('patListStatus', 'error', esc(r.json.error || 'Could not delete (HTTP ' + r.status + ')')); return; }
      if (S.editing === id) closeForm();
      if (S.runId === id) { $('patRun').hidden = true; S.runId = null; S.lastRun = null; }
      await loadList();
      say('patListStatus', 'ok', 'Deleted ' + esc(id) + '.');
    } catch (e) { say('patListStatus', 'error', esc(e.message)); } finally { S.busy = false; }
  }

  async function loadList() {
    say('patListStatus', 'info', 'Loading…');
    try {
      const r = await api('GET', '/api/patterns');
      if (!r.ok) { say('patListStatus', 'error', esc(r.json.error || 'Could not load patterns (HTTP ' + r.status + ')')); return; }
      S.list = r.json.patterns || []; say('patListStatus', '', ''); drawList();
    } catch (e) { say('patListStatus', 'error', esc(e.message)); }
  }

  async function seed() {
    say('patListStatus', 'info', 'Adding example patterns…');
    try {
      const r = await api('POST', '/api/patterns/seed');
      if (!r.ok) { say('patListStatus', 'error', esc(r.json.error || 'Could not add examples')); return; }
      await loadList();
      say('patListStatus', 'success', 'Added ' + r.json.created.length + ', already there ' + r.json.existing.length + '. The example codes are placeholders: check them against your data.');
    } catch (e) { say('patListStatus', 'error', esc(e.message)); }
  }

  function fill(spec, row) {
    const e = (spec && spec.epistemic) || {};
    $('patId').value = spec ? spec.id : ''; $('patId').readOnly = !!row;
    $('patKind').value = spec && spec.source ? spec.source.kind : 'library'; $('patKind').disabled = !!row;
    $('patCert').innerHTML = opts(CERT_ALL, e.certainty || 'hypothesis', CERT_ALL.filter((c) => !CERT_FREE.includes(c)));
    $('patBasis').innerHTML = opts(BASIS, e.basis || 'expert');
    $('patClaim').innerHTML = opts(CLAIM, e.claim || 'descriptive');
    $('patTags').value = (e.tags || []).join(', ');
    $('patPlain').value = spec ? spec.plain : ''; $('patNote').value = e.note || '';
    $('patLogic').value = spec ? JSON.stringify({ valuesets: spec.valuesets, events: spec.events, when: spec.when }, null, 2) : '';
    $('patChange').value = ''; $('patChangeWrap').hidden = !row;
  }

  async function openForm(id, o) {
    const form = $('patForm'); say('patFormStatus', '', '');
    S.editing = id; S.loaded = null; S.readOnly = false; S.history = []; S.review = null; S.dirty = false; S.draftSource = o && o.draft ? o.draft.source : null;
    if (id) {
      say('patListStatus', 'info', 'Loading ' + esc(id) + '…');
      try {
        const r = await api('GET', '/api/patterns/' + encodeURIComponent(id));
        if (!r.ok) { say('patListStatus', 'error', esc(r.json.error || 'Could not open the pattern')); return; }
        S.loaded = r.json.pattern; S.history = r.json.history || []; S.review = r.json.review || null;
        S.readOnly = r.json.pattern.status !== 'draft'; say('patListStatus', '', '');
      } catch (e) { say('patListStatus', 'error', esc(e.message)); return; }
    }
    fill(S.loaded ? S.loaded.spec : (o && o.draft) || null, S.loaded);
    if (o && o.draft) { $('patKind').disabled = true; S.dirty = true; }
    $('patFormTitle').textContent = id ? 'Pattern ' + id + (S.loaded ? ' (version ' + S.loaded.version + ', ' + S.loaded.status + ')' : '') : 'New pattern';
    $('patFormNote').textContent = S.readOnly ? 'Only drafts can be edited. This pattern is ' + S.loaded.status + '.' + (S.review && S.review.can_review ? ' Use the Review panel to send it back to draft.' : ' A reviewer can send it back to draft.') : (o && o.draft ? (o.draft.source && o.draft.source.model && o.draft.source.kind === 'library' ? 'AI-drafted from your description, unreviewed and not saved yet. A model can misread what you meant: check every code, relation and day range, give it an id you like, then save.' : 'Drafted from ' + (o.draft.source && o.draft.source.kind === 'few_cases' ? 'a few cases' : 'one case') + ' and not saved yet. Check every code and time window, give it an id you like, then save.' + (o.draft.source && o.draft.source.model ? ' The plain statement was worded by a model (' + o.draft.source.model + '): check that it says what the case shows.' : '')) : '');
    for (const el of form.querySelectorAll('input,select,textarea,button#patSave,button#patExample')) if (el.id !== 'patId' && el.id !== 'patKind') el.disabled = S.readOnly;
    if (S.readOnly) { $('patId').readOnly = true; $('patKind').disabled = true; }
    form.hidden = false; drawReview();
    if (!(o && o.keepFocus)) { $('patFormTitle').setAttribute('tabindex', '-1'); $('patFormTitle').focus(); form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  function closeForm() { $('patForm').hidden = true; $('patReview').hidden = true; S.editing = null; S.loaded = null; S.dirty = false; S.draftSource = null; const b = $('patNew'); if (b) b.focus(); }

  function errorList(errs) {
    return '<b>This pattern was not saved.</b><ul style="margin:6px 0 0 18px">' + errs.map((x) => '<li>' + (x.path ? '<code>' + esc(x.path) + '</code>: ' : '') + esc(x.message || x) + '</li>').join('') + '</ul>';
  }

  function build() {
    let logic;
    try { logic = JSON.parse($('patLogic').value); } catch (e) { return { errors: [{ path: 'logic', message: 'The pattern logic is not valid JSON (' + e.message + ')' }] }; }
    if (!logic || typeof logic !== 'object' || Array.isArray(logic)) return { errors: [{ path: 'logic', message: 'The pattern logic must be an object with valuesets, events and when' }] };
    const extra = Object.keys(logic).filter((k) => !['valuesets', 'events', 'when'].includes(k));
    if (extra.length) return { errors: [{ path: 'logic.' + extra[0], message: 'only valuesets, events and when go here' }] };
    const tags = $('patTags').value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const base = S.loaded ? S.loaded.spec : { source: S.draftSource || { kind: $('patKind').value } };
    const spec = Object.assign({}, base, {
      id: $('patId').value.trim(), plain: $('patPlain').value, valuesets: logic.valuesets, events: logic.events, when: logic.when,
      epistemic: { certainty: $('patCert').value, basis: $('patBasis').value, claim: $('patClaim').value, note: $('patNote').value, tags },
    });
    return { spec };
  }

  async function save() {
    if (S.busy || S.readOnly) return;
    const b = build();
    if (b.errors) { say('patFormStatus', 'error', errorList(b.errors)); return; }
    S.busy = true; $('patSave').disabled = true; say('patFormStatus', 'info', 'Saving…');
    try {
      const r = S.editing
        ? await api('PUT', '/api/patterns/' + encodeURIComponent(S.editing), { spec: b.spec, note: $('patChange').value, version: S.loaded.version })
        : await api('POST', '/api/patterns', { spec: b.spec });
      if (r.status === 422 && r.json.errors) say('patFormStatus', 'error', errorList(r.json.errors));
      else if (r.status === 409) say('patFormStatus', 'error', esc(r.json.error || 'Conflict') + ' Reload the list and open the pattern again.');
      else if (!r.ok) say('patFormStatus', 'error', esc(r.json.error || 'Could not save (HTTP ' + r.status + ')'));
      else {
        S.editing = r.json.pattern.id; S.loaded = r.json.pattern; S.loaded.spec = typeof S.loaded.spec === 'string' ? JSON.parse(S.loaded.spec) : S.loaded.spec;
        $('patFormTitle').textContent = 'Pattern ' + S.editing + ' (version ' + S.loaded.version + ', ' + S.loaded.status + ')';
        $('patId').readOnly = true; $('patKind').disabled = true; $('patChangeWrap').hidden = false; $('patChange').value = '';
        say('patFormStatus', 'success', 'Saved as a draft, version ' + esc(S.loaded.version) + '.');
        S.dirty = false; loadList(); reloadReview();
      }
    } catch (e) { say('patFormStatus', 'error', esc(e.message)); }
    finally { S.busy = false; $('patSave').disabled = S.readOnly; }
  }


  // ---------- review and certainty (chunk 8) ----------
  const STATUS_TEXT = {
    draft: 'Draft: can be edited; no reviewer has approved it yet.',
    reviewed: 'Reviewed: a reviewer approved the logic. It cannot be edited until it is sent back to draft.',
    active: 'Active: reviewed and in use.',
    retired: 'Retired: it cannot be run or changed. It can be reopened as a draft.',
  };
  const STEP_LABEL = { 'draft>reviewed': 'Mark as reviewed', 'reviewed>active': 'Make active', 'active>reviewed': 'Back to reviewed', 'reviewed>draft': 'Send back to draft', 'retired>draft': 'Reopen as draft' };
  const stepLabel = (from, to) => STEP_LABEL[from + '>' + to] || (to === 'retired' ? 'Retire' : 'Make ' + to);
  const when = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
  function what(h) {
    if (h.action === 'status') return 'Status ' + esc(h.from_status) + ' → ' + esc(h.to_status) + (h.from_certainty !== h.to_certainty ? '; certainty ' + esc(h.from_certainty) + ' → ' + esc(h.to_certainty) : '');
    if (h.action === 'certainty') return 'Certainty ' + esc(h.from_certainty) + ' → ' + esc(h.to_certainty);
    if (h.action === 'import') return 'Imported as ' + esc(h.to_status || 'draft') + ', certainty ' + esc(h.to_certainty || 'hypothesis');
    if (h.action === 'create') return 'Created as ' + esc(h.to_certainty || 'draft');
    return 'Edited' + (h.from_certainty !== h.to_certainty ? '; certainty ' + esc(h.from_certainty) + ' → ' + esc(h.to_certainty) : '');
  }

  function drawReview() {
    const box = $('patReview'), p = S.loaded;
    if (!p) { box.hidden = true; box.innerHTML = ''; return; }
    const spec = typeof p.spec === 'string' ? JSON.parse(p.spec) : p.spec, e = spec.epistemic || {};
    const rv = S.review || { can_review: false, transitions: [] }, draft = p.status === 'draft';
    const raiseOff = draft ? CERT_ALL.filter((c) => !CERT_FREE.includes(c)) : [];
    let h = '<h3 id="patReviewTitle" style="margin:0 0 6px">Review and certainty: ' + esc(p.id) + '</h3>' +
      '<p style="margin:0 0 6px"><b>Status:</b> ' + esc(p.status) + ' · <b>Certainty:</b> ' + esc(p.certainty) + ' · <b>Basis:</b> ' + esc(String(p.basis).replace(/_/g, ' ')) + ' · version ' + esc(p.version) + '</p>' +
      '<p class="an-muted" style="margin:0 0 10px">' + esc(STATUS_TEXT[p.status] || '') + '</p>';
    if (!rv.can_review) {
      h += '<p class="an-muted">Only a reviewer can change the status or the certainty. You can read the history below.</p>';
    } else if (p.status === 'retired' && !rv.transitions.length) {
      h += '';
    } else {
      h += '<label style="display:block;margin-bottom:8px">Reason for the change (required, saved in the history and the audit log)<br><input type="text" id="patRevNote" maxlength="500" autocomplete="off" style="width:100%"></label>';
      if (rv.transitions.length) {
        h += '<div style="margin-bottom:10px"><b>Status</b><br>' + rv.transitions.map((to) => '<button type="button" class="download-btn" style="margin:4px 6px 0 0" data-to="' + esc(to) + '">' + esc(stepLabel(p.status, to)) + '</button>').join('') +
          (p.status === 'reviewed' || p.status === 'retired' ? '<div class="an-muted" style="margin-top:4px">Sending a pattern back to draft resets a certainty of supported or established to hypothesis, because the logic can change. The old value stays in the history.</div>' : '') + '</div>';
      }
      if (p.status !== 'retired') {
        h += '<fieldset style="border:1px solid #ccd;padding:8px 10px;margin:0 0 10px"><legend>Certainty</legend>' +
          (draft ? '<div class="an-muted" style="margin-bottom:6px">Mark the pattern as reviewed first. A draft stays at hypothesis or contested.</div>' : '') +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">' +
          '<label>Certainty<br><select id="patRevCert" style="width:100%">' + opts(CERT_ALL, p.certainty, raiseOff) + '</select></label>' +
          '<label>Basis (the real one, not model suggested, for supported or established)<br><select id="patRevBasis" style="width:100%">' + opts(BASIS, e.basis || p.basis) + '</select></label>' +
          '<label>Claim<br><select id="patRevClaim" style="width:100%">' + opts(CLAIM, e.claim || p.claim) + '</select></label></div>' +
          '<label style="display:block;margin-top:8px">Source: guideline name or citation (required for supported and established; needed for contested)<br><textarea id="patRevSource" rows="2" maxlength="500" style="width:100%">' + esc(e.note || '') + '</textarea></label>' +
          '<button type="button" class="download-btn" id="patCertApply" style="margin-top:8px">Apply certainty</button></fieldset>';
      }
    }
    h += '<div id="patRevStatus" role="status" aria-live="polite" style="margin:6px 0"></div>';
    h += S.history.length ? '<div style="overflow-x:auto"><table class="an-table" style="width:100%"><caption class="an-muted" style="text-align:left;caption-side:top">History (newest first, last ' + S.history.length + ' changes)</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Note</th></tr></thead><tbody>' +
      S.history.map((x) => '<tr><td style="text-align:left;white-space:nowrap">' + esc(when(x.changed_at)) + '</td><td style="text-align:left">' + esc(x.changed_by || '') + '</td><td style="text-align:left;white-space:normal">' + what(x) + '</td><td style="text-align:left;white-space:normal;min-width:180px">' + esc(x.note || '') + '</td></tr>').join('') + '</tbody></table></div>'
      : '<p class="an-muted">No history yet.</p>';
    box.innerHTML = h; box.hidden = false;
  }

  async function reloadReview() {
    if (!S.editing) return;
    try {
      const r = await api('GET', '/api/patterns/' + encodeURIComponent(S.editing));
      if (!r.ok) return;
      S.history = r.json.history || []; S.review = r.json.review || S.review;
      if (S.loaded && r.json.pattern.version === S.loaded.version) S.loaded = Object.assign({}, S.loaded, r.json.pattern, { spec: S.loaded.spec });
      drawReview();
    } catch (e) { /* the panel keeps what it had */ }
  }

  // Shared by both buttons: send, show the server's answer, then reload the pattern so the form and the panel show what is saved.
  async function reviewCall(path, body, done) {
    if (S.busy || !S.loaded) return;
    if (S.dirty && !S.readOnly) { say('patRevStatus', 'error', 'You have unsaved edits. Save the draft first: a review applies to the saved version.'); return; }
    const note = ($('patRevNote') || {}).value || '';
    if (note.trim().length < 3) { say('patRevStatus', 'error', 'Write a short reason for the change first.'); const n = $('patRevNote'); if (n) n.focus(); return; }
    S.busy = true; say('patRevStatus', 'info', 'Saving…');
    try {
      const r = await api('POST', '/api/patterns/' + encodeURIComponent(S.editing) + '/' + path, Object.assign({ note: note.trim(), version: S.loaded.version }, body));
      if (r.status === 422 && r.json.errors) say('patRevStatus', 'error', errorList(r.json.errors).replace('This pattern was not saved.', 'Not changed.'));
      else if (r.status === 403) say('patRevStatus', 'error', 'Your account is not allowed to review patterns. Ask an administrator for the reviewer role.');
      else if (r.status === 409) say('patRevStatus', 'error', esc(r.json.error || 'Conflict') + ' Reload the pattern and try again.');
      else if (!r.ok) say('patRevStatus', 'error', esc(r.json.error || 'Could not save (HTTP ' + r.status + ')'));
      else { S.busy = false; const id = S.editing; await openForm(id, { keepFocus: true }); say('patRevStatus', 'success', done(r.json.pattern)); loadList(); }
    } catch (e) { say('patRevStatus', 'error', esc(e.message)); }
    finally { S.busy = false; }
  }
  const reviewStatus = (to) => reviewCall('status', { to }, (p) => 'Status is now ' + esc(p.status) + (p.certainty ? ', certainty ' + esc(p.certainty) : '') + '. Recorded in the history and the audit log.');
  const reviewCertainty = () => reviewCall('certainty', {
    certainty: $('patRevCert').value, basis: $('patRevBasis').value, claim: $('patRevClaim').value, source_note: $('patRevSource').value,
  }, (p) => 'Certainty is now ' + esc(p.certainty) + ' (version ' + esc(p.version) + '). Recorded in the history and the audit log.');

  // ---------- active cohort banner and run view (chunk 7) ----------
  const REASON_TEXT = {
    followup_incomplete: 'The follow-up window is not over at the as-of date, so "did not happen" cannot be asserted yet.',
  };
  function reasonText(r) {
    if (REASON_TEXT[r]) return REASON_TEXT[r];
    let m = /^(.+)_date_missing$/.exec(r); if (m) return 'A record for "' + m[1] + '" has no date.';
    m = /^(.+)_value_missing$/.exec(r); if (m) return 'The latest "' + m[1] + '" result has no numeric value.';
    m = /^(.+)_end_missing$/.exec(r); if (m) return 'The "' + m[1] + '" stay has no discharge date.';
    return '';
  }
  const RELI_TEXT = { thin: 'Thin: few patients', gappy: 'Gappy: many could not be judged', weak_hierarchy: 'Weak hierarchy: demo-sized code links' };
  const chip = (label, detail, tone) => '<span class="an-chip" title="' + esc(detail || '') + '" style="display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border-radius:999px;border:1px solid ' + (tone === 'warn' ? '#e0b24a' : '#9ccfc0') + ';background:' + (tone === 'warn' ? '#fff6dd' : '#e8f5ef') + ';color:#222;font-size:12.5px">' + esc(label) + '</span>';
  const cell = (n, min) => (n === null || n === undefined ? '<span title="Hidden: fewer than ' + esc(min) + ' patients">fewer than ' + esc(min) + '</span>' : esc(n));

  async function loadBanner() {
    const el = $('patBanner'); if (!el) return;
    try {
      const r = await api('GET', '/api/cohorts');
      const list = (r.json && r.json.cohorts) || [];
      const c = list.filter((x) => x.is_active).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id)[0];
      S.cohort = c || null;
      const pop = c && c.population_scope ? (typeof window.popLabel === 'function' ? window.popLabel(c.population_scope) : c.population_scope) : '';
      el.innerHTML = c ? '<b>Active cohort:</b> ' + esc(c.name) + (pop ? ' <span class="an-muted">· population ' + esc(pop) + '</span>' : '') + '<div class="an-muted">Patterns run on this cohort. Change it in the Analytics tab.</div>'
        : '<b>No active cohort.</b> Create or activate a cohort in the Analytics tab. Patterns always run on the active cohort.';
    } catch (e) { S.cohort = null; el.textContent = 'Could not check the active cohort: ' + e.message; }
    if (S.list.length) drawList();
  }

  function scopeQuery() {
    const sc = typeof window.anScope === 'function' ? window.anScope() : {}, q = new URLSearchParams();
    if (sc.batchGroup) q.set('batchGroup', sc.batchGroup); if (sc.batchId) q.set('batchId', sc.batchId);
    const s = q.toString(); return s ? '?' + s : '';
  }

  function openPatient(id) {
    const tab = document.querySelector('.tab[data-tab="tab6"]'); if (tab) tab.click();
    const box = document.getElementById('peDetail'), det = box && box.closest('details'); if (det) det.open = true;
    if (typeof window.peOpen === 'function') window.peOpen(id);
  }

  function drawRun(d) {
    const res = d.result, c = res.counts, min = res.min_cell, p = d.pattern, sc = d.scope;
    const chips = [chip('Status: ' + p.status + (p.reviewed ? '' : ' (not reviewed)'), p.reviewed ? 'A reviewer approved the logic of this pattern.' : 'No reviewer has approved this pattern yet: treat the result as a trial run.', p.reviewed ? 'ok' : 'warn'),
      chip('Certainty: ' + p.certainty, d.epistemic.text, p.certainty === 'hypothesis' || p.certainty === 'contested' ? 'warn' : 'ok')]
      .concat(res.reliability.length ? res.reliability.map((x) => chip(RELI_TEXT[x.id] || x.id, x.detail, 'warn')) : [chip('Reliability: no warnings', 'Enough patients, few gaps, hierarchy not demo-sized', 'ok')])
      .concat([chip('Evidence: ' + (res.evidence_mix.derived ? 'documented and derived' : 'documented'), res.evidence_mix.derived ? 'Some facts are inferred from records, for example a stop date from supply plus grace days.' : 'Everything counted is read directly from records.', res.evidence_mix.derived ? 'warn' : 'ok')]);
    const rows = [['Eligible (had the first event)', c.eligible], ['Matched', c.matched], ['Did not match', c.not_matched], ['Cannot evaluate', c.cannot_evaluate]];
    const reasons = res.reasons.length ? '<table class="an-table"><caption class="an-muted" style="text-align:left;caption-side:top">Why patients could not be judged (a patient can have more than one reason)</caption><thead><tr><th scope="col">Reason</th><th scope="col">Patients</th><th scope="col">Meaning</th></tr></thead><tbody>' +
      res.reasons.map((x) => '<tr><td style="text-align:left"><code>' + esc(x.reason) + '</code></td><td>' + cell(x.count, min) + '</td><td style="text-align:left;white-space:normal">' + esc(reasonText(x.reason)) + '</td></tr>').join('') + '</tbody></table>' : '';
    const matches = res.matches.length ? '<table class="an-table"><caption class="an-muted" style="text-align:left;caption-side:top">Matched patients' + (res.truncated ? ' (first ' + res.matches.length + ' only)' : '') + '. Open one in the patient explorer.</caption><thead><tr><th scope="col">Patient</th><th scope="col">Source records</th><th scope="col">Codes</th></tr></thead><tbody>' +
      res.matches.map((m) => '<tr><td style="text-align:left"><button type="button" class="download-btn" style="margin:0" data-patient="' + esc(m.patient_id) + '">' + esc(m.patient_id) + '</button></td>' +
        '<td style="text-align:left;white-space:normal">' + esc(Object.keys(m.records).map((k) => k + ': ' + m.records[k]).join(', ')) + '</td><td style="text-align:left">' + esc(Object.keys(m.codes).map((k) => k + ': ' + m.codes[k]).join(', ')) + '</td></tr>').join('') + '</tbody></table>'
      : (c.matched === null ? '<p class="an-muted">The matched count is below ' + esc(min) + ', so patients are not listed.</p>' : '');
    $('patRun').innerHTML =
      '<h3 id="patRunTitle" tabindex="-1" style="margin:0 0 4px">Run: ' + esc(p.id) + '</h3><div class="an-muted">' + esc(p.plain) + '</div>' +
      '<div class="an-muted" style="margin:6px 0">Run #' + esc(d.run.id) + ' · cohort ' + esc(sc.cohort === true ? 'active' : sc.cohort) + (sc.population ? ' · population ' + esc(sc.population) : '') + (sc.patients != null ? ' · ' + esc(sc.patients) + ' patients in scope' : '') + (sc.as_of ? ' · as of ' + esc(sc.as_of) : '') + '</div>' +
      '<div style="margin:8px 0">' + chips.join('') + '</div><p style="margin:0 0 8px">' + esc(d.epistemic.text) + '</p>' +
      '<table class="an-table"><caption class="an-muted" style="text-align:left;caption-side:top">Counts' + (res.suppressed ? ' (small numbers are hidden; the total is hidden with them)' : '') + '</caption><thead><tr><th scope="col">Group</th><th scope="col">Patients</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td style="text-align:left">' + esc(r[0]) + '</td><td>' + cell(r[1], min) + '</td></tr>').join('') +
      (res.match_rate !== null ? '<tr><td style="text-align:left">Matched, of those who could be judged</td><td>' + esc(Math.round(res.match_rate * 1000) / 10) + '%</td></tr>' : '') + '</tbody></table>' +
      reasons + matches +
      '<div style="margin-top:8px"><button type="button" class="download-btn" id="patRunAgain" style="margin-top:0">Run again</button> <button type="button" class="download-btn" id="patRunExplain" style="margin-top:0" title="Sends the pattern statement and the labels above to the external model. No counts and no patient data.">Explain in plain words</button> <button type="button" class="download-btn" id="patRunClose" style="margin-top:0">Close</button></div>' +
      '<div id="patRunExplainOut" role="status" aria-live="polite"></div>';
    S.lastRun = d;
    $('patRunTitle').focus();
  }

  async function runPattern(id) {
    if (S.busy) return;
    const box = $('patRun'); S.runId = id; box.hidden = false;
    if (!S.cohort) { box.innerHTML = '<h3 id="patRunTitle" style="margin:0 0 6px">Run: ' + esc(id) + '</h3><div class="status-output error">No active cohort. Create or activate a cohort in the Analytics tab.</div>'; return; }
    S.busy = true; box.innerHTML = '<h3 id="patRunTitle" style="margin:0 0 6px">Run: ' + esc(id) + '</h3><div class="status-output info" role="status">Running on the active cohort…</div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const r = await api('POST', '/api/patterns/' + encodeURIComponent(id) + '/run' + scopeQuery(), {});
      if (!r.ok) box.innerHTML = '<h3 id="patRunTitle" style="margin:0 0 6px">Run: ' + esc(id) + '</h3><div class="status-output error">' + esc(r.json.error || 'The run failed (HTTP ' + r.status + ')') + '</div>';
      else drawRun(r.json);
    } catch (e) { box.innerHTML = '<h3 id="patRunTitle" style="margin:0 0 6px">Run: ' + esc(id) + '</h3><div class="status-output error">' + esc(e.message) + '</div>'; }
    finally { S.busy = false; }
  }

  // ---------- create from one case (chunk 9) ----------
  function toggleCase() {
    const box = $('patCaseBox'), open = box.hidden;
    if (open) { box.hidden = false; $('patCase').setAttribute('aria-expanded', 'true'); $('patCaseTitle').focus(); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    else closeCase(true);
  }
  function closeCase(focus) {
    $('patCaseBox').hidden = true; $('patCase').setAttribute('aria-expanded', 'false');
    $('patCaseId').value = ''; $('patCaseWord').checked = false; $('patCaseOut').innerHTML = ''; say('patCaseStatus', '', '');
    if (focus) $('patCase').focus();
  }
  function drawCase(d) {
    const c = d.case || {}, pv = d.privacy || {}, ev = c.events || [];
    const rows = ev.slice(0, 30).map((e) => '<tr><td>' + esc(e.day) + '</td><td style="text-align:left">' + esc(DOM_LABEL[e.domain] || e.domain) + '</td><td style="text-align:left"><code>' + esc(e.code) + '</code></td></tr>').join('');
    const chips = [];
    if (pv.rare_combination) chips.push(chip('Rare sequence', pv.note, 'warn'));
    else if (pv.checked) chips.push(chip('Shared by ' + (pv.matched_in_cohort === null ? 'few' : pv.matched_in_cohort) + ' patients in the cohort', 'Matches of the draft in the active cohort', ''));
    else chips.push(chip('Not checked against the cohort', pv.error || pv.note, 'warn'));
    if (d.wording && d.wording.used) chips.push(chip('Statement worded by a model', 'Only the age band, codes and day numbers were sent to the external model. Check that the statement says what the case shows.', 'warn'));
    $('patCaseOut').innerHTML =
      '<div style="margin-top:10px">' + chips.join('') + '</div>' +
      (pv.rare_combination ? '<div class="status-output error">' + esc(pv.note) + '</div>' : '') +
      '<div class="an-muted" style="margin:6px 0">Abstracted case: age band ' + esc(c.age_band || 'unknown') + ' · ' + esc(ev.length) + ' event' + (ev.length === 1 ? '' : 's') + ' over ' + esc(c.span_days) + ' days' +
      (c.undated_codes ? ' · ' + esc(c.undated_codes) + ' code(s) without a date left out' : '') + (c.dropped ? ' · ' + esc(c.dropped) + ' record(s) dropped (not a code)' : '') + (c.left_out ? ' · ' + esc(c.left_out) + ' event(s) not used in the draft' : '') + '</div>' +
      '<div style="overflow-x:auto"><table><caption class="an-muted" style="text-align:left">Day 0 is the first dated record. No calendar dates are kept.</caption><thead><tr><th scope="col">Day</th><th scope="col">Kind</th><th scope="col">Code</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (ev.length > 30 ? '<div class="an-muted">…and ' + esc(ev.length - 30) + ' more.</div>' : '');
  }
  async function draftCase() {
    if (S.busy) return;
    const pid = $('patCaseId').value.trim();
    if (!pid) { say('patCaseStatus', 'error', 'Enter a patient id.'); $('patCaseId').focus(); return; }
    if (!S.cohort) { say('patCaseStatus', 'error', 'No active cohort. Create or activate a cohort in the Analytics tab.'); return; }
    if (S.dirty && !window.confirm('The form has unsaved changes. Replace them with the new draft?')) return;
    S.busy = true; $('patCaseGo').disabled = true; $('patCaseOut').innerHTML = ''; say('patCaseStatus', 'info', 'Reading the case and drafting…');
    try {
      const wording = $('patCaseWord').checked;
      const r = await api('POST', '/api/patterns/from-case' + scopeQuery(), wording ? { patient_id: pid, wording: true } : { patient_id: pid });
      if (!r.ok) { say('patCaseStatus', 'error', esc(r.json.error || 'Could not draft from this case (HTTP ' + r.status + ')') + (wording ? ' Untick the model wording box to draft this case without a model.' : '')); return; }
      say('patCaseStatus', 'success', 'Draft ready. It opened in the form below and is not saved yet.');
      drawCase(r.json); $('patCaseId').value = '';
      S.dirty = false; await openForm(null, { draft: r.json.draft, keepFocus: true });
      $('patForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { say('patCaseStatus', 'error', esc(e.message)); }
    finally { S.busy = false; $('patCaseGo').disabled = false; }
  }

  // ---------- create from a few cases (chunk 10) ----------
  function toggleCases() {
    const box = $('patCasesBox');
    if (box.hidden) { box.hidden = false; $('patCases').setAttribute('aria-expanded', 'true'); $('patCasesTitle').focus(); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    else closeCases(true);
  }
  function closeCases(focus) {
    $('patCasesBox').hidden = true; $('patCases').setAttribute('aria-expanded', 'false');
    $('patCasesIds').value = ''; $('patCasesOut').innerHTML = ''; say('patCasesStatus', '', '');
    if (focus) $('patCases').focus();
  }
  function drawCases(d) {
    const c = d.cases || {}, pv = d.privacy || {}, ev = c.events || [];
    const rows = ev.map((e) => '<tr><td style="text-align:left">' + esc(DOM_LABEL[e.domain] || e.domain) + '</td><td style="text-align:left"><code>' + esc(e.code) + '</code></td><td>' + esc(e.count) + ' of ' + esc(c.n) + '</td><td>' + esc(e.median_day) + '</td><td>' +
      (e.gap ? esc(e.gap.min) + ' to ' + esc(e.gap.max) + ' (median ' + esc(e.gap.median) + ', ' + esc(e.gap.n) + ' patients)' : 'first event') + '</td></tr>').join('');
    const chips = [chip('Based on ' + c.n + ' patients; a code needs ' + c.need, 'A code is kept when at least this many patients have it', '')];
    if (pv.rare_combination) chips.push(chip('Rare sequence', pv.note, 'warn'));
    else if (pv.checked) chips.push(chip('Matches ' + pv.matched_in_cohort + ' patients in the cohort', 'Matches of the draft in the active cohort', ''));
    else chips.push(chip('Not checked against the cohort', pv.error || pv.note, 'warn'));
    $('patCasesOut').innerHTML = '<div style="margin-top:10px">' + chips.join('') + '</div>' +
      (c.not_in_cohort ? '<div class="an-muted">' + esc(c.not_in_cohort) + ' id(s) were not in the active cohort and were skipped.</div>' : '') +
      (c.left_out ? '<div class="an-muted">' + esc(c.left_out) + ' code(s) were left out (too few patients, no clear order, or over the event limit).</div>' : '') +
      '<div style="overflow-x:auto"><table class="an-table"><caption class="an-muted" style="text-align:left;caption-side:top">Shared shape (day numbers are counted from each patient\'s first record)</caption><thead><tr><th scope="col">Kind</th><th scope="col">Code</th><th scope="col">Patients</th><th scope="col">Usual day</th><th scope="col">Days after the previous event</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  async function draftCases() {
    if (S.busy) return;
    const ids = $('patCasesIds').value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (ids.length < 2) { say('patCasesStatus', 'error', 'Enter at least two patient ids.'); $('patCasesIds').focus(); return; }
    if (!S.cohort) { say('patCasesStatus', 'error', 'No active cohort. Create or activate a cohort in the Analytics tab.'); return; }
    if (S.dirty && !window.confirm('The form has unsaved changes. Replace them with the new draft?')) return;
    S.busy = true; $('patCasesGo').disabled = true; $('patCasesOut').innerHTML = ''; say('patCasesStatus', 'info', 'Reading the cases and drafting…');
    try {
      const r = await api('POST', '/api/patterns/from-cases' + scopeQuery(), { patient_ids: ids });
      if (!r.ok) { say('patCasesStatus', 'error', esc(r.json.error || 'Could not draft from these cases (HTTP ' + r.status + ')')); return; }
      say('patCasesStatus', 'success', 'Draft ready. It opened in the form below and is not saved yet.');
      drawCases(r.json); $('patCasesIds').value = '';
      S.dirty = false; await openForm(null, { draft: r.json.draft, keepFocus: true });
      $('patForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { say('patCasesStatus', 'error', esc(e.message)); }
    finally { S.busy = false; $('patCasesGo').disabled = false; }
  }

  // ---------- explain a run (chunk 12d) ----------
  function drawExplain(d) {
    const items = (d.chips || []).map((c) => '<li><b>' + esc(c.label) + '</b>: ' + esc(c.text) + '</li>').join('');
    $('patRunExplainOut').innerHTML = '<div style="margin-top:10px"><div class="an-muted">What the labels on this run mean (fixed text, not written by a model)</div>' +
      '<ul style="margin:4px 0 8px 18px">' + items + '</ul>' +
      (d.explanation ? '<div class="an-muted">AI explanation (' + esc(d.model || 'model') + '), unreviewed</div><p style="margin:4px 0">' + esc(d.explanation) + '</p><div class="an-muted">' + esc(d.explanation_note || '') + '</div>'
        : '<div class="an-muted">' + esc(d.explanation_note || 'No AI explanation was added.') + '</div>') + '</div>';
  }
  async function explainRun() {
    const d = S.lastRun, id = d && d.pattern && d.pattern.id, rid = d && d.run && d.run.id;
    if (S.busy || !id || !rid) return;
    const btn = $('patRunExplain'); S.busy = true; if (btn) btn.disabled = true; say('patRunExplainOut', 'info', 'Asking the model for a plain-words explanation…');
    try {
      const r = await api('POST', '/api/patterns/' + encodeURIComponent(id) + '/explain', { run_id: Number(rid) });
      if (!r.ok || !Array.isArray(r.json.chips)) say('patRunExplainOut', 'error', esc(r.json.error || 'Could not explain this run (HTTP ' + r.status + ')'));
      else if (S.lastRun === d) drawExplain(r.json);
    } catch (e) { say('patRunExplainOut', 'error', esc(e.message)); }
    finally { S.busy = false; const b = $('patRunExplain'); if (b) b.disabled = false; }
  }

  // ---------- draft from a description (chunk 12b) ----------
  function toggleAi() {
    const box = $('patAiBox');
    if (box.hidden) { box.hidden = false; $('patAi').setAttribute('aria-expanded', 'true'); $('patAiTitle').focus(); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    else closeAi(true);
  }
  function closeAi(focus) {
    $('patAiBox').hidden = true; $('patAi').setAttribute('aria-expanded', 'false');
    $('patAiText').value = ''; $('patAiOut').innerHTML = ''; say('patAiStatus', '', '');
    if (focus) $('patAi').focus();
  }
  function drawAi(d) {
    const n = (d.notes && d.notes.dropped_keys) || 0, tries = (d.notes && d.notes.attempts) || 1;
    const chips = [chip('AI-drafted, unreviewed', 'Written by ' + (d.model || 'a model') + '. Certainty is hypothesis and the basis is model suggested until a reviewer changes them.', 'warn')];
    if (n) chips.push(chip(n + ' item' + (n === 1 ? '' : 's') + ' left out', 'The model named conditions or drugs that are not in the active cohort, or used a kind of record this draft does not support. They were removed.', 'warn'));
    if (tries > 1) chips.push(chip('Second try', 'The first reply did not pass the checker, so the model was asked once more.', ''));
    $('patAiOut').innerHTML = '<div style="margin-top:10px">' + chips.join('') + '</div>' +
      '<div class="an-muted">Model: ' + esc(d.model || 'unknown') + '. Only conditions and drugs can be drafted this way. Compare the plain statement and the pattern logic below with what you meant.</div>';
  }
  async function draftAi() {
    if (S.busy) return;
    const text = $('patAiText').value.trim();
    if (text.length < 10) { say('patAiStatus', 'error', 'Describe the pattern in at least a few words.'); $('patAiText').focus(); return; }
    if (!S.cohort) { say('patAiStatus', 'error', 'No active cohort. Create or activate a cohort in the Analytics tab.'); return; }
    if (S.dirty && !window.confirm('The form has unsaved changes. Replace them with the new draft?')) return;
    S.busy = true; $('patAiGo').disabled = true; $('patAiOut').innerHTML = ''; say('patAiStatus', 'info', 'Asking the model for a draft and checking it…');
    try {
      const r = await api('POST', '/api/patterns/ai-draft', { description: text });
      if (!r.ok || !r.json.draft) { say('patAiStatus', 'error', esc(r.json.error || 'Could not draft from this description (HTTP ' + r.status + ')') + (r.status === 422 || r.status === 502 ? ' Nothing was drafted. Try again, or reword the description.' : '')); return; }
      say('patAiStatus', 'success', 'Draft ready. It opened in the form below and is not saved yet.');
      drawAi(r.json); $('patAiText').value = '';
      S.dirty = false; await openForm(null, { draft: r.json.draft, keepFocus: true });
      $('patForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { say('patAiStatus', 'error', esc(e.message)); }
    finally { S.busy = false; $('patAiGo').disabled = false; }
  }

  // ---------- assistant: top diagnoses -> suggestions -> draft ----------
  const A = { dx: null, hidden: 0, minCell: 0, sugg: [], model: '', pick: null, seq: 0 };
  function toggleAsst() {
    const box = $('patAsstBox');
    if (!box.hidden) { closeAsst(true); return; }
    box.hidden = false; $('patAsst').setAttribute('aria-expanded', 'true'); $('patAsstTitle').focus(); box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!A.dx) loadAsstDx();
  }
  function closeAsst(focus) {
    $('patAsstBox').hidden = true; $('patAsst').setAttribute('aria-expanded', 'false');
    $('patAsstOut').innerHTML = ''; say('patAsstStatus', '', ''); A.sugg = []; A.pick = null; A.seq++;
    if (focus) $('patAsst').focus();
  }
  async function loadAsstDx() {
    if (!S.cohort) { say('patAsstStatus', 'error', 'No active cohort. Create or activate a cohort in the Analytics tab.'); return; }
    say('patAsstStatus', 'info', 'Loading the most common diagnoses…');
    try {
      const r = await api('GET', '/api/patterns/assistant/diagnoses');
      if (!r.ok || !Array.isArray(r.json.diagnoses)) { say('patAsstStatus', 'error', esc(r.json.error || 'Could not load diagnoses (HTTP ' + r.status + ')')); return; }
      A.dx = r.json.diagnoses; A.hidden = r.json.hidden_small || 0; A.minCell = r.json.min_cell || 0;
      say('patAsstStatus', A.dx.length ? '' : 'info', A.dx.length ? '' : 'No diagnosis is common enough to list in this cohort.');
      drawAsstList();
    } catch (e) { say('patAsstStatus', 'error', esc(e.message)); }
  }
  function drawAsstList() {
    const el = $('patAsstList'); if (!el || !A.dx) return;
    const q = $('patAsstFind').value.trim().toLowerCase();
    const rows = A.dx.filter((d) => !q || String(d.display).toLowerCase().includes(q) || String(d.code).toLowerCase().includes(q));
    el.innerHTML = (rows.length ? rows.map((d) => '<div role="listitem"><button type="button" class="download-btn" data-code="' + esc(d.code) + '" style="margin:0 0 4px;width:100%;text-align:left"' + (d.code === A.pick ? ' aria-current="true"' : '') + '>' +
      esc(d.display || d.code) + ' <span class="an-muted">(' + esc(d.code) + ') · ' + esc(Number(d.patients).toLocaleString()) + ' patients</span></button></div>').join('') : '<div class="an-muted">No diagnosis matches.</div>') +
      (A.hidden ? '<div class="an-muted" style="margin-top:6px">' + esc(A.hidden) + ' rarer diagnosis' + (A.hidden === 1 ? ' is' : 'es are') + ' not listed because fewer than ' + esc(A.minCell) + ' patients have ' + (A.hidden === 1 ? 'it' : 'them') + '.</div>' : '');
  }
  async function pickDx(code) {
    if (S.busy) return;
    const d = (A.dx || []).find((x) => x.code === code); if (!d) return;
    A.pick = code; A.sugg = []; const my = ++A.seq; drawAsstList();
    S.busy = true; $('patAsstOut').innerHTML = ''; say('patAsstStatus', 'info', 'Asking the model for pattern ideas for ' + esc(d.display || code) + ' and checking each one. This can take a little while…');
    try {
      const r = await api('POST', '/api/patterns/assistant/suggest', { code });
      if (my !== A.seq) return;
      if (!r.ok || !Array.isArray(r.json.suggestions)) { say('patAsstStatus', 'error', esc(r.json.error || 'Could not get suggestions (HTTP ' + r.status + ')') + (r.status === 422 || r.status === 502 ? ' Try another diagnosis, or try this one again.' : '')); return; }
      A.sugg = r.json.suggestions; A.model = r.json.model || '';
      const dropped = (r.json.notes && r.json.notes.dropped) || 0;
      say('patAsstStatus', 'success', esc(A.sugg.length) + ' suggestion' + (A.sugg.length === 1 ? '' : 's') + ' for ' + esc(d.display || code) + '.' + (dropped ? ' ' + esc(dropped) + ' more did not pass the checker and were left out.' : ''));
      drawSuggestions();
    } catch (e) { if (my === A.seq) say('patAsstStatus', 'error', esc(e.message)); }
    finally { S.busy = false; }
  }
  function drawSuggestions() {
    $('patAsstOut').innerHTML = '<div style="margin-top:10px">' + chip('AI-suggested, unreviewed', 'Written by ' + (A.model || 'a model') + '. Each idea is checked against the pattern rules, but a person must still read it before it is used.', 'warn') + '</div>' +
      A.sugg.map((s, i) => '<div class="an-card" style="margin-top:8px"><b>' + esc(s.title) + '</b><div style="margin:4px 0 8px">' + esc(s.plain) + '</div>' +
        '<button type="button" class="download-btn" data-sg="' + i + '" style="margin:0">Use this suggestion</button></div>').join('');
  }
  async function useSuggestion(i) {
    const s = A.sugg[i]; if (!s || !s.draft || S.busy) return;
    if (S.dirty && !window.confirm('The form has unsaved changes. Replace them with this draft?')) return;
    S.busy = true;
    try {
      S.dirty = false; await openForm(null, { draft: s.draft, keepFocus: true });
      say('patAsstStatus', 'success', 'Draft opened in the form below and is not saved yet. Read it, save it, then run it on the active cohort.');
      $('patForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { say('patAsstStatus', 'error', esc(e.message)); }
    finally { S.busy = false; }
  }

  // ---------- import and export (chunk 11) ----------
  async function exportPatterns() {
    if (S.busy) return;
    S.busy = true; say('patListStatus', 'info', 'Preparing the file…');
    try {
      const r = await fetch('/api/patterns/export');
      if (!r.ok) { let j = {}; try { j = await r.json(); } catch (e) { /* not JSON */ } say('patListStatus', 'error', esc(j.error || 'Export failed (HTTP ' + r.status + ')')); return; }
      const text = await r.text(), n = JSON.parse(text).count;
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = 'vibe-rounds-patterns-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say('patListStatus', n ? 'success' : 'info', n ? 'Exported ' + esc(n) + ' reviewed or active pattern' + (n === 1 ? '' : 's') + '. Drafts and retired patterns are not included.' : 'No reviewed or active patterns to export yet.');
    } catch (e) { say('patListStatus', 'error', esc(e.message)); }
    finally { S.busy = false; }
  }
  async function importPatterns(ev) {
    const input = ev.target, f = input.files && input.files[0]; input.value = '';
    if (!f || S.busy) return;
    if (f.size > 1000000) { say('patListStatus', 'error', 'The file is larger than 1 MB.'); return; }
    S.busy = true; say('patListStatus', 'info', 'Importing ' + esc(f.name) + '…');
    try {
      let bundle; try { bundle = JSON.parse(await f.text()); } catch (e) { say('patListStatus', 'error', 'That file is not valid JSON.'); return; }
      const r = await api('POST', '/api/patterns/import', { bundle, note: f.name.slice(0, 120) });
      if (r.status === 422 && r.json.errors) { say('patListStatus', 'error', '<b>The file was not imported.</b> ' + r.json.errors.map((x) => esc(x.message)).join(' ')); return; }
      if (!r.ok) { say('patListStatus', 'error', esc(r.json.error || 'Import failed (HTTP ' + r.status + ')')); return; }
      const j = r.json;
      await loadList();
      say('patListStatus', j.invalid.length ? 'error' : 'success', 'Imported ' + esc(j.created.length) + ' as drafts at hypothesis; ' + esc(j.existing.length) + ' already existed and were left alone' +
        (j.invalid.length ? '; <b>' + esc(j.invalid.length) + ' skipped as invalid</b>: ' + j.invalid.map((x) => '<code>' + esc(x.id || '#' + x.index) + '</code> (' + esc((x.errors[0] && x.errors[0].message) || 'invalid') + ')').join(', ') : '') + '. A reviewer must review them before they are used.');
    } catch (e) { say('patListStatus', 'error', esc(e.message)); }
    finally { S.busy = false; }
  }

  function refresh0() { return loadBanner().then(loadList); }

  function start() {
    if (!shell()) return;
    const tab = document.querySelector('.tab[data-tab="' + PANEL + '"]');
    const refresh = () => { loadBanner().then(loadList); };
    if (tab) tab.addEventListener('click', refresh);
    if (tab && tab.classList.contains('active')) refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.vrPatternsUi = { reload: refresh0 };
})();
