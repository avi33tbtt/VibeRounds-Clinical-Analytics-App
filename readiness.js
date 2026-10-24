// Analytics readiness (backend of the "Analytics readiness" card, shown before "Run analytics").
//
// For the selected Population / Batch (+ active cohort) it
//   1. profiles the data: records, patients, coded / dated / narrative share per resource type, dictionary recognition, history span;
//   2. runs every analytic in every version it has (V1 text, V3 codes, V4 codes + time) once with its default parameters and
//      classifies the outcome:  ok (rows returned) | empty (ran, no rows) | needs_input (wants a parameter) | error | timeout | na (no such version);
//   3. explains each non-ok result from the profile (for example "no medication records", "only 12% of observations are dated")
//      and writes plain-language insights (what to fix, which version fits this data best).
//
//   POST /api/readiness/profile  { batchId|batchGroup, cohortId }          fast: profile + data insights, no analytic is run
//   POST /api/readiness/check    { batchId|batchGroup, cohortId, modes? }  starts the full check -> { jobId }
//   GET  /api/readiness/jobs/:id                                           progress and results
//   POST /api/readiness/jobs/:id/cancel
//
// "ok" means the analytic returned rows with default parameters, not that the numbers are clinically meaningful.
// Self-test: node readiness.js --selftest

const crypto = require('crypto');
const T = require('./terminology');

const MODES = ['v1', 'v3', 'v4'];
const CONCURRENCY = 3, RUN_TIMEOUT_MS = 120000;

// resource type -> { alias in the scope CTE, code column, date column, label }
const TABLES = {
  dx: { label: 'conditions', code: 'code', date: 'onset_date' },
  ob: { label: 'observations (labs / vitals)', code: 'code', date: 'effective_date', value: 'value' },
  rx: { label: 'medications', code: 'code', date: 'prescribed_date' },
  pr: { label: 'procedures', code: 'code', date: 'performed_date' },
  en: { label: 'encounters', code: 'cls', date: 'start_date', end: 'end_date' },
  al: { label: 'allergies', code: 'substance', date: null },
  im: { label: 'immunizations', code: 'code', date: 'occurrence_date' }
};

// which resource types an analytic needs, guessed from its id / title / category (the catalog has no requirement metadata)
const NEEDS = [
  [/medic|drug|prescri|polypharm|adheren|pdc|treatment|regimen|first-line|co-prescr|antico|insulin/, 'rx'],
  [/\blab|hba1c|control|vital|blood pressure|egfr|creatinine|observation|glucose|trend/, 'ob'],
  [/allerg/, 'al'], [/procedur|screening|dialysis|surgery|care gap|colonoscop|mammo/, 'pr'],
  [/encounter|admission|readmi|utiliz|visit|emergency|inpatient|length of stay|\bicu\b|\bed\b/, 'en'],
  [/immuni|vaccin/, 'im'],
  [/condition|diagnos|comorbid|chronic|prevalence|incidence|multimorbid|disease|survival|kaplan|pathway|risk|burden/, 'dx']
];
const needsOf = a => { const s = `${a.id} ${a.title} ${a.category}`.toLowerCase(); const out = new Set(); for (const [re, t] of NEEDS) if (re.test(s)) out.add(t); return [...out]; };

const pctOf = (x, n) => (n ? Math.round((1000 * x) / n) / 10 : 0);

// ---- data profile -------------------------------------------------------------------------------------------
function profileSql(ctxWith) {
  const parts = Object.entries(TABLES).map(([a, d]) => {
    const code = d.code ? `count(${d.code})::int AS coded, count(DISTINCT ${d.code})::int AS codes` : `0 AS coded, 0 AS codes`;
    const date = d.date ? `count(${d.date})::int AS dated, min(${d.date})::date AS first_d, max(${d.date})::date AS last_d` : `0 AS dated, NULL::date AS first_d, NULL::date AS last_d`;
    const val = d.value ? `, count(${d.value})::int AS valued` : '';
    const end = d.end ? `, count(${d.end})::int AS ended` : '';
    return `'${a}', (SELECT row_to_json(x) FROM (SELECT count(*)::int AS n, count(DISTINCT patient_id)::int AS patients, ${code}, ${date}${val}${end},
      count(*) FILTER (WHERE j->'text'->>'div' IS NOT NULL)::int AS texted FROM ${a}) x)`;
  });
  return `${ctxWith} SELECT json_build_object(
    'patients', (SELECT count(*)::int FROM p), 'gender', (SELECT count(*)::int FROM p WHERE gender IS NOT NULL), 'birth', (SELECT count(*)::int FROM p WHERE birth_date IS NOT NULL),
    'texted', (SELECT count(*)::int FROM p WHERE pj->'text'->>'div' IS NOT NULL),
    'dictDx', (SELECT count(*)::int FROM dx WHERE code = ANY($1::text[])), 'dictOb', (SELECT count(*)::int FROM ob WHERE code = ANY($2::text[])), 'dictRx', (SELECT count(*)::int FROM rx WHERE code = ANY($3::text[])),
    ${parts.join(',\n    ')}) AS prof`;
}
const dictCodes = d => Object.values(d).map(v => v.code).filter(Boolean);

