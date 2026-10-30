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
//   GET /api/trajectory/stages?<scope + lens parameters>&index=<diagnosis>[&horizon=365][&longStay=7][&perKind=6][&minCell=5]
//        CARE STAGES for one chosen diagnosis: every patient with that diagnosis (day 0 = first onset date) is placed in nine columns:
//        Comorbidities (every OTHER diagnosis of the patient), Diagnosis (the chosen one), Presentation, Initial plan (first 2 days),
//        Medications, Procedures, Escalation, Advanced/recurrent, Disposition. Same stage names as the Inpatient trajectory analytic, but one row
//        per PATIENT instead of per inpatient episode. -> { scope, index, indexOptions, params, patients, stages, nodes, ribbons, detail, notes }
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


// ---- care stages (patient-level version of the Inpatient trajectory) ---------------------------------------------------
// Nine columns, one row per patient with the chosen diagnosis. Day 0 = the first onset date of that diagnosis. Everything after day 0 is
// looked at inside the horizon (days). Stages 1, 5 and 6 can hold several values per patient (a patient counts once in each value).
// A missing value is shown as '(none)', so every stage covers every patient. Fixed text only: nothing from the request is placed in the SQL.
// Parameters: $1 index code, $2 gender, $3 ageMin, $4 ageMax, $5 horizon (days), $6 long-stay limit (days), $7 values kept per multi-valued stage,
//             $8 initial-plan window (days), $9 minimum patients per node / band (final queries only).
const STAGES = [[1, 'Comorbidities'], [2, 'Diagnosis'], [3, 'Presentation'], [4, 'Initial plan'], [5, 'Medications'], [6, 'Procedures'], [7, 'Escalation'], [8, 'Advanced/recurrent'], [9, 'Disposition']];
const STAGE_KIND = { 1: 'condition', 5: 'medication', 6: 'procedure' };     // the multi-valued stages carry codes; all others carry fixed words
const PLAN_DAYS = 2, OTHER_CODE = '~other', OTHER_LABEL = 'Other (less common)', STAGE_RIBBON_CAP = 40;
const DISP_WORDS = [['home', 'Home'], ['snf', 'Skilled nursing'], ['rehab', 'Rehabilitation'], ['aadvice', 'Left against advice'], ['exp', 'Died']];
const stagesCte = ctxWith => `${prefix(ctxWith, false)},
  hz AS (SELECT ix.patient_id, ix.d0, ix.d0 + $5::int AS d1 FROM ix),
  m1 AS (SELECT dx.patient_id, 1 AS stage_no, dx.code, max(${DISP('dx')}) AS disp FROM dx JOIN ix ON ix.patient_id = dx.patient_id
         WHERE dx.code IS NOT NULL AND dx.code <> $1::text GROUP BY dx.patient_id, dx.code),
  m5 AS (SELECT rx.patient_id, 5 AS stage_no, rx.code, max(${RX_DISP}) AS disp FROM rx JOIN hz ON hz.patient_id = rx.patient_id
         WHERE rx.code IS NOT NULL AND rx.prescribed_date::date >= hz.d0 AND rx.prescribed_date::date <= hz.d1 GROUP BY rx.patient_id, rx.code),
  m6 AS (SELECT pr.patient_id, 6 AS stage_no, pr.code, max(${DISP('pr')}) AS disp FROM pr JOIN hz ON hz.patient_id = pr.patient_id
         WHERE pr.code IS NOT NULL AND pr.performed_date::date >= hz.d0 AND pr.performed_date::date <= hz.d1 GROUP BY pr.patient_id, pr.code),
  mm AS (SELECT * FROM m1 UNION ALL SELECT * FROM m5 UNION ALL SELECT * FROM m6),
  keep AS (SELECT stage_no, code FROM (SELECT stage_no, code, row_number() OVER (PARTITION BY stage_no ORDER BY count(*) DESC, code) AS rn FROM mm GROUP BY stage_no, code) t WHERE rn <= $7::int),
  mv AS (SELECT mm.patient_id, mm.stage_no, CASE WHEN k.code IS NULL THEN '${OTHER_CODE}' ELSE mm.code END AS code, max(mm.disp) AS disp
         FROM mm LEFT JOIN keep k ON k.stage_no = mm.stage_no AND k.code = mm.code GROUP BY mm.patient_id, mm.stage_no, CASE WHEN k.code IS NULL THEN '${OTHER_CODE}' ELSE mm.code END),
  fe AS (SELECT DISTINCT ON (en.patient_id) en.patient_id, en.cls, NULLIF(en.j->'hospitalization'->'admitSource'->'coding'->0->>'code', '') AS src
         FROM en JOIN hz ON hz.patient_id = en.patient_id
         WHERE en.cls IS DISTINCT FROM 'ACUTE' AND en.start_date IS NOT NULL AND en.start_date::date >= hz.d0 AND en.start_date::date <= hz.d1
         ORDER BY en.patient_id, en.start_date, en.cls),
  s3 AS (SELECT ix.patient_id, 3 AS stage_no, CASE WHEN fe.patient_id IS NULL THEN '(none)'
           WHEN fe.cls = 'IMP' THEN CASE fe.src WHEN 'emd' THEN 'Admitted via emergency department' WHEN 'gp' THEN 'Admitted on referral' WHEN 'hosp-trans' THEN 'Transferred from hospital'
                                         WHEN 'nursing' THEN 'Admitted from nursing home' ELSE 'Hospital admission' END
           WHEN fe.cls = 'EMER' THEN 'Emergency visit' ELSE 'Outpatient / other visit' END AS code
         FROM ix LEFT JOIN fe ON fe.patient_id = ix.patient_id),
  s4 AS (SELECT ix.patient_id, 4 AS stage_no, CASE WHEN a.has_pr AND a.has_rx THEN 'Procedure + medication' WHEN a.has_pr THEN 'Procedure only' WHEN a.has_rx THEN 'Medication only' ELSE 'Observation only' END AS code
         FROM ix CROSS JOIN LATERAL (SELECT
           EXISTS (SELECT 1 FROM pr WHERE pr.patient_id = ix.patient_id AND pr.performed_date::date >= ix.d0 AND pr.performed_date::date <= ix.d0 + $8::int) AS has_pr,
           EXISTS (SELECT 1 FROM rx WHERE rx.patient_id = ix.patient_id AND rx.prescribed_date::date >= ix.d0 AND rx.prescribed_date::date <= ix.d0 + $8::int) AS has_rx) a),
  s7 AS (SELECT ix.patient_id, 7 AS stage_no, CASE WHEN a.icu THEN 'ICU transfer' WHEN a.rrt THEN 'Rapid response call' ELSE 'None' END AS code
         FROM ix CROSS JOIN LATERAL (SELECT
           EXISTS (SELECT 1 FROM en k WHERE k.patient_id = ix.patient_id AND k.cls = 'ACUTE' AND k.start_date::date >= ix.d0 AND k.start_date::date <= ix.d0 + $5::int
                   AND k.j->'type'->0->>'text' = 'Intensive care unit stay') AS icu,
           EXISTS (SELECT 1 FROM en k WHERE k.patient_id = ix.patient_id AND k.cls = 'ACUTE' AND k.start_date::date >= ix.d0 AND k.start_date::date <= ix.d0 + $5::int
                   AND k.j->'type'->0->>'text' = 'Rapid response') AS rrt) a),
  s8 AS (SELECT ix.patient_id, 8 AS stage_no, CASE WHEN a.rd AND a.ls THEN 'Both' WHEN a.rd THEN 'Readmitted within 30 days' WHEN a.ls THEN 'Prolonged stay' ELSE 'Neither' END AS code
         FROM ix CROSS JOIN LATERAL (SELECT
           EXISTS (SELECT 1 FROM en a1 JOIN en b1 ON b1.patient_id = a1.patient_id AND b1.cls = 'IMP' AND b1.start_date > a1.end_date AND b1.start_date <= a1.end_date + interval '30 days'
                   WHERE a1.patient_id = ix.patient_id AND a1.cls = 'IMP' AND a1.end_date IS NOT NULL AND a1.start_date::date >= ix.d0 AND a1.start_date::date <= ix.d0 + $5::int) AS rd,
           EXISTS (SELECT 1 FROM en c1 WHERE c1.patient_id = ix.patient_id AND c1.cls = 'IMP' AND c1.end_date IS NOT NULL AND c1.start_date::date >= ix.d0 AND c1.start_date::date <= ix.d0 + $5::int
                   AND c1.end_date >= c1.start_date + ($6::int * interval '1 day')) AS ls) a),
  ld AS (SELECT DISTINCT ON (en.patient_id) en.patient_id, NULLIF(en.j->'hospitalization'->'dischargeDisposition'->'coding'->0->>'code', '') AS dc
         FROM en JOIN hz ON hz.patient_id = en.patient_id
         WHERE en.cls = 'IMP' AND en.end_date IS NOT NULL AND en.start_date::date >= hz.d0 AND en.start_date::date <= hz.d1
         ORDER BY en.patient_id, en.end_date DESC),
  s9 AS (SELECT ix.patient_id, 9 AS stage_no, CASE ${DISP_WORDS.map(([k, v]) => `WHEN ld.dc = '${k}' THEN '${v}'`).join(' ')} WHEN ld.dc IS NOT NULL THEN 'Other'
           WHEN (p.pj->>'deceasedDateTime' IS NOT NULL OR p.pj->>'deceasedBoolean' = 'true') THEN 'Died' ELSE '(none)' END AS code
         FROM ix JOIN p ON p.patient_id = ix.patient_id LEFT JOIN ld ON ld.patient_id = ix.patient_id),
  st AS (SELECT patient_id, stage_no, code FROM mv
         UNION ALL SELECT patient_id, 1, '(none)' FROM ix WHERE NOT EXISTS (SELECT 1 FROM mv WHERE mv.patient_id = ix.patient_id AND mv.stage_no = 1)
         UNION ALL SELECT patient_id, 5, '(none)' FROM ix WHERE NOT EXISTS (SELECT 1 FROM mv WHERE mv.patient_id = ix.patient_id AND mv.stage_no = 5)
         UNION ALL SELECT patient_id, 6, '(none)' FROM ix WHERE NOT EXISTS (SELECT 1 FROM mv WHERE mv.patient_id = ix.patient_id AND mv.stage_no = 6)
         UNION ALL SELECT patient_id, 2, $1::text FROM ix
         UNION ALL SELECT patient_id, stage_no, code FROM s3 UNION ALL SELECT patient_id, stage_no, code FROM s4
         UNION ALL SELECT patient_id, stage_no, code FROM s7 UNION ALL SELECT patient_id, stage_no, code FROM s8 UNION ALL SELECT patient_id, stage_no, code FROM s9)`;

