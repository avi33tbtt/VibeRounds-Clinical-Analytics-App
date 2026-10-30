'use strict';
// Care pathways: what the patients of the current scope actually went through after a chosen diagnosis.
// Backend of the "Care pathways" card in the Analytics tab. Everything is computed from the data of the scope
// (Population / Batch + active cohort, optional sex / age lens); nothing is stored and nothing is written.
//
//   GET /api/pathways?[batchId=|batchGroup=][&cohortId=][&index=<condition key or code>][&depth=5][&perKind=6]
//                    [&kinds=condition,encounter,lab,procedure,medication][&loops=0|1][&gender=][&ageMin=][&ageMax=]
//                    [&minCell=5][&drugDays=90][&monitorDays=365]
//        index    the diagnosis that starts the pathway (default: the most common condition in the scope)
//        depth    how many steps after the diagnosis are followed (2-8)
//        perKind  how many of the most common events of each kind are kept (the rest are ignored, not merged)
//        loops    1 = every inpatient / emergency visit counts (shows readmission loops); 0 = first one only
//        minCell  boxes, links and routes with fewer patients than this are hidden (never below PATHWAY_MIN_CELL, default 5)
//        -> { scope, index, indexOptions, params, totals, nodes, links, variants, otherVariants, outcomes, expected, notes }
//
//   GET /api/trajectory/cohort?<same parameters, no index / drugDays / monitorDays>   WHOLE-COHORT trajectory: every patient of the scope, day 0 = first dated
//        record of any kind; same answer shape as /api/pathways (mode: 'cohort', no expected-versus-observed). /api/trajectory/cohort/patients lists patients.
//
//   GET /api/pathways/patients?<same parameters>&node=<id>            patients in one box of the diagram
//   GET /api/pathways/patients?<same parameters>&from=<id>&to=<id>    patients who took one link
//        only boxes / links that the diagram shows (>= minCell patients) can be listed; at most 200 rows
//
// A pathway = the first time each event happens on or after the diagnosis date, in date order (same-day ties: diagnosis,
// admission / ED visit, lab, procedure, drug). Steps are numbered 1..depth. A patient with fewer steps ends in a
// "No further recorded care" box (drop-off). "Expected vs observed" uses the reference links in terminology.js
// (treated_by / monitored_by / screened_by); those are demo links, verify them before clinical use.
//
// Pure functions are exported for the self-test:  node pathways.js --selftest

const T = require('./knowledge').terminology;

const KINDS = ['condition', 'encounter', 'lab', 'procedure', 'medication'];     // also the order used to break same-day ties
const KIND_RANK = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const ENC_LABEL = { IMP: 'Hospital admission', EMER: 'Emergency visit' };
const MIN_CELL_FLOOR = Math.max(1, parseInt(process.env.PATHWAY_MIN_CELL || '5', 10) || 5);
const MAX_DRILL = 200;
const WHOLE_LABEL = 'Whole cohort (first dated record)', WHOLE_START = 'First dated record (day 0)';
const DICT = { condition: T.CONDITIONS, medication: T.MEDICATIONS, lab: T.LABS, procedure: T.PROCEDURES };

// ---- pure helpers ---------------------------------------------------------------------------------------------
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const stepKey = (kind, code) => `${kind}|${code}`;
const splitKey = k => { const i = String(k).indexOf('|'); return { kind: String(k).slice(0, i), code: String(k).slice(i + 1) }; };

// name of one event: dictionary name when the code is known, else the name found in the data, else the code
function makeLabeler(top) {
  const seen = new Map((top || []).map(r => [stepKey(r.kind, r.code), r.disp]));
  return (kind, code) => {
    if (kind === 'encounter') return ENC_LABEL[code] || `Encounter ${code}`;
    const d = Object.values(DICT[kind] || {}).find(x => x.code === code);
    return (d && d.display) || seen.get(stepKey(kind, code)) || code;
  };
}

// one database row -> patient with its ordered steps
const toPatient = r => ({ id: r.id, gender: r.gender || null, age: r.age === null || r.age === undefined ? null : Number(r.age), dead: !!r.dead,
  nImp: Number(r.n_imp) || 0, items: (r.items || []).slice(), days: (r.days || []).map(Number) });

// Give every patient the list of box ids they pass through: '0:index', '1:<kind>|<code>' ... and an end box '<k>:end' when
// they have fewer than `depth` steps. A step that fewer than minCell patients share at its position becomes '<k>:other'.
function assign(patients, { depth = 5, minCell = 5 } = {}) {
  const cnt = new Map();
  for (const p of patients) p.items.slice(0, depth).forEach((k, i) => { const id = `${i + 1}:${k}`; cnt.set(id, (cnt.get(id) || 0) + 1); });
  return patients.map(p => {
    const steps = p.items.slice(0, depth), path = ['0:index'];
    steps.forEach((k, i) => { const id = `${i + 1}:${k}`; path.push((cnt.get(id) || 0) < minCell ? `${i + 1}:other` : id); });
    if (steps.length < depth) path.push(`${steps.length + 1}:end`);
    return { p, path };
  });
}