async function buildProfile(pool, ctx) {
  const r = await pool.query(profileSql(ctx.with), [dictCodes(T.CONDITIONS), dictCodes(T.LABS), dictCodes(T.MEDICATIONS)]);
  const raw = r.rows[0].prof, P = { patients: raw.patients, gender: raw.gender, birth: raw.birth, texted: raw.texted, tables: {}, asOf: ctx.asOf, scope: { cohort: ctx.cohort, batches: ctx.suffixes.map(s => s || '(legacy tables)') } };
  for (const a of Object.keys(TABLES)) P.tables[a] = Object.assign({ label: TABLES[a].label }, raw[a]);
  P.tables.dx.dict = raw.dictDx; P.tables.ob.dict = raw.dictOb; P.tables.rx.dict = raw.dictRx;
  const firsts = Object.values(P.tables).map(t => t.first_d).filter(Boolean).sort(), lasts = Object.values(P.tables).map(t => t.last_d).filter(Boolean).sort();
  P.first = firsts[0] || null; P.last = lasts[lasts.length - 1] || null;
  P.years = P.first && P.last ? Math.round(((Date.parse(P.last) - Date.parse(P.first)) / (365.25 * 86400000)) * 10) / 10 : 0;
  return P;
}

// reasons an analytic of this version cannot show results on this data
function deficits(P, need, mode) {
  const out = [];
  if (!P.patients) return ['the selected population has no patients'];
  for (const a of need) {
    const t = P.tables[a]; if (!t) continue;
    if (!t.n) { out.push(`no ${t.label} records`); continue; }
    if (mode !== 'v1' && TABLES[a].code && t.coded / t.n < 0.5) out.push(`only ${pctOf(t.coded, t.n)}% of ${t.label} carry a code`);
    if (mode === 'v4' && TABLES[a].date && t.dated / t.n < 0.5) out.push(`only ${pctOf(t.dated, t.n)}% of ${t.label} have a date`);
    if (mode === 'v1' && t.texted / t.n < 0.2) out.push(`only ${pctOf(t.texted, t.n)}% of ${t.label} have narrative text (V1 reads text.div)`);
    if (mode !== 'v1' && t.dict !== undefined && t.n && t.dict / t.n < 0.2) out.push(`few ${t.label} use codes known to the built-in dictionary (${pctOf(t.dict, t.n)}%)`);
  }
  if (mode === 'v4' && P.years && P.years < 2) out.push(`the history spans only ${P.years} years`);
  if (mode === 'v1' && P.patients && !need.length && P.texted / P.patients < 0.2) out.push(`only ${pctOf(P.texted, P.patients)}% of patients have narrative text`);
  return out;
}

// ---- classification -----------------------------------------------------------------------------------------
function classify(res, err) {
  if (err) {
    const m = String(err.message || err);
    if (err.code === 'TIMEOUT') return { status: 'timeout', message: m };
    if (/^pick |choose a |is required|select a /i.test(m)) return { status: 'needs_input', message: m };
    return { status: 'error', message: m.slice(0, 240) };
  }
  const secs = (res && res.sections) || [], rows = secs.reduce((t, s) => t + ((s.rows && s.rows.length) || 0), 0);
  return rows ? { status: 'ok', rows, sections: secs.length } : { status: 'empty', rows: 0, sections: secs.length };
}

async function probeOne(runFn, a, mode, scope) {
  const t0 = Date.now();
  let timer;
  try {
    const res = await Promise.race([runFn({ id: a.id, mode, args: {}, ...scope }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`took longer than ${RUN_TIMEOUT_MS / 1000}s`), { code: 'TIMEOUT' })), RUN_TIMEOUT_MS); })]);
    return Object.assign(classify(res), { ms: Date.now() - t0 });
  } catch (e) { return Object.assign(classify(null, e), { ms: Date.now() - t0 }); }
  finally { clearTimeout(timer); }
}