// boxes: one row per (stage, value) with the patients carrying it; only values with at least $9 patients
const stageNodesSql = ctxWith => `${stagesCte(ctxWith)},
  nd AS (SELECT stage_no, code, count(DISTINCT patient_id)::int AS n FROM st GROUP BY stage_no, code)
  SELECT nd.stage_no, nd.code, nd.n, (SELECT max(mv.disp) FROM mv WHERE mv.stage_no = nd.stage_no AND mv.code = nd.code) AS disp
  FROM nd WHERE nd.n >= $9::int ORDER BY nd.stage_no, nd.n DESC, nd.code`;
// bands: patients going from one value of stage k to one value of stage k+1 (distinct patients per pair); multi-valued stages fan out
const stageRibbonsSql = ctxWith => `${stagesCte(ctxWith)},
  rb AS (SELECT a.stage_no AS fs, a.code AS fc, b.code AS tc, count(DISTINCT a.patient_id)::int AS n
         FROM st a JOIN st b ON b.patient_id = a.patient_id AND b.stage_no = a.stage_no + 1
         GROUP BY a.stage_no, a.code, b.code HAVING count(DISTINCT a.patient_id) >= $9::int),
  rk AS (SELECT rb.*, row_number() OVER (PARTITION BY fs ORDER BY n DESC, fc, tc) AS rn FROM rb)
  SELECT fs, fc, tc, n FROM rk WHERE rn <= ${STAGE_RIBBON_CAP} ORDER BY fs, n DESC, fc, tc`;