const boxOf = id => { const i = id.indexOf(':'), layer = Number(id.slice(0, i)), rest = id.slice(i + 1); return { layer, rest }; };

// The diagram: boxes (nodes) and links with patients and the median days between two steps.
function buildFlow(patients, labelOf, { depth = 5, minCell = 5, startLabel = 'Diagnosis (day 0)' } = {}) {
  const N = patients.length, rows = assign(patients, { depth, minCell });
  const nodes = new Map(), links = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { id, n: 0, dead: 0, adm: 0, readm: 0, days: [] }); return nodes.get(id); };
  for (const { p, path } of rows) {
    path.forEach((id, i) => {
      const nd = node(id); nd.n++; if (p.dead) nd.dead++; if (p.nImp >= 1) nd.adm++; if (p.nImp >= 2) nd.readm++;
      if (i > 0 && i <= p.days.length) nd.days.push(p.days[i - 1]);
      if (i > 0) {
        const k = `${path[i - 1]}>${id}`;
        if (!links.has(k)) links.set(k, { source: path[i - 1], target: id, n: 0, gaps: [] });
        const l = links.get(k); l.n++;
        if (i <= p.days.length) l.gaps.push(p.days[i - 1] - (i > 1 ? p.days[i - 2] : 0));
      }
    });
  }
  const keepLinks = [...links.values()].filter(l => l.n >= minCell);
  const alive = new Set(['0:index']); keepLinks.forEach(l => { alive.add(l.source); alive.add(l.target); });
  const outNodes = [...nodes.values()].filter(nd => alive.has(nd.id) && nd.n >= minCell).map(nd => {
    const { layer, rest } = boxOf(nd.id), end = rest === 'end', other = rest === 'other', index = rest === 'index';
    const { kind, code } = end || other || index ? { kind: rest, code: rest } : splitKey(rest);
    const label = index ? startLabel : end ? 'No further recorded care' : other ? 'Other (small groups)' : labelOf(kind, code);
    return { id: nd.id, layer, kind, code, label, n: nd.n, pctOfIndex: pct(nd.n, N), medianDays: index || end ? null : median(nd.days),
      deadPct: pct(nd.dead, nd.n), admittedPct: pct(nd.adm, nd.n), readmittedPct: pct(nd.readm, nd.n) };
  });
  const ids = new Set(outNodes.map(x => x.id)), nOf = new Map(outNodes.map(x => [x.id, x.n]));
  const outLinks = keepLinks.filter(l => ids.has(l.source) && ids.has(l.target))
    .map(l => ({ source: l.source, target: l.target, n: l.n, pctOfSource: pct(l.n, nOf.get(l.source)), medianDays: l.target.endsWith(':end') ? null : median(l.gaps) }));
  return { nodes: outNodes.sort((a, b) => a.layer - b.layer || b.n - a.n), links: outLinks, hiddenLinks: links.size - keepLinks.length };
}

// The most common whole routes (first `depth` steps), with outcomes. Routes under minCell patients are pooled into "other routes".
function buildVariants(patients, labelOf, { depth = 5, minCell = 5, top = 10 } = {}) {
  const N = patients.length, groups = new Map();
  for (const p of patients) {
    const items = p.items.slice(0, depth), k = items.join('>');
    if (!groups.has(k)) groups.set(k, { items, rows: [] });
    groups.get(k).rows.push(p);
  }
  const all = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || (a.items.join('>') < b.items.join('>') ? -1 : 1));
  const shown = all.filter(g => g.rows.length >= minCell).slice(0, top);
  const shownSet = new Set(shown);
  const rest = all.filter(g => !shownSet.has(g));
  const variants = shown.map((g, i) => {
    const n = g.rows.length, last = g.rows.map(r => r.days[g.items.length - 1]).filter(d => d !== undefined);
    return { rank: i + 1, n, pct: pct(n, N), path: g.items.map(k => { const s = splitKey(k); return { kind: s.kind, code: s.code, label: labelOf(s.kind, s.code) }; }),
      medianDays: g.items.length ? median(last) : null, deadPct: pct(g.rows.filter(r => r.dead).length, n),
      admittedPct: pct(g.rows.filter(r => r.nImp >= 1).length, n), readmittedPct: pct(g.rows.filter(r => r.nImp >= 2).length, n) };
  });
  return { variants, other: { patients: rest.reduce((s, g) => s + g.rows.length, 0), routes: rest.length }, distinctRoutes: all.length };
}