// ---- insights -----------------------------------------------------------------------------------------------
function dataInsights(P) {
  const I = [], add = (level, text) => I.push({ level, text });
  if (!P.patients) { add('bad', 'The selected population has no patients, so nothing can run. Check the Population / Batch and the active cohort.'); return I; }
  if (P.patients < 30) add('warn', `Only ${P.patients} patients: many analytics will show tiny or unstable numbers (several flag groups under 30). Fetch or generate more patients.`);
  else add('good', `${P.patients.toLocaleString()} patients in scope${P.scope.cohort ? ` (cohort "${P.scope.cohort.name}")` : ''}.`);
  const empty = Object.values(P.tables).filter(t => !t.n).map(t => t.label);
  if (empty.length) add('warn', `No records for: ${empty.join(', ')}. Analytics that need them will be empty (see "blocked by" below).`);
  const dx = P.tables.dx, ob = P.tables.ob, rx = P.tables.rx;
  const textShare = pctOf(Object.values(P.tables).reduce((t, x) => t + x.texted, 0), Object.values(P.tables).reduce((t, x) => t + x.n, 0));
  if (textShare < 20) add('warn', `Only ${textShare}% of records carry narrative text, so V1 (text) will mostly be empty. This is typical for data fetched from an EHR API; rely on V3 / V4. Synthetic data includes narratives.`);
  else add('good', `${textShare}% of records have narrative text, so V1 can work.`);
  for (const t of [dx, ob, rx]) if (t.n && t.coded / t.n < 0.8) add('warn', `${pctOf(t.coded, t.n)}% of ${t.label} have a code; the rest are invisible to V3 / V4.`);
  for (const [t, name] of [[dx, 'conditions'], [ob, 'observations'], [rx, 'medications']]) if (t.n && t.dict / t.n < 0.3) add('info', `Only ${pctOf(t.dict, t.n)}% of ${name} use codes from the built-in dictionary (terminology.js). Analytics driven by the dictionary (first-line drugs, chronic list, lab limits, quality measures) will undercount; the data-driven ones still work. Reviewer decisions can add codes.`);
  const dated = Object.entries(P.tables).filter(([a, t]) => TABLES[a].date && t.n);
  const lowDate = dated.filter(([, t]) => t.dated / t.n < 0.8).map(([, t]) => `${t.label} ${pctOf(t.dated, t.n)}%`);
  if (lowDate.length) add('warn', `Date completeness is low (${lowDate.join(', ')}); V4 (time-based) analytics drop undated records.`);
  if (P.years && P.years < 3) add('warn', `Clinical history spans ${P.years} years; trend, incidence, survival and adherence analytics need longer follow-up.`);
  else if (P.years) add('good', `History spans ${P.years} years (${P.first} to ${P.last}).`);
  if (P.gender / P.patients < 0.9 || P.birth / P.patients < 0.9) add('warn', `Gender is known for ${pctOf(P.gender, P.patients)}% and birth date for ${pctOf(P.birth, P.patients)}% of patients; age and sex breakdowns will have an "Unknown" group.`);
  return I;
}

function summarize(rows, P) {
  const per = {}, blockers = new Map();
  for (const m of MODES) per[m] = { total: 0, ok: 0, empty: 0, needs_input: 0, error: 0, timeout: 0 };
  for (const r of rows) for (const m of MODES) {
    const c = r.modes[m]; if (!c || c.status === 'na') continue;
    per[m].total++; per[m][c.status]++;
    if (c.status !== 'ok' && c.reasons) for (const why of c.reasons) { const k = why.replace(/\d+(\.\d+)?%/g, 'x%'); const b = blockers.get(k) || { text: why, count: 0 }; b.count++; blockers.set(k, b); }
  }
  const best = MODES.map(m => [m, per[m].total ? per[m].ok / per[m].total : 0]).sort((a, b) => b[1] - a[1])[0];
  return { perMode: per, bestMode: best && best[1] > 0 ? best[0] : null, blockers: [...blockers.values()].sort((a, b) => b.count - a.count).slice(0, 8) };
}