// how much of the detail the stages need exists in this scope (the later stages come from inpatient stays)
const stageScopeSql = ctxWith => `${stagesCte(ctxWith)}
  SELECT (SELECT count(*) FROM ix)::int AS patients,
         (SELECT count(*) FROM fe)::int AS with_encounter,
         (SELECT count(*) FROM ld)::int AS with_stay,
         (SELECT count(*) FROM ld WHERE dc IS NOT NULL)::int AS with_disposition`;

// rows from the two queries -> labelled boxes and bands (values under minCell are already left out by the SQL)
function buildStages(nodeRows, ribbonRows, N, labelOf, indexLabel) {
  const stageName = Object.fromEntries(STAGES), used = new Map(), byKey = new Map(), nodes = [];
  for (const r of nodeRows) {
    const code = String(r.code), no = Number(r.stage_no), kind = STAGE_KIND[no];
    let label = code === OTHER_CODE ? OTHER_LABEL : no === 2 ? indexLabel : kind && code !== '(none)' ? labelOf(kind, code, r.disp) : code;
    const seen = used.get(no) || new Set(); used.set(no, seen);
    if (seen.has(label)) label = `${label} (${code})`;
    seen.add(label);
    byKey.set(`${no}|${code}`, label);
    nodes.push({ stage_no: no, stage: stageName[no], value: label, code, patients: Number(r.n), pct_of_patients: pct(Number(r.n), N) });
  }
  const nOf = new Map(nodes.map(x => [`${x.stage_no}|${x.code}`, x.patients])), ribbons = [];
  for (const r of ribbonRows) {
    const fk = `${r.fs}|${r.fc}`, tk = `${Number(r.fs) + 1}|${r.tc}`;
    if (!byKey.has(fk) || !byKey.has(tk)) continue;
    ribbons.push({ from_stage: stageName[r.fs], from_value: byKey.get(fk), to_stage: stageName[Number(r.fs) + 1], to_value: byKey.get(tk), patients: Number(r.n), pct_of_from: pct(Number(r.n), nOf.get(fk)) });
  }
  return { nodes, ribbons };
}

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
    drugDays: intIn(one(q.drugDays), 1, 3650, 90), monitorDays: intIn(one(q.monitorDays), 1, 3650, 365),
    horizon: intIn(one(q.horizon), 30, 3650, 365), longStay: intIn(one(q.longStay), 3, 60, 7) };
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


  // care stages: the nine-column view for one chosen diagnosis (aggregates only; boxes and bands under minCell patients are left out)
  const stagesRoute = async (req, res) => {
    try {
      const q = req.query, P = parseParams(q), ctx = await engine.resolveScope(scopeIn(q));
      const opts = (await pool.query(optionsSql(ctx.with))).rows.map(r => {
        const key = Object.keys(T.CONDITIONS).find(k => T.CONDITIONS[k].code === r.code);
        return { value: r.code, key: key || null, label: key ? T.CONDITIONS[key].display : (r.disp || r.code), patients: r.patients };
      });
      if (!opts.length) throw Object.assign(new Error('No dated conditions in this scope, so there is no diagnosis to build the stages from.'), { status: 404 });
      const want = P.index && (T.CONDITIONS[P.index] ? T.CONDITIONS[P.index].code : P.index);
      const index = (want && opts.find(o => o.value === want)) || (P.index ? null : opts[0]);
      if (!index) throw Object.assign(new Error(`Condition "${P.index}" does not occur (with a date) in this scope.`), { status: 404 });
      const scope = { patients: ctx.patients, cohort: ctx.cohort, population: ctx.population, batches: ctx.suffixes.map(x => x || '(legacy tables)'), asOf: ctx.asOf };
      const params = { horizon: P.horizon, longStay: P.longStay, perKind: P.perKind, gender: P.gender, ageMin: P.ageMin, ageMax: P.ageMax, minCell: P.minCell, planDays: PLAN_DAYS };
      const head = { success: true, scope, index: { value: index.value, key: index.key, label: index.label }, indexOptions: opts, mode: 'stages', params, stages: STAGES.map(x => x[1]) };
      const base = [index.value, P.gender, P.ageMin, P.ageMax, P.horizon, P.longStay, P.perKind, PLAN_DAYS];
      const sc = (await pool.query(stageScopeSql(ctx.with), base)).rows[0] || {};
      const N = Number(sc.patients) || 0;
      if (N < P.minCell) return res.json({ ...head, patients: N, nodes: [], ribbons: [], detail: null,
        notes: [`Only ${N} patient(s) have ${index.label} (with a date) here; at least ${P.minCell} are needed to show the stages.`] });
      const [nr, rr] = await Promise.all([pool.query(stageNodesSql(ctx.with), [...base, P.minCell]), pool.query(stageRibbonsSql(ctx.with), [...base, P.minCell])]);
      const labelOf = makeLabeler(nr.rows.filter(r => STAGE_KIND[r.stage_no]).map(r => ({ kind: STAGE_KIND[r.stage_no], code: String(r.code), disp: r.disp })));
      const { nodes, ribbons } = buildStages(nr.rows, rr.rows, N, labelOf, index.label);
      const detail = { patients: N, withEncounter: Number(sc.with_encounter) || 0, withStay: Number(sc.with_stay) || 0, withDisposition: Number(sc.with_disposition) || 0 };
      const notes = [`One row per patient with ${index.label}. Day 0 is the first onset date of that diagnosis; every other diagnosis of the patient (any date) is a comorbidity. Presentation is the first visit or admission within ${P.horizon} days of day 0; the initial plan looks at the first ${PLAN_DAYS} days; medications, procedures, escalation, advanced/recurrent care and disposition look at the ${P.horizon} days after day 0.`,
        'Percentages are shares of all patients with this diagnosis. Stages 1, 5 and 6 can hold several values per patient, so their percentages can add up to more than 100 and a patient can sit in several bands.',
        `Only the ${P.perKind} most common values of the comorbidity, medication and procedure stages are named; the rest are grouped as "${OTHER_LABEL}". Boxes and bands with fewer than ${P.minCell} patients are not drawn. Escalation is ICU transfer or rapid response; "Advanced/recurrent" is readmission within 30 days, a stay of ${P.longStay} days or more, both, or neither.`];
      if (detail.withStay < Math.ceil(N / 10)) notes.push(`Only ${detail.withStay} of ${N} patients have a completed inpatient stay in this window, so Escalation, Advanced/recurrent and Disposition are mostly empty. Batches generated with "Inpatient detail (for trajectory analytics)" ticked carry the stay detail these stages need.`);
      res.json({ ...head, patients: N, nodes, ribbons, detail, notes });
    } catch (err) { fail(res, 'Care stages', err); }
  };

  app.get('/api/pathways', pathwaysRoute(false));
  app.get('/api/pathways/patients', patientsRoute(false));
  // whole cohort: every patient of the scope, from the first dated record (no diagnosis to pick)
  app.get('/api/trajectory/cohort', pathwaysRoute(true));
  app.get('/api/trajectory/cohort/patients', patientsRoute(true));
  app.get('/api/trajectory/stages', stagesRoute);          // nine care stages for one chosen diagnosis (patient-level)
}