function outcomesOf(patients) {
  const n = patients.length;
  return { n, deadPct: pct(patients.filter(p => p.dead).length, n), admittedPct: pct(patients.filter(p => p.nImp >= 1).length, n),
    readmittedPct: pct(patients.filter(p => p.nImp >= 2).length, n), medianDaysToFirstStep: median(patients.filter(p => p.days.length).map(p => p.days[0])) };
}

// reference steps for one condition from terminology.js (empty when the condition is not in the dictionary)
function expectedFor(indexKey) {
  const out = [];
  for (const r of T.RELATIONS) {
    if (r.from !== indexKey) continue;
    const kind = { treated_by: 'medication', monitored_by: 'lab', screened_by: 'procedure' }[r.type];
    if (!kind) continue;
    const d = DICT[kind][r.to];
    if (!d) continue;
    out.push({ kind, key: r.to, code: d.code, label: d.display || r.to, line: r.line || null,
      role: kind === 'medication' ? (r.line ? `treatment (line ${r.line})` : 'treatment') : kind === 'lab' ? 'monitoring' : 'screening' });
  }
  if (out.some(x => x.kind === 'medication')) out.unshift({ kind: 'medication', key: '*', code: '*', label: 'Any listed treatment drug', line: null, role: 'treatment (any)' });
  return out;
}

// merge reference steps with counts from the database: {kind, code, ever, within, med}
function buildGaps(expected, dbRows, N, { drugDays = 90, monitorDays = 365, minCell = 5 } = {}) {
  const by = new Map(dbRows.map(r => [stepKey(r.kind, r.code), r]));
  return expected.map(x => {
    const r = by.get(stepKey(x.kind, x.code)) || { ever: 0, within: 0, med: null };
    const windowDays = x.kind === 'medication' ? drugDays : monitorDays;
    const small = (r.ever > 0 && r.ever < minCell) || (r.within > 0 && r.within < minCell);
    return { kind: x.kind, label: x.label, role: x.role, line: x.line, windowDays, suppressed: small,
      everPct: small ? null : pct(r.ever, N), withinPct: small ? null : pct(r.within, N),
      gapPct: small ? null : Math.round((100 - pct(r.within, N)) * 10) / 10, medianDays: small || r.med === null || r.med === undefined ? null : Number(r.med) };
  });
}

// ---- SQL --------------------------------------------------------------------------------------------------------
const DISP = a => `coalesce(${a}.j->'code'->'coding'->0->>'display', ${a}.j->'code'->>'text')`;
const RX_DISP = `coalesce(rx.j->'medicationCodeableConcept'->'coding'->0->>'display', rx.j->'medicationCodeableConcept'->>'text')`;

// Shared start: scope CTEs (ctx.with), the lens (sex / age) and ix = one row per patient with the index diagnosis and its first date.
// Parameters: $1 index code, $2 gender, $3 ageMin, $4 ageMax.
// all = true: whole-cohort trajectory. Day 0 is each patient's first dated record of any kind and $1 is only the marker '*'.
const IX_ONE = `ix AS (SELECT dx.patient_id, min(dx.onset_date)::date AS d0 FROM dx
          WHERE dx.code = $1::text AND dx.onset_date IS NOT NULL AND dx.patient_id IN (SELECT patient_id FROM sel) GROUP BY dx.patient_id)`;
const IX_ALL = `ix AS (SELECT e.patient_id, min(e.d)::date AS d0 FROM (
            SELECT patient_id, onset_date::date AS d FROM dx UNION ALL SELECT patient_id, effective_date::date FROM ob UNION ALL SELECT patient_id, prescribed_date::date FROM rx
            UNION ALL SELECT patient_id, performed_date::date FROM pr UNION ALL SELECT patient_id, start_date::date FROM en) e
          WHERE $1::text = '*' AND e.d IS NOT NULL AND e.patient_id IN (SELECT patient_id FROM sel) GROUP BY e.patient_id)`;
const prefix = (ctxWith, all) => `${ctxWith},
  sel AS (SELECT p.patient_id FROM p, ref WHERE ($2::text IS NULL OR lower(p.gender) = $2::text)
            AND ($3::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) >= $3::int)
            AND ($4::int IS NULL OR date_part('year', age(ref.d, p.birth_date)) <= $4::int)),
  ${all ? IX_ALL : IX_ONE}`;