function resultInsights(rows, S, P) {
  const I = [], add = (level, text) => I.push({ level, text });
  const tot = MODES.reduce((t, m) => t + S.perMode[m].total, 0), ok = MODES.reduce((t, m) => t + S.perMode[m].ok, 0);
  if (!tot) return I;
  add(ok / tot >= 0.7 ? 'good' : ok / tot >= 0.4 ? 'info' : 'warn', `${ok} of ${tot} analytic versions returned results with default settings (${Math.round((100 * ok) / tot)}%).`);
  if (S.bestMode) add('info', `Best fit for this data: ${S.bestMode.toUpperCase()} (${S.perMode[S.bestMode].ok} of ${S.perMode[S.bestMode].total} return results).`);
  for (const b of S.blockers.slice(0, 5)) add('warn', `${b.count} analytic versions are held back by: ${b.text}.`);
  const err = rows.flatMap(r => MODES.filter(m => r.modes[m] && r.modes[m].status === 'error').map(m => `${r.title} (${m.toUpperCase()})`));
  if (err.length) add('bad', `${err.length} versions failed with an error, which points to a data shape the analytic does not expect rather than missing data: ${err.slice(0, 4).join('; ')}${err.length > 4 ? '; ...' : ''}.`);
  const ni = rows.filter(r => MODES.some(m => r.modes[m] && r.modes[m].status === 'needs_input')).length;
  if (ni) add('info', `${ni} analytics need you to choose a parameter (condition, drug, ...) before they can run; they are not broken.`);
  const slow = rows.flatMap(r => MODES.filter(m => r.modes[m] && r.modes[m].ms > 20000).map(m => `${r.title} (${m.toUpperCase()}) ${Math.round(r.modes[m].ms / 1000)}s`));
  if (slow.length) add('info', `Slowest: ${slow.slice(0, 3).join('; ')}. Dashboards that run everything will take a while on this population.`);
  return I;
}