module.exports = register;
module.exports.pure = { STAGES, buildStages, stagesCte, stageNodesSql, stageRibbonsSql, stageScopeSql, median, pct, assign, buildFlow, buildVariants, outcomesOf, expectedFor, buildGaps, makeLabeler, toPatient, parseParams, rawSql, sequenceSql, gapSql, topSql };

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

  // care stages: nine named stages, one statement per query, every request value bound (never in the text), same labels as the Inpatient trajectory
  assert.deepStrictEqual(STAGES.map(x => x[1]), ['Comorbidities', 'Diagnosis', 'Presentation', 'Initial plan', 'Medications', 'Procedures', 'Escalation', 'Advanced/recurrent', 'Disposition']);
  for (const f of [stageNodesSql, stageRibbonsSql, stageScopeSql]) { const q = f('WITH p AS (SELECT 1)'); assert.ok(!/;/.test(q) && /\$8::int/.test(q) && /\$5::int/.test(q), 'one statement, parameters bound'); }
  assert.ok(/\$9::int/.test(stageNodesSql('WITH p AS (SELECT 1)')) && /\$9::int/.test(stageRibbonsSql('WITH p AS (SELECT 1)')) && !/\$9/.test(stageScopeSql('WITH p AS (SELECT 1)')), 'minCell only in the two aggregate queries');
  assert.ok(/dx\.code <> \$1::text/.test(stagesCte('WITH p AS (SELECT 1)')), 'comorbidities exclude the chosen diagnosis only');
  assert.strictEqual(parseParams({}).horizon, 365); assert.strictEqual(parseParams({ horizon: '5' }).horizon, 30); assert.strictEqual(parseParams({ longStay: '99' }).longStay, 60);
  const lab = makeLabeler([{ kind: 'condition', code: 'ZZ9', disp: 'Zed nine' }]);
  const nr = [{ stage_no: 1, code: 'ZZ9', n: 10, disp: 'Zed nine' }, { stage_no: 1, code: '~other', n: 8, disp: 'x' }, { stage_no: 1, code: '(none)', n: 22, disp: null },
    { stage_no: 2, code: 'DX', n: 40, disp: null }, { stage_no: 7, code: 'None', n: 34, disp: null }, { stage_no: 3, code: 'Emergency visit', n: 6, disp: null }];
  const rr = [{ fs: 1, fc: 'ZZ9', tc: 'DX', n: 10 }, { fs: 1, fc: 'GONE', tc: 'DX', n: 7 }, { fs: 2, fc: 'DX', tc: 'Emergency visit', n: 6 }];
  const bs = buildStages(nr, rr, 40, lab, 'Chosen dx');
  assert.deepStrictEqual(bs.nodes.map(x => x.value), ['Zed nine', 'Other (less common)', '(none)', 'Chosen dx', 'None', 'Emergency visit']);
  assert.strictEqual(bs.nodes[0].pct_of_patients, 25); assert.strictEqual(bs.nodes[3].stage, 'Diagnosis');
  assert.strictEqual(bs.ribbons.length, 2, 'a band to a box that is not drawn is dropped'); assert.strictEqual(bs.ribbons[0].from_stage, 'Comorbidities'); assert.strictEqual(bs.ribbons[0].pct_of_from, 100);
  assert.strictEqual(bs.ribbons[1].to_stage, 'Presentation'); assert.strictEqual(bs.ribbons[1].pct_of_from, 15);
  assert.strictEqual(buildStages([{ stage_no: 5, code: 'A', n: 9 }, { stage_no: 5, code: 'B', n: 9 }], [], 20, () => 'Same name', 'x').nodes[1].value, 'Same name (B)', 'two codes with one name stay two boxes');
  console.log('pathways.js self-test: all checks passed');
};
if (require.main === module && process.argv.includes('--selftest')) module.exports.selftest();