// raw events after the diagnosis, only for the requested kinds. Fixed text only: nothing from the request is placed in the SQL.
function rawSql(kinds, loops) {
  const enc = `en.cls IN ('IMP', 'EMER') AND en.start_date::date >= ix.d0`;
  const parts = {
    condition: `SELECT dx.patient_id, 'condition'::text AS kind, dx.code, min(dx.onset_date)::date AS d, max(${DISP('dx')}) AS disp, 0 AS krank
                FROM dx JOIN ix ON ix.patient_id = dx.patient_id WHERE dx.code IS NOT NULL AND dx.code <> $1::text AND dx.onset_date::date >= ix.d0 GROUP BY dx.patient_id, dx.code`,
    encounter: loops
      ? `SELECT DISTINCT en.patient_id, 'encounter'::text AS kind, en.cls AS code, en.start_date::date AS d, NULL::text AS disp, 1 AS krank
         FROM en JOIN ix ON ix.patient_id = en.patient_id WHERE ${enc}`
      : `SELECT en.patient_id, 'encounter'::text AS kind, en.cls AS code, min(en.start_date)::date AS d, NULL::text AS disp, 1 AS krank
         FROM en JOIN ix ON ix.patient_id = en.patient_id WHERE ${enc} GROUP BY en.patient_id, en.cls`,
    lab: `SELECT ob.patient_id, 'lab'::text AS kind, ob.code, min(ob.effective_date)::date AS d, max(${DISP('ob')}) AS disp, 2 AS krank
          FROM ob JOIN ix ON ix.patient_id = ob.patient_id WHERE ob.code IS NOT NULL AND ob.effective_date::date >= ix.d0 GROUP BY ob.patient_id, ob.code`,
    procedure: `SELECT pr.patient_id, 'procedure'::text AS kind, pr.code, min(pr.performed_date)::date AS d, max(${DISP('pr')}) AS disp, 3 AS krank
                FROM pr JOIN ix ON ix.patient_id = pr.patient_id WHERE pr.code IS NOT NULL AND pr.performed_date::date >= ix.d0 GROUP BY pr.patient_id, pr.code`,
    medication: `SELECT rx.patient_id, 'medication'::text AS kind, rx.code, min(rx.prescribed_date)::date AS d, max(${RX_DISP}) AS disp, 4 AS krank
                 FROM rx JOIN ix ON ix.patient_id = rx.patient_id WHERE rx.code IS NOT NULL AND rx.prescribed_date::date >= ix.d0 GROUP BY rx.patient_id, rx.code`
  };
  return kinds.map(k => parts[k]).join('\n UNION ALL\n ');
}

// Adds: raw events and the most common ones per kind. Parameter $5 = events kept per kind.
const withTop = (ctxWith, kinds, loops, all) => `${prefix(ctxWith, all)},
  raw AS (${rawSql(kinds, loops)}),
  top AS (SELECT kind, code, patients, disp FROM (
            SELECT kind, code, count(DISTINCT patient_id)::int AS patients, mode() WITHIN GROUP (ORDER BY disp) AS disp,
                   row_number() OVER (PARTITION BY kind ORDER BY count(DISTINCT patient_id) DESC, code) AS rn
            FROM raw GROUP BY kind, code) x WHERE rn <= $5::int)`;

// One row per indexed patient: ordered steps (kind|code), days after the diagnosis, outcome flags. Parameter $6 = depth.
const sequenceSql = (ctxWith, kinds, loops, all) => `${withTop(ctxWith, kinds, loops, all)},
  rk AS (SELECT r.patient_id, r.kind, r.code, r.d, row_number() OVER (PARTITION BY r.patient_id ORDER BY r.d, r.krank, r.code) AS rn
         FROM raw r JOIN top t ON t.kind = r.kind AND t.code = r.code),
  seq AS (SELECT rk.patient_id, array_agg(rk.kind || '|' || rk.code ORDER BY rk.rn) AS items, array_agg((rk.d - ix.d0)::int ORDER BY rk.rn) AS days
          FROM rk JOIN ix ON ix.patient_id = rk.patient_id WHERE rk.rn <= $6::int GROUP BY rk.patient_id)
  SELECT ix.patient_id AS id, lower(p.gender) AS gender, date_part('year', age(ref.d, p.birth_date))::int AS age,
         (p.pj->>'deceasedDateTime' IS NOT NULL OR p.pj->>'deceasedBoolean' = 'true') AS dead,
         (SELECT count(*) FROM en WHERE en.patient_id = ix.patient_id AND en.cls = 'IMP' AND en.start_date::date >= ix.d0)::int AS n_imp,
         coalesce(seq.items, ARRAY[]::text[]) AS items, coalesce(seq.days, ARRAY[]::int[]) AS days
  FROM ix JOIN p ON p.patient_id = ix.patient_id LEFT JOIN seq ON seq.patient_id = ix.patient_id, ref
  ORDER BY ix.patient_id`;

const topSql = (ctxWith, kinds, loops, all) => `${withTop(ctxWith, kinds, loops, all)} SELECT kind, code, patients, disp FROM top ORDER BY patients DESC`;