// ---- job ----------------------------------------------------------------------------------------------------
const JOBS = new Map();
async function runCheck(job, { catalog, runFn, profile, scope, modes }) {
  try {
    job.profile = profile; job.insights = dataInsights(profile);
    const work = [];
    job.rows = catalog.map(a => { const row = { id: a.id, title: a.title, category: a.category || '', needs: needsOf(a), modes: {} };
      for (const m of MODES) { if (typeof a[m] !== 'function') row.modes[m] = { status: 'na' }; else if (modes.includes(m)) work.push([a, m, row]); else row.modes[m] = { status: 'skipped' }; }
      return row; });
    job.total = work.length; let i = 0;
    const worker = async () => {
      while (i < work.length && !job.cancel) {
        const [a, m, row] = work[i++], r = await probeOne(runFn, a, m, scope);
        if (r.status !== 'ok') r.reasons = deficits(profile, row.needs, m);
        row.modes[m] = r; job.done++;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    job.summary = summarize(job.rows, profile);
    job.insights = dataInsights(profile).concat(resultInsights(job.rows, job.summary, profile));
    job.status = job.cancel ? 'cancelled' : 'done';
  } catch (e) { job.status = 'error'; job.message = e.message; }
  finally { job.finishedAt = Date.now(); }
}

// ---- Express wiring -----------------------------------------------------------------------------------------
function register(app, pool, engine, { CATALOG, scopeOf, fail }) {
  const json = require('express').json({ limit: '1mb' });
  const scopeCtx = async b => engine.resolveScope({ ...scopeOf(b || {}) });

  app.post('/api/readiness/profile', json, async (req, res) => {
    try { const ctx = await scopeCtx(req.body), P = await buildProfile(pool, ctx); res.json({ success: true, profile: P, insights: dataInsights(P) }); }
    catch (err) { fail(res, 'Readiness profile', err); }
  });

  app.post('/api/readiness/check', json, async (req, res) => {
    try {
      const b = req.body || {};
      if ([...JOBS.values()].some(j => j.status === 'running')) return res.status(409).json({ success: false, error: 'A readiness check is already running' });
      const modes = (Array.isArray(b.modes) && b.modes.length ? b.modes : MODES).filter(m => MODES.includes(m));
      const ctx = await scopeCtx(b), profile = await buildProfile(pool, ctx), scope = scopeOf(b);
      const job = { id: crypto.randomUUID(), status: 'running', done: 0, total: 0, cancel: false, rows: [], insights: [], profile, summary: null, startedAt: Date.now(), finishedAt: null };
      JOBS.set(job.id, job); if (JOBS.size > 10) JOBS.delete(JOBS.keys().next().value);
      runCheck(job, { catalog: CATALOG, runFn: engine.run, profile, scope, modes });
      res.json({ success: true, jobId: job.id });
    } catch (err) { fail(res, 'Readiness check', err); }
  });

  app.get('/api/readiness/jobs/:id', (req, res) => {
    const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' });
    res.json({ success: true, job: { id: j.id, status: j.status, done: j.done, total: j.total, message: j.message || null, seconds: Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000),
      profile: j.profile, insights: j.insights, summary: j.summary, rows: j.rows } });
  });
  app.post('/api/readiness/jobs/:id/cancel', (req, res) => { const j = JOBS.get(req.params.id); if (!j) return res.status(404).json({ success: false, error: 'Unknown job' }); j.cancel = true; res.json({ success: true }); });
}

module.exports = register;
module.exports.pure = { classify, deficits, needsOf, dataInsights, summarize, resultInsights, runCheck, profileSql };

// ---- self-test ----------------------------------------------------------------------------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  (async () => {
    const assert = require('assert');
    assert.strictEqual(classify({ sections: [{ rows: [1] }] }).status, 'ok');
    assert.strictEqual(classify({ sections: [{ rows: [] }, { rows: [] }] }).status, 'empty');
    assert.strictEqual(classify(null, new Error('Pick a condition')).status, 'needs_input');
    assert.strictEqual(classify(null, new Error('column "x" does not exist')).status, 'error');
    assert.strictEqual(classify(null, Object.assign(new Error('slow'), { code: 'TIMEOUT' })).status, 'timeout');
    const tb = (n, o = {}) => Object.assign({ label: 'x', n, patients: n, coded: n, codes: 3, dated: n, texted: n, dict: n }, o);
    const P = { patients: 100, gender: 100, birth: 100, texted: 0, years: 5, first: '2020-01-01', last: '2025-01-01', scope: { cohort: null },
      tables: { dx: tb(200, { label: 'conditions', texted: 0 }), ob: tb(0, { label: 'observations (labs / vitals)' }), rx: tb(50, { label: 'medications', dated: 10, coded: 50, texted: 0 }), pr: tb(5, { label: 'procedures' }), en: tb(20, { label: 'encounters' }), al: tb(0, { label: 'allergies' }), im: tb(0, { label: 'immunizations' }) } };
    assert.deepStrictEqual(needsOf({ id: 'allergy_profile', title: 'Allergy profile and conflicts', category: 'Safety' }), ['al']);
    assert.ok(deficits(P, ['ob'], 'v3').some(d => /no observations/.test(d)));
    assert.ok(deficits(P, ['rx'], 'v4').some(d => /20% of medications have a date|only 20/.test(d)));
    assert.ok(deficits(P, ['dx'], 'v1').some(d => /narrative text/.test(d)));
    assert.deepStrictEqual(deficits(P, ['dx'], 'v3'), []);
    // fake catalog + runner
    const f = () => 1, cat = [{ id: 'demographics', title: 'Demographics', category: 'Population', v1: f, v3: f, v4: f },
      { id: 'lab_summary', title: 'Lab and vital summary', category: 'Labs', v3: f, v4: f }, { id: 'broken', title: 'Broken', category: 'X', v3: f }];
    const runFn = async ({ id, mode }) => { if (id === 'broken') throw new Error('boom'); if (id === 'lab_summary') return { sections: [{ rows: [] }] }; if (mode === 'v1') return { sections: [{ rows: [] }] }; return { sections: [{ rows: [{ a: 1 }] }] }; };
    const job = { done: 0, rows: [], cancel: false, startedAt: Date.now() };
    await runCheck(job, { catalog: cat, runFn, profile: P, scope: {}, modes: ['v1', 'v3', 'v4'] });
    assert.strictEqual(job.status, 'done'); assert.strictEqual(job.total, 6); assert.strictEqual(job.done, 6);
    const d = job.rows.find(r => r.id === 'demographics'), l = job.rows.find(r => r.id === 'lab_summary');
    assert.strictEqual(d.modes.v3.status, 'ok'); assert.strictEqual(d.modes.v1.status, 'empty'); assert.ok(d.modes.v1.reasons.length, 'empty V1 explained');
    assert.strictEqual(l.modes.v1.status, 'na'); assert.strictEqual(l.modes.v3.status, 'empty'); assert.ok(l.modes.v3.reasons.some(r => /no observations/.test(r)));
    assert.strictEqual(job.rows.find(r => r.id === 'broken').modes.v3.status, 'error');
    assert.strictEqual(job.summary.perMode.v3.total, 3); assert.strictEqual(job.summary.perMode.v3.ok, 1); assert.strictEqual(job.summary.bestMode, 'v4');
    assert.ok(job.insights.some(i => /V1 \(text\) will mostly be empty/.test(i.text)) && job.insights.some(i => i.level === 'bad'));
    assert.ok(/WITH|SELECT/.test(profileSql('WITH p AS (SELECT 1)')));
    console.log('readiness.js self-test: all checks passed');
  })().catch(e => { console.error(e); process.exit(1); });
}