// Reference steps: for each expected drug / lab / procedure the patients who had it on or after the diagnosis, and within the window.
// Parameters: $5 drug codes, $6 lab codes, $7 procedure codes, $8 drug window (days), $9 monitoring window (days).
const gapSql = ctxWith => `${prefix(ctxWith)},
  f AS (SELECT 'medication'::text AS kind, rx.code, rx.patient_id, min(rx.prescribed_date)::date AS d FROM rx JOIN ix ON ix.patient_id = rx.patient_id
          WHERE rx.code = ANY($5::text[]) AND rx.prescribed_date::date >= ix.d0 GROUP BY rx.code, rx.patient_id
        UNION ALL SELECT 'lab', ob.code, ob.patient_id, min(ob.effective_date)::date FROM ob JOIN ix ON ix.patient_id = ob.patient_id
          WHERE ob.code = ANY($6::text[]) AND ob.effective_date::date >= ix.d0 GROUP BY ob.code, ob.patient_id
        UNION ALL SELECT 'procedure', pr.code, pr.patient_id, min(pr.performed_date)::date FROM pr JOIN ix ON ix.patient_id = pr.patient_id
          WHERE pr.code = ANY($7::text[]) AND pr.performed_date::date >= ix.d0 GROUP BY pr.code, pr.patient_id),
  g AS (SELECT kind, code, patient_id, d FROM f
        UNION ALL SELECT 'medication', '*', patient_id, min(d) FROM f WHERE kind = 'medication' GROUP BY patient_id)
  SELECT g.kind, g.code, count(*)::int AS ever,
         (count(*) FILTER (WHERE g.d - ix.d0 <= CASE g.kind WHEN 'medication' THEN $8::int ELSE $9::int END))::int AS within,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (g.d - ix.d0)) AS med
  FROM g JOIN ix ON ix.patient_id = g.patient_id GROUP BY g.kind, g.code`;

const optionsSql = ctxWith => `${ctxWith}
  SELECT dx.code, mode() WITHIN GROUP (ORDER BY ${DISP('dx')}) AS disp, count(DISTINCT dx.patient_id)::int AS patients
  FROM dx WHERE dx.code IS NOT NULL AND dx.onset_date IS NOT NULL GROUP BY dx.code ORDER BY patients DESC, dx.code LIMIT 40`;

// ---- request parsing -----------------------------------------------------------------------------------------------
const one = v => (Array.isArray(v) ? v[0] : v);
const intIn = (v, lo, hi, def) => { if (v === undefined || v === null || v === '') return def; const x = Math.floor(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : def; };
const bad = msg => Object.assign(new Error(msg), { status: 400 });

function parseParams(q) {
  const kinds = one(q.kinds) === undefined || one(q.kinds) === '' ? KINDS.slice() : String(one(q.kinds)).split(',').map(s => s.trim()).filter(Boolean);
  if (!kinds.length || kinds.some(k => !KINDS.includes(k))) throw bad(`kinds must be a list of: ${KINDS.join(', ')}`);
  const gender = String(one(q.gender) || '').toLowerCase();
  if (gender && !['male', 'female', 'other', 'unknown'].includes(gender)) throw bad('gender must be male, female, other or unknown');
  const ageMin = intIn(one(q.ageMin), 0, 130, null), ageMax = intIn(one(q.ageMax), 0, 130, null);
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) throw bad('ageMin is larger than ageMax');
  const index = String(one(q.index) || '').trim();
  if (index.length > 64) throw bad('index is too long');
  return { index, kinds: KINDS.filter(k => kinds.includes(k)), loops: one(q.loops) === '1' || one(q.loops) === 'true', gender: gender || null, ageMin, ageMax,
    depth: intIn(one(q.depth), 2, 8, 5), perKind: intIn(one(q.perKind), 2, 12, 6), minCell: intIn(one(q.minCell), MIN_CELL_FLOOR, 1000, MIN_CELL_FLOOR),
    drugDays: intIn(one(q.drugDays), 1, 3650, 90), monitorDays: intIn(one(q.monitorDays), 1, 3650, 365) };
}

// ---- Express wiring ------------------------------------------------------------------------------------------------
function register(app, pool, engine, { fail }) {
  const scopeIn = q => ({ batchId: one(q.batchId), batchGroup: one(q.batchGroup), cohortId: one(q.cohortId), useCohort: true });

  // all = true: the whole-cohort trajectory (every patient, day 0 = first dated record); false: the pathway after one diagnosis
  async function analyse(q, all) {
    const P = parseParams(q), ctx = await engine.resolveScope(scopeIn(q));
    let opts = [], index;
    if (all) index = { value: '*', key: null, label: WHOLE_LABEL };
    else {
      opts = (await pool.query(optionsSql(ctx.with))).rows.map(r => {
        const key = Object.keys(T.CONDITIONS).find(k => T.CONDITIONS[k].code === r.code);
        return { value: r.code, key: key || null, label: key ? T.CONDITIONS[key].display : (r.disp || r.code), patients: r.patients };
      });
      if (!opts.length) throw Object.assign(new Error('No dated conditions in this scope, so there is no diagnosis to start a pathway from.'), { status: 404 });
      const want = P.index && (T.CONDITIONS[P.index] ? T.CONDITIONS[P.index].code : P.index);
      index = (want && opts.find(o => o.value === want)) || (P.index ? null : opts[0]);
      if (!index) throw Object.assign(new Error(`Condition "${P.index}" does not occur (with a date) in this scope.`), { status: 404 });
    }
    const base = [index.value, P.gender, P.ageMin, P.ageMax];
    const rows = (await pool.query(sequenceSql(ctx.with, P.kinds, P.loops, all), [...base, P.perKind, P.depth])).rows.map(toPatient);
    if (all) index.patients = rows.length;
    return { P, ctx, opts, index, rows, base };
  }
  const flowOpts = (P, all) => ({ depth: P.depth, minCell: P.minCell, startLabel: all ? WHOLE_START : undefined });

  const pathwaysRoute = all => async (req, res) => {
    try {
      const { P, ctx, opts, index, rows, base } = await analyse(req.query, all);
      const N = rows.length, scope = { patients: ctx.patients, cohort: ctx.cohort, population: ctx.population, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf };
      const head = { success: true, scope, index: { value: index.value, key: index.key, label: index.label, patients: N }, indexOptions: opts, mode: all ? 'cohort' : 'diagnosis',
        params: { depth: P.depth, perKind: P.perKind, kinds: P.kinds, loops: P.loops, gender: P.gender, ageMin: P.ageMin, ageMax: P.ageMax, minCell: P.minCell, drugDays: P.drugDays, monitorDays: P.monitorDays } };
      if (N < P.minCell) return res.json({ ...head, totals: { patients: N }, nodes: [], links: [], variants: [], otherVariants: { patients: 0, routes: 0 }, outcomes: null, expected: [],
        notes: [all ? `Only ${N} patient(s) have a dated record here; at least ${P.minCell} are needed to show a trajectory.` : `Only ${N} patient(s) have this diagnosis here; at least ${P.minCell} are needed to show a pathway.`] });
      const top = (await pool.query(topSql(ctx.with, P.kinds, P.loops, all), [...base, P.perKind])).rows;
      const labelOf = makeLabeler(top);
      const flow = buildFlow(rows, labelOf, flowOpts(P, all));
      const v = buildVariants(rows, labelOf, { depth: P.depth, minCell: P.minCell });
      let expected = [];
      const exp = !all && index.key ? expectedFor(index.key) : [];
      if (exp.length) {
        const codes = k => exp.filter(x => x.kind === k && x.code !== '*').map(x => x.code);
        const g = (await pool.query(gapSql(ctx.with), [...base, codes('medication'), codes('lab'), codes('procedure'), P.drugDays, P.monitorDays])).rows;
        expected = buildGaps(exp, g, N, P);
      }
      const notes = [all ? `Day 0 is each patient's first dated record of any kind. The trajectory shows the first time each event happens on or after day 0. Only the ${P.perKind} most common events of each kind are followed; others are ignored.`
          : `Pathways show the first time each event happens on or after the diagnosis date. Only the ${P.perKind} most common events of each kind are followed; others are ignored.`,
        `Boxes, links and routes with fewer than ${P.minCell} patients are hidden${flow.hiddenLinks ? ` (${flow.hiddenLinks} link(s) hidden here)` : ''}.`,
        'Outcome percentages are crude and unadjusted: follow-up time and case mix differ between routes, so differences are leads to review, not proof that one route works better.'];
      if (!all && !index.key) notes.push('This diagnosis is not in the reference dictionary, so there is no expected-versus-observed comparison for it.');
      res.json({ ...head, totals: { patients: N, distinctRoutes: v.distinctRoutes, hiddenLinks: flow.hiddenLinks }, nodes: flow.nodes, links: flow.links,
        variants: v.variants, otherVariants: v.other, outcomes: outcomesOf(rows), expected, notes });
    } catch (err) { fail(res, all ? 'Cohort trajectory' : 'Care pathways', err); }
  };

  const patientsRoute = all => async (req, res) => {
    try {
      const q = req.query, node = one(q.node), from = one(q.from), to = one(q.to);
      if (!node && !(from && to)) throw bad('Send node=<id>, or from=<id>&to=<id>');
      const { P, ctx, index, rows, base } = await analyse(q, all);
      const top = (await pool.query(topSql(ctx.with, P.kinds, P.loops, all), [...base, P.perKind])).rows, labelOf = makeLabeler(top);
      const shown = buildFlow(rows, labelOf, flowOpts(P, all));
      const asg = assign(rows, { depth: P.depth, minCell: P.minCell });
      let hit;
      if (node) {
        if (!shown.nodes.some(n => n.id === String(node))) throw bad('That box is not shown in the diagram (fewer than the minimum number of patients).');
        hit = asg.filter(a => a.path.includes(String(node)));
      } else {
        if (!shown.links.some(l => l.source === String(from) && l.target === String(to))) throw bad('That link is not shown in the diagram (fewer than the minimum number of patients).');
        hit = asg.filter(a => a.path.some((id, i) => i > 0 && a.path[i - 1] === String(from) && id === String(to)));
      }
      const patients = hit.slice(0, MAX_DRILL).map(({ p }) => ({ id: p.id, gender: p.gender, age: p.age, dead: p.dead, admissions: p.nImp, days: p.days,
        path: p.items.slice(0, P.depth).map(k => { const s = splitKey(k); return labelOf(s.kind, s.code); } ) }));
      res.json({ success: true, index: { label: index.label }, total: hit.length, truncated: hit.length > MAX_DRILL, patients });
    } catch (err) { fail(res, all ? 'Cohort trajectory patients' : 'Care pathway patients', err); }
  };

  app.get('/api/pathways', pathwaysRoute(false));
  app.get('/api/pathways/patients', patientsRoute(false));
  // whole cohort: every patient of the scope, from the first dated record (no diagnosis to pick)
  app.get('/api/trajectory/cohort', pathwaysRoute(true));
  app.get('/api/trajectory/cohort/patients', patientsRoute(true));
}

module.exports = register;
module.exports.pure = { median, pct, assign, buildFlow, buildVariants, outcomesOf, expectedFor, buildGaps, makeLabeler, toPatient, parseParams, rawSql, sequenceSql, gapSql, topSql };

// ---- self-test -----------------------------------------------------------------------------------------------------
module.exports.selftest = () => {
  const assert = require('assert');
  const mk = (id, items, days, o = {}) => ({ id, gender: 'female', age: 60, dead: !!o.dead, nImp: o.nImp || 0, items, days });
  const MET = 'medication|' + T.MEDICATIONS.metformin.code, A1C = 'lab|' + T.LABS.hba1c.code, IMP = 'encounter|IMP';
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push(mk('a' + i, [MET, A1C, IMP], [10, 40, 200], { nImp: i < 3 ? 2 : 1, dead: i < 2 }));   // metformin -> HbA1c -> admission
  for (let i = 0; i < 8; i++) pts.push(mk('b' + i, [A1C, MET], [5, 30]));                                                     // HbA1c -> metformin, then nothing
  for (let i = 0; i < 6; i++) pts.push(mk('c' + i, [], []));                                                                  // never any further care
  pts.push(mk('d0', [IMP], [3], { nImp: 1 }), mk('d1', [IMP], [4], { nImp: 1 }));                                              // rare route (2 patients)
  const labelOf = makeLabeler([]);
  assert.strictEqual(labelOf('encounter', 'IMP'), 'Hospital admission');
  assert.strictEqual(labelOf('medication', T.MEDICATIONS.metformin.code), T.MEDICATIONS.metformin.display);
  assert.strictEqual(labelOf('lab', 'zzz'), 'zzz');
  assert.strictEqual(median([3, 1, 2]), 2); assert.strictEqual(median([1, 2, 3, 4]), 2.5); assert.strictEqual(median([]), null);

  const f = buildFlow(pts, labelOf, { depth: 3, minCell: 5 });
  const byId = Object.fromEntries(f.nodes.map(n => [n.id, n]));
  assert.strictEqual(byId['0:index'].n, 28);
  assert.strictEqual(byId['1:' + MET].n, 12); assert.strictEqual(byId['1:' + A1C].n, 8);
  assert.strictEqual(byId['1:end'].n, 6, 'patients with no step drop off at layer 1');
  assert.ok(!byId['1:' + IMP], 'a first step shared by only 2 patients is hidden');
  assert.ok(!f.nodes.some(n => n.id === '1:other'), 'the pooled "other" box (2 patients) is also under the minimum, so it is hidden');
  const link = f.links.find(l => l.source === '0:index' && l.target === '1:' + MET);
  assert.strictEqual(link.n, 12); assert.strictEqual(link.medianDays, 10); assert.strictEqual(link.pctOfSource, 42.9);
  const l2 = f.links.find(l => l.source === '1:' + MET && l.target === '2:' + A1C);
  assert.strictEqual(l2.medianDays, 30, 'median days between steps 1 and 2 (40 - 10)');
  const l3 = f.links.find(l => l.source === '1:' + A1C && l.target === '2:' + MET);
  assert.strictEqual(l3.medianDays, 25);
  assert.ok(f.links.some(l => l.source === '2:' + MET && l.target === '3:end' && l.n === 8), 'drop-off after two steps');
  assert.ok(f.links.every(l => l.n >= 5), 'no link below the minimum');
  assert.strictEqual(byId['1:' + MET].deadPct, 16.7); assert.strictEqual(byId['1:' + MET].readmittedPct, 25);

  const v = buildVariants(pts, labelOf, { depth: 3, minCell: 5 });
  assert.strictEqual(v.variants.length, 3); assert.strictEqual(v.variants[0].n, 12); assert.strictEqual(v.variants[0].path.length, 3);
  assert.strictEqual(v.variants[0].medianDays, 200); assert.strictEqual(v.variants[0].deadPct, 16.7);
  assert.deepStrictEqual(v.other, { patients: 2, routes: 1 }); assert.strictEqual(v.distinctRoutes, 4);
  assert.strictEqual(v.variants.find(x => x.path.length === 0).n, 6);

  const asg = assign(pts, { depth: 3, minCell: 5 });
  assert.deepStrictEqual(asg.find(a => a.p.id === 'd0').path, ['0:index', '1:other', '2:end']);
  assert.deepStrictEqual(asg.find(a => a.p.id === 'a0').path, ['0:index', '1:' + MET, '2:' + A1C, '3:' + IMP]);

  const o = outcomesOf(pts); assert.strictEqual(o.n, 28); assert.strictEqual(o.deadPct, 7.1); assert.strictEqual(o.medianDaysToFirstStep, 10);

  const ex = expectedFor('diabetes');
  assert.ok(ex.some(x => x.kind === 'medication' && x.key === 'metformin' && x.line === 1) && ex.some(x => x.kind === 'lab' && x.key === 'hba1c'));
  assert.strictEqual(ex[0].code, '*'); assert.deepStrictEqual(expectedFor('not_a_condition'), []);
  const gaps = buildGaps([{ kind: 'lab', key: 'hba1c', code: 'L', label: 'HbA1c', role: 'monitoring' }, { kind: 'medication', key: '*', code: '*', label: 'Any', role: 'treatment (any)' },
    { kind: 'procedure', key: 'p', code: 'P', label: 'Small', role: 'screening' }],
  [{ kind: 'lab', code: 'L', ever: 80, within: 60, med: 20 }, { kind: 'medication', code: '*', ever: 90, within: 70, med: 14 }, { kind: 'procedure', code: 'P', ever: 3, within: 2, med: 1 }], 100, { minCell: 5 });
  assert.strictEqual(gaps[0].withinPct, 60); assert.strictEqual(gaps[0].gapPct, 40); assert.strictEqual(gaps[0].windowDays, 365); assert.strictEqual(gaps[1].windowDays, 90);
  assert.strictEqual(gaps[2].suppressed, true); assert.strictEqual(gaps[2].withinPct, null);

  assert.throws(() => parseParams({ kinds: 'condition,evil' }), /kinds must be/);
  assert.throws(() => parseParams({ gender: 'x' }), /gender/);
  assert.throws(() => parseParams({ ageMin: '70', ageMax: '20' }), /ageMin/);
  assert.strictEqual(parseParams({ minCell: '1' }).minCell, MIN_CELL_FLOOR, 'the minimum cell size cannot be lowered from the browser');
  assert.strictEqual(parseParams({ depth: '99' }).depth, 8); assert.deepStrictEqual(parseParams({}).kinds, KINDS);
  const sql = sequenceSql('WITH p AS (SELECT 1)', ['condition', 'encounter'], true);
  assert.ok(/SELECT DISTINCT en\.patient_id/.test(sql) && !/FROM rx/.test(sql) && !/;/.test(sql), 'loops use every visit; unselected kinds are not queried; one statement only');
  assert.ok(!/DISTINCT en\.patient_id/.test(rawSql(['encounter'], false)));
  // whole-cohort mode: day 0 is the first dated record of any kind; the diagnosis query is untouched
  const sqlAll = sequenceSql('WITH p AS (SELECT 1)', ['lab'], false, true), sqlOne = sequenceSql('WITH p AS (SELECT 1)', ['lab'], false);
  assert.ok(/WHERE \$1::text = '\*'/.test(sqlAll) && /FROM en\)/.test(sqlAll) && !/;/.test(sqlAll), 'cohort start: first dated record of any kind, one statement');
  assert.ok(/dx\.code = \$1::text/.test(sqlOne) && !/FROM rx\)/.test(sqlOne), 'diagnosis start is unchanged');
  assert.ok(!/\$7/.test(sqlAll) && /\$6::int/.test(sqlAll), 'same parameter positions as the diagnosis query');
  const fa = buildFlow(pts, labelOf, { depth: 3, minCell: 5, startLabel: WHOLE_START });
  assert.strictEqual(fa.nodes.find(n => n.id === '0:index').label, WHOLE_START);
  assert.strictEqual(buildFlow(pts, labelOf, { depth: 3, minCell: 5 }).nodes.find(n => n.id === '0:index').label, 'Diagnosis (day 0)');
  console.log('pathways.js self-test: all checks passed');
};
if (require.main === module && process.argv.includes('--selftest')) module.exports.selftest();
